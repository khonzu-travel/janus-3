import type { AtlasConfig } from '../config.js';
import { DecodeError, object, string, type Decoder } from './decode.js';
import {
  checkApiVersion,
  decodeCaptureDetail,
  decodeCaptureList,
  decodeClock,
  decodeEndpoint,
  decodeErrorEnvelope,
  decodeFixture,
  decodeConfig,
  decodeHealth,
  decodeInventory,
  decodeExplanation,
  decodePromotionErrorDetails,
  decodePromotionList,
  decodePromotionResult,
  decodeRecording,
  decodeReloadResult,
  decodeRenderedFixture,
  decodeScenarios,
  IncompatibleVersionError,
  type CaptureOutcome,
  type CaptureSource,
  type PromotionErrorDetails,
  type ReviewState,
  type WirePromotionList,
  type WirePromotionResult,
  type WireCaptureDetail,
  type WireCaptureItem,
  type WireClock,
  type WireConfig,
  type WireEndpoint,
  type WireEndpointItem,
  type WireFixture,
  type WireFixtureItem,
  type WireHealth,
  type WireExplanation,
  type WireMatrix,
  type WireMatrixRepresentation,
  type WireMatrixRow,
  type WireRecording,
  type WireReloadResult,
  type WireRenderedFixture,
  type WireScenario,
  type WireScenarios,
} from './wire.js';
import {
  currentOf,
  decodeEnvironmentDetail,
  decodeFolderDetail,
  decodeImportResult,
  decodeRequestDetail,
  decodeRequestTree,
  decodeRunList,
  decodeRunRecord,
  decodeRunStarted,
  decodeWritten,
  problemsOf,
  runnerPath,
  type CurrentFile,
  type EnvironmentDetail,
  type EnvironmentDocument,
  type FolderDetail,
  type FolderDocument,
  type ImportRequest,
  type ImportResult,
  type RequestDetail,
  type RequestDocument,
  type RequestTree,
  type RunnerProblem,
  type RunRecord,
  type RunRequest,
  type RunSummary,
  type Written,
} from './runner.js';

/** A capture ID: a scenario name and a six-digit exchange number. */
const CAPTURE_ID = /^[a-z0-9]+(-[a-z0-9]+)*\/[0-9]{6}$/;

/** Default bound on any single Atlas request, connection and body included. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export type AtlasErrorKind =
  /** The request never got an HTTP response (refused, DNS, offline, CORS). */
  | 'network'
  | 'timeout'
  /** A non-2xx response that is not one of the classified Atlas errors below. */
  | 'http'
  /** `409 atlas-snapshot-stale`, or documents from two snapshots. */
  | 'stale'
  /** `404 atlas-resource-not-found`, or an ID absent from the current inventory. */
  | 'not-found'
  /** A 2xx response that is not the documented JSON, or a link outside the Atlas root. */
  | 'decode'
  | 'incompatible'
  /** Health answered, but not with `status: "ready"`. */
  | 'not-ready'
  /** `403 atlas-origin-forbidden`: Janus refuses state changes from this page's origin. */
  | 'origin-forbidden';

/** A classified, display-safe failure. It never carries an unverified response body. */
export class AtlasError extends Error {
  constructor(
    readonly kind: AtlasErrorKind,
    message: string,
    readonly details: {
      readonly url?: string;
      readonly status?: number;
      /** `error.code` from a response that passed the envelope decoder. */
      readonly code?: string;
      /** A promotion error's decoded details: the field, conflicts, problems and hint it names. */
      readonly promotion?: PromotionErrorDetails;
      /** A runner write's `422` problems. */
      readonly problems?: readonly RunnerProblem[];
      /** A runner write's `412 request-changed`: the file now, or null when it is gone. */
      readonly current?: CurrentFile | null;
    } = {},
  ) {
    super(message);
    this.name = 'AtlasError';
  }
}

export interface Health extends WireHealth {
  readonly status: 'ready';
}

export interface EndpointItem extends Omit<WireEndpointItem, 'detailHref'> {
  /** Absolute URL, already checked to lie inside the Atlas root. */
  readonly detailUrl: string;
}

export interface Inventory {
  readonly snapshotVersion: string;
  /** The scenario listed. */
  readonly scenario: string;
  readonly items: readonly EndpointItem[];
}

export interface Scenario extends Omit<WireScenario, 'endpointsHref'> {
  /** The scenario's inventory, checked to lie inside the Atlas root. */
  readonly endpointsUrl: string;
}

/** The answer to `POST /_janus/scenarios`: the scenario created and the one it extends. */
export interface CreatedScenario {
  readonly name: string;
  readonly extends: string;
}

const decodeCreatedScenario: Decoder<CreatedScenario> = object({ name: string, extends: string });

export interface Scenarios extends Omit<WireScenarios, 'items'> {
  readonly items: readonly Scenario[];
}

export interface MatrixRepresentation extends Omit<WireMatrixRepresentation, 'detailHref'> {
  readonly detailUrl: string;
}

export interface MatrixRow extends Omit<WireMatrixRow, 'detailHref' | 'cells'> {
  readonly detailUrl: string;
  readonly cells: readonly ({ readonly representations: readonly MatrixRepresentation[] } | null)[];
}

export interface Matrix extends Omit<WireMatrix, 'rows'> {
  readonly rows: readonly MatrixRow[];
}

export interface FixtureItem extends Omit<WireFixtureItem, 'detailHref'> {
  readonly detailUrl: string;
}

export interface RepresentationGroup {
  readonly status: number;
  /** Null for plain responses. */
  readonly variant: string | null;
  readonly locale: string | null;
  readonly representations: readonly FixtureItem[];
}

export interface Endpoint extends Omit<WireEndpoint, 'fixtures' | 'representationGroups' | 'matrix'> {
  readonly fixtures: readonly FixtureItem[];
  /** Always present: grouped by the client when the server does not report groups. */
  readonly representationGroups: readonly RepresentationGroup[];
  /** Null from an older server. */
  readonly matrix: Matrix | null;
}

export type Fixture = WireFixture;

export type RenderedFixture = WireRenderedFixture;

export type Clock = WireClock;

/** Inputs for a rendered preview: an RFC 3339 instant and path parameter values. */
export interface RenderInput {
  readonly now?: string;
  readonly params: Readonly<Record<string, string>>;
}

export type EffectiveConfig = WireConfig;

/** A request to simulate: the wire envelope of `POST /_janus/resolve`. */
export interface ResolveEnvelope {
  readonly method: string;
  readonly target: string;
  readonly headers?: Readonly<Record<string, readonly string[]>>;
  readonly body?: { readonly encoding: 'utf8' | 'base64'; readonly data: string };
  /** RFC 3339 instant. */
  readonly nowMs?: string;
  /** The scenario to simulate in, ahead of every other source. */
  readonly scenario?: string;
}

export interface Explanation extends Omit<WireExplanation, 'fixture' | 'shadowed'> {
  /** The fixture that answered, with its detail link checked to lie inside the Atlas root. */
  readonly fixture: { readonly endpointId: string; readonly fixtureId: string; readonly detailUrl: string } | null;
  /** The endpoint holding each hidden file in `trace.shadowed`. */
  readonly shadowed: readonly { readonly endpointId: string; readonly fixtureId: string; readonly detailUrl: string }[];
}

export type ReloadResult = WireReloadResult;

export type Recording = WireRecording;

/** A capture list item; a captured one carries its detail link, checked to lie inside the Atlas root. */
export type CaptureItem =
  | (Omit<Extract<WireCaptureItem, { id: string }>, 'detailHref'> & { readonly detailUrl: string | null })
  | Extract<WireCaptureItem, { outcome: 'unreadable' }>;

export interface CaptureList {
  readonly items: readonly CaptureItem[];
  readonly next: string | null;
}

/** Filters and paging for `GET /_janus/captures`. */
export interface CaptureQuery {
  readonly scenario: string | null;
  readonly outcome: CaptureOutcome | 'unreadable' | null;
  readonly before: string | null;
  /** Who sent it; null or absent for both. */
  readonly source?: CaptureSource | null;
}

export type CaptureDetail = WireCaptureDetail;

export interface DiagnosticEntry {
  readonly kind: AtlasErrorKind;
  /** Origin and path only: credentials, query, and fragment are removed. */
  readonly url: string;
  readonly status?: number;
  readonly code?: string;
}

export interface AtlasClientOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Receives one safe entry per failed request. */
  readonly onDiagnostic?: (entry: DiagnosticEntry) => void;
}

export interface AtlasClient {
  readonly atlasRoot: URL;
  health(signal?: AbortSignal): Promise<Health>;
  /** `GET /_janus/config`. An older server answers `404 route-not-found`, classified as `http`. */
  config(signal?: AbortSignal): Promise<EffectiveConfig>;
  /** One scenario's endpoints; the configured default when `scenario` is null. */
  inventory(scenario: string | null, signal?: AbortSignal): Promise<Inventory>;
  /** `GET /_janus/scenarios`. */
  scenarios(signal?: AbortSignal): Promise<Scenarios>;
  /** `POST /_janus/scenarios`: creates an empty scenario `name` that extends `extendsName`; the server answers `201`. */
  createScenario(name: string, extendsName: string, signal?: AbortSignal): Promise<CreatedScenario>;
  endpoint(item: EndpointItem, signal?: AbortSignal): Promise<Endpoint>;
  fixture(item: FixtureItem, signal?: AbortSignal): Promise<Fixture>;
  /** The fixture rendered with `view=rendered`, from the server-issued fixture link. */
  renderedFixture(item: FixtureItem, input: RenderInput, signal?: AbortSignal): Promise<RenderedFixture>;
  /** `GET /_janus/clock`. An older server answers `404 route-not-found`, classified as `http`. */
  clock(signal?: AbortSignal): Promise<Clock>;
  /** `POST /_janus/resolve`: what Janus would answer, and why. Nothing is served. */
  resolve(envelope: ResolveEnvelope, signal?: AbortSignal): Promise<Explanation>;
  /** `GET /_janus/reload`: the most recent reload result. */
  reloadResult(signal?: AbortSignal): Promise<ReloadResult>;
  /** `GET /_janus/recording`: the registrations and limits. */
  recording(signal?: AbortSignal): Promise<Recording>;
  /** `GET /_janus/captures`: recorded exchanges, newest first. Read from disk, never snapshot-bound. */
  captures(query: CaptureQuery, signal?: AbortSignal): Promise<CaptureList>;
  /** The detail link of capture `scenario/exchange`, for a view opened from its own address; null for a malformed ID. */
  captureUrl(id: string): string | null;
  /** One capture, from the list's server-issued link. */
  capture(detailUrl: string, signal?: AbortSignal): Promise<CaptureDetail>;
  /** `GET /_janus/promotions`: promoted files, newest first. */
  promotions(query: PromotionQuery, signal?: AbortSignal): Promise<PromotionList>;
  /** `POST /_janus/promotions`: a dry run with `dryRun: true`, otherwise a write. */
  promote(request: PromotionRequest, signal?: AbortSignal): Promise<PromotionResult>;
  /** A conflicting file's fixture, from the dry run's link, to show its content and digest. */
  conflictFixture(detailUrl: string, signal?: AbortSignal): Promise<Fixture>;
  /** `POST /_janus/promotions/review`: marks files reviewed, each with the digest the user saw. */
  review(request: ReviewRequest, signal?: AbortSignal): Promise<void>;
  /** `GET /_janus/events`, for an `EventSource`. */
  readonly eventsUrl: URL;
  /** The request runner; every route answers `404` unless `capabilities.runner.available`. */
  readonly runner: RunnerClient;
}

/**
 * How a runner write states what it expects on disk: the
 * digest it read, or that nothing exists yet.
 */
export type Expect = { readonly digest: string } | 'absent';

export interface RunnerClient {
  tree(signal?: AbortSignal): Promise<RequestTree>;
  request(id: string, signal?: AbortSignal): Promise<RequestDetail>;
  saveRequest(id: string, document: RequestDocument, expect: Expect, signal?: AbortSignal): Promise<Written>;
  deleteRequest(id: string, digest: string, signal?: AbortSignal): Promise<void>;
  folder(id: string, signal?: AbortSignal): Promise<FolderDetail>;
  saveFolder(id: string, document: FolderDocument, expect: Expect, signal?: AbortSignal): Promise<Written>;
  /** `digest` is null for a folder with no `folder.yaml`. */
  deleteFolder(id: string, digest: string | null, signal?: AbortSignal): Promise<void>;
  /** Environments are shared by every collection. */
  environment(name: string, signal?: AbortSignal): Promise<EnvironmentDetail>;
  saveEnvironment(
    name: string,
    body: { readonly document: EnvironmentDocument; readonly local: EnvironmentDocument | null },
    expect: Expect,
    signal?: AbortSignal,
  ): Promise<Written>;
  deleteEnvironment(name: string, digest: string, signal?: AbortSignal): Promise<void>;
  importFiles(request: ImportRequest, signal?: AbortSignal): Promise<ImportResult>;
  startRun(request: RunRequest, signal?: AbortSignal): Promise<string>;
  runs(signal?: AbortSignal): Promise<readonly RunSummary[]>;
  run(id: string, signal?: AbortSignal): Promise<RunRecord>;
  cancelRun(id: string, signal?: AbortSignal): Promise<void>;
}

export interface PromotionQuery {
  readonly review: ReviewState | null;
  readonly scenario: string | null;
}

export type PromotionList = WirePromotionList;
export type PromotionResult = WirePromotionResult;

/** The body of `POST /_janus/promotions`. */
export interface PromotionRequest {
  readonly capture: string;
  readonly scenario?: string;
  readonly path?: string;
  readonly variant?: string;
  readonly ids?: Readonly<Record<string, string>>;
  readonly replace?: readonly { readonly file: string; readonly digest?: string }[];
  /** The response body as edited before promoting, in place of the captured one. */
  readonly body?: string;
  /** The response headers as edited before promoting, in place of the captured ones. */
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  readonly dryRun?: boolean;
}

/** The body of `POST /_janus/promotions/review`. */
export interface ReviewRequest {
  readonly scenario: string;
  readonly files: readonly { readonly file: string; readonly digest: string }[];
}

/**
 * The UI's only door to Janus. It requests URLs inside the configured Atlas
 * root, decodes every payload, and follows server-issued links rather than
 * building resource URLs itself.
 */
export function createAtlasClient(config: AtlasConfig, options: AtlasClientOptions = {}): AtlasClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const root = config.atlasRoot;

  const report = (error: AtlasError): AtlasError => {
    options.onDiagnostic?.({
      kind: error.kind,
      url: error.details.url ?? safeUrl(root),
      ...(error.details.status === undefined ? {} : { status: error.details.status }),
      ...(error.details.code === undefined ? {} : { code: error.details.code }),
    });
    return error;
  };

  const resolveLink = (href: string): string => {
    let url: URL;
    try {
      url = new URL(href, root);
    } catch {
      throw new DecodeError('detailHref', 'a link');
    }
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || url.hash !== '') {
      throw new DecodeError('detailHref', 'a link inside the Atlas root');
    }
    return url.href;
  };

  /** An explanation with its fixture links checked to lie inside the Atlas root and name its snapshot. */
  const linkExplanation = (explanation: WireExplanation): Explanation => {
    const linked = (href: string): string => {
      const detailUrl = resolveLink(href);
      assertSnapshotLink(detailUrl, explanation.snapshotVersion);
      return detailUrl;
    };
    const { fixture } = explanation;
    return {
      ...explanation,
      fixture:
        fixture === null
          ? null
          : { endpointId: fixture.endpointId, fixtureId: fixture.fixtureId, detailUrl: linked(fixture.detailHref) },
      shadowed: explanation.shadowed.map((entry) => ({
        endpointId: entry.endpointId,
        fixtureId: entry.fixtureId,
        detailUrl: linked(entry.detailHref),
      })),
    };
  };

  async function get<T>(
    url: URL,
    decode: Decoder<T>,
    signal: AbortSignal | undefined,
    post?: { readonly json: unknown },
  ): Promise<T> {
    return (await send(url, decode, signal, post === undefined ? {} : { method: 'POST', json: post.json })).value;
  }

  /** Any Atlas request: a JSON body when `json` is set, extra headers, and the status of the answer. */
  async function send<T>(
    url: URL,
    decode: Decoder<T>,
    signal: AbortSignal | undefined,
    init: { readonly method?: string; readonly json?: unknown; readonly headers?: Readonly<Record<string, string>> },
  ): Promise<{ readonly value: T; readonly status: number }> {
    const method = init.method ?? 'GET';
    const hasBody = 'json' in init;
    const where = safeUrl(url);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const cancel = (): void => {
      controller.abort();
    };
    signal?.addEventListener('abort', cancel);
    if (signal?.aborted === true) controller.abort();

    const failed = (cause: unknown): never => {
      if (signal?.aborted === true) throw signal.reason;
      if (timedOut) {
        throw report(new AtlasError('timeout', `No response within ${String(timeoutMs / 1000)} s`, { url: where }));
      }
      if (cause instanceof AtlasError) throw report(cause);
      throw report(new AtlasError('network', 'Could not reach the server', { url: where }));
    };

    try {
      let response: Response;
      let text: string;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            accept: 'application/json',
            ...(hasBody ? { 'content-type': 'application/json' } : {}),
            ...init.headers,
          },
          ...(hasBody ? { body: JSON.stringify(init.json) } : {}),
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        text = await response.text();
      } catch (cause) {
        return failed(cause);
      }
      if (signal?.aborted === true) throw signal.reason;

      const parsed = parseJson(text);
      if (!response.ok) return failed(httpError(response.status, parsed, where));
      try {
        // `204 No Content` (a runner delete) has no document to check.
        if (response.status === 204) return { value: decode(null, ''), status: 204 };
        if (parsed === undefined) throw new DecodeError('', 'JSON');
        checkApiVersion(parsed);
        return { value: decode(parsed, ''), status: response.status };
      } catch (cause) {
        if (cause instanceof IncompatibleVersionError) {
          return failed(
            new AtlasError(
              'incompatible',
              cause.apiVersion === null
                ? `The server does not speak the Atlas API (this UI needs atlas.v1)`
                : `The server speaks ${cause.apiVersion}; this UI needs atlas.v1`,
              { url: where, status: response.status },
            ),
          );
        }
        if (cause instanceof DecodeError) {
          return failed(
            new AtlasError('decode', `The server sent an unexpected response (${cause.message})`, {
              url: where,
              status: response.status,
            }),
          );
        }
        if (cause instanceof AtlasError) return failed(cause);
        throw cause;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  return {
    atlasRoot: root,
    async health(signal) {
      const health = await get(new URL('health', root), decodeHealth, signal);
      if (health.status !== 'ready') {
        throw report(
          new AtlasError('not-ready', `The server reported status "${health.status}"`, { url: safeUrl(root) }),
        );
      }
      return { ...health, status: 'ready' };
    },
    async config(signal) {
      return get(new URL('config', root), decodeConfig, signal);
    },
    async inventory(scenario, signal) {
      const url = new URL('endpoints', root);
      if (scenario !== null) url.searchParams.set('scenario', scenario);
      return get(
        url,
        (value, path) => {
          const inventory = decodeInventory(value, path);
          if (scenario !== null && inventory.scenario !== scenario) {
            throw new DecodeError('scenario', `the scenario ${scenario}`);
          }
          return {
            snapshotVersion: inventory.snapshotVersion,
            scenario: inventory.scenario,
            items: inventory.items.map(({ detailHref, ...item }) => {
              const detailUrl = resolveLink(detailHref);
              assertSnapshotLink(detailUrl, inventory.snapshotVersion);
              return { ...item, detailUrl };
            }),
          };
        },
        signal,
      );
    },
    async scenarios(signal) {
      return get(
        new URL('scenarios', root),
        (value, path) => {
          const scenarios = decodeScenarios(value, path);
          return {
            ...scenarios,
            items: scenarios.items.map(({ endpointsHref, ...item }) => {
              const endpointsUrl = resolveLink(endpointsHref);
              assertSnapshotLink(endpointsUrl, scenarios.snapshotVersion);
              return { ...item, endpointsUrl };
            }),
          };
        },
        signal,
      );
    },
    async createScenario(name, extendsName, signal) {
      return get(new URL('scenarios', root), decodeCreatedScenario, signal, { json: { name, extends: extendsName } });
    },
    async endpoint(item, signal) {
      return get(
        new URL(item.detailUrl),
        (value, path) => {
          const endpoint = decodeEndpoint(value, path);
          assertSnapshotDocument(endpoint.snapshotVersion, item.detailUrl);
          if (
            endpoint.id !== item.id ||
            endpoint.scenario !== item.scenario ||
            endpoint.method !== item.method ||
            endpoint.path !== item.path
          ) {
            throw new DecodeError('endpoint', 'the endpoint selected from the inventory');
          }
          const fixtures = endpoint.fixtures.map(({ detailHref, ...fixture }) => {
            const detailUrl = resolveLink(detailHref);
            assertSnapshotLink(detailUrl, endpoint.snapshotVersion);
            return { ...fixture, detailUrl };
          });
          const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
          const representationGroups =
            endpoint.representationGroups === null
              ? groupFixtures(fixtures)
              : endpoint.representationGroups.map((group, index) => ({
                  status: group.status,
                  variant: group.variant,
                  locale: group.locale,
                  representations: group.representations.map((representation, position) => {
                    const fixture = byId.get(representation.id);
                    if (fixture === undefined) {
                      throw new DecodeError(
                        `representationGroups[${String(index)}].representations[${String(position)}]`,
                        'a response listed in fixtures',
                      );
                    }
                    return fixture;
                  }),
                }));
          const linked = (href: string): string => {
            const detailUrl = resolveLink(href);
            assertSnapshotLink(detailUrl, endpoint.snapshotVersion);
            return detailUrl;
          };
          const matrix =
            endpoint.matrix === null
              ? null
              : {
                  identities: endpoint.matrix.identities,
                  rows: endpoint.matrix.rows.map(({ detailHref, cells, ...row }) => ({
                    ...row,
                    detailUrl: linked(detailHref),
                    cells: cells.map((cell) =>
                      cell === null
                        ? null
                        : {
                            representations: cell.representations.map(({ detailHref: href, ...entry }) => ({
                              ...entry,
                              detailUrl: linked(href),
                            })),
                          },
                    ),
                  })),
                };
          return { ...endpoint, fixtures, representationGroups, matrix };
        },
        signal,
      );
    },
    async fixture(item, signal) {
      return get(new URL(item.detailUrl), checkedFixture(item, decodeFixture), signal);
    },
    async renderedFixture(item, input, signal) {
      const url = new URL(item.detailUrl);
      url.searchParams.set('view', 'rendered');
      if (input.now !== undefined) url.searchParams.set('now', input.now);
      for (const [name, value] of Object.entries(input.params)) url.searchParams.set(`param.${name}`, value);
      return get(url, checkedFixture(item, decodeRenderedFixture), signal);
    },
    async clock(signal) {
      return get(new URL('clock', root), decodeClock, signal);
    },
    async resolve(envelope, signal) {
      return get(new URL('resolve', root), (value, path) => linkExplanation(decodeExplanation(value, path)), signal, {
        json: envelope,
      });
    },
    async reloadResult(signal) {
      return get(new URL('reload', root), decodeReloadResult, signal);
    },
    async recording(signal) {
      return get(new URL('recording', root), decodeRecording, signal);
    },
    async captures(query, signal) {
      const url = new URL('captures', root);
      if (query.scenario !== null) url.searchParams.set('scenario', query.scenario);
      if (query.outcome !== null) url.searchParams.set('outcome', query.outcome);
      if (query.before !== null) url.searchParams.set('before', query.before);
      if (query.source != null) url.searchParams.set('source', query.source);
      return get(
        url,
        (value, path) => {
          const list = decodeCaptureList(value, path);
          return {
            next: list.next,
            items: list.items.map((item) => {
              if (item.outcome === 'unreadable') return item;
              const { detailHref, ...rest } = item;
              return { ...rest, detailUrl: detailHref === null ? null : resolveLink(detailHref) };
            }),
          };
        },
        signal,
      );
    },
    captureUrl(id) {
      return CAPTURE_ID.test(id) ? new URL(`captures/${id}`, root).href : null;
    },
    async capture(detailUrl, signal) {
      const url = new URL(detailUrl);
      return get(
        url,
        (value, path) => {
          const detail = decodeCaptureDetail(value, path);
          if (!url.pathname.endsWith(`/captures/${detail.id}`)) {
            throw new DecodeError('id', 'the capture selected from the list');
          }
          return detail;
        },
        signal,
      );
    },
    async promotions(query, signal) {
      const url = new URL('promotions', root);
      if (query.review !== null) url.searchParams.set('review', query.review);
      if (query.scenario !== null) url.searchParams.set('scenario', query.scenario);
      return get(url, decodePromotionList, signal);
    },
    async promote(request, signal) {
      return get(
        new URL('promotions', root),
        (value, path) => {
          const result = decodePromotionResult(value, path);
          return {
            ...result,
            conflicts: result.conflicts.map((conflict) => ({
              ...conflict,
              detailHref: conflict.detailHref === null ? null : resolveLink(conflict.detailHref),
            })),
          };
        },
        signal,
        { json: request },
      );
    },
    async conflictFixture(detailUrl, signal) {
      return get(
        new URL(detailUrl),
        (value, path) => {
          const fixture = decodeFixture(value, path);
          assertSnapshotDocument(fixture.snapshotVersion, detailUrl);
          return fixture;
        },
        signal,
      );
    },
    async review(request, signal) {
      await get(new URL('promotions/review', root), () => undefined, signal, { json: request });
    },
    eventsUrl: new URL('events', root),
    runner: runnerClient(),
  };

  function runnerClient(): RunnerClient {
    const precondition = (expect: Expect): Record<string, string> =>
      expect === 'absent' ? { 'if-none-match': '*' } : { 'if-match': expect.digest };
    const write = async (
      path: string,
      json: unknown,
      expect: Expect,
      signal: AbortSignal | undefined,
    ): Promise<Written> => {
      const answer = await send(new URL(path, root), decodeWritten, signal, {
        method: 'PUT',
        json,
        headers: precondition(expect),
      });
      return { ...answer.value, created: answer.status === 201 };
    };
    const remove = async (path: string, digest: string | null, signal: AbortSignal | undefined): Promise<void> => {
      await send(new URL(path, root), () => undefined, signal, {
        method: 'DELETE',
        headers: digest === null ? {} : { 'if-match': digest },
      });
    };
    return {
      tree: (signal) => get(new URL('requests', root), decodeRequestTree, signal),
      request: (id, signal) => get(new URL(runnerPath('requests', id), root), decodeRequestDetail, signal),
      saveRequest: (id, document, expect, signal) => write(runnerPath('requests', id), document, expect, signal),
      deleteRequest: (id, digest, signal) => remove(runnerPath('requests', id), digest, signal),
      folder: (id, signal) => get(new URL(runnerPath('folders', id), root), decodeFolderDetail, signal),
      saveFolder: (id, document, expect, signal) => write(runnerPath('folders', id), document, expect, signal),
      deleteFolder: (id, digest, signal) => remove(runnerPath('folders', id), digest, signal),
      environment: (name, signal) =>
        get(new URL(runnerPath('environments', name), root), decodeEnvironmentDetail, signal),
      saveEnvironment: (name, body, expect, signal) => write(runnerPath('environments', name), body, expect, signal),
      deleteEnvironment: (name, digest, signal) => remove(runnerPath('environments', name), digest, signal),
      importFiles: (request, signal) => get(new URL('imports', root), decodeImportResult, signal, { json: request }),
      startRun: (request, signal) => get(new URL('runs', root), decodeRunStarted, signal, { json: request }),
      runs: (signal) => get(new URL('runs', root), decodeRunList, signal),
      run: (id, signal) =>
        get(new URL(`runs/${encodeURIComponent(id)}`, root), decodeRunRecord(linkExplanation), signal),
      cancelRun: async (id, signal) => {
        await send(new URL(`runs/${encodeURIComponent(id)}`, root), () => undefined, signal, { method: 'DELETE' });
      },
    };
  }
}

/** Decodes a fixture document and checks it is the one the endpoint listed, from the same snapshot. */
function checkedFixture<T extends WireFixture>(item: FixtureItem, decode: Decoder<T>): Decoder<T> {
  return (value, path) => {
    const fixture = decode(value, path);
    assertSnapshotDocument(fixture.snapshotVersion, item.detailUrl);
    if (
      fixture.id !== item.id ||
      fixture.status !== item.status ||
      fixture.identity !== item.identity ||
      fixture.mediaType !== item.mediaType ||
      fixture.locale !== item.locale ||
      fixture.byteLength !== item.byteLength
    ) {
      throw new DecodeError('fixture', 'the response selected from the endpoint');
    }
    return fixture;
  };
}

/** Groups fixtures by status and locale, in first-seen order, for servers that do not report groups. */
function groupFixtures(fixtures: readonly FixtureItem[]): RepresentationGroup[] {
  const groups: { status: number; variant: null; locale: string | null; representations: FixtureItem[] }[] = [];
  for (const fixture of fixtures) {
    const group = groups.find((entry) => entry.status === fixture.status && entry.locale === fixture.locale);
    if (group === undefined) {
      groups.push({ status: fixture.status, variant: null, locale: fixture.locale, representations: [fixture] });
    } else {
      group.representations.push(fixture);
    }
  }
  return groups;
}

/** Snapshot-bound links and documents must agree, even if a proxy returns an incoherent 2xx response. */
function assertSnapshotLink(url: string, snapshotVersion: string): void {
  const values = new URL(url).searchParams.getAll('at');
  if (values.length !== 1 || values[0] !== snapshotVersion) {
    throw new DecodeError('detailHref', `a link for snapshot ${snapshotVersion}`);
  }
}

function assertSnapshotDocument(snapshotVersion: string, detailUrl: string): void {
  const expected = new URL(detailUrl).searchParams.getAll('at');
  if (expected.length !== 1 || expected[0] !== snapshotVersion) {
    throw new AtlasError('stale', 'The fixture snapshot changed', { url: safeUrl(new URL(detailUrl)) });
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function httpError(status: number, body: unknown, url: string): AtlasError {
  let envelope: { code: string; message: string } | null = null;
  try {
    envelope = body === undefined ? null : decodeErrorEnvelope(body, '');
  } catch {
    // Not an Atlas envelope (e.g. a proxy's HTML page): report the status only.
  }
  const code = envelope?.code;
  const promotion = envelope === null ? null : decodePromotionErrorDetails(body);
  const problems = envelope === null ? null : problemsOf(body);
  const current = envelope === null ? undefined : currentOf(body);
  const details = {
    url,
    status,
    ...(code === undefined ? {} : { code }),
    ...(promotion === null ? {} : { promotion }),
    ...(problems === null ? {} : { problems }),
    ...(current === undefined ? {} : { current }),
  };
  if (status === 409 && code === 'atlas-snapshot-stale') {
    return new AtlasError('stale', 'The fixture snapshot changed', details);
  }
  if (status === 403 && code === 'atlas-origin-forbidden') {
    return new AtlasError('origin-forbidden', "This page's origin is not allowed to change this server", details);
  }
  if (status === 404 && code === 'atlas-resource-not-found') {
    return new AtlasError('not-found', 'This resource is not in the current snapshot', details);
  }
  return new AtlasError('http', envelope?.message ?? `The server answered HTTP ${String(status)}`, details);
}

/** Origin and path only, for logs and diagnostics. */
export function safeUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}
