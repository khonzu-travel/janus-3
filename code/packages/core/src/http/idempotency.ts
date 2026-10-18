/** The longest idempotency key, in characters. */
export const MAX_IDEMPOTENCY_KEY = 255;

const VISIBLE = /^[\x21-\x7e]+$/;

export type IdempotencyKeyResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * The idempotency key header: exactly one field line holding 1
 * to 255 visible ASCII characters, either bare or as an RFC 8941 string.
 * `header` is the lower-cased configured name; the reason names it as written.
 */
export function parseIdempotencyKey(lines: readonly string[] | undefined, header: string): IdempotencyKeyResult {
  if (lines === undefined || lines.length === 0) return { kind: 'absent' };
  const invalid: IdempotencyKeyResult = {
    kind: 'invalid',
    reason: `the ${header} header must occur once, with 1 to ${String(MAX_IDEMPOTENCY_KEY)} visible ASCII characters or an RFC 8941 string holding them`,
  };
  if (lines.length > 1) return invalid;
  const value = (lines[0] ?? '').trim();
  const key = value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? sfString(value) : value;
  if (key === null || key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY || !VISIBLE.test(key)) return invalid;
  return { kind: 'key', key };
}

/** Decodes an RFC 8941 sf-string (`"…"` with `\"` and `\\` escapes), or null. */
function sfString(text: string): string | null {
  let out = '';
  for (let i = 1; i < text.length - 1; i++) {
    const char = text.charAt(i);
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return null;
    if (char === '"') return null;
    if (char === '\\') {
      const next = text.charAt(i + 1);
      if (i + 1 >= text.length - 1 || (next !== '"' && next !== '\\')) return null;
      out += next;
      i++;
      continue;
    }
    out += char;
  }
  return out;
}
