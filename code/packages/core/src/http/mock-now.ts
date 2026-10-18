import { parseRfc3339 } from '../dynamic/time.js';
import type { HeaderMap } from '../types/index.js';

/** The request header that freezes the clock for one request. */
export const MOCK_NOW_HEADER = 'x-mock-now';

export type MockNow =
  | { readonly kind: 'absent' }
  | { readonly kind: 'instant'; readonly instant: number }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Reads `X-Mock-Now`: exactly one RFC 3339 instant with an offset. Repeated
 * field lines and comma-joined lists are rejected rather than picking one.
 * The reason never quotes the value.
 */
export function parseMockNow(headers: HeaderMap): MockNow {
  const values = headers[MOCK_NOW_HEADER];
  if (values === undefined || values.length === 0) return { kind: 'absent' };
  if (values.length > 1 || (values[0] ?? '').includes(',')) {
    return { kind: 'invalid', reason: 'the X-Mock-Now header must occur exactly once, with one instant' };
  }
  const instant = parseRfc3339((values[0] ?? '').trim());
  if (instant === null) {
    return {
      kind: 'invalid',
      reason: 'the X-Mock-Now header must be an RFC 3339 instant with an offset, e.g. 2026-01-01T00:00:00Z',
    };
  }
  return { kind: 'instant', instant };
}
