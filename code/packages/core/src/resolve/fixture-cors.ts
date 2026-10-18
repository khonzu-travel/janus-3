import { compareStrings } from '../canonical.js';
import type { EngineConfig } from '../config/merge.js';
import { RESERVED_SEGMENT } from '../fixtures/build.js';
import { searchRoute, type SnapshotData } from '../fixtures/snapshot.js';
import { ANY_ORIGIN, parseOrigin } from '../http/origin.js';
import { isToken } from '../http/token.js';
import type { HeaderMap, HttpMethod } from '../types/index.js';

/**
 * CORS for fixture routes. Separate from the Atlas's
 * `cors.origins`: it never applies under `/_janus`, and the Atlas's never
 * applies here.
 */

export type FixtureCorsSettings = EngineConfig['fixtureCors'];

/** The CORS-safelisted response headers, which a page can always read. */
const SAFELISTED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'cache-control',
  'content-language',
  'content-length',
  'content-type',
  'expires',
  'last-modified',
  'pragma',
]);

/** True for an `OPTIONS` request carrying both `Origin` and `Access-Control-Request-Method`. */
export function isPreflightRequest(method: string, headers: HeaderMap): boolean {
  return (
    method === 'OPTIONS' &&
    (headers['origin']?.length ?? 0) > 0 &&
    (headers['access-control-request-method']?.length ?? 0) > 0
  );
}

/** `Access-Control-Allow-Origin` for a listed origin, or null when the origin is absent, malformed or unlisted. */
export function allowedFixtureOrigin(headers: HeaderMap, settings: FixtureCorsSettings): string | null {
  const values = headers['origin'];
  if (settings.origins.length === 0 || values?.length !== 1) return null;
  const value = values[0] ?? '';
  const origin = parseOrigin(value);
  if (origin === null) return null;
  if (settings.origins[0] === ANY_ORIGIN) return ANY_ORIGIN;
  return settings.origins.includes(origin.serialized) ? value : null;
}

export type PreflightDecision =
  | {
      readonly ok: true;
      readonly headers: Readonly<Record<string, readonly string[]>>;
      readonly allowed: readonly string[];
    }
  | { readonly ok: false };

/**
 * Decides a fixture preflight from every scenario's routes:
 * a preflight carries no scenario, so the union of what any scenario serves
 * at the path decides. `x-mock-record` is never allowed.
 */
export function decidePreflight(
  snapshot: SnapshotData,
  segments: readonly string[],
  headers: HeaderMap,
  settings: FixtureCorsSettings,
): PreflightDecision {
  const origin = allowedFixtureOrigin(headers, settings);
  if (origin === null) return { ok: false };
  const methods = new Set<HttpMethod>();
  for (const scenario of snapshot.scenarios.values()) {
    const match = searchRoute(scenario.root, segments, RESERVED_SEGMENT).match;
    if (match === undefined) continue;
    for (const method of match.node.methods.keys()) methods.add(method);
  }
  if (methods.has('GET')) methods.add('HEAD');
  const requestMethods = headers['access-control-request-method'] ?? [];
  const requested = requestMethods.length === 1 ? (requestMethods[0] ?? '').trim() : null;
  if (requested === null || !methods.has(requested)) return { ok: false };
  const requestedHeaders: string[] = [];
  for (const value of headers['access-control-request-headers'] ?? []) {
    for (const part of value.split(',')) {
      const name = part.trim().toLowerCase();
      if (name === '') continue;
      if (!isToken(name) || name === 'x-mock-record') return { ok: false };
      if (!requestedHeaders.includes(name)) requestedHeaders.push(name);
    }
  }
  const allowed = Object.freeze([...methods].sort(compareStrings));
  const answer: Record<string, readonly string[]> = {
    'access-control-allow-origin': [origin],
    'access-control-allow-methods': [allowed.join(', ')],
  };
  if (requestedHeaders.length > 0) answer['access-control-allow-headers'] = [requestedHeaders.join(', ')];
  if (settings.credentials) answer['access-control-allow-credentials'] = ['true'];
  answer['access-control-max-age'] = [String(settings.maxAge)];
  answer['vary'] = ['Origin, Access-Control-Request-Method, Access-Control-Request-Headers'];
  return { ok: true, headers: Object.freeze(answer), allowed };
}

/**
 * The CORS headers an actual response to a fixture path gets:
 * `Vary: Origin` whenever fixture CORS is on, and for a listed origin
 * `Access-Control-Allow-Origin`, `-Allow-Credentials` and `-Expose-Headers`
 * naming every header the response carries that a page could not otherwise read.
 */
export function fixtureCorsHeaders(
  settings: FixtureCorsSettings,
  requestHeaders: HeaderMap,
  responseHeaderNames: Iterable<string>,
): Record<string, string> {
  if (settings.origins.length === 0) return {};
  const origin = allowedFixtureOrigin(requestHeaders, settings);
  if (origin === null) return {};
  const exposed = new Set<string>();
  for (const name of responseHeaderNames) {
    const lower = name.toLowerCase();
    if (SAFELISTED_RESPONSE_HEADERS.has(lower) || lower.startsWith('access-control-') || lower === 'set-cookie') {
      continue;
    }
    exposed.add(lower);
  }
  return {
    'access-control-allow-origin': origin,
    ...(settings.credentials ? { 'access-control-allow-credentials': 'true' } : {}),
    ...(exposed.size === 0 ? {} : { 'access-control-expose-headers': [...exposed].sort(compareStrings).join(', ') }),
  };
}
