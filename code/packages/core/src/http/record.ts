import type { HeaderMap } from '../types/index.js';

/** The recording control header, lower-cased. */
export const RECORD_HEADER = 'x-mock-record';

/** The diagnostic header naming a recorded exchange. */
export const RECORDED_HEADER = 'x-mock-recorded';

/** The diagnostic header saying how an auto promotion ended. */
export const PROMOTED_HEADER = 'x-mock-promoted';

export type RecordHeader =
  | { readonly kind: 'absent' }
  | { readonly kind: 'record'; readonly record: boolean }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * `X-Mock-Record`: absent or `false` resolves normally, `true`
 * records, and anything else, or more than one field line, is invalid. Values
 * compare ASCII case-insensitively after trimming optional whitespace.
 */
export function parseRecordHeader(headers: HeaderMap): RecordHeader {
  const values = headers[RECORD_HEADER];
  if (values === undefined || values.length === 0) return { kind: 'absent' };
  const value = (values[0] ?? '').replace(/^[ \t]+|[ \t]+$/g, '').toLowerCase();
  if (values.length > 1 || (value !== 'true' && value !== 'false')) {
    return { kind: 'invalid', reason: 'the X-Mock-Record header must occur once, with the value true or false' };
  }
  return { kind: 'record', record: value === 'true' };
}
