/** Portable byte helpers. Core uses these instead of Node's `Buffer`. */

const encoder = new TextEncoder();

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Decodes strict UTF-8, or returns null when the bytes are not valid UTF-8. A leading BOM is dropped. */
export function utf8DecodeStrict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard, padded base64 (RFC 4648 §4). Portable: no `Buffer` or `btoa`. */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64.charAt((triple >> 18) & 63) + BASE64.charAt((triple >> 12) & 63);
    out += i + 1 < bytes.length ? BASE64.charAt((triple >> 6) & 63) : '=';
    out += i + 2 < bytes.length ? BASE64.charAt(triple & 63) : '=';
  }
  return out;
}

/** Decodes standard, padded base64 (RFC 4648 §4) strictly; null for anything else, including whitespace. */
export function fromBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let offset = 0;
  for (let i = 0; i < text.length; i += 4) {
    let triple = 0;
    for (let j = 0; j < 4; j++) {
      const char = text.charAt(i + j);
      triple = (triple << 6) | (char === '=' ? 0 : BASE64.indexOf(char));
    }
    const bytes = [(triple >> 16) & 255, (triple >> 8) & 255, triple & 255];
    for (const byte of bytes) if (offset < out.length) out[offset++] = byte;
  }
  // Canonical only: the unused bits of the last character must be zero, so each input has one spelling.
  return toBase64(out) === text ? out : null;
}
