/**
 * The two ports through which core reaches an upstream API and the captures
 * directory. The server implements both; core plans every byte.
 */

/** One header field line, name as written. */
export type HeaderLine = readonly [fieldName: string, fieldValue: string];

/** The request Janus sends upstream. */
export interface UpstreamRequest {
  /** Absolute URL: the configured origin and base path, the canonical path, the raw query. */
  readonly url: string;
  readonly method: string;
  /** In the caller's order, after the removals. The transport sets `Host` and `Content-Length`. */
  readonly headers: readonly HeaderLine[];
  /** Absent when the caller sent no body. */
  readonly body: Uint8Array | null;
}

/** Why no response arrived: the kind only, never the upstream's error text. */
export type UpstreamFailureKind = 'connect' | 'timeout' | 'too-large';

/**
 * Why a `connect` failure happened, from a fixed list. Responses and logs
 * Janus returns name only these; the error text goes to the server log alone.
 */
export const UPSTREAM_FAILURE_REASONS = Object.freeze([
  'dns',
  'refused',
  'unreachable',
  'connect-timeout',
  'reset',
  'certificate',
  'tls',
  'invalid-response',
  'invalid-request',
  'unknown',
] as const);

export type UpstreamFailureReason = (typeof UPSTREAM_FAILURE_REASONS)[number];

const REASON_TEXT: Readonly<Record<UpstreamFailureReason, string>> = {
  dns: 'the host name could not be resolved',
  refused: 'the connection was refused',
  unreachable: 'the host or network is unreachable',
  'connect-timeout': 'the connection could not be opened in time',
  reset: 'the connection was closed before a complete response arrived',
  certificate: "the upstream's TLS certificate was not trusted",
  tls: 'the TLS handshake failed',
  'invalid-response': 'the upstream sent a response that is not valid HTTP',
  'invalid-request': 'the request could not be sent as written',
  unknown: 'the connection failed',
};

/** A reason as a phrase, for messages: e.g. "the connection was refused". */
export function upstreamFailureText(reason: UpstreamFailureReason): string {
  return REASON_TEXT[reason];
}

export function isUpstreamFailureReason(value: unknown): value is UpstreamFailureReason {
  return typeof value === 'string' && (UPSTREAM_FAILURE_REASONS as readonly string[]).includes(value);
}

export type UpstreamResponse =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly headers: readonly HeaderLine[];
      readonly body: Uint8Array;
    }
  | {
      readonly kind: 'failure';
      readonly failure: UpstreamFailureKind;
      /** Set for `connect` failures; absent means `unknown`. */
      readonly reason?: UpstreamFailureReason;
    };

export interface Upstream {
  /**
   * Sends one request and buffers the whole response, following no redirect
   * and decoding no content. Bounded by `recording.timeoutMs` over the whole
   * exchange and `recording.maxResponseBytes` for the body. Never rejects for
   * a network failure: it resolves with a failure kind instead.
   */
  send(request: UpstreamRequest, signal: AbortSignal): Promise<UpstreamResponse>;
}

/** A claimed exchange number. Issued only by the sink. */
export interface CaptureReservation {
  readonly scenario: string;
  /** Eight random lowercase hex digits, e.g. `3f9a0c1e`; see `EXCHANGE_PATTERN`. */
  readonly exchange: string;
}

/** An exchange's outcome in the scenario log. */
export type CaptureOutcome =
  'captured' | 'capture-failed' | 'upstream-failed' | 'upstream-timeout' | 'response-too-large';

/** One line of `log.jsonl`. */
export interface CaptureLogEntry {
  readonly exchange: string;
  /** Wall-clock RFC 3339 instant when the exchange completed. */
  readonly at: string;
  readonly method: string;
  /** The request target as received. */
  readonly target: string;
  /** The registration's path template. */
  readonly registration: string;
  readonly outcome: CaptureOutcome;
  /** The upstream's status; absent when no response arrived. */
  readonly status?: number;
  /** `upstream-failed` lines: why, from the fixed list; never the error text. */
  readonly reason?: UpstreamFailureReason;
  readonly durationMs: number;
  /** `runner` for an exchange the request runner sent; absent means `recording`. */
  readonly source?: CaptureSourceKind;
  /** Runner captures: the run's ID and the request ID. */
  readonly run?: string;
  readonly request?: string;
}

/** Who sent a captured exchange. */
export type CaptureSourceKind = 'recording' | 'runner';

/** A file of an exchange: a name from the fixed allowlist and its bytes. */
export interface CaptureFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Everything the sink writes for an exchange that has a response. */
export interface CapturePlan {
  readonly files: readonly CaptureFile[];
  /** Appended last, after every file is written and flushed. */
  readonly log: CaptureLogEntry;
}

/** The log entry of an exchange that has no response. */
export type CaptureFailureEntry = CaptureLogEntry & {
  readonly outcome: 'upstream-failed' | 'upstream-timeout' | 'response-too-large';
};

export type CaptureWriteResult = { readonly ok: true } | { readonly ok: false };

export interface CaptureSink {
  /** Claims the next exchange number by creating its directory exclusively. Rejects when none can be claimed. */
  claim(scenario: string): Promise<CaptureReservation>;
  /**
   * Writes the files, then appends the log line. When a file cannot be
   * written it removes those it wrote, appends a `capture-failed` line where
   * it can, and resolves `{ ok: false }`.
   */
  write(reservation: CaptureReservation, plan: CapturePlan): Promise<CaptureWriteResult>;
  /** Completes an exchange that has no response by appending its failure line. */
  fail(reservation: CaptureReservation, entry: CaptureFailureEntry): Promise<void>;
}

/** The recording ports passed to `createEngine`; recording is unavailable without both. */
export interface RecordingPorts {
  readonly upstream: Upstream;
  readonly captures: CaptureSink;
}

/** One `log.jsonl` line, with its newline. */
export function formatCaptureLogLine(entry: CaptureLogEntry): string {
  const { status, reason, source, run, request, ...rest } = entry;
  const ordered = {
    exchange: rest.exchange,
    at: rest.at,
    method: rest.method,
    target: rest.target,
    registration: rest.registration,
    outcome: rest.outcome,
    ...(status === undefined ? {} : { status }),
    ...(reason === undefined ? {} : { reason }),
    durationMs: rest.durationMs,
    ...(source === undefined ? {} : { source }),
    ...(run === undefined ? {} : { run }),
    ...(request === undefined ? {} : { request }),
  };
  return `${JSON.stringify(ordered)}\n`;
}
