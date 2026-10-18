import { utf8Encode } from '../bytes.js';

/** Stable `error.code` values for Janus-generated request errors. */
export type RequestErrorCode =
  | 'invalid-request'
  | 'route-not-found'
  | 'method-not-allowed'
  | 'not-acceptable'
  | 'unsupported-media-type'
  | 'request-too-large'
  | 'internal-error'
  // Atlas stream limit and shutdown
  | 'service-unavailable'
  // Dynamic values
  | 'render-failed'
  // Transport limits
  | 'url-too-long'
  | 'headers-too-large'
  // Host check on a loopback listener
  | 'host-not-allowed'
  // Atlas
  | 'atlas-invalid-request'
  | 'atlas-snapshot-stale'
  | 'atlas-resource-not-found'
  // Untrusted origin on a state-changing Atlas request
  | 'atlas-origin-forbidden'
  // Scenarios and sessions
  | 'unknown-scenario'
  | 'session-required'
  | 'session-not-found'
  | 'session-forbidden'
  | 'session-exists'
  | 'no-session-clock'
  | 'session-limit'
  // Choosing between responses
  | 'expectation-failed'
  | 'idempotency-key-reused'
  | 'not-mocked'
  // Recording
  | 'recording-not-allowed'
  | 'recording-unavailable'
  | 'recording-busy'
  | 'recording-capture-failed'
  | 'recording-upstream-failed'
  | 'recording-upstream-timeout'
  | 'recording-response-too-large'
  // Faults and transport
  | 'decoded-body-too-large'
  | 'unsupported-content-encoding'
  | 'unsupported-expectation'
  | 'fault-capacity-exceeded'
  // Promotion
  | 'promotion-conflict'
  | 'capture-modified'
  | 'capture-body-unavailable'
  | 'capture-unreadable'
  | 'promotion-invalid-path'
  | 'promotion-template-conflict'
  | 'promotion-unknown-id'
  | 'promotion-invalid-tree'
  | 'promotion-unavailable'
  | 'promotion-write-failed'
  // Creating a scenario from Atlas
  | 'scenario-invalid-name'
  | 'scenario-exists'
  // Request runner
  | 'request-invalid'
  | 'request-changed'
  | 'precondition-required'
  | 'folder-not-empty'
  | 'unknown-environment'
  | 'runner-busy'
  | 'run-finished'
  | 'import-destination-exists'
  | 'import-unsupported-format'
  | 'import-invalid'
  | 'import-too-large'
  | 'requests-write-failed';

export const ERROR_CONTENT_TYPE = 'application/json';

export interface ErrorEnvelopeInput {
  readonly code: RequestErrorCode;
  /** Safe diagnostic text: no stack traces, absolute paths, or credentials. */
  readonly message: string;
  /** Members after `message`, such as `unknown-scenario`'s `source` and `known`. */
  readonly details?: Readonly<Record<string, unknown>> | undefined;
  readonly requestId?: string | undefined;
}

/**
 * Encodes the error envelope every Janus-generated request error uses:
 * `{"error":{"code":…,"message":…,"requestId":…}}`. Key order is fixed so all
 * delivery modes produce byte-identical errors.
 */
export function encodeErrorEnvelope(input: ErrorEnvelopeInput): Uint8Array {
  const error: Record<string, unknown> = { code: input.code, message: input.message, ...input.details };
  if (input.requestId !== undefined) error['requestId'] = input.requestId;
  return utf8Encode(JSON.stringify({ error }));
}
