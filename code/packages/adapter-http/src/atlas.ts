import {
  CAPTURE_LIST_LIMIT,
  CAPTURE_LIST_OUTCOMES,
  EXCHANGE_PATTERN,
  parseCaptureCursor,
  projectCaptureDetail,
  projectCaptureList,
  type CaptureListQuery,
  type CaptureLog,
  type CaptureLogEntry,
  type CaptureOutcome,
  decodeResolveEnvelope,
  encodeErrorEnvelope,
  ERROR_CONTENT_TYPE,
  formatPath,
  isScenarioName,
  reloadSummary,
  RESERVED_SEGMENT,
  type Atlas,
  type AtlasEndpoint,
  type AtlasExplanation,
  type AtlasFixture,
  type AtlasFixtureSummary,
  type AtlasLookup,
  type AtlasMatrix,
  type AtlasReloadResult,
  type AtlasRenderedFixture,
  type AtlasScenarios,
  type AtlasSnapshotEvent,
  type AtlasSnapshotState,
  type EnginePromotions,
  type EngineSessions,
  filterPromotions,
  type HeaderMap,
  type PromotionAnswer,
  type PromotionEvent,
  type RequestErrorCode,
  type SessionAnswer,
  type SessionSource,
} from '@janus/core';

import { allowOrigin, isPreflight, isTrustedOrigin, preflightHeaders, readOrigin, type CorsSettings } from './cors.js';
import {
  handleRunnerRequest,
  RUNNER_METHODS,
  RUNNER_RESOURCES,
  runnerRoute,
  type AtlasRunnerEvent,
  type AtlasRunnerService,
  type RunnerRoute,
} from './runner.js';

/** Every successful Atlas document carries this. */
export const ATLAS_API_VERSION = 'atlas.v1';

/** The methods read-only Atlas resources answer; everything else under them is `405`. */
export const ATLAS_METHODS: readonly string[] = ['GET', 'HEAD'];

/** Slack the resolve envelope gets beyond twice the body limit, for JSON framing and headers. */
export const ENVELOPE_OVERHEAD_BYTES = 64 * 1024;

const SNAPSHOT_VERSION = /^[0-9a-f]{16}$/;

/**
 * Reloading as the HTTP adapter sees it. The server
 * implements it; the adapter only mounts it.
 */
export interface AtlasReloadService {
  /** Triggers a manual reload; settles with the result of the reload that includes it. */
  trigger(): Promise<AtlasReloadResult>;
  /** The most recent result, or null before the first reload. */
  last(): AtlasReloadResult | null;
  /** Whether automatic watching is configured and currently running. */
  watching(): boolean;
  /** Reads the state and subscribes in one synchronous step. */
  subscribe(listener: (event: AtlasSnapshotEvent) => void): {
    readonly state: AtlasSnapshotState;
    unsubscribe(): void;
  };
}

/** A `capture` event: no request values. */
export interface AtlasCaptureEvent {
  readonly id: string;
  readonly scenario: string;
  readonly outcome: CaptureOutcome;
}

/**
 * The captures directory as the Atlas capture routes read it. The server implements it; core projects what it returns.
 */
export interface AtlasCaptureService {
  /** Every scenario's log, or one scenario's. */
  logs(scenario?: string): Promise<readonly CaptureLog[]>;
  /** An exchange with a `captured` line and its allowlisted files, or null. */
  exchange(
    scenario: string,
    exchange: string,
  ): Promise<{ readonly entry: CaptureLogEntry; readonly files: ReadonlyMap<string, Uint8Array | null> } | null>;
  /** Subscribes to `capture` events; returns the unsubscribe function. */
  subscribe(listener: (event: AtlasCaptureEvent) => void): () => void;
}

/** What the Atlas routes need besides the engine's projections. */
export interface AtlasContext {
  readonly atlas: Atlas;
  /** `atlas.resolve`: whether `POST /_janus/resolve` is mounted, and the decoded body limit. */
  readonly resolve: { readonly enabled: boolean; readonly maxBodyBytes: number };
  /** Mounts `/_janus/reload` and `/_janus/events` when present. */
  readonly reload: AtlasReloadService | null;
  /** `capabilities.ui`: the UI is enabled and its files loaded. */
  readonly ui: boolean;
  /** `cors.origins` and `cors.maxAge`. */
  readonly cors: CorsSettings;
  /** The caller's own session. */
  readonly sessions: EngineSessions;
  /** The captures directory; without it the capture list is empty. */
  readonly captures: AtlasCaptureService | null;
  /** Promotion and review. */
  readonly promotions: EnginePromotions;
  /** The request runner; null leaves its routes unmounted. */
  readonly runner: AtlasRunnerService | null;
  /**
   * Called after each `POST`, `PATCH` or `DELETE /_janus/session` and each
   * `DELETE /_janus/sequences` that reached the engine.
   */
  readonly onSessionWrite?: (record: SessionWriteRecord) => void;
}

/** One session write, for the log. Holds no write key and no credential: a derived ID is already a hash. */
export interface SessionWriteRecord {
  readonly requestId: string;
  readonly route: '/_janus/session' | '/_janus/sequences';
  readonly method: 'POST' | 'PATCH' | 'DELETE';
  /** Null when the session key itself was malformed. */
  readonly source: SessionSource | null;
  readonly id: string | null;
  readonly status: number;
  /** `created`, `updated`, `deleted` or `reset`, or the error code. */
  readonly outcome: string;
}

export interface AtlasRequest {
  /** Uppercased request method. */
  readonly method: string;
  /** Decoded, normalized path segments; the first is `_janus`. */
  readonly segments: readonly string[];
  readonly query: readonly (readonly [name: string, value: string])[];
  /** Request headers: `GET /_janus/clock` reads `X-Mock-Now`, `POST /_janus/resolve` reads `Content-Type`. */
  readonly headers?: HeaderMap;
  readonly requestId: string;
  /** The request body, read only by `POST` resources. */
  readonly body?: Uint8Array | null;
  /** Aborted when the client goes away. */
  readonly signal?: AbortSignal;
}

/** A complete Atlas response, ready for the transport to write. */
export interface AtlasResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** UTF-8 JSON; null for HEAD. */
  readonly body: Uint8Array | null;
  /** Canonical path for the request log (no query). */
  readonly path: string;
}

export type AtlasRoute =
  | 'health'
  | 'config'
  | 'inventory'
  | 'scenarios'
  | 'endpoint'
  | 'fixture'
  | 'clock'
  | 'session'
  | 'sequences'
  | 'resolve'
  | 'reload'
  | 'events'
  | 'recording'
  | 'captures'
  | 'capture'
  | 'promotions'
  | 'promotions-review'
  | `runner:${RunnerRoute}`;

/** The methods each resource answers. */
const ALLOWED: Readonly<Partial<Record<AtlasRoute, readonly string[]>>> = {
  resolve: ['POST'],
  reload: ['GET', 'HEAD', 'POST'],
  session: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'],
  sequences: ['DELETE'],
  promotions: ['GET', 'HEAD', 'POST'],
  'promotions-review': ['POST'],
  // POST creates a scenario.
  scenarios: ['GET', 'HEAD', 'POST'],
  ...(Object.fromEntries(
    Object.entries(RUNNER_METHODS).map(([route, methods]) => [`runner:${route}`, methods]),
  ) as Record<`runner:${RunnerRoute}`, readonly string[]>),
};

/** Routes whose writes are checked against the request's `Origin`. */
const ORIGIN_CHECKED: ReadonlySet<AtlasRoute> = new Set<AtlasRoute>([
  'resolve',
  'reload',
  'session',
  'sequences',
  'promotions',
  'promotions-review',
  'scenarios',
  // Every state-changing runner route.
  ...(Object.keys(RUNNER_METHODS) as RunnerRoute[]).map((route) => `runner:${route}` as const),
]);

/** Methods that change nothing, so never need the `Origin` check. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** Lets a script on a listed origin read the write key. */
const EXPOSE_SESSION_KEY = 'X-Mock-Session-Key';

function isRunnerAtlasRoute(route: AtlasRoute): route is `runner:${RunnerRoute}` {
  return route.startsWith('runner:');
}

/** The methods a mounted Atlas resource answers. */
export function atlasMethods(route: AtlasRoute): readonly string[] {
  return ALLOWED[route] ?? ATLAS_METHODS;
}

/** True when a normalized path lies in the reserved Atlas namespace, which the adapter owns entirely. */
export function isAtlasPath(segments: readonly string[]): boolean {
  return segments[0] === RESERVED_SEGMENT;
}

/** The mounted Atlas resource a path names, or null; disabled resources are not mounted. */
export function atlasRoute(segments: readonly string[], context: AtlasContext): AtlasRoute | null {
  const [, resource, id, ...rest] = segments;
  // Mounted with the runner; answered 404 while it is unavailable.
  if (resource !== undefined && RUNNER_RESOURCES.has(resource)) {
    const runner = context.runner === null ? null : runnerRoute(segments);
    return runner === null ? null : `runner:${runner}`;
  }
  // Exactly a scenario and an exchange, checked again before any read.
  if (resource === 'captures') {
    if (id === undefined) return 'captures';
    return rest.length === 1 ? 'capture' : null;
  }
  if (rest.length > 0) return null;
  // The list and promotion share one resource; review is its own.
  if (resource === 'promotions') return id === undefined ? 'promotions' : id === 'review' ? 'promotions-review' : null;
  if (resource === 'endpoints') return id === undefined ? 'inventory' : 'endpoint';
  if (resource === 'fixtures') return id === undefined ? null : 'fixture';
  if (id !== undefined) return null;
  switch (resource) {
    case 'health':
    case 'config':
    case 'clock':
    case 'session':
    case 'sequences':
    case 'scenarios':
    case 'recording':
      return resource;
    case 'resolve':
      return context.resolve.enabled ? 'resolve' : null;
    case 'reload':
    case 'events':
      return context.reload === null ? null : resource;
    default:
      return null;
  }
}

/**
 * Answers one request beneath `/_janus`. Reads come
 * from `context.atlas`; `POST /_janus/resolve` simulates without serving, and
 * `POST /_janus/reload` changes only which snapshot is served. The event
 * stream itself is written by the transport; this answers its `HEAD`.
 */
export async function handleAtlasRequest(context: AtlasContext, request: AtlasRequest): Promise<AtlasResponse> {
  const { atlas } = context;
  const { method, segments, requestId } = request;
  const path = formatPath(segments);
  // HEAD has the headers of GET, Content-Length included.
  const send = (status: number, body: Uint8Array, extra: Readonly<Record<string, string>> = {}): AtlasResponse => ({
    status,
    headers: {
      'content-type': ERROR_CONTENT_TYPE,
      'cache-control': 'no-store',
      ...extra,
      ...(method === 'HEAD' ? { 'content-length': String(body.length) } : {}),
    },
    body: method === 'HEAD' ? null : body,
    path,
  });
  const ok = (document: unknown, status = 200, extra?: Record<string, string>): AtlasResponse =>
    send(status, encoder.encode(JSON.stringify(document)), extra);
  const fail = (
    status: number,
    code: RequestErrorCode,
    message: string,
    extra?: Record<string, string>,
    details?: Readonly<Record<string, unknown>>,
  ) => send(status, encodeErrorEnvelope({ code, message, requestId, details }), extra);

  const route = atlasRoute(segments, context);
  if (request.headers !== undefined && isPreflight(method, request.headers)) {
    // All or nothing: a failed preflight is answered like a plain OPTIONS.
    const preflight = preflightHeaders(request.headers, route === null ? null : atlasMethods(route), context.cors);
    if (preflight !== null)
      return { status: 204, headers: { 'cache-control': 'no-store', ...preflight }, body: null, path };
  }
  if (route === null) {
    // Byte-for-byte what the engine answers when it sees an unknown `/_janus` path.
    return fail(404, 'route-not-found', `No fixture matches ${method} ${path}`);
  }
  const allowed = atlasMethods(route);
  if (!allowed.includes(method)) {
    return fail(405, 'method-not-allowed', `${method} is not allowed for ${path}; allowed: ${allowed.join(', ')}`, {
      allow: allowed.join(', '),
    });
  }
  const headers = request.headers ?? {};
  if (!SAFE_METHODS.has(method) && ORIGIN_CHECKED.has(route) && !isTrustedOrigin(headers, context.cors)) {
    return fail(
      403,
      'atlas-origin-forbidden',
      "This page's origin is not allowed to change this server; list it in cors.origins or use the server's own origin",
    );
  }
  // A real request carrying a session key keeps that session alive; the session route does its own.
  if (route !== 'session' && route !== 'sequences') context.sessions.touch(headers);

  if (isRunnerAtlasRoute(route)) {
    if (context.runner === null) return fail(404, 'route-not-found', `No fixture matches ${method} ${path}`);
    const answer = await handleRunnerRequest(
      context.runner,
      route.slice('runner:'.length) as RunnerRoute,
      method,
      segments,
      headers,
      request.body ?? null,
      request.signal,
    );
    if (!answer.ok) return fail(answer.status, answer.code, answer.message, {}, answer.details);
    if (answer.document === undefined) {
      return { status: answer.status, headers: { 'cache-control': 'no-store' }, body: null, path };
    }
    return ok({ apiVersion: ATLAS_API_VERSION, ...answer.document }, answer.status);
  }

  switch (route) {
    case 'health': {
      const health = atlas.health();
      const reload = context.reload;
      const last = reload?.last() ?? null;
      return ok({
        apiVersion: ATLAS_API_VERSION,
        status: health.status,
        snapshot: health.snapshotVersion,
        snapshotVersion: health.snapshotVersion,
        fixtureCount: health.fixtureCount,
        routeCount: health.routeCount,
        configDigest: health.configDigest,
        warnings: health.warnings,
        scenarioCount: health.scenarioCount,
        configuredDefaultScenario: health.configuredDefaultScenario,
        capabilities: {
          resolve: context.resolve.enabled,
          reload: reload !== null,
          watch: reload?.watching() ?? false,
          events: reload !== null,
          ui: context.ui,
          cors: { origins: context.cors.origins.length, fixtures: health.transport.fixtureOrigins },
          scenarios: true,
          sessions: true,
          variants: true,
          sequences: true,
          pages: true,
          expectations: true,
          idempotency: health.idempotency,
          recording: { available: atlas.recording().available, endpoints: atlas.recording().endpoints.length },
          promotion: atlas.promotion(),
          faults: health.transport.faults,
          compression: health.transport.compression,
          codecs: health.transport.codecs,
          autoOptions: health.transport.autoOptions,
          runner: context.runner?.capability() ?? { available: false, collections: 0 },
        },
        lastReload: last === null ? null : reloadSummary(last),
      });
    }
    case 'config': {
      const config = atlas.config();
      return ok({
        apiVersion: ATLAS_API_VERSION,
        configDigest: config.configDigest,
        configFile: config.configFile,
        settings: config.settings,
      });
    }
    case 'inventory': {
      const names = request.query.filter(([name]) => name === 'scenario').map(([, value]) => value);
      const name = names[0];
      if (names.length > 1 || (name !== undefined && !isScenarioName(name))) {
        return fail(400, 'atlas-invalid-request', 'Invalid Atlas request: "scenario" must be one scenario name');
      }
      const inventory = name === undefined ? atlas.inventory() : atlas.inventory(name);
      if (inventory === undefined) {
        return fail(
          404,
          'atlas-resource-not-found',
          `No scenario named ${JSON.stringify(name)} exists in the current snapshot`,
        );
      }
      return ok({
        apiVersion: ATLAS_API_VERSION,
        snapshotVersion: inventory.snapshotVersion,
        scenario: inventory.scenario,
        items: inventory.items.map((item) => ({
          id: item.id,
          scenario: item.scenario,
          method: item.method,
          path: item.path,
          pathParameters: item.pathParameters,
          origin: item.origin,
          ...(item.review === undefined ? {} : { review: item.review }),
          ...(item.hasFaults === undefined ? {} : { hasFaults: true }),
          detailHref: detailHref('endpoints', item.id, inventory.snapshotVersion),
        })),
      });
    }
    case 'scenarios':
      if (method === 'POST') {
        // Written through promotion's fixture writer and reload.
        const answer = await context.promotions.createScenario(headers, request.body ?? null, request.signal);
        return promotionAnswer(answer, atlas.health().snapshotVersion, ok, fail);
      }
      return ok(scenariosDocument(atlas.scenarios()));
    case 'session': {
      const answer =
        method === 'GET' || method === 'HEAD'
          ? context.sessions.describe(headers)
          : context.sessions.write(method as 'POST' | 'PATCH' | 'DELETE', headers, request.body ?? null);
      if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
        context.onSessionWrite?.(sessionWriteRecord(requestId, method, answer));
      }
      if (!answer.ok) return fail(answer.status, answer.code, answer.message, {}, answer.details);
      const extra: Record<string, string> = {};
      if (answer.writeKey !== undefined) {
        // Sent once, in this header only.
        extra['x-mock-session-key'] = answer.writeKey;
        if (allowOrigin(readOrigin(headers), context.cors) !== null) {
          extra['access-control-expose-headers'] = EXPOSE_SESSION_KEY;
        }
      }
      return ok({ apiVersion: ATLAS_API_VERSION, session: answer.document }, answer.status, extra);
    }
    case 'sequences': {
      const endpoints = request.query.filter(([name]) => name === 'endpoint').map(([, value]) => value);
      if (endpoints.length > 1) {
        return fail(400, 'atlas-invalid-request', 'Invalid Atlas request: "endpoint" must be one endpoint ID');
      }
      const answer = context.sessions.resetSequences(headers, endpoints[0] ?? null);
      context.onSessionWrite?.(sessionWriteRecord(requestId, 'DELETE', answer, '/_janus/sequences'));
      if (!answer.ok) return fail(answer.status, answer.code, answer.message, {}, answer.details);
      return ok({ apiVersion: ATLAS_API_VERSION, session: answer.document });
    }
    case 'clock': {
      const clock = atlas.clock(request.headers ?? {});
      if (clock.kind === 'bad-input')
        return fail(400, 'atlas-invalid-request', `Invalid Atlas request: ${clock.message}`);
      return ok({ apiVersion: ATLAS_API_VERSION, ...clock.value });
    }
    case 'resolve':
      return resolveRoute(context, request, ok, fail);
    case 'reload': {
      const reload = context.reload;
      if (reload === null) return fail(404, 'route-not-found', `No fixture matches ${method} ${path}`);
      if (method !== 'POST') {
        const last = reload.last();
        return ok(last === null ? { apiVersion: ATLAS_API_VERSION, outcome: null } : reloadDocument(last));
      }
      if ((request.body?.length ?? 0) > 0) {
        return fail(400, 'atlas-invalid-request', 'Invalid Atlas request: POST /_janus/reload takes no body');
      }
      let result: AtlasReloadResult;
      try {
        // Not tied to the request: a reload continues even if its caller disconnects.
        result = await reload.trigger();
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'service-unavailable') {
          return fail(503, 'service-unavailable', 'Janus is shutting down; the reload was not performed');
        }
        throw error;
      }
      return ok(reloadDocument(result), result.outcome === 'failed' ? 422 : 200);
    }
    case 'recording':
      return ok({ apiVersion: ATLAS_API_VERSION, ...atlas.recording() });
    case 'captures': {
      const query = captureListQuery(request.query);
      if (typeof query === 'string') return fail(400, 'atlas-invalid-request', `Invalid Atlas request: ${query}`);
      const logs = context.captures === null ? [] : await context.captures.logs(query.scenario);
      const list = projectCaptureList(logs, query);
      return ok({ apiVersion: ATLAS_API_VERSION, items: list.items, next: list.next });
    }
    case 'capture': {
      const scenario = segments[2] ?? '';
      const exchange = segments[3] ?? '';
      // Each segment was decoded exactly once by the target normaliser; nothing else is accepted.
      if (!isScenarioName(scenario) || !EXCHANGE_PATTERN.test(exchange)) {
        return fail(404, 'atlas-resource-not-found', 'No capture with this ID exists');
      }
      const found = context.captures === null ? null : await context.captures.exchange(scenario, exchange);
      if (found === null) return fail(404, 'atlas-resource-not-found', 'No capture with this ID exists');
      return ok({
        apiVersion: ATLAS_API_VERSION,
        ...projectCaptureDetail(scenario, found.entry, found.files),
        // The files in the active snapshot promoted from this capture.
        promotedTo: atlas.promotedTo(`${scenario}/${exchange}`),
      });
    }
    case 'promotions': {
      if (method === 'POST') {
        const answer = await context.promotions.promote(headers, request.body ?? null, request.signal);
        return promotionAnswer(answer, atlas.health().snapshotVersion, ok, fail);
      }
      const query = promotionListQuery(request.query);
      if (typeof query === 'string') return fail(400, 'atlas-invalid-request', `Invalid Atlas request: ${query}`);
      const list = atlas.promotions();
      if (query.at !== undefined && query.at !== list.snapshotVersion) {
        return fail(409, 'atlas-snapshot-stale', 'The fixture snapshot changed; reload the list');
      }
      const items = filterPromotions(list.items, query);
      return ok({
        apiVersion: ATLAS_API_VERSION,
        at: list.snapshotVersion,
        items: items.map((item) => ({
          ...item,
          ...(item.fixtureId === undefined
            ? {}
            : { detailHref: detailHref('fixtures', item.fixtureId, list.snapshotVersion) }),
        })),
        pending: items.filter((item) => item.review === 'pending').length,
      });
    }
    case 'promotions-review':
      return promotionAnswer(
        await context.promotions.review(headers, request.body ?? null),
        atlas.health().snapshotVersion,
        ok,
        fail,
      );
    case 'events':
      // Only HEAD reaches here: GET is streamed by the transport.
      return {
        status: 200,
        headers: { 'content-type': EVENT_STREAM_CONTENT_TYPE, 'cache-control': 'no-store' },
        body: null,
        path,
      };
    case 'endpoint':
    case 'fixture': {
      const at = request.query.filter(([name]) => name === 'at').map(([, value]) => value);
      if (at.length !== 1 || !SNAPSHOT_VERSION.test(at[0] ?? '')) {
        return fail(400, 'atlas-invalid-request', 'Invalid Atlas request: "at" must be exactly one snapshot version');
      }
      const id = segments[2] ?? '';
      const version = at[0] ?? '';
      if (route === 'endpoint') {
        const lookup = atlas.endpoint(id, version);
        return lookup.kind === 'found' ? ok(endpointDocument(lookup.value)) : miss(lookup, route, fail);
      }
      const view = renderInput(request.query);
      if (view.kind === 'invalid') return fail(400, 'atlas-invalid-request', `Invalid Atlas request: ${view.message}`);
      if (view.kind === 'rendered') {
        const rendered = atlas.renderedFixture(id, version, view.input);
        if (rendered.kind === 'bad-input') {
          return fail(400, 'atlas-invalid-request', `Invalid Atlas request: ${rendered.message}`);
        }
        return rendered.kind === 'found' ? ok(renderedDocument(rendered.value)) : miss(rendered, route, fail);
      }
      const lookup = atlas.fixture(id, version);
      return lookup.kind === 'found' ? ok(fixtureDocument(lookup.value)) : miss(lookup, route, fail);
    }
  }
}

export const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream';

/** `POST /_janus/resolve`: decode the envelope, simulate, and explain. */
async function resolveRoute(
  context: AtlasContext,
  request: AtlasRequest,
  ok: (document: unknown) => AtlasResponse,
  fail: (status: number, code: RequestErrorCode, message: string) => AtlasResponse,
): Promise<AtlasResponse> {
  const { maxBodyBytes } = context.resolve;
  if (!isJsonContentType(request.headers?.['content-type'])) {
    return fail(415, 'unsupported-media-type', 'The resolve envelope must be sent as application/json');
  }
  const bytes = request.body ?? new Uint8Array();
  if (bytes.length > envelopeLimit(maxBodyBytes)) {
    return fail(413, 'request-too-large', 'The resolve envelope exceeds the configured limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail(400, 'atlas-invalid-request', 'Invalid Atlas request: the envelope is not valid UTF-8 JSON');
  }
  const decoded = decodeResolveEnvelope(parsed, { maxBodyBytes });
  if (!decoded.ok) {
    return decoded.kind === 'too-large'
      ? fail(413, 'request-too-large', decoded.message)
      : fail(400, 'atlas-invalid-request', `Invalid Atlas request: ${decoded.message}`);
  }
  const explanation = await context.atlas.explain(
    decoded.request,
    request.signal === undefined ? {} : { signal: request.signal },
  );
  return ok(explanationDocument(explanation));
}

/** `?scenario`, `?outcome`, `?limit` and `?before` of `GET /_janus/captures`, or why they are invalid. */
function captureListQuery(query: readonly (readonly [string, string])[]): CaptureListQuery | string {
  const seen = new Map<string, string>();
  for (const [name, value] of query) {
    if (!['scenario', 'outcome', 'limit', 'before', 'source'].includes(name)) return `unknown parameter "${name}"`;
    if (seen.has(name)) return `"${name}" may appear only once`;
    seen.set(name, value);
  }
  const scenario = seen.get('scenario');
  if (scenario !== undefined && !isScenarioName(scenario)) return '"scenario" must be one scenario name';
  const outcome = seen.get('outcome');
  if (outcome !== undefined && !CAPTURE_LIST_OUTCOMES.includes(outcome as CaptureOutcome)) {
    return `"outcome" must be one of ${CAPTURE_LIST_OUTCOMES.join(', ')}`;
  }
  const source = seen.get('source');
  if (source !== undefined && source !== 'recording' && source !== 'runner')
    return '"source" must be recording or runner';
  const limitText = seen.get('limit');
  const limit =
    limitText === undefined ? CAPTURE_LIST_LIMIT.default : /^[0-9]{1,3}$/.test(limitText) ? Number(limitText) : NaN;
  if (!(limit >= CAPTURE_LIST_LIMIT.min && limit <= CAPTURE_LIST_LIMIT.max)) {
    return `"limit" must be an integer from ${String(CAPTURE_LIST_LIMIT.min)} to ${String(CAPTURE_LIST_LIMIT.max)}`;
  }
  const beforeText = seen.get('before');
  const before = beforeText === undefined ? undefined : parseCaptureCursor(beforeText);
  if (before === null) return '"before" must be a capture ID from "next"';
  return {
    limit,
    ...(scenario === undefined ? {} : { scenario }),
    ...(outcome === undefined ? {} : { outcome: outcome as NonNullable<CaptureListQuery['outcome']> }),
    ...(before === undefined ? {} : { before }),
    ...(source === undefined ? {} : { source }),
  };
}

/** A promotion or review answer as an Atlas response. */
function promotionAnswer(
  answer: PromotionAnswer,
  snapshotVersion: string,
  ok: (document: unknown, status?: number) => AtlasResponse,
  fail: (
    status: number,
    code: RequestErrorCode,
    message: string,
    extra?: Record<string, string>,
    details?: Readonly<Record<string, unknown>>,
  ) => AtlasResponse,
): AtlasResponse {
  if (!answer.ok) return fail(answer.status, answer.code, answer.message, {}, answer.details);
  const document = answer.document;
  const reload = document['reload'] as AtlasReloadResult | undefined;
  // A dry run's conflicting response files link to their detail, where the content and its digest are shown.
  const conflicts = document['conflicts'] as readonly { readonly fixtureId?: string }[] | undefined;
  return ok(
    {
      apiVersion: ATLAS_API_VERSION,
      ...document,
      ...(reload === undefined ? {} : { reload: reloadDocument(reload) }),
      ...(conflicts === undefined
        ? {}
        : {
            conflicts: conflicts.map((conflict) => ({
              ...conflict,
              ...(conflict.fixtureId === undefined
                ? {}
                : { detailHref: detailHref('fixtures', conflict.fixtureId, snapshotVersion) }),
            })),
          }),
    },
    answer.status,
  );
}

/** `?review`, `?scenario` and `?at` of `GET /_janus/promotions`, or why they are invalid. */
function promotionListQuery(
  query: readonly (readonly [string, string])[],
): { review?: 'pending' | 'reviewed'; scenario?: string; at?: string } | string {
  const seen = new Map<string, string>();
  for (const [name, value] of query) {
    if (!['review', 'scenario', 'at'].includes(name)) return `unknown parameter "${name}"`;
    if (seen.has(name)) return `"${name}" may appear only once`;
    seen.set(name, value);
  }
  const review = seen.get('review');
  if (review !== undefined && review !== 'pending' && review !== 'reviewed') {
    return '"review" must be pending or reviewed';
  }
  const scenario = seen.get('scenario');
  if (scenario !== undefined && !isScenarioName(scenario)) return '"scenario" must be one scenario name';
  const at = seen.get('at');
  if (at !== undefined && !SNAPSHOT_VERSION.test(at)) return '"at" must be a snapshot version';
  return {
    ...(review === undefined ? {} : { review }),
    ...(scenario === undefined ? {} : { scenario }),
    ...(at === undefined ? {} : { at }),
  };
}

/** The decoded body may be `maxBodyBytes`; the envelope gets twice that (base64 and escapes) plus framing. */
export function envelopeLimit(maxBodyBytes: number): number {
  return 2 * maxBodyBytes + ENVELOPE_OVERHEAD_BYTES;
}

/** `application/json`, any case, optionally with parameters such as `charset=utf-8`. */
function isJsonContentType(values: readonly string[] | undefined): boolean {
  if (values?.length !== 1) return false;
  const essence = (values[0] ?? '').split(';')[0]?.trim().toLowerCase();
  return essence === 'application/json';
}

/** An explanation as `POST /_janus/resolve` answers it; the request runner reports its steps' decisions the same way. */
export function explanationDocument(explanation: AtlasExplanation): unknown {
  const { fixture } = explanation;
  return {
    apiVersion: ATLAS_API_VERSION,
    snapshotVersion: explanation.snapshotVersion,
    response: explanation.response,
    trace: explanation.trace,
    fixture:
      fixture === null
        ? null
        : {
            endpointId: fixture.endpointId,
            fixtureId: fixture.fixtureId,
            detailHref: detailHref('fixtures', fixture.fixtureId, explanation.snapshotVersion),
          },
    shadowed: explanation.shadowed.map((entry) => ({
      ...entry,
      detailHref: detailHref('fixtures', entry.fixtureId, explanation.snapshotVersion),
    })),
    notes: explanation.notes,
  };
}

function reloadDocument(result: AtlasReloadResult): unknown {
  return {
    apiVersion: ATLAS_API_VERSION,
    outcome: result.outcome,
    triggers: result.triggers,
    finishedAt: result.finishedAt,
    activeSnapshotVersion: result.activeSnapshotVersion,
    candidateSnapshotVersion: result.candidateSnapshotVersion,
    errors: result.errors,
    warnings: result.warnings,
  };
}

/** One server-sent event. */
export function formatEvent(
  event:
    | AtlasSnapshotEvent
    | ({ readonly type: 'capture' } & AtlasCaptureEvent)
    | ({ readonly type: 'promotion' } & PromotionEvent)
    | AtlasRunnerEvent,
): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The block every stream opens with: the reconnect hint, then the authoritative state. */
export function formatOpening(state: AtlasSnapshotState, retryMs: number): string {
  return `retry: ${String(retryMs)}\nevent: state\ndata: ${JSON.stringify(state)}\n\n`;
}

const encoder = new TextEncoder();

function miss(
  lookup: Exclude<AtlasLookup<unknown>, { kind: 'found' }>,
  route: 'endpoint' | 'fixture',
  fail: (status: number, code: RequestErrorCode, message: string) => AtlasResponse,
): AtlasResponse {
  switch (lookup.kind) {
    case 'invalid':
      return fail(400, 'atlas-invalid-request', `Invalid Atlas request: malformed ${route} ID`);
    case 'stale':
      return fail(409, 'atlas-snapshot-stale', 'The fixture snapshot changed; reload the inventory');
    case 'not-found':
      return fail(404, 'atlas-resource-not-found', `No ${route} with this ID exists in the current snapshot`);
  }
}

/** Relative to the Atlas root (`/_janus/`), never to the containing document. */
function detailHref(resource: 'endpoints' | 'fixtures', id: string, snapshotVersion: string): string {
  return `${resource}/${id}?at=${snapshotVersion}`;
}

function endpointDocument(endpoint: AtlasEndpoint): unknown {
  const linked = (fixture: AtlasFixtureSummary): Record<string, unknown> => ({
    ...fixtureSummary(fixture),
    detailHref: detailHref('fixtures', fixture.id, endpoint.snapshotVersion),
  });
  return {
    apiVersion: ATLAS_API_VERSION,
    snapshotVersion: endpoint.snapshotVersion,
    id: endpoint.id,
    scenario: endpoint.scenario,
    method: endpoint.method,
    path: endpoint.path,
    pathParameters: endpoint.pathParameters,
    origin: endpoint.origin,
    fixtures: endpoint.fixtures.map(linked),
    representationGroups: endpoint.representationGroups.map((group) => ({
      status: group.status,
      variant: group.variant,
      locale: group.locale,
      representations: group.representations.map(linked),
    })),
    accepts: endpoint.accepts,
    matrix: matrixDocument(endpoint.matrix, endpoint.snapshotVersion),
    controls: endpoint.controls,
    ...(endpoint.faults === undefined ? {} : { faults: endpoint.faults }),
  };
}

function matrixDocument(matrix: AtlasMatrix, snapshotVersion: string): unknown {
  return {
    identities: matrix.identities,
    rows: matrix.rows.map((row) => ({
      scenario: row.scenario,
      endpointId: row.endpointId,
      detailHref: detailHref('endpoints', row.endpointId, snapshotVersion),
      ...(row.fault === undefined ? {} : { fault: row.fault }),
      cells: row.cells.map((cell) =>
        cell === null
          ? null
          : {
              representations: cell.representations.map((representation) => ({
                ...representation,
                detailHref: detailHref('fixtures', representation.fixtureId, snapshotVersion),
              })),
            },
      ),
    })),
  };
}

function scenariosDocument(scenarios: AtlasScenarios): unknown {
  return {
    apiVersion: ATLAS_API_VERSION,
    snapshotVersion: scenarios.snapshotVersion,
    configuredDefault: scenarios.configuredDefault,
    items: scenarios.items.map((item) => ({
      ...item,
      endpointsHref: `endpoints?scenario=${item.name}&at=${scenarios.snapshotVersion}`,
    })),
  };
}

function sessionWriteRecord(
  requestId: string,
  method: SessionWriteRecord['method'],
  answer: SessionAnswer,
  route: SessionWriteRecord['route'] = '/_janus/session',
): SessionWriteRecord {
  const done =
    route === '/_janus/sequences' ? 'reset' : { POST: 'created', PATCH: 'updated', DELETE: 'deleted' }[method];
  const outcome = answer.ok ? done : answer.code;
  return {
    requestId,
    route,
    method,
    source: answer.key?.source ?? null,
    id: answer.key?.id ?? null,
    status: answer.status,
    outcome,
  };
}

function fixtureDocument(fixture: AtlasFixture): unknown {
  return {
    apiVersion: ATLAS_API_VERSION,
    snapshotVersion: fixture.snapshotVersion,
    ...fixtureSummary(fixture),
    endpointId: fixture.endpointId,
    method: fixture.method,
    path: fixture.path,
    pathParameters: fixture.pathParameters,
    preview: fixture.preview,
    dynamic: fixture.dynamic,
    tokens: fixture.tokens,
  };
}

function renderedDocument(fixture: AtlasRenderedFixture): unknown {
  return { ...(fixtureDocument(fixture) as Record<string, unknown>), rendered: fixture.rendered };
}

type View =
  | { readonly kind: 'raw' }
  | { readonly kind: 'rendered'; readonly input: { now?: string; params: Record<string, string> } }
  | { readonly kind: 'invalid'; readonly message: string };

/**
 * `view=rendered` with optional `now` and `param.<name>`.
 * Each may appear once; `now` and parameters need `view=rendered`.
 */
function renderInput(query: readonly (readonly [string, string])[]): View {
  const seen = new Set<string>();
  let view: string | undefined;
  let now: string | undefined;
  const params: Record<string, string> = {};
  for (const [name, value] of query) {
    if (name === 'at') continue;
    if (seen.has(name)) return { kind: 'invalid', message: `"${name}" may appear only once` };
    seen.add(name);
    if (name === 'view') view = value;
    else if (name === 'now') now = value;
    else if (name.startsWith('param.') && name.length > 6) params[name.slice(6)] = value;
  }
  if (view === undefined) {
    return seen.size === 0
      ? { kind: 'raw' }
      : { kind: 'invalid', message: '"now" and "param.<name>" need view=rendered' };
  }
  if (view !== 'rendered') return { kind: 'invalid', message: `"view" must be "rendered", got "${view}"` };
  return { kind: 'rendered', input: { ...(now === undefined ? {} : { now }), params } };
}

function fixtureSummary(fixture: AtlasFixtureSummary): Record<string, unknown> {
  return {
    id: fixture.id,
    status: fixture.status,
    variant: fixture.variant,
    identity: fixture.identity,
    mediaType: fixture.mediaType,
    wireContentType: fixture.wireContentType,
    locale: fixture.locale,
    byteLength: fixture.byteLength,
    headers: fixture.headers,
    scenario: fixture.scenario,
    origin: fixture.origin,
    digest: fixture.digest,
    provenance: fixture.provenance,
    ...(fixture.review === undefined ? {} : { review: fixture.review }),
    sidecar: fixture.sidecar,
  };
}
