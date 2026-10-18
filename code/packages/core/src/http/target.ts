/**
 * Request-target normalisation. This is the only place
 * request paths are canonicalised (architecture invariant 3).
 */

export type QueryPair = readonly [name: string, value: string];

export type TargetResult =
  | { readonly ok: true; readonly segments: readonly string[]; readonly query: readonly QueryPair[] }
  | { readonly ok: false; readonly reason: string };

export interface TargetOptions {
  /** Defaults to true. */
  readonly strictTrailingSlash?: boolean;
}

export type SegmentResult =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };

/**
 * Normalises a raw origin-form request target:
 *
 * 1. split at the first "?" into path and query;
 * 2. require the path to begin with "/";
 * 3. split the path on literal "/" before any decoding;
 * 4. percent-decode each segment exactly once as UTF-8;
 * 5. reject malformed escapes, invalid UTF-8, NUL, decoded "/", empty interior segments, "." and "..";
 * 6. NFC-normalise; 7. preserve case; 8. "" and "/" are zero segments.
 *
 * By default (`strictTrailingSlash: true`) a trailing "/" leaves a final empty
 * segment, which no fixture can define, so it never silently aliases the path
 * without it. With `strictTrailingSlash: false`, exactly one trailing "/" is
 * dropped before matching: "/a/" is "/a", "/a//" is still invalid, and "/" is
 * unchanged.
 */
export function normalizeTarget(target: string, options: TargetOptions = {}): TargetResult {
  const queryStart = target.indexOf('?');
  const rawPath = queryStart === -1 ? target : target.slice(0, queryStart);
  const rawQuery = queryStart === -1 ? '' : target.slice(queryStart + 1);

  if (!rawPath.startsWith('/')) return { ok: false, reason: 'the request target must be a path beginning with "/"' };

  const segments: string[] = [];
  if (rawPath !== '/') {
    const parts = rawPath.slice(1).split('/');
    for (const [index, part] of parts.entries()) {
      const isLast = index === parts.length - 1;
      if (part === '') {
        if (!isLast) return { ok: false, reason: `path segment ${String(index + 1)} is empty` };
        if (options.strictTrailingSlash !== false) segments.push('');
        continue;
      }
      const decoded = decodePathSegment(part);
      if (!decoded.ok) return { ok: false, reason: `path segment ${String(index + 1)} ${decoded.reason}` };
      segments.push(decoded.value);
    }
  }

  return { ok: true, segments, query: parseQuery(rawQuery) };
}

/**
 * Decodes and validates one raw path segment. Shared by request normalisation
 * and fixture directory names, so both sides agree on what a segment means.
 */
export function decodePathSegment(raw: string): SegmentResult {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false, reason: 'has a malformed percent-escape or invalid UTF-8' };
  }
  if (decoded === '') return { ok: false, reason: 'is empty' };
  if (decoded.includes('\0')) return { ok: false, reason: 'contains NUL' };
  if (decoded.includes('/')) return { ok: false, reason: 'contains an encoded "/"' };
  if (decoded === '.' || decoded === '..') return { ok: false, reason: 'is a dot-segment' };
  return { ok: true, value: decoded.normalize('NFC') };
}

/** Parses a query string into ordered pairs, keeping repeats and blank values. Undecodable parts stay raw. */
export function parseQuery(rawQuery: string): QueryPair[] {
  const pairs: QueryPair[] = [];
  if (rawQuery === '') return pairs;
  for (const piece of rawQuery.split('&')) {
    if (piece === '') continue;
    const eq = piece.indexOf('=');
    const name = eq === -1 ? piece : piece.slice(0, eq);
    const value = eq === -1 ? '' : piece.slice(eq + 1);
    pairs.push([decodeQueryComponent(name), decodeQueryComponent(value)]);
  }
  return pairs;
}

function decodeQueryComponent(raw: string): string {
  const spaced = raw.replaceAll('+', ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

const PATH_SAFE = /[!$&'()*+,;=:@]/;

/** Formats decoded segments as a canonical, re-encoded path for traces, logs, and error messages. */
export function formatPath(segments: readonly string[]): string {
  return '/' + segments.map(encodePathSegment).join('/');
}

/** A route segment: a decoded literal, or a `{name}` path parameter. */
export type RouteSegment =
  { readonly kind: 'literal'; readonly value: string } | { readonly kind: 'param'; readonly name: string };

/** Formats a route template: literals re-encoded as `formatPath` does, parameters as `{name}`. */
export function formatTemplate(segments: readonly RouteSegment[]): string {
  return (
    '/' +
    segments
      .map((segment) => (segment.kind === 'param' ? `{${segment.name}}` : encodePathSegment(segment.value)))
      .join('/')
  );
}

/** One decoded segment as `formatPath` writes it: UTF-8 percent-encoding, `!$&'()*+,;=:@` and unreserved kept. */
export function encodePathSegment(segment: string): string {
  let out = '';
  for (const char of segment) out += PATH_SAFE.test(char) ? char : encodeURIComponent(char);
  return out;
}
