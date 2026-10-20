import {
  array,
  boolean,
  count,
  DecodeError,
  literal,
  nullable,
  object,
  oneOf,
  optional,
  pattern,
  string,
  type Decoder,
} from './decode.js';

/**
 * The UI's own copy of the Atlas wire contract. It deliberately
 * does not import `@janus/*`: the UI knows only the documented HTTP resources.
 */

export const ATLAS_API_VERSION = 'atlas.v1';

const version = pattern(/^[0-9a-f]{16}$/, 'a snapshot version');
const endpointId = pattern(/^ep_[0-9a-f]{16}$/, 'an endpoint ID');
const fixtureId = pattern(/^fx_[0-9a-f]{16}$/, 'a fixture ID');

export interface WireHealth {
  readonly status: string;
  readonly snapshotVersion: string;
  readonly fixtureCount: number;
  readonly routeCount: number;
  /** Absent when the server predates configuration support: "not reported", not an error. */
  readonly configDigest?: string;
  readonly warnings?: readonly WireWarning[];
  /** What the server supports; all false from an older server. */
  readonly capabilities: WireCapabilities;
  /** The last reload in brief; null before the first, or from an older server. */
  readonly lastReload: WireReloadSummary | null;
  /** The scenario a request without a scenario header or pin gets; `default` from an older server. */
  readonly configuredDefaultScenario: string;
  /** 1 from an older server, which has only `default`. */
  readonly scenarioCount: number;
}

export interface WireRunnerCapability {
  readonly available: boolean;
  readonly reason: 'non-loopback' | null;
  readonly collections: number;
}

export interface WireCapabilities {
  /** `POST /_janus/resolve`: the resolution explorer. */
  readonly resolve: boolean;
  /** `POST /_janus/reload`. */
  readonly reload: boolean;
  /** Automatic watching is configured and running. */
  readonly watch: boolean;
  /** `GET /_janus/events`. */
  readonly events: boolean;
  /** `GET /_janus/scenarios` and `?scenario=` on the inventory. */
  readonly scenarios: boolean;
  /** `/_janus/session`. The UI never writes sessions. */
  readonly sessions: boolean;
  /** Named variants and their control files. */
  readonly variants: boolean;
  readonly sequences: boolean;
  readonly pages: boolean;
  readonly expectations: boolean;
  /** `idempotency.enabled`. */
  readonly idempotency: boolean;
  /** Recording: whether this server can record, and how many endpoints are registered. */
  readonly recording: { readonly available: boolean; readonly endpoints: number };
  /** Promotion: whether captures can be promoted, the mode, and how many promoted files await review. */
  readonly promotion: WirePromotionCapability;
  /** Faults; null from an older server. */
  readonly faults: {
    readonly enabled: boolean;
    readonly timeoutMs: number;
    readonly maxHeldConnections: number;
  } | null;
  /** Response compression; null from an older server. */
  readonly compression: { readonly enabled: boolean; readonly encodings: readonly string[] } | null;
  /** Request body codecs; null from an older server. */
  readonly codecs: { readonly xml: boolean } | null;
  /** `server.autoOptions`. */
  readonly autoOptions: boolean;
  /** The request runner: off on a non-loopback listener without the opt-in. */
  readonly runner: WireRunnerCapability;
}

export interface WirePromotionCapability {
  readonly available: boolean;
  readonly mode: 'staged' | 'auto';
  readonly pending: number;
}

export type ReloadOutcome = 'swapped' | 'unchanged' | 'failed';

export interface WireReloadSummary {
  readonly outcome: ReloadOutcome;
  readonly errorCount: number;
  readonly finishedAt: string;
}

/** A reload problem, located by endpoint and file name (never a path). */
export interface WireReloadProblem {
  readonly code: string;
  /** The scenario directory holding the problem; null outside one. */
  readonly scenario: string | null;
  readonly endpoint: { readonly method: string | null; readonly path: string };
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly message: string;
}

/** `GET /_janus/reload`: `outcome` is null before the first reload. */
export type WireReloadResult =
  | { readonly outcome: null }
  | {
      readonly outcome: ReloadOutcome;
      readonly triggers: readonly string[];
      readonly finishedAt: string;
      readonly activeSnapshotVersion: string;
      readonly candidateSnapshotVersion: string | null;
      readonly errors: readonly WireReloadProblem[];
      readonly warnings: readonly WireReloadProblem[];
    };

/** A header of a simulated response: no treatment, since nothing was replayed from a sidecar. */
export interface ResponseHeader {
  readonly name: string;
  readonly value: string;
}

export type SelectionSource = 'caller' | 'request-header' | 'session' | 'config' | 'default';

/** How a request's scenario was chosen. */
export interface WireSelection {
  readonly source: SelectionSource;
  /** The selected scenario first, ending with "default". */
  readonly chain: readonly string[];
}

/** An ancestor's file the selected scenario hid. */
export interface WireShadowed {
  readonly scenario: string;
  readonly fixtureId: string;
  readonly by: 'replaced' | 'overrides' | 'removes';
}

/** The request's session. */
export interface WireSessionTrace {
  readonly id: string | null;
  readonly source: 'header' | 'derived' | 'default';
  readonly exists: boolean;
}

/** The resolution trace, as much of it as the explorer explains. */
export interface WireTrace {
  readonly snapshotVersion: string;
  /** The selected scenario; null from a server that does not report it. */
  readonly scenario: string | null;
  readonly selection: WireSelection | null;
  /** The scenario whose file answered. */
  readonly resolvedFrom: string | null;
  readonly shadowed: readonly WireShadowed[];
  /** The full number of hidden files, when `shadowed` was cut. */
  readonly shadowedCount: number | null;
  readonly session: WireSessionTrace | null;
  readonly normalizedPath: string;
  readonly outcome: WireOutcome;
  readonly route: {
    readonly template: string | null;
    readonly params: Readonly<Record<string, string>>;
    readonly considered: readonly string[];
  } | null;
  readonly negotiation: {
    readonly language: { readonly requested: string | null; readonly selected: string | null } | null;
    readonly mediaType: {
      readonly requested: string | null;
      readonly available: readonly string[];
      readonly selected: string | null;
      readonly droppedRanges: readonly string[];
    } | null;
  } | null;
  readonly headers: {
    readonly identity: string;
    readonly dropped: readonly string[];
    readonly contentTypeOverride: { readonly representation: string; readonly wire: string } | null;
  } | null;
  readonly render: {
    readonly instant: string;
    readonly clockSource: string;
    readonly tokens: number;
    readonly nondeterministic: boolean;
  } | null;
  /** Which identity answered and what chose it. */
  readonly choice: WireChoice | null;
  /** The `expect.yaml` check. */
  readonly expect: { readonly passed: boolean; readonly failed: readonly string[] } | null;
  readonly sequence: WireSequenceTrace | null;
  readonly replay: { readonly outcome: ReplayOutcome } | null;
  /** The delay, fault and codings. */
  readonly transport: WireTransportTrace | null;
}

export interface WireTransportTrace {
  readonly latency: {
    readonly ms: number;
    readonly source: 'fault-file' | 'scenario' | 'config';
    readonly scenario: string | null;
    readonly profile: LatencyProfile;
  } | null;
  readonly fault: {
    readonly kind: FaultKind;
    readonly rule: number;
    readonly step: number | null;
    readonly bytes: number | null;
    readonly form: MalformedForm | null;
  } | null;
  readonly rulesTried: number;
  readonly faultSequence: {
    readonly position: number;
    readonly steps: number;
    readonly advanced: boolean;
    readonly notAdvancedBecause: string | null;
  } | null;
  /** False in a simulation, or with `faults.enabled: false`. */
  readonly performed: boolean;
  readonly requestCodings: readonly string[];
  readonly responseCoding: string | null;
  readonly cors: string | null;
}

export type ChoiceBy = 'expect' | 'rule' | 'page' | 'sequence' | 'plain';

export interface WireChoice {
  /** `200` or `200.empty`. */
  readonly identity: string;
  readonly by: ChoiceBy;
  readonly rule: number | null;
  readonly page: { readonly key: string | null; readonly via: 'value' | 'whenAbsent' | 'otherwise' } | null;
  readonly step: number | null;
  readonly rulesTried: number;
}

export type NotAdvancedReason = 'head' | 'no-session' | 'not-chosen' | 'not-served' | 'simulation';

export interface WireSequenceTrace {
  /** Null for `sequence.yaml`, else the rule number. */
  readonly rule: number | null;
  readonly position: number;
  readonly steps: number;
  readonly advanced: boolean;
  readonly notAdvancedBecause: NotAdvancedReason | null;
}

export type ReplayOutcome = 'stored' | 'replayed' | 'key-reused' | 'no-session' | 'not-stored' | 'would-replay';

export interface WireOutcome {
  readonly kind: string;
  /** `method-not-allowed`. */
  readonly allowed: readonly string[] | null;
  /** `not-acceptable`. */
  readonly axis: string | null;
  readonly available: readonly string[] | null;
  /** `unsupported-media-type`. */
  readonly accepted: readonly string[] | null;
  /** `invalid-request` and `render-failed`. */
  readonly reason: string | null;
  readonly token: string | null;
  /** `unknown-scenario`: where the name came from, and the scenarios that exist. */
  readonly source: string | null;
  readonly known: readonly string[] | null;
  /** `expectation-failed`: the failing references, never the request's values. */
  readonly failed: readonly string[] | null;
  /** `would-record`: the registration matched, the URL that would be requested and the header names sent. */
  readonly registration: { readonly method: string; readonly path: string } | null;
  readonly upstream: string | null;
  readonly forwardedHeaders: readonly string[] | null;
  /** `fault`: `reset` or `timeout`. */
  readonly fault: string | null;
}

/** `POST /_janus/resolve`. */
export interface WireExplanation {
  readonly snapshotVersion: string;
  /** Null when the request would be forwarded to an upstream: there is no response to show. */
  readonly response: {
    readonly status: number;
    readonly headers: readonly ResponseHeader[];
    readonly body: Preview;
  } | null;
  readonly trace: WireTrace;
  readonly fixture: { readonly endpointId: string; readonly fixtureId: string; readonly detailHref: string } | null;
  /** The endpoint holding each file in `trace.shadowed`; empty from an older server. */
  readonly shadowed: readonly {
    readonly endpointId: string;
    readonly fixtureId: string;
    readonly detailHref: string;
  }[];
  readonly notes: readonly string[];
}

/** A startup warning as Atlas reports it: a code and a message, never a location. */
export interface WireWarning {
  readonly code: string;
  readonly message: string;
}

export type SettingSource = 'default' | 'file' | 'cli';

/** Lists, null for an unset `dynamic.now` or `dynamic.seed`, and maps for `dynamic.aliases`. */
export type SettingValue = string | number | boolean | null | readonly string[] | Readonly<Record<string, string>>;

export interface WireSetting {
  readonly key: string;
  /** A list for list settings such as `negotiation.mediaTypePreference`. */
  readonly value: SettingValue;
  readonly source: SettingSource;
}

export interface WireConfig {
  readonly configDigest: string;
  readonly configFile: boolean;
  readonly settings: readonly WireSetting[];
}

/** Where an endpoint's responses come from, relative to its scenario. */
export type Origin = 'own' | 'inherited' | 'mixed';

export interface WireEndpointItem {
  readonly id: string;
  readonly scenario: string;
  readonly method: string;
  /** A path template: parameters appear as `{name}`. */
  readonly path: string;
  /** Parameter names in template order. */
  readonly pathParameters: readonly string[];
  /** `own` where every file is the scenario's own. */
  readonly origin: Origin;
  /** Set when a response was promoted: `pending` while any promoted file awaits review. */
  readonly review: ReviewState | null;
  /** The method's effective directory has a `fault.yaml`. */
  readonly hasFaults: boolean;
  readonly detailHref: string;
}

export interface WireInventory {
  readonly snapshotVersion: string;
  /** The scenario listed. */
  readonly scenario: string;
  readonly items: readonly WireEndpointItem[];
}

/** `GET /_janus/scenarios`. */
export interface WireScenarios {
  readonly snapshotVersion: string;
  readonly configuredDefault: string;
  readonly items: readonly WireScenario[];
}

export interface WireScenario {
  readonly name: string;
  readonly description: string | null;
  readonly extends: string | null;
  readonly chain: readonly string[];
  readonly ids: readonly { readonly name: string; readonly value: string; readonly from: string }[];
  readonly overrides: readonly string[];
  readonly removes: readonly string[];
  readonly endpoints: { readonly own: number; readonly inherited: number; readonly total: number };
  /** The scenario's own `flow.yaml` latency and the one it uses along its chain; both null from an older server. */
  readonly latency: {
    readonly own: LatencyProfile | null;
    readonly effective: { readonly profile: LatencyProfile; readonly scenario: string } | null;
  };
  readonly endpointsHref: string;
}

/** A delay before the first byte: exactly `ms`, or a deterministic draw from `min` to `max`. */
export type LatencyProfile =
  | { readonly ms: number; readonly min?: undefined; readonly max?: undefined }
  | { readonly ms?: undefined; readonly min: number; readonly max: number };

export type FaultKind = 'reset' | 'timeout' | 'truncate' | 'malformed' | 'none';
export type MalformedForm = 'status-line' | 'header-line' | 'conflicting-length' | 'bad-chunk';

export interface WireFault {
  readonly kind: FaultKind;
  /** `truncate` with a byte count; null for half the body. */
  readonly bytes: number | null;
  /** `malformed`'s form. */
  readonly form: MalformedForm | null;
}

/** A method's `fault.yaml`. */
export interface WireFaults {
  /** The file's path within its scenario, e.g. "/v1/payments/POST/fault.yaml". */
  readonly file: string;
  readonly scenario: string;
  readonly inherited: boolean;
  readonly latency: LatencyProfile | null;
  readonly rules: readonly { readonly when: readonly WireCondition[]; readonly fault: readonly WireFault[] }[];
}

/** `replayed` headers are sent as shown; `dropped` ones are computed by Janus instead. */
export type HeaderTreatment = 'replayed' | 'dropped';

export interface Header {
  readonly name: string;
  readonly value: string;
  readonly treatment: HeaderTreatment;
}

export interface WireFixtureSummary {
  readonly id: string;
  readonly status: number;
  /** The variant name, or null for a plain response. */
  readonly variant: string | null;
  /** `200` or `200.empty`. */
  readonly identity: string;
  /** The file name's media type: the representation `Accept` selects. */
  readonly mediaType: string | null;
  /** The `Content-Type` actually sent; equal to `mediaType` when not reported. */
  readonly wireContentType: string | null;
  readonly locale: string | null;
  readonly byteLength: number;
  readonly headers: readonly Header[];
  /** `sha256:` digest of the file; null from an older server. */
  readonly digest: string | null;
  /** Where the file was promoted from; null for a hand-written file or an older server. */
  readonly promotion: WireFilePromotion | null;
  /** The header sidecar beside this response, with its digest and promotion; null without one. */
  readonly sidecar: {
    readonly digest: string;
    readonly promotion: WireFilePromotion | null;
    readonly preview: Preview | null;
  } | null;
}

export type ReviewState = 'pending' | 'reviewed';
export type RewriteTier = 'exact' | 'inferred';

/** Where in a promoted file an ID was found: a JSON Pointer, a text line or a header name. */
export interface PromotionLocation {
  readonly pointer?: string;
  readonly line?: number;
  readonly header?: string;
}

export interface PromotionRewrite extends PromotionLocation {
  readonly id: string;
  readonly tier: RewriteTier;
}

export interface PromotionSuggestion extends PromotionLocation {
  readonly id: string;
}

export interface PromotionRefusal extends PromotionLocation {
  readonly id: string;
  readonly code: string;
}

export interface PromotionNote {
  readonly code: string;
  readonly message: string;
}

/** A promoted file's provenance: locations and codes, never values. */
export interface WireFilePromotion {
  /** The file key `POST /_janus/promotions/review` names. */
  readonly file: string;
  readonly capture: string;
  readonly promotedAt: string;
  readonly review: ReviewState;
  readonly reviewedAt: string | null;
  readonly modified: boolean;
  readonly rewrites: readonly PromotionRewrite[];
  readonly suggestions: readonly PromotionSuggestion[];
  readonly refusals: readonly PromotionRefusal[];
  readonly notes: readonly PromotionNote[];
}

export interface WireFixtureItem extends WireFixtureSummary {
  readonly detailHref: string;
  /** The scenario holding the file; null from an older server. */
  readonly holder: string | null;
  /** `own` when the endpoint's scenario holds the file. */
  readonly origin: 'own' | 'inherited';
}

export interface WireRepresentationGroup<F = WireFixtureItem> {
  readonly status: number;
  /** Null for plain responses. */
  readonly variant: string | null;
  readonly locale: string | null;
  readonly representations: readonly F[];
}

export interface WireAccepts {
  readonly mediaTypes: readonly string[];
  readonly allowMissingContentType: string | null;
  /** The scenario whose `accepts.yaml` this is; null from an older server. */
  readonly scenario: string | null;
}

/** This route and method in every scenario that has it: rows are scenarios, columns identities. */
export interface WireMatrix {
  readonly identities: readonly WireIdentity[];
  readonly rows: readonly WireMatrixRow[];
}

export interface WireIdentity {
  readonly identity: string;
  readonly status: number;
  readonly variant: string | null;
}

export interface WireMatrixRow {
  readonly scenario: string;
  readonly endpointId: string;
  readonly detailHref: string;
  readonly cells: readonly ({ readonly representations: readonly WireMatrixRepresentation[] } | null)[];
  /** The row's `fault.yaml`: own, inherited from `scenario`, or null without one. */
  readonly fault: { readonly origin: 'own' | 'inherited'; readonly scenario: string } | null;
}

export interface WireMatrixRepresentation {
  readonly fixtureId: string;
  readonly locale: string | null;
  readonly mediaType: string | null;
  readonly origin: 'own' | 'inherited';
  readonly scenario: string;
  readonly detailHref: string;
}

export interface WireEndpoint {
  readonly snapshotVersion: string;
  readonly id: string;
  readonly scenario: string;
  readonly method: string;
  readonly path: string;
  readonly pathParameters: readonly string[];
  readonly fixtures: readonly WireFixtureItem[];
  /** Null when not reported; the client then groups `fixtures` itself. */
  readonly representationGroups: readonly WireRepresentationGroup[] | null;
  /** `undefined`: not reported; `null`: any request body is accepted. */
  readonly accepts: WireAccepts | null | undefined;
  readonly origin: Origin;
  /** Null from an older server. */
  readonly matrix: WireMatrix | null;
  /** The method's control files; null from an older server. */
  readonly controls: WireControls | null;
  /** The method's `fault.yaml`; null without one. */
  readonly faults: WireFaults | null;
}

/** A condition with its operands as written in the control file. */
export interface WireCondition {
  readonly reference: string;
  readonly test: 'equals' | 'in' | 'present' | 'range' | 'matchesETag';
  readonly value: Scalar | undefined;
  readonly values: readonly Scalar[] | undefined;
  readonly present: boolean | undefined;
  readonly bounds: Readonly<Record<RangeBound, number | undefined>> | undefined;
  readonly tag: string | undefined;
}

export type Scalar = string | number | boolean | null;
export type RangeBound = 'gt' | 'gte' | 'lt' | 'lte';

export interface WireRule {
  readonly when: readonly WireCondition[];
  /** A plain rule's identity; null for a rule sequence. */
  readonly serve: string | null;
  /** A rule sequence's steps; null for a plain rule. */
  readonly steps: readonly string[] | null;
}

export interface WireControls {
  readonly rules: { readonly scenario: string; readonly items: readonly WireRule[] } | null;
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
    readonly conditions: readonly WireCondition[];
    readonly onMismatch: string | null;
  } | null;
  readonly idempotent: boolean;
}

export type Preview =
  | {
      readonly state: 'available';
      readonly encoding: 'utf8' | 'base64';
      readonly value: string;
      readonly byteLength: number;
      readonly truncated: boolean;
    }
  | { readonly state: 'unavailable'; readonly reason: 'bodyless' | 'render-failed' };

export type TokenCategory = 'clock' | 'request' | 'generator' | 'context';

export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A dynamic value in a fixture. */
export interface Token {
  readonly location: 'body' | 'header';
  /** JSON Pointer, or `line:column` in a text body. */
  readonly pointer: string;
  readonly header: string | null;
  readonly expression: string;
  readonly category: TokenCategory;
  readonly unique: boolean;
  /** UTF-16 offsets in the raw preview value (body) or header value. */
  readonly span: Span;
}

export interface WireRendered {
  readonly preview: Preview;
  readonly headers: readonly Header[];
  readonly instant: string | null;
  readonly clockSource: 'caller' | 'server-default' | 'wall-clock' | null;
  readonly seed: number;
  readonly nondeterministic: boolean;
  readonly unresolved: readonly string[];
  /** Where each body token's rendered text is in `preview.value`, in body token order. */
  readonly spans: readonly Span[];
  readonly error: string | null;
}

export type ClockMode = 'frozen' | 'offset' | 'live';

/** `GET /_janus/clock`. */
export interface WireClock {
  readonly now: string | null;
  readonly mode: ClockMode;
  readonly source: 'request-header' | 'session' | 'server-default' | 'wall-clock';
  /** The caller's session ID; null for the default session or an older server. */
  readonly session: string | null;
  readonly timezone: string;
  readonly seed: number;
  readonly seedSource: 'config' | 'cli' | 'generated';
  readonly serverDefault: { readonly now: string | null; readonly mode: ClockMode };
}

export interface WireFixture extends WireFixtureSummary {
  readonly snapshotVersion: string;
  readonly endpointId: string;
  readonly scenario: string;
  readonly method: string;
  readonly path: string;
  readonly pathParameters: readonly string[];
  readonly preview: Preview;
  /** False from an older server. */
  readonly dynamic: boolean;
  readonly tokens: readonly Token[];
}

export interface WireRenderedFixture extends WireFixture {
  readonly rendered: WireRendered;
}

export interface WireError {
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
}

/** Throws an IncompatibleVersionError unless `apiVersion` is the version this UI speaks. */
export function checkApiVersion(value: unknown): void {
  const apiVersion = (value as { apiVersion?: unknown } | null)?.apiVersion;
  if (apiVersion !== ATLAS_API_VERSION) {
    throw new IncompatibleVersionError(typeof apiVersion === 'string' ? apiVersion : null);
  }
}

export class IncompatibleVersionError extends Error {
  constructor(readonly apiVersion: string | null) {
    super(`unsupported apiVersion ${apiVersion ?? '(missing)'}`);
    this.name = 'IncompatibleVersionError';
  }
}

const statusCode: Decoder<number> = (value, path) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
    throw new DecodeError(path, 'an HTTP status');
  }
  return value;
};

const configDigest = pattern(/^cfg_[0-9a-f]{16}$/, 'a configuration digest');
const warning: Decoder<WireWarning> = object({ code: pattern(/^[a-z0-9-]{1,64}$/, 'a warning code'), message: string });

/**
 * Health keeps `snapshot`; clients prefer `snapshotVersion` and accept `snapshot` alone.
 * `configDigest` and `warnings` are optional: an older server simply does not report them.
 */
export const decodeHealth: Decoder<WireHealth> = (value, path) => {
  const record = object({ status: string, fixtureCount: count, routeCount: count })(value, path);
  const raw = value as {
    snapshotVersion?: unknown;
    snapshot?: unknown;
    configDigest?: unknown;
    warnings?: unknown;
    capabilities?: unknown;
    lastReload?: unknown;
  };
  const snapshotVersion = version(raw.snapshotVersion ?? raw.snapshot, 'snapshotVersion');
  return {
    ...record,
    snapshotVersion,
    ...(raw.configDigest === undefined ? {} : { configDigest: configDigest(raw.configDigest, 'configDigest') }),
    ...(raw.warnings === undefined ? {} : { warnings: array(warning)(raw.warnings, 'warnings') }),
    capabilities: optional(capabilities, NO_CAPABILITIES)(raw.capabilities, 'capabilities'),
    lastReload: optional(nullable(reloadSummary), null)(raw.lastReload, 'lastReload'),
    configuredDefaultScenario: optional(scenarioName, 'default')(
      (value as { configuredDefaultScenario?: unknown }).configuredDefaultScenario,
      'configuredDefaultScenario',
    ),
    scenarioCount: optional(count, 1)((value as { scenarioCount?: unknown }).scenarioCount, 'scenarioCount'),
  };
};

/** What a server that reports no capabilities supports: none of them. */
export const NO_CAPABILITIES: WireCapabilities = {
  resolve: false,
  reload: false,
  watch: false,
  events: false,
  scenarios: false,
  sessions: false,
  variants: false,
  sequences: false,
  pages: false,
  expectations: false,
  idempotency: false,
  recording: { available: false, endpoints: 0 },
  promotion: { available: false, mode: 'staged', pending: 0 },
  faults: null,
  compression: null,
  codecs: null,
  autoOptions: false,
  runner: { available: false, reason: null, collections: 0 },
};

const capabilities: Decoder<WireCapabilities> = object({
  resolve: optional(boolean, false),
  reload: optional(boolean, false),
  watch: optional(boolean, false),
  events: optional(boolean, false),
  scenarios: optional(boolean, false),
  sessions: optional(boolean, false),
  variants: optional(boolean, false),
  sequences: optional(boolean, false),
  pages: optional(boolean, false),
  expectations: optional(boolean, false),
  idempotency: optional(boolean, false),
  recording: optional(object({ available: boolean, endpoints: count }), { available: false, endpoints: 0 }),
  promotion: optional(
    object<WirePromotionCapability>({
      available: boolean,
      mode: oneOf<'staged' | 'auto'>('a promotion mode', literal('staged'), literal('auto')),
      pending: count,
    }),
    { available: false, mode: 'staged', pending: 0 },
  ),
  faults: optional(nullable(object({ enabled: boolean, timeoutMs: count, maxHeldConnections: count })), null),
  compression: optional(nullable(object({ enabled: boolean, encodings: array(string) })), null),
  codecs: optional(nullable(object({ xml: boolean })), null),
  autoOptions: optional(boolean, false),
  runner: optional(
    object<WireRunnerCapability>({
      available: boolean,
      reason: optional(nullable(literal('non-loopback')), null),
      collections: count,
    }),
    { available: false, reason: null, collections: 0 },
  ),
});

/** A scenario name: lowercase words of letters and digits joined by "-". */
export const SCENARIO_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const scenarioName = pattern(SCENARIO_NAME, 'a scenario name');

const reloadOutcome = oneOf<ReloadOutcome>(
  'a reload outcome',
  literal('swapped'),
  literal('unchanged'),
  literal('failed'),
);

export const reloadSummary: Decoder<WireReloadSummary> = object({
  outcome: reloadOutcome,
  errorCount: count,
  finishedAt: string,
});

const reloadProblem: Decoder<WireReloadProblem> = object({
  code: pattern(/^[a-z0-9-]{1,64}$/, 'a problem code'),
  scenario: nullable(string),
  endpoint: object({ method: nullable(string), path: string }),
  file: nullable(string),
  line: nullable(count),
  column: nullable(count),
  message: string,
});

export const decodeReloadResult: Decoder<WireReloadResult> = (value, path) => {
  if ((value as { outcome?: unknown } | null)?.outcome === null) return { outcome: null };
  return object({
    outcome: reloadOutcome,
    triggers: array(string),
    finishedAt: string,
    activeSnapshotVersion: version,
    candidateSnapshotVersion: nullable(version),
    errors: array(reloadProblem),
    warnings: array(reloadProblem),
  })(value, path);
};

const settingValue: Decoder<SettingValue> = (value, path) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return array(string)(value, path);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, string(item, `${path}.${key}`)]),
    );
  }
  throw new DecodeError(path, 'a string, number, boolean, null, list of strings, or map of strings');
};

export const decodeConfig: Decoder<WireConfig> = object({
  configDigest,
  configFile: boolean,
  settings: array(
    object({
      key: pattern(/^[A-Za-z0-9$.]{1,128}$/, 'a setting key'),
      value: settingValue,
      source: oneOf<SettingSource>('a setting source', literal('default'), literal('file'), literal('cli')),
    }),
  ),
});

const reviewState = oneOf<ReviewState>('a review state', literal('pending'), literal('reviewed'));
const sha256 = pattern(/^sha256:[0-9a-f]{64}$/, 'a sha256 digest');

const pathParameters = optional(array(pattern(/^[A-Za-z_][A-Za-z0-9_]*$/, 'a path parameter name')), []);

const origin = optional(oneOf<Origin>('an origin', literal('own'), literal('inherited'), literal('mixed')), 'own');
const fileOrigin = optional(oneOf<'own' | 'inherited'>('an origin', literal('own'), literal('inherited')), 'own');

export const decodeInventory: Decoder<WireInventory> = object({
  snapshotVersion: version,
  scenario: optional(scenarioName, 'default'),
  items: array(
    object({
      id: endpointId,
      scenario: string,
      method: string,
      path: string,
      pathParameters,
      origin,
      review: optional(nullable(reviewState), null),
      hasFaults: optional(boolean, false),
      detailHref: string,
    }),
  ),
});

const latencyProfile: Decoder<LatencyProfile> = oneOf<LatencyProfile>(
  'a latency profile',
  object({ ms: count }),
  object({ min: count, max: count }),
);

const faultKind = oneOf<FaultKind>(
  'a fault kind',
  literal('reset'),
  literal('timeout'),
  literal('truncate'),
  literal('malformed'),
  literal('none'),
);

const malformedForm = oneOf<MalformedForm>(
  'a malformed form',
  literal('status-line'),
  literal('header-line'),
  literal('conflicting-length'),
  literal('bad-chunk'),
);

export const decodeScenarios: Decoder<WireScenarios> = object({
  snapshotVersion: version,
  configuredDefault: scenarioName,
  items: array(
    object({
      name: scenarioName,
      description: nullable(string),
      extends: nullable(scenarioName),
      chain: array(scenarioName),
      ids: array(object({ name: string, value: string, from: scenarioName })),
      overrides: array(string),
      removes: array(string),
      endpoints: object({ own: count, inherited: count, total: count }),
      latency: optional(
        object({
          own: nullable(latencyProfile),
          effective: nullable(object({ profile: latencyProfile, scenario: scenarioName })),
        }),
        { own: null, effective: null },
      ),
      endpointsHref: string,
    }),
  ),
});

const treatment = optional(
  oneOf<HeaderTreatment>('a header treatment', literal('replayed'), literal('dropped')),
  'replayed',
);

const header: Decoder<Header> = object({ name: string, value: string, treatment });

const variantName = pattern(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'a variant name');
const identityName = pattern(/^\d{3}(\.[a-z0-9]+(-[a-z0-9]+)*)?$/, 'a response identity');

/** Adds `identity` from the status when the server omits it. */
function withIdentity<T extends { status: number }>(decoder: Decoder<T>): Decoder<T & { identity: string }> {
  return (value, path) => {
    const decoded = decoder(value, path);
    const raw = (value as { identity?: unknown }).identity;
    const identity =
      raw === undefined ? String(decoded.status) : identityName(raw, path === '' ? 'identity' : `${path}.identity`);
    return { ...decoded, identity };
  };
}

/** Copies only the location members that are present and well formed. */
const location = (value: unknown, path: string): PromotionLocation => {
  const record = (value ?? {}) as { pointer?: unknown; line?: unknown; header?: unknown };
  return {
    ...(record.pointer === undefined ? {} : { pointer: string(record.pointer, `${path}.pointer`) }),
    ...(record.line === undefined ? {} : { line: count(record.line, `${path}.line`) }),
    ...(record.header === undefined ? {} : { header: string(record.header, `${path}.header`) }),
  };
};
const located =
  <T extends object>(decoder: Decoder<T>): Decoder<T & PromotionLocation> =>
  (value, path) => ({ ...decoder(value, path), ...location(value, path) });

const rewriteTier = oneOf<RewriteTier>('a rewrite tier', literal('exact'), literal('inferred'));
const promotionRewrite: Decoder<PromotionRewrite> = located(object({ id: string, tier: rewriteTier }));
const promotionSuggestion: Decoder<PromotionSuggestion> = located(object({ id: string }));
const promotionRefusal: Decoder<PromotionRefusal> = located(object({ id: string, code: string }));
const promotionNote: Decoder<PromotionNote> = object({ code: string, message: string });

const filePromotion: Decoder<WireFilePromotion> = object<WireFilePromotion>({
  file: string,
  capture: string,
  promotedAt: string,
  review: reviewState,
  reviewedAt: nullable(string),
  modified: boolean,
  rewrites: array(promotionRewrite),
  suggestions: array(promotionSuggestion),
  refusals: array(promotionRefusal),
  notes: array(promotionNote),
});

const summaryShape = {
  id: fixtureId,
  status: statusCode,
  variant: optional(nullable(variantName), null),
  mediaType: nullable(string),
  locale: nullable(string),
  byteLength: count,
  headers: array(header),
  digest: optional(nullable(sha256), null),
};

/**
 * Adds the promotion facts, which the wire calls `provenance`.
 */
function withPromotion<T>(
  decoder: Decoder<T>,
): Decoder<T & { promotion: WireFilePromotion | null; sidecar: WireFixtureSummary['sidecar'] }> {
  return (value, path) => {
    const decoded = decoder(value, path);
    const at = (name: string) => (path === '' ? name : `${path}.${name}`);
    const raw = value as { provenance?: unknown; sidecar?: unknown };
    const promotion = optional(nullable(filePromotion), null)(raw.provenance, at('provenance'));
    const sidecarRaw = raw.sidecar as { digest?: unknown; provenance?: unknown; preview?: unknown } | null | undefined;
    const sidecar =
      sidecarRaw === undefined || sidecarRaw === null
        ? null
        : {
            digest: sha256(sidecarRaw.digest, at('sidecar.digest')),
            preview: optional(nullable(preview), null)(sidecarRaw.preview, at('sidecar.preview')),
            promotion: optional(nullable(filePromotion), null)(sidecarRaw.provenance, at('sidecar.provenance')),
          };
    return { ...decoded, promotion, sidecar };
  };
}

/** Adds `wireContentType`, defaulting to the media type when an older server omits it. */
function withWireContentType<T extends { mediaType: string | null }>(
  decoder: Decoder<T>,
): Decoder<T & { wireContentType: string | null }> {
  return (value, path) => {
    const decoded = decoder(value, path);
    const raw = (value as { wireContentType?: unknown }).wireContentType;
    const wireContentType =
      raw === undefined
        ? decoded.mediaType
        : nullable(string)(raw, path === '' ? 'wireContentType' : `${path}.wireContentType`);
    return { ...decoded, wireContentType };
  };
}

const fixtureItem: Decoder<WireFixtureItem> = (value, path) => {
  const decoded = withPromotion(
    withIdentity(withWireContentType(object({ ...summaryShape, detailHref: string, origin: fileOrigin }))),
  )(value, path);
  const holder = (value as { scenario?: unknown }).scenario;
  return {
    ...decoded,
    holder: optional(nullable(scenarioName), null)(holder, path === '' ? 'scenario' : `${path}.scenario`),
  };
};

const accepts: Decoder<WireAccepts> = object({
  mediaTypes: array(string),
  allowMissingContentType: nullable(string),
  scenario: optional(nullable(scenarioName), null),
});

const matrixIdentity: Decoder<WireIdentity> = withIdentity(
  object({ status: statusCode, variant: optional(nullable(variantName), null) }),
);

const scalar: Decoder<Scalar> = (value, path) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new DecodeError(path, 'a JSON scalar');
};

const finite: Decoder<number> = (value, path) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DecodeError(path, 'a number');
  return value;
};

const condition: Decoder<WireCondition> = object<WireCondition>({
  reference: string,
  test: oneOf<WireCondition['test']>(
    'a condition test',
    literal('equals'),
    literal('in'),
    literal('present'),
    literal('range'),
    literal('matchesETag'),
  ),
  value: (value, path) => (value === undefined ? undefined : scalar(value, path)),
  values: optional<readonly Scalar[] | undefined>(array(scalar), undefined),
  present: optional<boolean | undefined>(boolean, undefined),
  bounds: optional<Readonly<Record<RangeBound, number | undefined>> | undefined>(
    object({
      gt: optional<number | undefined>(finite, undefined),
      gte: optional<number | undefined>(finite, undefined),
      lt: optional<number | undefined>(finite, undefined),
      lte: optional<number | undefined>(finite, undefined),
    }),
    undefined,
  ),
  tag: optional<string | undefined>(string, undefined),
});

const identityList = array(identityName);

const controls: Decoder<WireControls> = object<WireControls>({
  rules: nullable(
    object({
      scenario: scenarioName,
      items: array(
        object<WireRule>({
          when: array(condition),
          serve: optional(nullable(identityName), null),
          steps: optional(nullable(identityList), null),
        }),
      ),
    }),
  ),
  pages: nullable(
    object({
      scenario: scenarioName,
      by: string,
      pages: array(object({ key: string, identity: identityName })),
      whenAbsent: nullable(string),
      otherwise: nullable(identityName),
    }),
  ),
  sequence: nullable(object({ scenario: scenarioName, steps: identityList })),
  expect: nullable(
    object({ scenario: scenarioName, conditions: array(condition), onMismatch: nullable(identityName) }),
  ),
  idempotent: boolean,
});

const faults: Decoder<WireFaults> = object<WireFaults>({
  file: string,
  scenario: scenarioName,
  inherited: boolean,
  latency: nullable(latencyProfile),
  rules: array(
    object({
      when: array(condition),
      fault: array(
        object<WireFault>({
          kind: faultKind,
          bytes: optional(nullable(count), null),
          form: optional(nullable(malformedForm), null),
        }),
      ),
    }),
  ),
});

const matrix: Decoder<WireMatrix> = object({
  identities: array(matrixIdentity),
  rows: array(
    object({
      scenario: scenarioName,
      endpointId,
      detailHref: string,
      fault: optional(
        nullable(
          object({
            origin: oneOf<'own' | 'inherited'>('an origin', literal('own'), literal('inherited')),
            scenario: scenarioName,
          }),
        ),
        null,
      ),
      cells: array(
        nullable(
          object({
            representations: array(
              object({
                fixtureId,
                locale: nullable(string),
                mediaType: nullable(string),
                origin: oneOf<'own' | 'inherited'>('an origin', literal('own'), literal('inherited')),
                scenario: scenarioName,
                detailHref: string,
              }),
            ),
          }),
        ),
      ),
    }),
  ),
});

export const decodeEndpoint: Decoder<WireEndpoint> = (value, path) => {
  const endpoint = object({
    snapshotVersion: version,
    id: endpointId,
    scenario: string,
    method: string,
    path: string,
    pathParameters,
    fixtures: array(fixtureItem),
    representationGroups: optional(
      nullable(
        array(
          object({
            status: statusCode,
            variant: optional(nullable(variantName), null),
            locale: nullable(string),
            representations: array(fixtureItem),
          }),
        ),
      ),
      null,
    ),
    origin,
    matrix: optional(nullable(matrix), null),
    controls: optional(nullable(controls), null),
    faults: optional(nullable(faults), null),
  })(value, path);
  const raw = (value as { accepts?: unknown }).accepts;
  return { ...endpoint, accepts: raw === undefined ? undefined : nullable(accepts)(raw, 'accepts') };
};

const preview: Decoder<Preview> = oneOf<Preview>(
  'a preview',
  object({
    state: literal('available'),
    encoding: oneOf<'utf8' | 'base64'>('an encoding', literal('utf8'), literal('base64')),
    value: string,
    byteLength: count,
    truncated: boolean,
  }),
  object({
    state: literal('unavailable'),
    reason: oneOf<'bodyless' | 'render-failed'>('a reason', literal('bodyless'), literal('render-failed')),
  }),
);

const span: Decoder<Span> = object({ start: count, end: count });

const token: Decoder<Token> = object({
  location: oneOf<'body' | 'header'>('a token location', literal('body'), literal('header')),
  pointer: string,
  header: nullable(string),
  expression: string,
  category: oneOf<TokenCategory>(
    'a token category',
    literal('clock'),
    literal('request'),
    literal('generator'),
    literal('context'),
  ),
  unique: boolean,
  span,
});

const clockMode = oneOf<ClockMode>('a clock mode', literal('frozen'), literal('offset'), literal('live'));

const rendered: Decoder<WireRendered> = object({
  preview,
  headers: array(header),
  instant: nullable(string),
  clockSource: nullable(
    oneOf<'caller' | 'server-default' | 'wall-clock'>(
      'a clock source',
      literal('caller'),
      literal('server-default'),
      literal('wall-clock'),
    ),
  ),
  seed: count,
  nondeterministic: boolean,
  unresolved: array(string),
  spans: array(span),
  error: nullable(string),
});

export const decodeClock: Decoder<WireClock> = object({
  now: nullable(string),
  mode: clockMode,
  source: oneOf<WireClock['source']>(
    'a clock source',
    literal('request-header'),
    literal('session'),
    literal('server-default'),
    literal('wall-clock'),
  ),
  session: optional(nullable(string), null),
  timezone: string,
  seed: count,
  seedSource: oneOf<WireClock['seedSource']>('a seed source', literal('config'), literal('cli'), literal('generated')),
  serverDefault: object({ now: nullable(string), mode: clockMode }),
});

export const decodeFixture: Decoder<WireFixture> = withPromotion(
  withIdentity(
    withWireContentType(
      object({
        ...summaryShape,
        snapshotVersion: version,
        endpointId,
        scenario: string,
        method: string,
        path: string,
        pathParameters,
        preview,
        dynamic: optional(boolean, false),
        tokens: optional(array(token), []),
      }),
    ),
  ),
);

export const decodeRenderedFixture: Decoder<WireRenderedFixture> = (value, path) => ({
  ...decodeFixture(value, path),
  rendered: rendered((value as { rendered?: unknown }).rendered, path === '' ? 'rendered' : `${path}.rendered`),
});

const responseHeader: Decoder<ResponseHeader> = object({ name: string, value: string });

const strings = array(string);
const optionalStrings = optional<readonly string[] | null>(nullable(strings), null);
const optionalString = optional<string | null>(nullable(string), null);

const decodeOutcome: Decoder<WireOutcome> = object({
  kind: pattern(/^[a-z-]{1,64}$/, 'an outcome kind'),
  allowed: optionalStrings,
  axis: optionalString,
  available: optionalStrings,
  accepted: optionalStrings,
  reason: optionalString,
  token: optionalString,
  source: optionalString,
  known: optionalStrings,
  failed: optionalStrings,
  registration: optional(nullable(object({ method: string, path: string })), null),
  upstream: optionalString,
  forwardedHeaders: optionalStrings,
  fault: optionalString,
});

const stringRecord: Decoder<Readonly<Record<string, string>>> = (value, path) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DecodeError(path, 'an object');
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, string(item, `${path}.${key}`)]),
  );
};

type Negotiation = NonNullable<WireTrace['negotiation']>;

/** A trace member an older server or another outcome leaves out: absent and null both mean "not reported". */
const maybe = <T>(decoder: Decoder<T>): Decoder<T | null> => optional<T | null>(nullable(decoder), null);

const decodeNegotiation: Decoder<Negotiation> = object<Negotiation>({
  language: maybe(object({ requested: nullable(string), selected: nullable(string) })),
  mediaType: maybe(
    object({ requested: nullable(string), available: strings, selected: nullable(string), droppedRanges: strings }),
  ),
});

const selectionSource = oneOf<SelectionSource>(
  'a selection source',
  literal('caller'),
  literal('request-header'),
  literal('session'),
  literal('config'),
  literal('default'),
);

const decodeTrace: Decoder<WireTrace> = object<WireTrace>({
  snapshotVersion: version,
  scenario: maybe(string),
  selection: maybe(object({ source: selectionSource, chain: array(scenarioName) })),
  resolvedFrom: maybe(scenarioName),
  shadowed: optional(
    array(
      object({
        scenario: scenarioName,
        fixtureId,
        by: oneOf<WireShadowed['by']>('a reason', literal('replaced'), literal('overrides'), literal('removes')),
      }),
    ),
    [],
  ),
  shadowedCount: maybe(count),
  session: maybe(
    object({
      id: nullable(string),
      source: oneOf<WireSessionTrace['source']>(
        'a session source',
        literal('header'),
        literal('derived'),
        literal('default'),
      ),
      exists: boolean,
    }),
  ),
  normalizedPath: string,
  outcome: decodeOutcome,
  route: maybe(object({ template: nullable(string), params: stringRecord, considered: optional(strings, []) })),
  negotiation: maybe(decodeNegotiation),
  headers: maybe(
    object({
      identity: fixtureId,
      dropped: strings,
      contentTypeOverride: nullable(object({ representation: string, wire: string })),
    }),
  ),
  render: maybe(object({ instant: string, clockSource: string, tokens: count, nondeterministic: boolean })),
  choice: maybe(
    object<WireChoice>({
      identity: identityName,
      by: oneOf<ChoiceBy>(
        'a choice',
        literal('expect'),
        literal('rule'),
        literal('page'),
        literal('sequence'),
        literal('plain'),
      ),
      rule: maybe(count),
      page: maybe(
        object({
          key: nullable(string),
          via: oneOf<'value' | 'whenAbsent' | 'otherwise'>(
            'a page source',
            literal('value'),
            literal('whenAbsent'),
            literal('otherwise'),
          ),
        }),
      ),
      step: maybe(count),
      rulesTried: optional(count, 0),
    }),
  ),
  expect: maybe(object({ passed: boolean, failed: strings })),
  sequence: maybe(
    object<WireSequenceTrace>({
      rule: maybe(count),
      position: count,
      steps: count,
      advanced: boolean,
      notAdvancedBecause: maybe(
        oneOf<NotAdvancedReason>(
          'a reason',
          literal('head'),
          literal('no-session'),
          literal('not-chosen'),
          literal('not-served'),
          literal('simulation'),
        ),
      ),
    }),
  ),
  replay: maybe(
    object({
      outcome: oneOf<ReplayOutcome>(
        'a replay outcome',
        literal('stored'),
        literal('replayed'),
        literal('key-reused'),
        literal('no-session'),
        literal('not-stored'),
        literal('would-replay'),
      ),
    }),
  ),
  transport: maybe(
    object<WireTransportTrace>({
      latency: maybe(
        object({
          ms: count,
          source: oneOf<'fault-file' | 'scenario' | 'config'>(
            'a latency source',
            literal('fault-file'),
            literal('scenario'),
            literal('config'),
          ),
          scenario: maybe(scenarioName),
          profile: latencyProfile,
        }),
      ),
      fault: maybe(
        object({
          kind: faultKind,
          rule: count,
          step: maybe(count),
          bytes: maybe(count),
          form: maybe(malformedForm),
        }),
      ),
      rulesTried: optional(count, 0),
      faultSequence: maybe(
        object({ position: count, steps: count, advanced: boolean, notAdvancedBecause: maybe(string) }),
      ),
      performed: boolean,
      requestCodings: optional(strings, []),
      responseCoding: maybe(string),
      cors: maybe(string),
    }),
  ),
});

export const decodeExplanation: Decoder<WireExplanation> = object({
  snapshotVersion: version,
  response: nullable(object({ status: statusCode, headers: array(responseHeader), body: preview })),
  trace: decodeTrace,
  fixture: nullable(object({ endpointId, fixtureId, detailHref: string })),
  shadowed: optional(array(object({ endpointId, fixtureId, detailHref: string })), []),
  notes: strings,
});

export const decodeErrorEnvelope: Decoder<WireError> = (value, path) =>
  object({
    error: object({
      code: pattern(/^[a-z0-9-]{1,64}$/, 'an error code'),
      message: string,
      requestId: nullable(string),
    }),
  })(
    // `requestId` may be absent; treat that as null.
    normalizeRequestId(value),
    path,
  ).error;

function normalizeRequestId(value: unknown): unknown {
  const error = (value as { error?: unknown } | null)?.error;
  if (typeof error !== 'object' || error === null || 'requestId' in error) return value;
  return { error: { ...error, requestId: null } };
}

/** `GET /_janus/recording`: the registrations and limits; the captures directory is never reported. */
export interface WireRecording {
  readonly available: boolean;
  readonly endpoints: readonly { readonly method: string; readonly path: string; readonly upstream: string }[];
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxConcurrent: number;
}

export const decodeRecording: Decoder<WireRecording> = object({
  available: boolean,
  endpoints: array(object({ method: string, path: string, upstream: string })),
  timeoutMs: count,
  maxResponseBytes: count,
  maxConcurrent: count,
});

/** How a recorded exchange ended; `unreadable` marks a log line that no longer parses. */
export type CaptureOutcome =
  'captured' | 'capture-failed' | 'upstream-failed' | 'upstream-timeout' | 'response-too-large';

export const CAPTURE_OUTCOMES: readonly CaptureOutcome[] = [
  'captured',
  'capture-failed',
  'upstream-failed',
  'upstream-timeout',
  'response-too-large',
];

const exchangeId = pattern(/^(?:[0-9a-f]{8}|[0-9]{6})$/, 'an exchange ID');

/** An upstream may answer any three-digit status, which Janus relays and captures unchanged. */
const captureStatus: Decoder<number> = (value, path) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 999) {
    throw new DecodeError(path, 'an HTTP status');
  }
  return value;
};

export type WireCaptureItem =
  | {
      readonly outcome: CaptureOutcome;
      readonly id: string;
      readonly scenario: string;
      readonly exchange: string;
      readonly at: string;
      readonly method: string;
      readonly target: string;
      readonly registration: string;
      readonly status: number | null;
      /** `upstream-failed` exchanges: why, from the server's fixed list of reasons. */
      readonly reason: string | null;
      readonly durationMs: number;
      /** Only for `captured` exchanges. */
      readonly detailHref: string | null;
      /** Who sent it: a request through a registered upstream, or the request runner. */
      readonly source: CaptureSource;
    }
  | { readonly outcome: 'unreadable'; readonly scenario: string; readonly line: number };

/** `GET /_janus/captures`. */
export interface WireCaptureList {
  readonly items: readonly WireCaptureItem[];
  readonly next: string | null;
}

export type CaptureSource = 'recording' | 'runner';

const captureSource = oneOf<CaptureSource>('a capture source', literal('recording'), literal('runner'));

const captureOutcome = oneOf<CaptureOutcome>('a capture outcome', ...CAPTURE_OUTCOMES.map((value) => literal(value)));

const captureItem: Decoder<WireCaptureItem> = oneOf<WireCaptureItem>(
  'a capture',
  object({ outcome: literal('unreadable'), scenario: scenarioName, line: count }),
  object({
    outcome: captureOutcome,
    id: string,
    scenario: scenarioName,
    exchange: exchangeId,
    at: string,
    method: string,
    target: string,
    registration: string,
    status: maybe(captureStatus),
    reason: maybe(string),
    durationMs: count,
    detailHref: maybe(string),
    source: optional(captureSource, 'recording'),
  }),
);

export const decodeCaptureList: Decoder<WireCaptureList> = object({
  items: array(captureItem),
  next: nullable(string),
});

/** A part of a capture whose file is missing or no longer parses. */
export interface Unreadable {
  readonly state: 'unreadable';
}

export interface WireCaptureNote {
  readonly code: string;
  readonly message: string;
}

/** `<status>.meta.json`, as far as the UI reads it; every member is optional because the file can be edited. */
export interface WireProvenance {
  readonly state: 'available';
  readonly capturedAt: string | null;
  readonly durationMs: number | null;
  readonly registration: { readonly method: string; readonly path: string; readonly upstream: string } | null;
  readonly removedHeaders: readonly string[];
  readonly notes: readonly WireCaptureNote[];
}

/** `GET /_janus/captures/{scenario}/{exchange}`. */
export interface WireCaptureDetail {
  readonly id: string;
  readonly request:
    | {
        readonly state: 'available';
        readonly method: string;
        readonly target: string;
        readonly registration: { readonly method: string; readonly path: string };
        readonly params: readonly { readonly name: string; readonly value: string }[];
        readonly headers: readonly ResponseHeader[];
        readonly body: Preview;
      }
    | Unreadable;
  readonly response:
    | {
        readonly state: 'available';
        readonly status: number;
        readonly fileName: string;
        readonly headers: readonly ResponseHeader[];
        readonly body: Preview;
        readonly modified: boolean;
      }
    | Unreadable;
  readonly provenance: WireProvenance | Unreadable;
  /** The fixture files promoted from this capture; empty from an older server. */
  readonly promotedTo: readonly WirePromotedFile[];
  /** Who sent it; `recording` from an older server. */
  readonly source: CaptureSource;
  /** Runner captures: the run that sent it and the request's ID. */
  readonly run: string | null;
  readonly requestId: string | null;
}

/** A file promoted from a capture. Response files name their fixture and endpoint. */
export interface WirePromotedFile {
  readonly scenario: string;
  readonly file: string;
  readonly fixtureId: string | null;
  readonly endpointId: string | null;
}

const unreadable: Decoder<Unreadable> = object({ state: literal('unreadable') });

/** Lenient: a provenance member of the wrong shape reads as not reported rather than failing the page. */
const lenient =
  <T>(decoder: Decoder<T>, fallback: T): Decoder<T> =>
  (value, path) => {
    try {
      return value === undefined ? fallback : decoder(value, path);
    } catch (error) {
      if (error instanceof DecodeError) return fallback;
      throw error;
    }
  };

const provenance: Decoder<WireProvenance> = object<WireProvenance>({
  state: literal('available'),
  capturedAt: lenient(nullable(string), null),
  durationMs: lenient(nullable(count), null),
  registration: lenient(nullable(object({ method: string, path: string, upstream: string })), null),
  removedHeaders: lenient(strings, []),
  notes: lenient(array(object({ code: string, message: string })), []),
});

export const decodeCaptureDetail: Decoder<WireCaptureDetail> = object<WireCaptureDetail>({
  id: string,
  request: oneOf<WireCaptureDetail['request']>(
    'a captured request',
    unreadable,
    object({
      state: literal('available'),
      method: string,
      target: string,
      registration: object({ method: string, path: string }),
      params: array(object({ name: string, value: string })),
      headers: array(responseHeader),
      body: preview,
    }),
  ),
  response: oneOf<WireCaptureDetail['response']>(
    'a captured response',
    unreadable,
    object({
      state: literal('available'),
      status: captureStatus,
      fileName: string,
      headers: array(responseHeader),
      body: preview,
      modified: boolean,
    }),
  ),
  provenance: oneOf<WireCaptureDetail['provenance']>('provenance', unreadable, provenance),
  promotedTo: optional(
    array(
      object<WirePromotedFile>({
        scenario: scenarioName,
        file: string,
        fixtureId: optional(nullable(fixtureId), null),
        endpointId: optional(nullable(endpointId), null),
      }),
    ),
    [],
  ),
  source: optional(captureSource, 'recording'),
  run: optional(nullable(string), null),
  requestId: optional(nullable(string), null),
});

/** One promoted file in `GET /_janus/promotions`. */
export interface WirePromotionItem {
  readonly scenario: string;
  readonly file: string;
  /** Null for a header sidecar. */
  readonly fixtureId: string | null;
  readonly endpointId: string | null;
  readonly capture: string;
  /** The capture it came from is still on disk; true from an older server. */
  readonly captureExists: boolean;
  readonly promotedAt: string;
  readonly review: ReviewState;
  readonly reviewedAt: string | null;
  readonly modified: boolean;
  readonly attention: {
    readonly inferred: number;
    readonly suggestions: number;
    readonly refusals: number;
    readonly notes: number;
  };
}

/** `GET /_janus/promotions`: newest first. */
export interface WirePromotionList {
  readonly at: string;
  readonly items: readonly WirePromotionItem[];
  readonly pending: number;
}

export const decodePromotionList: Decoder<WirePromotionList> = object<WirePromotionList>({
  at: version,
  items: array(
    object<WirePromotionItem>({
      scenario: scenarioName,
      file: string,
      fixtureId: optional(nullable(fixtureId), null),
      endpointId: optional(nullable(endpointId), null),
      capture: string,
      captureExists: optional(boolean, true),
      promotedAt: string,
      review: reviewState,
      reviewedAt: optional(nullable(string), null),
      modified: boolean,
      attention: object({ inferred: count, suggestions: count, refusals: count, notes: count }),
    }),
  ),
  pending: count,
});

export type PromotionFileRole = 'response' | 'headers' | 'provenance';

/** A file a promotion writes or would write. */
export interface WirePlannedFile {
  readonly file: string;
  readonly role: PromotionFileRole;
  readonly action: string;
  readonly digest: string;
  /** Only in a dry run. */
  readonly preview: Preview | null;
}

/** Why an existing file blocks a promotion, with its fixture when it is a response file. */
export interface WirePromotionConflict {
  readonly file: string;
  readonly kind: 'promoted' | 'modified' | 'hand-written';
  readonly reason: string;
  readonly fixtureId: string | null;
  /** The response file's fixture detail, in a dry run; null for a sidecar or a provenance file. */
  readonly detailHref: string | null;
}

export interface WirePromotionBinding {
  readonly id: string;
  readonly value: string;
  readonly tier: RewriteTier;
  readonly source: 'explicit' | 'path' | 'response';
}

/** The answer to `POST /_janus/promotions`: `planned` for a dry run, `promoted` after a write. */
export interface WirePromotionResult {
  readonly outcome: 'planned' | 'promoted';
  readonly capture: string;
  readonly scenario: string;
  readonly endpoint: { readonly method: string; readonly path: string };
  readonly files: readonly WirePlannedFile[];
  readonly bindings: readonly WirePromotionBinding[];
  readonly rewrites: readonly (PromotionRewrite & { readonly file?: string })[];
  readonly suggestions: readonly (PromotionSuggestion & { readonly file?: string })[];
  readonly refusals: readonly (PromotionRefusal & { readonly file?: string })[];
  readonly notes: readonly PromotionNote[];
  /** Only in a dry run: false while `conflicts` lists files the request may not replace. */
  readonly applicable: boolean;
  readonly conflicts: readonly WirePromotionConflict[];
}

const conflictKind = oneOf<WirePromotionConflict['kind']>(
  'a file kind',
  literal('promoted'),
  literal('modified'),
  literal('hand-written'),
);

export const promotionConflict: Decoder<WirePromotionConflict> = object<WirePromotionConflict>({
  file: string,
  kind: conflictKind,
  reason: string,
  fixtureId: optional(nullable(fixtureId), null),
  detailHref: optional(nullable(string), null),
});

const withFile =
  <T extends object>(decoder: Decoder<T>): Decoder<T & { file?: string }> =>
  (value, path) => {
    const file = (value as { file?: unknown } | null)?.file;
    return { ...decoder(value, path), ...(file === undefined ? {} : { file: string(file, `${path}.file`) }) };
  };

export const decodePromotionResult: Decoder<WirePromotionResult> = object<WirePromotionResult>({
  outcome: oneOf<'planned' | 'promoted'>('a promotion outcome', literal('planned'), literal('promoted')),
  capture: string,
  scenario: scenarioName,
  endpoint: object({ method: string, path: string }),
  files: array(
    object<WirePlannedFile>({
      file: string,
      role: oneOf<PromotionFileRole>('a file role', literal('response'), literal('headers'), literal('provenance')),
      action: string,
      digest: sha256,
      preview: optional(nullable(preview), null),
    }),
  ),
  bindings: array(
    object<WirePromotionBinding>({
      id: string,
      value: string,
      tier: rewriteTier,
      source: oneOf<WirePromotionBinding['source']>(
        'a binding source',
        literal('explicit'),
        literal('path'),
        literal('response'),
      ),
    }),
  ),
  rewrites: array(withFile(promotionRewrite)),
  suggestions: array(withFile(promotionSuggestion)),
  refusals: array(withFile(promotionRefusal)),
  notes: array(promotionNote),
  applicable: optional(boolean, true),
  conflicts: optional(array(promotionConflict), []),
});

/** A startup-style problem a promotion would cause, located by source-relative path. */
export interface WirePromotionProblem {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** The decoded details of a promotion error: only the members the UI shows. */
export interface PromotionErrorDetails {
  readonly field: string | null;
  readonly conflicts: readonly WirePromotionConflict[];
  readonly problems: readonly WirePromotionProblem[];
  readonly hint: { readonly scenario: string; readonly overrides: string; readonly message: string } | null;
}

/** Reads the details of a promotion error envelope; anything malformed is left out. */
export function decodePromotionErrorDetails(body: unknown): PromotionErrorDetails {
  const error = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
  const attempt = <T>(decoder: Decoder<T>, value: unknown, fallback: T): T => {
    try {
      return value === undefined ? fallback : decoder(value, '');
    } catch (cause) {
      if (cause instanceof DecodeError) return fallback;
      throw cause;
    }
  };
  return {
    field: attempt(nullable(string), error['field'], null),
    conflicts: attempt(array(promotionConflict), error['conflicts'], []),
    problems: attempt(
      array(object<WirePromotionProblem>({ code: string, path: string, message: string })),
      error['errors'],
      [],
    ),
    hint: attempt(nullable(object({ scenario: string, overrides: string, message: string })), error['hint'], null),
  };
}
