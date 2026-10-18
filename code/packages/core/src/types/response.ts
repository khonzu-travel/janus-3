import type { HeaderMap, HttpMethod } from './request.js';
import type { UpstreamFailureReason } from '../recording/ports.js';

export interface ResponseDescription {
  readonly kind: 'response';
  /** 0 for a `reset` or `timeout` fault, which produces no response. */
  readonly status: number;
  readonly headers: HeaderMap;
  /** null = bodyless (204/205/304, HEAD). Required, so "forgot to set it" can't happen. */
  readonly body: Uint8Array | null;
  readonly trace: ResolutionTrace;
  /** What the transport does with the response. Present for every fixture-path request. */
  readonly transport?: TransportDirective;
}

/** The ways a `malformed` fault breaks HTTP/1.1 framing. */
export type MalformedForm = 'status-line' | 'header-line' | 'conflicting-length' | 'bad-chunk';

/** A slot for a `timeout` hold, released exactly once by whoever performs the hold. */
export interface HoldTicket {
  release(): void;
}

/** The held-connection limit, as the HTTP adapter implements it. */
export interface TransportCapacity {
  /** Reserves a slot for a `timeout` hold, or null when none is free. */
  tryHold(): HoldTicket | null;
}

/**
 * Core's decision, carried out by the adapter: the delay, the
 * fault, and the content coding. Core never waits, touches a socket or
 * compresses.
 */
export interface TransportDirective {
  /** Milliseconds before the first byte, or before the fault; 0 when faults are disabled. */
  readonly delayMs: number;
  /** Null when no fault is performed. */
  readonly fault:
    | null
    | { readonly kind: 'reset' }
    | { readonly kind: 'timeout'; readonly holdMs: number; readonly ticket: HoldTicket }
    | { readonly kind: 'truncate'; readonly bytes: number | null }
    | { readonly kind: 'malformed'; readonly form: MalformedForm };
  /** The content coding to apply to the body, or null for identity. */
  readonly coding: 'br' | 'gzip' | 'deflate' | null;
  /**
   * For a `HEAD` answered with a coding: the body `GET` would get, so the
   * adapter can send the compressed `Content-Length`.
   */
  readonly headBody?: Uint8Array;
  /** The answer must not get fixture CORS headers: a refused preflight, or a relayed recording. */
  readonly noCors?: boolean;
  /** Close the connection after this response (`503 fault-capacity-exceeded`). */
  readonly close?: boolean;
}

/** How a request's transport was decided. Never holds a request value. */
export interface TransportTrace {
  readonly latency: LatencyTrace | null;
  readonly fault: FaultTrace | null;
  readonly rulesTried: number;
  readonly faultSequence?: {
    readonly position: number;
    readonly steps: number;
    readonly advanced: boolean;
    readonly notAdvancedBecause?: 'head' | 'no-session' | 'simulation';
  };
  /** False when faults.enabled is false, or in a simulation. */
  readonly performed: boolean;
  /** Codings removed from the request body, outermost last. */
  readonly requestCodings: readonly string[];
  readonly responseCoding: 'br' | 'gzip' | 'deflate' | null;
  readonly cors?: 'preflight' | 'actual' | 'preflight-refused';
}

export interface LatencyTrace {
  readonly ms: number;
  readonly source: 'fault-file' | 'scenario' | 'config';
  /** The scenario whose flow.yaml set it, when source is "scenario". */
  readonly scenario?: string;
  readonly profile: { readonly ms: number } | { readonly min: number; readonly max: number };
}

export interface FaultTrace {
  readonly kind: 'reset' | 'timeout' | 'truncate' | 'malformed' | 'none';
  /** The 1-based rule that decided. */
  readonly rule: number;
  /** The 1-based step, for a fault sequence. */
  readonly step?: number;
  readonly bytes?: number;
  readonly form?: MalformedForm;
}

export interface ResolutionTrace {
  readonly snapshotVersion: string;
  /** The selected scenario; before selection, the one the request asked for or "default". */
  readonly scenario: string;
  readonly normalizedPath: string;
  readonly outcome: ResolutionOutcome;
  /**
   * The matched route template and its bound parameters, and
   * the prefixes abandoned on the way. Present once a route
   * matched, or on a miss when any template was considered.
   */
  readonly route?: RouteTrace;
  /** How the representation was chosen. Present once negotiation ran. */
  readonly negotiation?: NegotiationTrace;
  /** How fixture headers were treated. Present only when a fixture answered. */
  readonly headers?: HeadersTrace;
  /** How dynamic values were rendered. Present only when the served fixture has tokens. */
  readonly render?: RenderTrace;
  /** How the scenario was selected. Present once a scenario was selected. */
  readonly selection?: SelectionTrace;
  /** The scenario whose file answered. Present exactly when `headers` is. */
  readonly resolvedFrom?: string;
  /** Inherited files at this route and method that the selected scenario hid; present once a route and method matched. */
  readonly shadowed?: readonly ShadowedTrace[];
  /** The full number of hidden files, when `shadowed` was cut at 64. */
  readonly shadowedCount?: number;
  /** The request's session. Present once the session key was resolved. */
  readonly session?: SessionTrace;
  /** Which identity answered and what chose it. Present once an identity was chosen. */
  readonly choice?: ChoiceTrace;
  /** The `expect.yaml` check. Present when the method has one and it ran. */
  readonly expect?: ExpectTrace;
  /** The sequence that chose the response, or else the method's `sequence.yaml`. */
  readonly sequence?: SequenceTrace;
  /** Idempotency replay. Present when the method is replayable and the key header was sent. */
  readonly replay?: ReplayTrace;
  /** A recorded exchange. Present once an exchange number was claimed. */
  readonly recording?: RecordingTrace;
  /** Latency, fault, codings and CORS. Present for every request to a fixture path. */
  readonly transport?: TransportTrace;
}

/** What happened to a recorded exchange, for the request log. */
export interface RecordingTrace {
  readonly scenario: string;
  /** Six decimal digits. */
  readonly exchange: string;
  readonly outcome: 'captured' | 'capture-failed' | 'upstream-failed' | 'upstream-timeout' | 'response-too-large';
  readonly upstreamMs: number;
  /** The upstream's origin only: never its path or query. */
  readonly upstream: string;
  /** Why no response arrived; never the upstream's error text. */
  readonly failure?: 'connect' | 'timeout' | 'too-large';
  /** For a `connect` failure: the reason from the fixed list. */
  readonly reason?: UpstreamFailureReason;
}

export interface ChoiceTrace {
  /** `200` or `200.empty`. */
  readonly identity: string;
  readonly by: 'expect' | 'rule' | 'page' | 'sequence' | 'plain';
  /** The 1-based rule that matched. A rule sequence sets both `rule` and `step`. */
  readonly rule?: number;
  readonly page?: {
    /** The page key as the fixture writes it; null when `otherwise` decided. */
    readonly key: string | null;
    readonly via: 'value' | 'whenAbsent' | 'otherwise';
  };
  /** The 1-based step that answered. */
  readonly step?: number;
  /** Rules whose conditions were evaluated, including the one that matched. */
  readonly rulesTried: number;
}

export interface ExpectTrace {
  readonly passed: boolean;
  /** The references of the failing conditions, in file order; never their values. */
  readonly failed: readonly string[];
}

export interface SequenceTrace {
  /** Null for `sequence.yaml`, else the rule number. */
  readonly rule: number | null;
  /** The step this request got, or would get. */
  readonly position: number;
  readonly steps: number;
  readonly advanced: boolean;
  readonly notAdvancedBecause?: 'head' | 'no-session' | 'not-chosen' | 'not-served' | 'simulation';
}

export interface ReplayTrace {
  readonly outcome: 'stored' | 'replayed' | 'key-reused' | 'no-session' | 'not-stored' | 'would-replay';
}

export interface SelectionTrace {
  readonly source: 'caller' | 'request-header' | 'session' | 'config' | 'default';
  /** The selected scenario first, ending with "default". */
  readonly chain: readonly string[];
}

export interface ShadowedTrace {
  /** The ancestor holding the file. */
  readonly scenario: string;
  readonly fixtureId: string;
  readonly by: 'replaced' | 'overrides' | 'removes';
}

export interface SessionTrace {
  /** Null for the default session. A derived ID is a hash, never the credential. */
  readonly id: string | null;
  readonly source: 'header' | 'derived' | 'default';
  /** False when the key names no session. */
  readonly exists: boolean;
}

export interface RenderTrace {
  /** The instant tokens rendered against, RFC 3339 in UTC. */
  readonly instant: string;
  readonly clockSource: 'caller' | 'request-header' | 'session' | 'server-default' | 'wall-clock';
  /** Number of tokens in the served body and headers. */
  readonly tokens: number;
  /** True when the same request could get different bytes: a `:unique` token, or a moving clock. */
  readonly nondeterministic: boolean;
}

export interface RouteTrace {
  /** Canonical template, e.g. "/v1/products/{productId}"; null when no complete route matched. */
  readonly template: string | null;
  /** Parameter name → the decoded path segment it bound. Empty for a miss. */
  readonly params: Readonly<Record<string, string>>;
  /** Templates that matched a prefix of the path and were abandoned, in the order tried. */
  readonly considered: readonly string[];
}

/**
 * Negotiation results. `requested` is the canonical range that decided the
 * choice (e.g. "application/*"), never the raw request header; null when no
 * range did.
 */
export interface NegotiationTrace {
  readonly language?: {
    readonly requested: string | null;
    /** The selected language tag, or null for the language-neutral group. */
    readonly selected: string | null;
  };
  readonly mediaType?: {
    readonly requested: string | null;
    /** The media types the selected group offers. */
    readonly available: readonly string[];
    readonly selected: string | null;
    /**
     * 1-based positions of unusable `Accept` members ("#2"), counted across
     * field lines. The members themselves are echoed only in `X-Mock-Warning`.
     */
    readonly droppedRanges: readonly string[];
  };
}

export interface HeadersTrace {
  /** The served fixture's Atlas ID (`fx_…`): the same value as `X-Mock-Identity`. */
  readonly identity: string;
  /** Janus-computed header names removed from the sidecar. */
  readonly dropped: readonly string[];
  readonly contentTypeOverride: { readonly representation: string; readonly wire: string } | null;
}

export type ResolutionOutcome =
  | { readonly kind: 'matched'; readonly fixture: FixtureRef }
  | { readonly kind: 'route-not-found' }
  | { readonly kind: 'method-not-allowed'; readonly allowed: readonly HttpMethod[] }
  /**
   * No representation is acceptable. `axis: "language"`: only localized groups
   * exist and none matches `Accept-Language`; `available` lists their tags.
   * `axis: "media-type"`: `available` lists the selected group's media types.
   */
  | { readonly kind: 'not-acceptable'; readonly axis: 'language' | 'media-type'; readonly available: readonly string[] }
  /** The request body's media type is not in the method's `accepts.yaml`. */
  | { readonly kind: 'unsupported-media-type'; readonly accepted: readonly string[] }
  | { readonly kind: 'invalid-request'; readonly reason: string }
  /**
   * A dynamic value could not be rendered. `token` is its
   * expression and `reason` says why; neither records a request value.
   */
  | { readonly kind: 'render-failed'; readonly fixture: FixtureRef; readonly token: string; readonly reason: string }
  /** The selected name matches no scenario. `known` is sorted and cut at 50 names. */
  /** `expect.yaml` failed without `onMismatch`. `failed` lists references, never values. */
  | { readonly kind: 'expectation-failed'; readonly failed: readonly string[] }
  /** A stored idempotency key was reused with a different request. */
  | { readonly kind: 'idempotency-key-reused' }
  /** `X-Mock-Record: true` on a request no registration allows, or a `HEAD`. */
  | { readonly kind: 'recording-not-allowed' }
  /**
   * A simulation of a request that would be forwarded: the
   * registration, the URL that would be requested and the header names sent.
   */
  | {
      readonly kind: 'would-record';
      readonly registration: { readonly method: HttpMethod; readonly path: string };
      readonly upstream: string;
      readonly forwardedHeaders: readonly string[];
    }
  /** The upstream's response, relayed. */
  | {
      readonly kind: 'recorded';
      readonly registration: { readonly method: HttpMethod; readonly path: string };
      readonly status: number;
    }
  /** Recording failures. */
  | { readonly kind: 'recording-unavailable' }
  | { readonly kind: 'recording-busy' }
  | { readonly kind: 'recording-capture-failed' }
  | { readonly kind: 'recording-upstream-failed' }
  | { readonly kind: 'recording-upstream-timeout' }
  | { readonly kind: 'recording-response-too-large' }
  /** A `reset` or `timeout` fault: no response is produced. */
  | { readonly kind: 'fault'; readonly fault: 'reset' | 'timeout' }
  /** A `timeout` fault found every hold slot taken. */
  | { readonly kind: 'fault-capacity-exceeded' }
  /** `OPTIONS` answered by Janus. `allowed` is empty when `Allow` is withheld. */
  | { readonly kind: 'automatic-options'; readonly allowed: readonly HttpMethod[] }
  /** A fixture preflight answered by Janus. */
  | { readonly kind: 'preflight'; readonly allowed: readonly HttpMethod[] }
  | {
      readonly kind: 'unknown-scenario';
      readonly source: SelectionTrace['source'];
      readonly known: readonly string[];
      readonly knownCount?: number;
    };

export interface FixtureRef {
  /** Source-relative path, e.g. "default/v1/products/GET/200.json". */
  readonly path: string;
  /** For a promoted fixture, the capture it came from and its review state. */
  readonly provenance?: { readonly capture: string; readonly review: 'pending' | 'reviewed' };
}
