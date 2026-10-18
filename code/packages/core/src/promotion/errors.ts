import type { RequestErrorCode } from '../errors/index.js';

/** The request error codes promotion answers with. */
export type PromotionErrorCode = Extract<
  RequestErrorCode,
  | 'invalid-request'
  | 'unsupported-media-type'
  | 'request-too-large'
  | 'unknown-scenario'
  | 'atlas-resource-not-found'
  | 'atlas-snapshot-stale'
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
  // Creating a scenario, which writes through the same ports
  | 'atlas-invalid-request'
  | 'scenario-invalid-name'
  | 'scenario-exists'
>;

/**
 * A promotion or review refused with an HTTP status and code. Thrown inside
 * planning and caught where the request is answered; never escapes core.
 */
export class PromotionError extends Error {
  override readonly name = 'PromotionError';

  constructor(
    readonly status: number,
    readonly code: PromotionErrorCode,
    message: string,
    /** Error envelope members after `message`: file keys, codes and field names, never file content. */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}
