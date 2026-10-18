/** Lower-cased header name → values in arrival order. Always an array, so repeats are never lost. */
export type HeaderMap = Readonly<Record<string, readonly string[]>>;

/** Uppercase method token. Kept open (not a union) so the engine can classify unknown methods itself. */
export type HttpMethod = string;

export interface RequestDescription {
  readonly method: HttpMethod;
  /** Raw request-target exactly as received ("/v1/a%2Fb?x=1"). Never pre-decoded; only core/src/http normalises it. */
  readonly target: string;
  readonly headers: HeaderMap;
  /**
   * The same header fields as lines, in the order received, when the transport
   * has them. Only recording reads them, to forward the lines in order; everything else reads `headers`.
   */
  readonly headerLines?: readonly (readonly [fieldName: string, fieldValue: string])[];
  /** Absent = no body; an empty Uint8Array = a body of zero bytes. Always decoded. */
  readonly body?: Uint8Array;
  /** The `Content-Encoding` codings the transport removed from `body`, in the order applied. */
  readonly bodyCodings?: readonly string[];
  /**
   * The body as received, before `bodyCodings` were removed. Recording
   * forwards these bytes and never re-encodes; everything
   * else reads `body`.
   */
  readonly receivedBody?: Uint8Array;
  /**
   * The scenario to resolve against, ahead of every other source. Absent: `X-Mock-Scenario`, the
   * session's pin, `scenarios.default`,
   * then "default".
   */
  readonly scenario?: string;
  /** Epoch ms that overrides the injected wall clock for this request. Core never reads a clock itself. */
  readonly nowMs?: number;
  /** Transport-supplied correlation value, echoed in error envelopes. Must be safe to disclose. */
  readonly requestId?: string;
}
