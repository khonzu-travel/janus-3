import type { PublicSetting } from '../config/merge.js';
import type { CompressionCoding } from '../config/schema.js';
import type { LatencyProfile } from '../fixtures/latency.js';
import type { AtlasPromotionList, AtlasPromotionStatus, AtlasProvenance } from './promotions.js';
import type {
  HeaderMap,
  HttpMethod,
  MalformedForm,
  RequestDescription,
  ResponseDescription,
  ResolutionTrace,
  ResolveOptions,
  StartupErrorCode,
  StartupSource,
  StartupWarningCode,
} from '../types/index.js';

/**
 * Read-only projections of the snapshot an engine serves.
 * Every value is deeply frozen, built from the in-memory snapshot only, and
 * free of filesystem paths.
 */
export interface Atlas {
  health(): AtlasHealth;
  /** The effective settings. Not snapshot-bound. */
  config(): AtlasConfig;
  /**
   * One scenario's endpoints; the configured default scenario
   * when `scenario` is absent. Undefined for a name no scenario has.
   */
  inventory(): AtlasInventory;
  inventory(scenario: string): AtlasInventory | undefined;
  /** Every scenario and how it inherits. */
  scenarios(): AtlasScenarios;
  /** `at` is the snapshot version the caller's link was issued for. */
  endpoint(id: string, at: string): AtlasLookup<AtlasEndpoint>;
  fixture(id: string, at: string): AtlasLookup<AtlasFixture>;
  /**
   * The fixture rendered against a synthetic request: the
   * given path parameters and no query, headers or body. Changes no state.
   */
  renderedFixture(id: string, at: string, input: AtlasRenderInput): AtlasLookup<AtlasRenderedFixture> | AtlasBadInput;
  /**
   * The instant a request with these headers would render against now, honouring the caller's
   * session. Not snapshot-bound.
   */
  clock(headers: HeaderMap): { readonly kind: 'found'; readonly value: AtlasClock } | AtlasBadInput;
  /**
   * Simulates one request against the snapshot active when called: the same resolution a served
   * request gets, projected for display.
   * Nothing is logged, stored or changed. Rejects only when `signal` aborts.
   */
  explain(request: RequestDescription, options?: ResolveOptions): Promise<AtlasExplanation>;
  /**
   * The same projection for a request Janus already served: the decisions
   * `resolve` made, read from its response's trace. Carries no simulation
   * notes, since nothing was simulated.
   */
  explainServed(request: RequestDescription, response: ResponseDescription): AtlasExplanation;
  /** `GET /_janus/recording`. Not snapshot-bound; never names the captures directory. */
  recording(): AtlasRecording;
  /** Every promoted file of the snapshot, newest first. */
  promotions(): AtlasPromotionList;
  /** Each file in the snapshot whose provenance names this capture. */
  promotedTo(capture: string): readonly AtlasPromotedFile[];
  /** `capabilities.promotion`. */
  promotion(): AtlasPromotionStatus;
}

/** The recording settings and whether this engine can record. */
export interface AtlasRecording {
  /** False when the engine has no recording ports. */
  readonly available: boolean;
  /** In configuration order, each upstream URL as configured. */
  readonly endpoints: readonly { readonly method: HttpMethod; readonly path: string; readonly upstream: string }[];
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxConcurrent: number;
}

/** What Janus would answer for a request, and why. */
export interface AtlasExplanation {
  readonly snapshotVersion: string;
  /** Null when the request would be forwarded to an upstream: there is no response to show. */
  readonly response: {
    readonly status: number;
    /** One entry per value, sorted by name. */
    readonly headers: readonly AtlasResponseHeader[];
    /** The body preview; `unavailable: bodyless` for bodyless responses and `HEAD`. */
    readonly body: AtlasPreview;
  } | null;
  readonly trace: ResolutionTrace;
  /** The fixture that answered; null for Janus-generated outcomes. */
  readonly fixture: { readonly endpointId: string; readonly fixtureId: string } | null;
  /** The endpoint holding each file in `trace.shadowed`, in the same order, so a client can link to it. */
  readonly shadowed: readonly { readonly endpointId: string; readonly fixtureId: string }[];
  /** Caveats that apply to this simulation, as stable sentences. */
  readonly notes: readonly string[];
}

/** A response header as served. */
export interface AtlasResponseHeader {
  readonly name: string;
  readonly value: string;
}

/** How a reload ended. */
export type AtlasReloadOutcome = 'swapped' | 'unchanged' | 'failed';

/** What started a reload. Listed in this order when several were coalesced. */
export type AtlasReloadTrigger = 'watch' | 'request' | 'promotion';

/** The result of one reload. */
export interface AtlasReloadResult {
  readonly outcome: AtlasReloadOutcome;
  readonly triggers: readonly AtlasReloadTrigger[];
  /** Wall-clock RFC 3339 instant in UTC. */
  readonly finishedAt: string;
  readonly activeSnapshotVersion: string;
  /** The candidate's version; null when no candidate could be built. */
  readonly candidateSnapshotVersion: string | null;
  readonly errors: readonly AtlasReloadProblem[];
  readonly warnings: readonly AtlasReloadProblem[];
}

/** A reload error or warning, located by endpoint and file name, never by filesystem path. */
export interface AtlasReloadProblem {
  readonly code: StartupErrorCode | StartupWarningCode;
  /** The scenario directory holding the problem; null outside one (a configuration problem, or the data root). */
  readonly scenario: string | null;
  /** The method directory and path template; `method` is null outside a method directory. */
  readonly endpoint: { readonly method: HttpMethod | null; readonly path: string };
  /** The file name inside the method directory, or null. */
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly message: string;
}

/** The last reload in brief, for health and the event stream. */
export interface AtlasReloadSummary {
  readonly outcome: AtlasReloadOutcome;
  readonly errorCount: number;
  readonly finishedAt: string;
}

/** A request Atlas cannot answer because an input is malformed, e.g. an invalid `now`. */
export interface AtlasBadInput {
  readonly kind: 'bad-input';
  readonly message: string;
}

export interface AtlasRenderInput {
  /** RFC 3339 instant; the server's instant when absent. */
  readonly now?: string;
  /** Path parameter values by name; every name must be one of the endpoint's parameters. */
  readonly params?: Readonly<Record<string, string>>;
}

/** Checked in this order: `invalid` (malformed ID or version), `stale`, then `not-found`. */
export type AtlasLookup<T> =
  | { readonly kind: 'found'; readonly value: T }
  | { readonly kind: 'stale' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid' };

export interface AtlasHealth {
  readonly status: 'ready';
  readonly snapshotVersion: string;
  /** Path + method pairs; equals the number of inventory items. */
  readonly fixtureCount: number;
  /** Distinct path templates. */
  readonly routeCount: number;
  /** `cfg_` + 16 hex digits over the behaviour-affecting settings. */
  readonly configDigest: string;
  readonly warnings: readonly AtlasWarning[];
  /** The counts above describe this scenario. */
  readonly configuredDefaultScenario: string;
  readonly scenarioCount: number;
  /** `idempotency.enabled`. */
  readonly idempotency: boolean;
  /** Transport settings for `capabilities`. */
  readonly transport: {
    readonly faults: { readonly enabled: boolean; readonly timeoutMs: number; readonly maxHeldConnections: number };
    readonly compression: { readonly enabled: boolean; readonly encodings: readonly CompressionCoding[] };
    readonly codecs: { readonly xml: boolean };
    readonly autoOptions: boolean;
    /** How many `cors.fixtures.origins` are listed; never the list. */
    readonly fixtureOrigins: number;
  };
}

export interface AtlasScenarios {
  readonly snapshotVersion: string;
  readonly configuredDefault: string;
  /** Sorted by name. */
  readonly items: readonly AtlasScenario[];
}

export interface AtlasScenario {
  readonly name: string;
  readonly description: string | null;
  /** Null for `default`. */
  readonly extends: string | null;
  /** The scenario first, ending with "default". */
  readonly chain: readonly string[];
  /** Effective `ids`, sorted by name, each with the scenario whose value wins. */
  readonly ids: readonly { readonly name: string; readonly value: string; readonly from: string }[];
  readonly overrides: readonly string[];
  readonly removes: readonly string[];
  /** `own`: endpoints with at least one file from the scenario itself. */
  readonly endpoints: { readonly own: number; readonly inherited: number; readonly total: number };
  /** The scenario's own `flow.yaml` latency, and the one it uses along its chain. */
  readonly latency: {
    readonly own: LatencyProfile | null;
    readonly effective: { readonly profile: LatencyProfile; readonly scenario: string } | null;
  };
}

/** Where an endpoint's representations come from, relative to its scenario. */
export type AtlasOrigin = 'own' | 'inherited' | 'mixed';

/** A startup warning without its location: messages never contain paths. */
export interface AtlasWarning {
  readonly code: StartupWarningCode;
  readonly source: StartupSource;
  readonly message: string;
}

export interface AtlasConfig {
  readonly configDigest: string;
  /** True when Janus loaded a configuration file. */
  readonly configFile: boolean;
  /** Sorted by key; `fixtures.root`, `server.host` and `server.port` are never included. */
  readonly settings: readonly PublicSetting[];
}

export interface AtlasInventory {
  readonly snapshotVersion: string;
  /** The scenario listed. */
  readonly scenario: string;
  /** Sorted by path segment by segment, then method. */
  readonly items: readonly AtlasEndpointSummary[];
}

export interface AtlasEndpointSummary {
  /** `ep_` + 16 hex digits; stable across content-only changes. */
  readonly id: string;
  readonly scenario: string;
  readonly method: HttpMethod;
  /** Canonical path template: literals re-encoded, parameters as `{name}`, e.g. "/v1/products/{productId}". */
  readonly path: string;
  /** Parameter names in template order. */
  readonly pathParameters: readonly string[];
  readonly origin: AtlasOrigin;
  /** Set when a fixture of the endpoint was promoted: `pending` while any awaits review. */
  readonly review?: 'pending' | 'reviewed';
  /** Set when the method's effective directory has a `fault.yaml`: the inventory's badge. */
  readonly hasFaults?: true;
}

export interface AtlasEndpoint extends AtlasEndpointSummary {
  readonly snapshotVersion: string;
  /** Every representation, flattened from `representationGroups` in the same order. */
  readonly fixtures: readonly AtlasFixtureSummary[];
  /** The neutral group first, then localized ones by lower-cased locale; each by media type. */
  readonly representationGroups: readonly AtlasRepresentationGroup[];
  /** The method's `accepts.yaml`, or null when it accepts any request body. */
  readonly accepts: AtlasAccepts | null;
  /** This route and method in every scenario that has it. */
  readonly matrix: AtlasMatrix;
  /** The method's control files, as written. */
  readonly controls: AtlasControls;
  /** The method's `fault.yaml`, when its effective directory has one. */
  readonly faults?: AtlasFaults;
}

/** Rows are scenarios, sorted by name; columns are response identities. */
export interface AtlasMatrix {
  /** Plain identities by status, then named ones by name. */
  readonly identities: readonly AtlasIdentity[];
  readonly rows: readonly AtlasMatrixRow[];
}

export interface AtlasIdentity {
  /** `200` or `200.empty`. */
  readonly identity: string;
  readonly status: number;
  /** Null for a plain response. */
  readonly variant: string | null;
}

/** A condition with its operands as written in the control file. */
export interface AtlasCondition {
  readonly reference: string;
  readonly test: 'equals' | 'in' | 'present' | 'range' | 'matchesETag';
  readonly value?: string | number | boolean | null;
  readonly values?: readonly (string | number | boolean | null)[];
  readonly present?: boolean;
  readonly bounds?: Readonly<Partial<Record<'gt' | 'gte' | 'lt' | 'lte', number>>>;
  readonly tag?: string;
}

/** A rule serves one identity or, for a rule sequence, steps through several. */
export interface AtlasRule {
  readonly when: readonly AtlasCondition[];
  readonly serve?: string;
  readonly steps?: readonly string[];
}

export interface AtlasControls {
  readonly rules: { readonly scenario: string; readonly items: readonly AtlasRule[] } | null;
  readonly pages: {
    readonly scenario: string;
    readonly by: string;
    readonly pages: readonly { readonly key: string; readonly identity: string }[];
    readonly whenAbsent: string | null;
    readonly otherwise: string | null;
  } | null;
  readonly sequence: { readonly scenario: string; readonly steps: readonly string[] } | null;
  readonly expect: {
    readonly scenario: string;
    readonly conditions: readonly AtlasCondition[];
    readonly onMismatch: string | null;
  } | null;
  /** The method is replayable under the current configuration. */
  readonly idempotent: boolean;
}

/** A method's `fault.yaml` as Atlas shows it. */
export interface AtlasFaults {
  /** The file's path within its scenario, e.g. "/v1/payments/POST/fault.yaml". */
  readonly file: string;
  /** The scenario holding the file. */
  readonly scenario: string;
  readonly inherited: boolean;
  readonly latency: LatencyProfile | null;
  readonly rules: readonly {
    readonly when: readonly AtlasCondition[];
    /** One fault, or a fault sequence's steps. */
    readonly fault: readonly AtlasFault[];
  }[];
}

export interface AtlasFault {
  readonly kind: 'reset' | 'timeout' | 'truncate' | 'malformed' | 'none';
  /** `truncate` with a byte count. */
  readonly bytes?: number;
  readonly form?: MalformedForm;
}

export interface AtlasMatrixRow {
  readonly scenario: string;
  readonly endpointId: string;
  /** The row's `fault.yaml`, own or inherited; absent without one. */
  readonly fault?: { readonly origin: 'own' | 'inherited'; readonly scenario: string };
  /** One per identity, in `identities` order; null where the scenario has no representation of it. */
  readonly cells: readonly (AtlasMatrixCell | null)[];
}

export interface AtlasMatrixCell {
  readonly representations: readonly {
    readonly fixtureId: string;
    readonly locale: string | null;
    readonly mediaType: string | null;
    readonly origin: 'own' | 'inherited';
    /** The scenario holding the file. */
    readonly scenario: string;
  }[];
}

export interface AtlasRepresentationGroup {
  readonly status: number;
  /** Null for plain responses. */
  readonly variant: string | null;
  readonly locale: string | null;
  readonly representations: readonly AtlasFixtureSummary[];
}

export interface AtlasAccepts {
  readonly mediaTypes: readonly string[];
  readonly allowMissingContentType: string | null;
  /** The scenario whose `accepts.yaml` this is. */
  readonly scenario: string;
}

export interface AtlasFixtureSummary {
  /** `fx_` + 16 hex digits; stable across content-only changes. */
  readonly id: string;
  readonly status: number;
  /** The variant name, or null for a plain response. */
  readonly variant: string | null;
  /** `200` or `200.empty`. */
  readonly identity: string;
  /** The file name's media type (the representation negotiation uses), or null for a bodyless response. */
  readonly mediaType: string | null;
  /** The `Content-Type` actually sent: `mediaType` unless a sidecar overrides it or adds parameters. */
  readonly wireContentType: string | null;
  /** The language tag as written in the file name, or null for the neutral representation. */
  readonly locale: string | null;
  /** Body length in bytes; 0 for a bodyless response. */
  readonly byteLength: number;
  /** Fixture headers, one entry per value, with each header's treatment. */
  readonly headers: readonly AtlasHeader[];
  /** The scenario holding the file. */
  readonly scenario: string;
  /** `own` when the endpoint's scenario holds the file. */
  readonly origin: 'own' | 'inherited';
  /** `sha256:` digest of the file's bytes. */
  readonly digest: string;
  /** Set when the file was promoted. */
  readonly provenance: AtlasProvenance | null;
  /** Set when the file was promoted: its review state. */
  readonly review?: 'pending' | 'reviewed';
  /** The header sidecar this representation replays, with its digest and provenance; null without one. */
  readonly sidecar: {
    readonly digest: string;
    readonly provenance: AtlasProvenance | null;
    /** Exact sidecar content, present in fixture detail only. */
    readonly preview?: AtlasPreview;
  } | null;
}

export interface AtlasFixture extends AtlasFixtureSummary {
  readonly snapshotVersion: string;
  /** The endpoint of the scenario holding the file. */
  readonly endpointId: string;
  readonly method: HttpMethod;
  /** The endpoint's path template. */
  readonly path: string;
  readonly pathParameters: readonly string[];
  readonly preview: AtlasPreview;
  /** True when the body or a replayed header contains a dynamic value. */
  readonly dynamic: boolean;
  readonly tokens: readonly AtlasToken[];
}

/** One dynamic value in a fixture. */
export interface AtlasToken {
  readonly location: 'body' | 'header';
  /** A JSON Pointer into a JSON body or the header sidecar, or `line:column` in a text body. */
  readonly pointer: string;
  /** The lower-cased header name, for header tokens. */
  readonly header: string | null;
  /** The token without braces and insignificant whitespace, e.g. `today+14d`. */
  readonly expression: string;
  readonly category: 'clock' | 'request' | 'generator' | 'context';
  readonly unique: boolean;
  /** UTF-16 offsets of `{{$ … }}` in the raw preview value, or in the header value. */
  readonly span: AtlasSpan;
}

export interface AtlasSpan {
  readonly start: number;
  readonly end: number;
}

export interface AtlasRenderedFixture extends AtlasFixture {
  readonly rendered: AtlasRendered;
}

export interface AtlasRendered {
  /** The rendered body; `unavailable` with `render-failed` when rendering failed. */
  readonly preview: AtlasPreview;
  /** Replayed headers with dynamic values rendered. */
  readonly headers: readonly AtlasHeader[];
  /** The instant rendered against, RFC 3339 in UTC; null for a fixture without tokens or without a clock. */
  readonly instant: string | null;
  readonly clockSource: 'caller' | 'server-default' | 'wall-clock' | null;
  readonly seed: number;
  readonly nondeterministic: boolean;
  /** Expressions of request tokens the synthetic request has no value for. */
  readonly unresolved: readonly string[];
  /** Where each body token's rendered text is in `preview.value`, in body token order. */
  readonly spans: readonly AtlasSpan[];
  /** Why rendering failed, naming the token; null on success. */
  readonly error: string | null;
}

/** The clock resource. */
export interface AtlasClock {
  /** RFC 3339 in UTC; null when the source is the wall clock and none was provided. */
  readonly now: string | null;
  readonly mode: 'frozen' | 'offset' | 'live';
  readonly source: 'request-header' | 'session' | 'server-default' | 'wall-clock';
  /** The caller's session ID; null for the `default` session. */
  readonly session: string | null;
  readonly timezone: string;
  readonly seed: number;
  readonly seedSource: 'config' | 'cli' | 'generated';
  readonly serverDefault: { readonly now: string | null; readonly mode: 'frozen' | 'offset' | 'live' };
}

/**
 * A header value and its treatment. `replayed` headers are sent as shown;
 * `dropped` ones are computed by Janus instead.
 */
export interface AtlasHeader {
  readonly name: string;
  readonly value: string;
  readonly treatment: AtlasHeaderTreatment;
}

export type AtlasHeaderTreatment = 'replayed' | 'dropped';

export type AtlasPreview =
  | {
      readonly state: 'available';
      readonly encoding: 'utf8' | 'base64';
      readonly value: string;
      /** Length of the whole original body, even when truncated. */
      readonly byteLength: number;
      readonly truncated: boolean;
    }
  | { readonly state: 'unavailable'; readonly reason: 'bodyless' | 'render-failed' };

/** A snapshot change announced on `GET /_janus/events`. */
export type AtlasSnapshotEvent =
  | { readonly type: 'snapshot'; readonly snapshotVersion: string; readonly previousVersion: string }
  | { readonly type: 'reload-failed'; readonly errorCount: number; readonly finishedAt: string }
  /** A reload that changed nothing still replaces the last result, e.g. clearing an earlier failure. */
  | ({ readonly type: 'state' } & AtlasSnapshotState);

/** What every event-stream connection is told first: the active version and the last reload. */
export interface AtlasSnapshotState {
  readonly snapshotVersion: string;
  readonly lastReload: AtlasReloadSummary | null;
}

/** A file promoted from a capture; response files carry their fixture and endpoint. */
export interface AtlasPromotedFile {
  readonly scenario: string;
  readonly file: string;
  readonly fixtureId?: string;
  readonly endpointId?: string;
}
