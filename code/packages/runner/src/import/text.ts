/**
 * Small platform-neutral helpers for reading untrusted import sources as data:
 * UTF-8, base64 and safe access to parsed JSON and YAML.
 */

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const encoder = new TextEncoder();

/** The bytes as UTF-8 text, or null when they are not valid UTF-8. A leading BOM is dropped. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Parses JSON text, returning undefined when it does not parse. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_INDEX = new Map(Array.from({ length: BASE64.length }, (_, index) => [BASE64.charAt(index), index]));

export function base64Encode(bytes: Uint8Array): string {
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

/** Decodes base64 (standard or URL-safe, padding optional); null when the text is not base64. */
export function base64Decode(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (clean.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    const digit = BASE64_INDEX.get(char);
    if (digit === undefined) return null;
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 255;
    }
  }
  return out.subarray(0, index);
}

export type JsonRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as a record, or an empty one. */
export function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

/** The value as an array, or an empty one. */
export function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/** A string, or a number or boolean as its text; undefined for anything else. */
export function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** The last "/"-separated part of a path, without a Windows drive or directories. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? '';
}
