/**
 * `Content-Encoding`, `Accept-Encoding` and `Expect` parsing. Pure string handling: the adapter
 * decompresses, compresses and
 * sends `100 Continue`.
 */
import type { CompressionCoding } from '../config/schema.js';
import type { HeaderMap } from '../types/index.js';
import { isToken } from './token.js';

/** Request codings Janus decodes, lower-cased. */
export type RequestCoding = 'gzip' | 'x-gzip' | 'deflate' | 'br';
const REQUEST_CODINGS: ReadonlySet<string> = new Set(['gzip', 'x-gzip', 'deflate', 'br']);

/** At most this many codings in one request's `Content-Encoding`. */
export const MAX_REQUEST_CODINGS = 4;

/** What `415 unsupported-content-encoding` advertises, as RFC 9110 §12.5.3 describes. */
export const ACCEPTED_REQUEST_ENCODINGS = 'br, deflate, gzip';

export type ContentEncoding =
  /** The codings to remove, in the order they were applied; `identity` left out. Empty: nothing to decode. */
  | { readonly kind: 'codings'; readonly codings: readonly RequestCoding[] }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'malformed' };

/**
 * Reads a request's `Content-Encoding` across its field lines. An unknown
 * coding, or more than four, is unsupported; a member that is not a token is
 * malformed. Codings compare case-insensitively.
 */
export function parseContentEncoding(values: readonly string[] | undefined): ContentEncoding {
  const members = listMembers(values);
  if (members === null) return { kind: 'malformed' };
  if (members.length > MAX_REQUEST_CODINGS) return { kind: 'unsupported' };
  const codings: RequestCoding[] = [];
  for (const member of members) {
    if (!isToken(member)) return { kind: 'malformed' };
    const coding = member.toLowerCase();
    if (coding === 'identity') continue;
    if (!REQUEST_CODINGS.has(coding)) return { kind: 'unsupported' };
    codings.push(coding as RequestCoding);
  }
  return { kind: 'codings', codings: Object.freeze(codings) };
}

const WEIGHT = /^(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * The response coding `Accept-Encoding` asks for among `encodings`: the highest quality wins, ties
 * go to the earlier configured coding,
 * `*` covers configured codings not listed, and `q=0` is never chosen. Null
 * means the body goes as it is: no header, only `identity`, nothing
 * acceptable, or a malformed field.
 */
export function chooseResponseCoding(
  values: readonly string[] | undefined,
  encodings: readonly CompressionCoding[],
): CompressionCoding | null {
  if (values === undefined) return null;
  const members = listMembers(values);
  if (members === null) return null;
  const weights = new Map<string, number>();
  for (const member of members) {
    const [name = '', ...parameters] = member.split(';').map((part) => part.trim());
    if (!isToken(name)) return null;
    let weight = 1000;
    for (const parameter of parameters) {
      const match = /^q=(.*)$/i.exec(parameter);
      if (match === null || !WEIGHT.test(match[1] ?? '')) return null;
      weight = Math.round(Number(match[1]) * 1000);
    }
    const coding = name.toLowerCase() === 'x-gzip' ? 'gzip' : name.toLowerCase();
    weights.set(coding, Math.max(weights.get(coding) ?? 0, weight));
  }
  let best: CompressionCoding | null = null;
  let bestWeight = 0;
  for (const coding of encodings) {
    const weight = weights.get(coding) ?? weights.get('*') ?? 0;
    if (weight > bestWeight) {
      best = coding;
      bestWeight = weight;
    }
  }
  return best;
}

export type Expectation = { readonly kind: 'none' } | { readonly kind: 'continue' } | { readonly kind: 'unsupported' };

/** Reads `Expect`: only `100-continue`, compared case-insensitively, is met. */
export function parseExpect(headers: HeaderMap): Expectation {
  const members = listMembers(headers['expect']);
  if (members === null) return { kind: 'unsupported' };
  if (members.length === 0) return headers['expect'] === undefined ? { kind: 'none' } : { kind: 'unsupported' };
  return members.every((member) => member.toLowerCase() === '100-continue')
    ? { kind: 'continue' }
    : { kind: 'unsupported' };
}

/** The non-empty members of a comma-separated list across field lines; null when a member is quoted. */
function listMembers(values: readonly string[] | undefined): string[] | null {
  const members: string[] = [];
  for (const value of values ?? []) {
    if (value.includes('"')) return null;
    for (const part of value.split(',')) {
      const member = part.trim();
      if (member !== '') members.push(member);
    }
  }
  return members;
}
