import { utf8Encode } from '../bytes.js';
import type { HeaderMap, ResponseDescription } from '../types/index.js';
import { isToken } from './token.js';

/** Connection-specific fields a fixture may not define (RFC 9110 §7.6.1). */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function isFieldName(name: string): boolean {
  return isToken(name);
}

/**
 * RFC 9110 field-value characters: HTAB, visible ASCII, space, and obs-text.
 * CR, LF, NUL, and other controls are rejected so a value cannot inject fields.
 */
export function isFieldValue(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const allowed = code === 0x09 || (code >= 0x20 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
    if (!allowed) return false;
  }
  return true;
}

/**
 * A header value a fixture writes (a sidecar, or one rendered from it): any
 * well-formed Unicode text without control characters other than HTAB. It is
 * sent as its UTF-8 bytes, the bytes of the file (see `wireHeaders`).
 */
export function isFixtureFieldValue(value: string): boolean {
  return !LONE_SURROGATE.test(value) && !FIXTURE_FORBIDDEN.test(value);
}

/** An unpaired UTF-16 surrogate, which has no UTF-8 encoding. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** C0 controls except HTAB, DEL, and C1 controls. */
// eslint-disable-next-line no-control-regex
const FIXTURE_FORBIDDEN = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

/** True when `value` has a control character a fixture header value may not contain. */
export function hasFieldControl(value: string): boolean {
  return FIXTURE_FORBIDDEN.test(value);
}

/**
 * Text to the "byte string" HTTP stacks such as Node use for header values:
 * one character per byte of the value's UTF-8. ASCII is unchanged.
 */
export function encodeFieldValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\u0000-\u007f]*$/.test(value)) return value;
  let out = '';
  for (const byte of utf8Encode(value)) out += String.fromCharCode(byte);
  return out;
}

/**
 * A received header value (one character per byte, as Node and undici give it)
 * as text: its bytes decoded as UTF-8 when they are valid UTF-8, unchanged otherwise.
 */
export function decodeFieldValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\u0000-\u007f]*$/.test(value) || /[^\u0000-ÿ]/.test(value)) return value;
  const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return value;
  }
}

/**
 * The headers to write for a response: fixture values are text,
 * sent as UTF-8 bytes; a relayed upstream response already
 * holds the bytes the upstream sent, so it passes through unchanged.
 */
export function wireHeaders(response: ResponseDescription): HeaderMap {
  if (response.trace.recording !== undefined) return response.headers;
  const out: Record<string, readonly string[]> = {};
  for (const [name, values] of Object.entries(response.headers)) out[name] = values.map(encodeFieldValue);
  return out;
}
