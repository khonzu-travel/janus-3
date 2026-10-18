import type { HeaderMap, HttpMethod, RequestDescription } from '../types/index.js';
import { normalizeTarget, type QueryPair, type TargetOptions } from './target.js';
import { normalizeMethod } from './token.js';

/** Core's internal, normalised view of a request. Not exported from core. */
export interface NormalizedRequest {
  readonly method: HttpMethod; // uppercased and validated
  readonly pathSegments: readonly string[]; // decoded, dot-segments rejected
  /** Ordered pairs: query order and repeats are significant. */
  readonly query: readonly QueryPair[];
  readonly headers: HeaderMap;
  readonly body: Uint8Array | null;
}

export type NormalizeResult =
  | { readonly ok: true; readonly request: NormalizedRequest }
  | { readonly ok: false; readonly reason: string; readonly method: HttpMethod | null };

export function normalizeRequest(request: RequestDescription, options: TargetOptions = {}): NormalizeResult {
  const method = normalizeMethod(request.method);
  if (method === null) return { ok: false, reason: 'the request method is not a valid HTTP token', method: null };
  const target = normalizeTarget(request.target, options);
  if (!target.ok) return { ok: false, reason: target.reason, method };
  return {
    ok: true,
    request: {
      method,
      pathSegments: target.segments,
      query: target.query,
      headers: request.headers,
      body: request.body ?? null,
    },
  };
}
