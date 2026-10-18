import { ANY_ORIGIN, isSameAuthority, parseAuthority, parseOrigin, type HeaderMap, type Origin } from '@janus/core';

/** `cors.origins` and `cors.maxAge`. An empty list disables CORS. */
export interface CorsSettings {
  /** Normalized origins, or `["*"]`. */
  readonly origins: readonly string[];
  /** Preflight cache time, in seconds. */
  readonly maxAge: number;
}

export const NO_CORS: CorsSettings = Object.freeze({ origins: Object.freeze([]), maxAge: 600 });

/** Headers a preflight may request, lowercased. */
export const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'x-mock-now',
  'x-mock-scenario',
  'x-mock-session',
  'x-mock-session-key',
]);

/** The request's `Origin`, as the CORS rules see it. */
export type RequestOrigin =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'valid'; readonly origin: Origin; readonly value: string };

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Reads `Origin`. More than one header, `null`, a list, or
 * anything else that is not a serialized origin is malformed.
 */
export function readOrigin(headers: HeaderMap): RequestOrigin {
  const values = headers['origin'];
  if (values === undefined || values.length === 0) return { kind: 'absent' };
  if (values.length > 1) return { kind: 'malformed' };
  const value = values[0] ?? '';
  const origin = parseOrigin(value);
  return origin === null ? { kind: 'malformed' } : { kind: 'valid', origin, value };
}

/** Whether `cors.origins` lists the origin, or is `["*"]`. */
export function isListed(origin: Origin, cors: CorsSettings): boolean {
  return cors.origins.some((entry) => entry === ANY_ORIGIN || entry === origin.serialized);
}

/**
 * The `Origin` check on a state-changing Atlas request: true
 * when the request may proceed. Requests without `Origin` are allowed; the rest
 * need the request's own authority (`Host`, scheme not compared) or a listed origin.
 */
export function isTrustedOrigin(headers: HeaderMap, cors: CorsSettings): boolean {
  const origin = readOrigin(headers);
  if (origin.kind === 'absent') return true;
  if (origin.kind === 'malformed') return false;
  if (isListed(origin.origin, cors)) return true;
  const hosts = headers['host'];
  if (hosts?.length !== 1) return false;
  const authority = parseAuthority(hosts[0] ?? '');
  return authority !== null && isSameAuthority(origin.origin, authority);
}

/** `Access-Control-Allow-Origin` for an actual request from a listed origin, or null when none applies. */
export function allowOrigin(origin: RequestOrigin, cors: CorsSettings): string | null {
  if (origin.kind !== 'valid' || !isListed(origin.origin, cors)) return null;
  return cors.origins[0] === ANY_ORIGIN ? ANY_ORIGIN : origin.value;
}

/** True for an `OPTIONS` request carrying both `Origin` and `Access-Control-Request-Method`. */
export function isPreflight(method: string, headers: HeaderMap): boolean {
  return (
    method === 'OPTIONS' &&
    (headers['origin']?.length ?? 0) > 0 &&
    (headers['access-control-request-method']?.length ?? 0) > 0
  );
}

/**
 * Answers a preflight all-or-nothing: the headers of the `204`
 * when every condition holds, or null so the request is answered as a plain
 * `OPTIONS` would be. `methods` is null for an unknown or disabled path.
 */
export function preflightHeaders(
  headers: HeaderMap,
  methods: readonly string[] | null,
  cors: CorsSettings,
): Record<string, string> | null {
  const allow = allowOrigin(readOrigin(headers), cors);
  if (allow === null || methods === null) return null;
  const allowed = methods.includes('GET') && !methods.includes('HEAD') ? [...methods, 'HEAD'] : [...methods];

  const requestedMethod = headers['access-control-request-method'];
  if (requestedMethod?.length !== 1) return null;
  const method = requestedMethod[0] ?? '';
  // Compared case-sensitively, as the Fetch standard does.
  if (!TOKEN.test(method) || !allowed.includes(method)) return null;

  const requested = requestedHeaders(headers['access-control-request-headers']);
  if (requested === null || !requested.every((name) => ALLOWED_REQUEST_HEADERS.has(name))) return null;

  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': allowed.join(', '),
    ...(requested.length === 0 ? {} : { 'access-control-allow-headers': requested.join(', ') }),
    'access-control-max-age': String(cors.maxAge),
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
}

/**
 * `Access-Control-Request-Headers` split on commas, trimmed, lowercased,
 * without empty items or repeats. Null when a name is not an HTTP token.
 */
export function requestedHeaders(values: readonly string[] | undefined): string[] | null {
  const names = new Set<string>();
  for (const value of values ?? []) {
    for (const item of value.split(',')) {
      const name = item.trim().toLowerCase();
      if (name === '') continue;
      if (!TOKEN.test(name)) return null;
      names.add(name);
    }
  }
  return [...names];
}
