import { toBase64 } from '../bytes.js';
import { compareStrings } from '../canonical.js';
import { PRIVATE_SETTINGS, type EngineConfig, type PublicSetting } from '../config/merge.js';
import { describeCondition } from '../controls/choose.js';
import { chooseInstant, serverInstant, type InstantChoice, type SessionInstant } from '../dynamic/clock.js';
import { renderFixture, type RenderContextValues } from '../dynamic/render.js';
import { parseRfc3339, rfc3339 } from '../dynamic/time.js';
import { DEFAULT_SCENARIO, templateKey } from '../fixtures/build.js';
import type { Fault } from '../fixtures/controls.js';
import { fileDigest } from '../fixtures/provenance.js';
import {
  provenanceOf,
  type RepresentationGroup,
  type RouteNode,
  type SnapshotData,
  type StoredMethod,
  type StoredResponse,
} from '../fixtures/snapshot.js';
import { projectPromotions, projectProvenance, type AtlasPromotionList } from './promotions.js';
import { mediaTypeEssence } from '../http/media-type.js';
import { formatTemplate } from '../http/target.js';
import { endpointId } from '../ids.js';
import type { DynamicRuntime } from '../resolve/resolve.js';
import type { FixtureSnapshot, HeaderMap, HttpMethod, StartupWarning } from '../types/index.js';
import type {
  Atlas,
  AtlasClock,
  AtlasConfig,
  AtlasControls,
  AtlasEndpoint,
  AtlasEndpointSummary,
  AtlasFault,
  AtlasFaults,
  AtlasFixture,
  AtlasFixtureSummary,
  AtlasHeader,
  AtlasHealth,
  AtlasIdentity,
  AtlasInventory,
  AtlasLookup,
  AtlasMatrix,
  AtlasPreview,
  AtlasRendered,
  AtlasRenderedFixture,
  AtlasRenderInput,
  AtlasRepresentationGroup,
  AtlasScenario,
  AtlasScenarios,
} from './types.js';

/** Preview ceiling: 64 KiB of the original body, applied before encoding. */
export const PREVIEW_LIMIT = 64 * 1024;

const ENDPOINT_ID = /^ep_[0-9a-f]{16}$/;
const FIXTURE_ID = /^fx_[0-9a-f]{16}$/;
const SNAPSHOT_VERSION = /^[0-9a-f]{16}$/;

/** What the composition root knows about the configuration, for Atlas to publish. */
export interface AtlasDiagnostics {
  readonly configDigest: string;
  readonly configFile: boolean;
  readonly settings: readonly PublicSetting[];
  readonly warnings: readonly StartupWarning[];
}

/** What Atlas needs to render previews and report the clock. */
export interface AtlasDynamic {
  readonly config: EngineConfig;
  readonly runtime: DynamicRuntime;
  readonly seedSource: 'config' | 'cli' | 'generated';
}

/** The caller's session as the clock resource sees it. */
export interface AtlasSessionClock {
  /** Null for the `default` session. */
  readonly id: string | null;
  readonly clock: SessionInstant | null;
}

const NO_SESSION_CLOCK: AtlasSessionClock = Object.freeze({ id: null, clock: null });

/** One snapshot's Atlas data. The engine adds `explain`, which needs the resolver, and the caller's session. */
export interface AtlasProjection extends Omit<
  Atlas,
  'explain' | 'explainServed' | 'clock' | 'recording' | 'promotion'
> {
  /** The endpoint a fixture belongs to, for linking a resolved response to its detail. */
  fixtureEndpoint(fixtureId: string): string | undefined;
  clock(headers: HeaderMap, session?: AtlasSessionClock): ReturnType<Atlas['clock']>;
}

interface FixtureEntry {
  readonly summary: AtlasFixtureSummary;
  readonly endpoint: AtlasEndpoint;
  readonly response: StoredResponse;
}

/** Statuses and representations of one scenario's route and method, before the matrix links them. */
interface EndpointDraft {
  readonly scenario: string;
  readonly id: string;
  readonly method: HttpMethod;
  readonly key: string;
  readonly endpoint: Omit<AtlasEndpoint, 'matrix'>;
  readonly responses: readonly StoredResponse[];
}

/**
 * Projects a snapshot for Atlas. Everything except previews is computed once
 * up front: the snapshot is immutable, so every call returns the same frozen
 * objects. Previews are built per call so large bodies are not held twice.
 */
export function createAtlas(
  summary: FixtureSnapshot,
  snapshot: SnapshotData,
  diagnostics: AtlasDiagnostics,
  dynamic: AtlasDynamic,
): AtlasProjection {
  const version = snapshot.version;
  const endpoints = new Map<string, AtlasEndpoint>();
  const fixtures = new Map<string, FixtureEntry>();
  const configured = snapshot.scenarios.has(dynamic.config.defaultScenario)
    ? dynamic.config.defaultScenario
    : DEFAULT_SCENARIO;

  // One endpoint per route and method in each scenario's effective tree.
  const drafts: EndpointDraft[] = [];
  for (const scenario of snapshot.scenarios.values()) {
    for (const { method, node } of listEndpoints(scenario.root)) {
      const stored = node.methods.get(method);
      if (stored === undefined) continue;
      const template = templateKey(node.segments);
      const id = endpointId(scenario.name, method, template);
      // Plain groups first, then each named identity's by name.
      const groups: RepresentationGroup[] = [
        ...(stored.fallback === null ? [] : [stored.fallback]),
        ...stored.localized,
        ...[...stored.identities.values()]
          .filter((identity) => identity.variant !== null)
          .flatMap((identity) => [...(identity.fallback === null ? [] : [identity.fallback]), ...identity.localized]),
      ];
      const representationGroups = groups.map((group): AtlasRepresentationGroup => ({
        status: group.status,
        variant: group.variant,
        locale: group.locale,
        representations: group.representations.map((response) => fixtureSummary(response, scenario.name, snapshot)),
      }));
      const flat = representationGroups.flatMap((group) => group.representations);
      const own = flat.filter((fixture) => fixture.origin === 'own').length;
      drafts.push({
        scenario: scenario.name,
        id,
        method,
        key: JSON.stringify([method, ...template]),
        responses: groups.flatMap((group) => group.representations),
        endpoint: {
          id,
          scenario: scenario.name,
          method,
          path: formatTemplate(node.segments),
          pathParameters: node.segments.flatMap((segment) => (segment.kind === 'param' ? [segment.name] : [])),
          origin: own === flat.length ? 'own' : own === 0 ? 'inherited' : 'mixed',
          snapshotVersion: version,
          fixtures: flat,
          representationGroups,
          accepts:
            stored.accepts === null
              ? null
              : {
                  mediaTypes: [...stored.accepts.mediaTypes],
                  allowMissingContentType: stored.accepts.allowMissingContentType,
                  scenario: stored.acceptsScenario ?? scenario.name,
                },
          controls: projectControls(stored, method, dynamic.config),
          ...(stored.controls.fault === null
            ? {}
            : {
                faults: projectFaults(
                  stored.controls.fault,
                  scenario.name,
                  `${node.segments.length === 0 ? '' : formatTemplate(node.segments)}/${method}/fault.yaml`,
                ),
              }),
        },
      });
    }
  }

  const byRoute = new Map<string, EndpointDraft[]>();
  for (const draft of drafts) byRoute.set(draft.key, [...(byRoute.get(draft.key) ?? []), draft]);
  for (const draft of drafts) {
    const endpoint = deepFreeze<AtlasEndpoint>({
      ...draft.endpoint,
      matrix: buildMatrix(byRoute.get(draft.key) ?? [draft]),
    });
    endpoints.set(draft.id, endpoint);
    endpoint.fixtures.forEach((fixture, index) => {
      const response = draft.responses[index];
      // A fixture belongs to the endpoint of the scenario that holds its file.
      if (response !== undefined && fixture.origin === 'own') {
        fixtures.set(fixture.id, { summary: fixture, endpoint, response });
      }
    });
  }

  const inventories = new Map<string, AtlasInventory>();
  const scenarioItems: AtlasScenario[] = [];
  for (const scenario of snapshot.scenarios.values()) {
    const items = drafts
      .filter((draft) => draft.scenario === scenario.name)
      .map((draft): AtlasEndpointSummary => {
        const { id, method, path, pathParameters, origin } = draft.endpoint;
        // The inventory badges an endpoint while any of its promoted files awaits review.
        const states = draft.endpoint.fixtures.flatMap((fixture) => [
          ...(fixture.review === undefined ? [] : [fixture.review]),
          ...(fixture.sidecar?.provenance == null ? [] : [fixture.sidecar.provenance.review]),
        ]);
        const review = states.length === 0 ? undefined : states.includes('pending') ? 'pending' : 'reviewed';
        return {
          id,
          scenario: scenario.name,
          method,
          path,
          pathParameters,
          origin,
          ...(review === undefined ? {} : { review }),
          ...(draft.endpoint.faults === undefined ? {} : { hasFaults: true as const }),
        };
      });
    inventories.set(
      scenario.name,
      deepFreeze<AtlasInventory>({ snapshotVersion: version, scenario: scenario.name, items }),
    );
    const own = items.filter((item) => item.origin !== 'inherited').length;
    scenarioItems.push({
      name: scenario.name,
      description: scenario.description,
      extends: scenario.parent,
      chain: scenario.chain,
      ids: scenario.ids,
      overrides: scenario.overrides,
      removes: scenario.removes,
      endpoints: { own, inherited: items.length - own, total: items.length },
      latency: { own: scenario.latency, effective: scenario.effectiveLatency },
    });
  }
  const scenarios = deepFreeze<AtlasScenarios>({
    snapshotVersion: version,
    configuredDefault: configured,
    items: scenarioItems,
  });
  const configuredScenario = snapshot.scenarios.get(configured);
  const configuredInventory = inventories.get(configured);
  if (configuredInventory === undefined) throw new Error('a snapshot always has its default scenario');

  const health = deepFreeze<AtlasHealth>({
    status: 'ready',
    snapshotVersion: version,
    fixtureCount: configuredScenario?.fixtureCount ?? summary.fixtureCount,
    routeCount: configuredScenario?.routeCount ?? summary.routeCount,
    configDigest: diagnostics.configDigest,
    // Codes and messages only: locations could disclose data-root paths.
    warnings: diagnostics.warnings.map(({ code, source, message }) => ({ code, source, message })),
    configuredDefaultScenario: configured,
    scenarioCount: snapshot.scenarios.size,
    idempotency: dynamic.config.idempotency.enabled,
    transport: {
      faults: {
        enabled: dynamic.config.faults.enabled,
        timeoutMs: dynamic.config.faults.timeoutMs,
        maxHeldConnections: dynamic.config.faults.maxHeldConnections,
      },
      compression: { enabled: dynamic.config.compression.enabled, encodings: dynamic.config.compression.encodings },
      codecs: { xml: dynamic.config.xml },
      autoOptions: dynamic.config.autoOptions,
      fixtureOrigins: dynamic.config.fixtureCors.origins.length,
    },
  });
  const config = deepFreeze<AtlasConfig>({
    configDigest: diagnostics.configDigest,
    configFile: diagnostics.configFile,
    settings: diagnostics.settings
      .filter((setting) => !PRIVATE_SETTINGS.has(setting.key))
      .map(({ key, value, source }) => ({ key, value, source }))
      .sort((a, b) => compareStrings(a.key, b.key)),
  });

  // A response file's fixture belongs to the scenario holding it.
  const fixtureBySource = new Map<string, { readonly fixtureId: string; readonly endpointId: string }>();
  for (const entry of fixtures.values()) {
    fixtureBySource.set(entry.response.source, { fixtureId: entry.summary.id, endpointId: entry.endpoint.id });
  }
  const promotions = deepFreeze<AtlasPromotionList>({
    snapshotVersion: version,
    items: projectPromotions(snapshot.provenance, (record) => fixtureBySource.get(record.source)),
  });

  const lookup = <T>(id: string, at: string, pattern: RegExp, find: (id: string) => T | undefined): AtlasLookup<T> => {
    if (!pattern.test(id) || !SNAPSHOT_VERSION.test(at)) return { kind: 'invalid' };
    if (at !== version) return { kind: 'stale' };
    const value = find(id);
    return value === undefined ? { kind: 'not-found' } : { kind: 'found', value };
  };

  const detail = (entry: FixtureEntry): AtlasFixture => {
    const { endpoint, summary: fixtureSummary, response } = entry;
    return {
      ...fixtureSummary,
      snapshotVersion: version,
      endpointId: endpoint.id,
      method: endpoint.method,
      path: endpoint.path,
      pathParameters: endpoint.pathParameters,
      sidecar:
        fixtureSummary.sidecar === null || response.sidecar === null
          ? null
          : { ...fixtureSummary.sidecar, preview: previewBody(response.sidecar.bytes, 'application/json') },
      preview: projectPreview(response),
      dynamic: (response.dynamic?.tokens.length ?? 0) > 0,
      tokens: response.dynamic?.tokens ?? [],
    };
  };

  return Object.freeze({
    promotions: () => promotions,
    promotedTo: (capture: string) =>
      promotions.items
        .filter((item) => item.capture === capture)
        .map(({ scenario, file, fixtureId, endpointId }) =>
          Object.freeze({
            scenario,
            file,
            ...(fixtureId === undefined || endpointId === undefined ? {} : { fixtureId, endpointId }),
          }),
        ),
    fixtureEndpoint: (id: string) => fixtures.get(id)?.endpoint.id,
    health: () => health,
    config: () => config,
    inventory: ((scenario?: string) =>
      scenario === undefined ? configuredInventory : inventories.get(scenario)) as Atlas['inventory'],
    scenarios: () => scenarios,
    endpoint: (id: string, at: string) => lookup(id, at, ENDPOINT_ID, (key) => endpoints.get(key)),
    fixture: (id: string, at: string) =>
      lookup(id, at, FIXTURE_ID, (key) => {
        const entry = fixtures.get(key);
        return entry === undefined ? undefined : deepFreeze(detail(entry));
      }),
    renderedFixture: (id: string, at: string, input: AtlasRenderInput) => {
      const found = lookup(id, at, FIXTURE_ID, (key) => fixtures.get(key));
      if (found.kind !== 'found') return found;
      const entry = found.value;
      let requested: number | undefined;
      if (input.now !== undefined) {
        const parsed = parseRfc3339(input.now);
        if (parsed === null) {
          return { kind: 'bad-input' as const, message: '"now" must be an RFC 3339 instant with an offset' };
        }
        requested = parsed;
      }
      const params = input.params ?? {};
      const unknown = Object.keys(params).find((name) => !entry.endpoint.pathParameters.includes(name));
      if (unknown !== undefined) {
        return {
          kind: 'bad-input' as const,
          message: `"param.${unknown}" is not a parameter of ${entry.endpoint.path}`,
        };
      }
      const holder = snapshot.scenarios.get(entry.endpoint.scenario);
      const context = {
        scenario: entry.endpoint.scenario,
        ids: new Map((holder?.ids ?? []).map(({ name, value }) => [name, value])),
        sequencePosition: null,
      };
      const rendered = renderPreview(entry, params, requested, dynamic, context);
      return { kind: 'found' as const, value: deepFreeze<AtlasRenderedFixture>({ ...detail(entry), rendered }) };
    },
    clock: (headers: HeaderMap, session: AtlasSessionClock = NO_SESSION_CLOCK) => {
      const { config: engine, runtime, seedSource } = dynamic;
      const choice = chooseInstant(runtime.clock, undefined, headers, session.clock);
      if (!choice.ok && choice.kind === 'invalid-request')
        return { kind: 'bad-input' as const, message: choice.reason };
      const source = choice.ok ? (choice.source as AtlasClock['source']) : 'wall-clock';
      const configuredMode: AtlasClock['mode'] = engine.now === null ? 'live' : engine.clockMode;
      const mode: AtlasClock['mode'] =
        source === 'request-header'
          ? 'frozen'
          : source === 'session'
            ? (session.clock?.mode ?? 'frozen')
            : configuredMode;
      return {
        kind: 'found' as const,
        value: deepFreeze<AtlasClock>({
          now: choice.ok ? rfc3339(choice.instant) : null,
          mode,
          source,
          session: session.id,
          timezone: engine.timezone,
          seed: engine.seed ?? 0,
          seedSource,
          serverDefault: { now: engine.now === null ? null : rfc3339(engine.now), mode: configuredMode },
        }),
      };
    },
  });
}

/** Renders a fixture for a preview: the endpoint's method, the given parameters, no query, headers or body. */
function renderPreview(
  entry: FixtureEntry,
  params: Readonly<Record<string, string>>,
  requested: number | undefined,
  dynamic: AtlasDynamic,
  context: RenderContextValues,
): AtlasRendered {
  const { response, endpoint } = entry;
  const { config, runtime } = dynamic;
  const seed = config.seed ?? 0;
  const fixture = response.dynamic;
  const unrendered = {
    preview: projectPreview(response),
    headers: projectHeaders(response),
    instant: null,
    clockSource: null,
    seed,
    nondeterministic: false,
    unresolved: [],
    spans: [],
    error: null,
  };
  if (fixture === null) return unrendered;
  const failed = (error: string): AtlasRendered => ({
    ...unrendered,
    preview: { state: 'unavailable', reason: 'render-failed' },
    error,
  });

  let choice: InstantChoice | null = null;
  if (fixture.tokens.length > 0) {
    choice =
      requested === undefined
        ? serverInstant(runtime.clock)
        : { ok: true, instant: requested, source: 'caller', moving: false };
    if (!choice.ok) return failed(choice.reason);
  }
  const instant = choice?.ok === true ? choice.instant : 0;
  const result = renderFixture(
    fixture,
    response,
    { method: endpoint.method, routeTemplate: endpoint.path, params, query: [], headers: {}, body: null },
    {
      instant,
      timezone: config.timezone,
      seed,
      strictRefs: false,
      randomBytes: runtime.randomBytes,
      fixtureId: response.id,
      status: response.status,
      preview: true,
      context,
    },
  );
  if (!result.ok)
    return failed(result.kind === 'render-failed' ? `{{$${result.token}}}: ${result.reason}` : result.reason);
  const served: StoredResponse = { ...response, headers: result.headers, body: result.body ?? response.body };
  return {
    preview: projectPreview(served),
    headers: projectHeaders(served),
    instant: choice?.ok === true ? rfc3339(choice.instant) : null,
    clockSource: choice?.ok === true ? (choice.source as 'caller' | 'server-default' | 'wall-clock') : null,
    seed,
    nondeterministic: fixture.usesUnique || (choice?.ok === true && choice.moving && fixture.usesInstant),
    unresolved: result.unresolved,
    spans: result.spans,
    error: null,
  };
}

interface EndpointLocation {
  readonly method: HttpMethod;
  readonly node: RouteNode;
}

/**
 * Every template + method, sorted by template segment by segment (parents
 * first; a node's literal children before its template child), then method.
 */
function listEndpoints(root: RouteNode): EndpointLocation[] {
  const out: EndpointLocation[] = [];
  const visit = (node: RouteNode): void => {
    for (const method of [...node.methods.keys()].sort(compareStrings)) out.push({ method, node });
    for (const segment of [...node.children.keys()].sort(compareStrings)) {
      const child = node.children.get(segment);
      if (child !== undefined) visit(child);
    }
    if (node.param !== null) visit(node.param.node);
  };
  visit(root);
  return out;
}

/**
 * The matrix of one route and method: a row per
 * scenario that has it, a column per identity any of them answers, plain
 * identities by status first, then named ones by name.
 */
function buildMatrix(drafts: readonly EndpointDraft[]): AtlasMatrix {
  const byName = new Map<string, AtlasIdentity>();
  for (const fixture of drafts.flatMap((draft) => draft.endpoint.fixtures)) {
    byName.set(fixture.identity, { identity: fixture.identity, status: fixture.status, variant: fixture.variant });
  }
  const identities = [...byName.values()].sort((a, b) =>
    a.variant === null || b.variant === null
      ? a.variant === null && b.variant === null
        ? a.status - b.status
        : a.variant === null
          ? -1
          : 1
      : compareStrings(a.variant, b.variant),
  );
  const rows = [...drafts]
    .sort((a, b) => compareStrings(a.scenario, b.scenario))
    .map((draft) => ({
      scenario: draft.scenario,
      endpointId: draft.id,
      ...(draft.endpoint.faults === undefined
        ? {}
        : {
            fault: {
              origin: draft.endpoint.faults.inherited ? ('inherited' as const) : ('own' as const),
              scenario: draft.endpoint.faults.scenario,
            },
          }),
      cells: identities.map(({ identity }) => {
        const representations = draft.endpoint.fixtures
          .filter((fixture) => fixture.identity === identity)
          .map((fixture) => ({
            fixtureId: fixture.id,
            locale: fixture.locale,
            mediaType: fixture.mediaType,
            origin: fixture.origin,
            scenario: fixture.scenario,
          }));
        return representations.length === 0 ? null : { representations };
      }),
    }));
  return { identities, rows };
}

/** The method's `fault.yaml` as Atlas shows it. */
function projectFaults(
  held: NonNullable<StoredMethod['controls']['fault']>,
  scenario: string,
  file: string,
): AtlasFaults {
  const fault = (value: Fault): AtlasFault => ({
    kind: value.kind,
    ...(value.kind === 'truncate' && value.bytes !== null ? { bytes: value.bytes } : {}),
    ...(value.kind === 'malformed' ? { form: value.form } : {}),
  });
  return {
    file,
    scenario: held.scenario,
    inherited: held.scenario !== scenario,
    latency: held.control.latency,
    rules: held.control.rules.map((rule) => ({
      when: rule.when.map(describeCondition),
      fault: (rule.steps ?? (rule.fault === null ? [] : [rule.fault])).map(fault),
    })),
  };
}

/** The method's control files as Atlas shows them. */
function projectControls(stored: StoredMethod, method: HttpMethod, config: EngineConfig): AtlasControls {
  const { rules, pages, sequence, expect } = stored.controls;
  return {
    rules:
      rules === null
        ? null
        : {
            scenario: rules.scenario,
            items: rules.control.rules.map((rule) => ({
              when: rule.when.map(describeCondition),
              ...(rule.steps === null ? { serve: rule.serve ?? '' } : { steps: [...rule.steps] }),
            })),
          },
    pages:
      pages === null
        ? null
        : {
            scenario: pages.scenario,
            by: pages.control.by.text,
            pages: pages.control.pages.map(([key, identity]) => ({ key, identity })),
            whenAbsent: pages.control.whenAbsent,
            otherwise: pages.control.otherwise,
          },
    sequence: sequence === null ? null : { scenario: sequence.scenario, steps: [...sequence.control.steps] },
    expect:
      expect === null
        ? null
        : {
            scenario: expect.scenario,
            conditions: expect.control.expect.map(describeCondition),
            onMismatch: expect.control.onMismatch,
          },
    idempotent: config.idempotency.enabled && config.idempotency.methods.includes(method),
  };
}

function fixtureSummary(response: StoredResponse, scenario: string, snapshot: SnapshotData): AtlasFixtureSummary {
  const record = provenanceOf(snapshot, response.source);
  const sidecar = response.sidecar;
  const sidecarRecord = sidecar === null ? undefined : provenanceOf(snapshot, sidecar.source);
  return {
    id: response.id,
    status: response.status,
    variant: response.variant,
    identity: response.identity,
    mediaType: response.mediaType,
    wireContentType: response.body === null ? null : (response.headers['content-type']?.[0] ?? null),
    locale: response.locale,
    byteLength: response.body?.length ?? 0,
    headers: projectHeaders(response),
    scenario: response.scenario,
    origin: response.scenario === scenario ? 'own' : 'inherited',
    digest: responseDigest(response),
    provenance: record === undefined ? null : projectProvenance(record),
    ...(record === undefined ? {} : { review: record.entry.review }),
    sidecar:
      sidecar === null
        ? null
        : {
            digest: sidecar.digest,
            provenance: sidecarRecord === undefined ? null : projectProvenance(sidecarRecord),
          },
  };
}

const digests = new WeakMap<StoredResponse, string>();

/** The response file's digest; a bodyless file is empty. Computed once per stored response. */
function responseDigest(response: StoredResponse): string {
  let digest = digests.get(response);
  if (digest === undefined) {
    digest = fileDigest(response.body ?? new Uint8Array());
    digests.set(response, digest);
  }
  return digest;
}

/** Replayed headers as served (before diagnostics), then Janus-computed ones the sidecar set, which are dropped. */
function projectHeaders(response: StoredResponse): AtlasHeader[] {
  const headers: AtlasHeader[] = [];
  const add = (name: string, values: readonly string[], treatment: 'replayed' | 'dropped'): void => {
    for (const value of values) headers.push({ name, value, treatment });
  };
  for (const name of Object.keys(response.headers).sort(compareStrings)) {
    add(name, response.headers[name] ?? [], 'replayed');
  }
  for (const { name, values } of response.dropped) add(name, values, 'dropped');
  return headers;
}

/** `utf8` for valid-UTF-8 JSON and text bodies, `base64` otherwise; bounded at `PREVIEW_LIMIT`. */
export function projectPreview(response: StoredResponse): AtlasPreview {
  return previewBody(response.body, response.mediaType);
}

/** The preview of any body, textual by `mediaType`; null is bodyless. */
export function previewBody(body: Uint8Array | null, mediaType: string | null): AtlasPreview {
  if (body === null) return { state: 'unavailable', reason: 'bodyless' };
  const truncated = body.length > PREVIEW_LIMIT;
  if (isTextual(mediaType ?? undefined) && decodeUtf8(body) !== null) {
    let end = Math.min(body.length, PREVIEW_LIMIT);
    // Back up to the start of a character so no partial sequence is shown.
    while (end > 0 && end < body.length && ((body[end] ?? 0) & 0xc0) === 0x80) end--;
    return {
      state: 'available',
      encoding: 'utf8',
      value: decodeUtf8(body.subarray(0, end)) ?? '',
      byteLength: body.length,
      truncated,
    };
  }
  return {
    state: 'available',
    encoding: 'base64',
    value: toBase64(body.subarray(0, PREVIEW_LIMIT)),
    byteLength: body.length,
    truncated,
  };
}

/** JSON, YAML, XML, HTML and other text previews are shown as UTF-8. */
function isTextual(mediaType: string | undefined): boolean {
  const essence = mediaTypeEssence(mediaType ?? '');
  return (
    essence.startsWith('text/') ||
    TEXTUAL_APPLICATION_TYPES.has(essence) ||
    essence.endsWith('+json') ||
    essence.endsWith('+xml') ||
    essence.endsWith('+yaml')
  );
}

const TEXTUAL_APPLICATION_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/yaml',
  'application/x-yaml',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
]);

/** Strict UTF-8 that keeps a leading BOM, so the preview shows the bytes as they are. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
