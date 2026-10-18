import { isToken } from './token.js';

/**
 * Decodes a filename media-type token: the first "-" stands for "/", so
 * "application-json" is "application/json" and "application-vnd.api+json" is
 * "application/vnd.api+json". Returns null when the result is not a concrete
 * `type/subtype` (neither half may contain `*`).
 */
export function decodeMediaTypeToken(token: string): string | null {
  const dash = token.indexOf('-');
  if (dash <= 0) return null;
  const type = token.slice(0, dash);
  const subtype = token.slice(dash + 1);
  if (!isToken(type) || !isToken(subtype)) return null;
  // `*` is a token character, but a file has one concrete media type, never a range.
  if (type.includes('*') || subtype.includes('*')) return null;
  return `${type}/${subtype}`;
}

/** Media types of short-form fixture file names, keyed by lower-cased extension. */
const EXTENSION_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  ['json', 'application/json'],
  ['txt', 'text/plain'],
  ['html', 'text/html'],
  ['css', 'text/css'],
  ['js', 'text/javascript'],
  ['csv', 'text/csv'],
  ['md', 'text/markdown'],
  ['xml', 'application/xml'],
  ['yaml', 'application/yaml'],
  ['yml', 'application/yaml'],
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['svg', 'image/svg+xml'],
  ['bin', 'application/octet-stream'],
]);

/** The media type a short-form file name's extension stands for, or null when the table has none. */
export function mediaTypeForExtension(extension: string): string | null {
  return EXTENSION_MEDIA_TYPES.get(extension.toLowerCase()) ?? null;
}

/**
 * The short-form extension for a media type essence: the table's first
 * extension for it (`.yaml`, `.jpg`), or null when the table has none.
 */
export function extensionForMediaType(essence: string): string | null {
  for (const [extension, mediaType] of EXTENSION_MEDIA_TYPES) if (mediaType === essence) return extension;
  return null;
}

/** Compares two Content-Type values by essence (type/subtype), case-insensitively, ignoring parameters. */
export function sameMediaType(a: string, b: string): boolean {
  return mediaTypeEssence(a) === mediaTypeEssence(b);
}

/** Lower-cased `type/subtype` of a media type value, without parameters. */
export function mediaTypeEssence(value: string): string {
  return (value.split(';')[0] ?? '').trim().toLowerCase();
}

export type MediaParameter = readonly [name: string, value: string];

export interface MediaType {
  /** Lower-cased. */
  readonly type: string;
  /** Lower-cased. */
  readonly subtype: string;
  /** Lower-cased names; values unquoted and otherwise as written, in order. */
  readonly parameters: readonly MediaParameter[];
}

/**
 * Parses a `Content-Type`-shaped value (RFC 9110 §8.3.1):
 * `type "/" subtype *( OWS ";" OWS [ name "=" ( token / quoted-string ) ] )`.
 * Returns null when it is malformed. Wildcards are ordinary tokens here; callers
 * that forbid them check for "*".
 */
export function parseMediaType(value: string): MediaType | null {
  const [head = '', ...rest] = splitOutsideQuotes(value, ';');
  const essence = head.trim();
  const slash = essence.indexOf('/');
  const type = essence.slice(0, slash);
  const subtype = essence.slice(slash + 1);
  if (slash === -1 || !isToken(type) || !isToken(subtype)) return null;
  const parameters = parseParameters(rest);
  if (parameters === null) return null;
  return { type: type.toLowerCase(), subtype: subtype.toLowerCase(), parameters };
}

/** Parses `name=value` parameters that were split on ";"; empty ones are skipped, as RFC 9110 allows. */
export function parseParameters(parts: readonly string[]): MediaParameter[] | null {
  const parameters: MediaParameter[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return null;
    const name = trimmed.slice(0, eq);
    const raw = trimmed.slice(eq + 1);
    if (!isToken(name)) return null;
    const value = raw.startsWith('"') ? unquote(raw) : isToken(raw) ? raw : null;
    if (value === null) return null;
    parameters.push([name.toLowerCase(), value]);
  }
  return parameters;
}

/** Splits `value` on `separator` outside quoted strings, honouring backslash escapes inside them. */
export function splitOutsideQuotes(value: string, separator: ',' | ';'): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i] ?? '';
    if (quoted) {
      current += char;
      if (char === '\\' && i + 1 < value.length) current += value[++i] ?? '';
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      current += char;
    } else if (char === separator) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/** The content of a complete RFC 9110 quoted-string, or null when it is not one. */
function unquote(raw: string): string | null {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return null;
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const char = raw[i] ?? '';
    if (char === '"') return null;
    if (char === '\\') {
      if (i + 1 >= raw.length - 1) return null;
      out += raw[++i] ?? '';
    } else {
      out += char;
    }
  }
  return out;
}

/** `type/subtype;name=value…` with parameters re-quoted where needed; used for canonical text. */
export function formatMediaRange(type: string, subtype: string, parameters: readonly MediaParameter[]): string {
  const params = parameters.map(([name, value]) => `;${name}=${isToken(value) ? value : quote(value)}`);
  return `${type}/${subtype}${params.join('')}`;
}

function quote(value: string): string {
  return `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`;
}
