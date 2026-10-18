import { HOP_BY_HOP_HEADERS, SCENARIO_HEADER, type HeaderLine } from '@janus/core';

import { pathParameterNames } from './documents.js';
import type { SendRequest } from './render.js';
import { StepFailure } from './render.js';

/**
 * What each mode sends. Both modes send the request the
 * same code built; only the destination and these header changes differ.
 */

/** Names listed in `Connection`, lower-cased. */
function connectionListed(lines: readonly HeaderLine[]): ReadonlySet<string> {
  const listed = new Set<string>();
  for (const [name, value] of lines) {
    if (name.toLowerCase() !== 'connection') continue;
    for (const token of value.split(',')) if (token.trim() !== '') listed.add(token.trim().toLowerCase());
  }
  return listed;
}

/**
 * The headers Record and Upstream modes never send: hop-by-hop headers,
 * `Host`, `Content-Length`, `Expect` and every `X-Mock-*` header.
 */
function withoutJanusHeaders(headers: readonly HeaderLine[]): HeaderLine[] {
  const listed = connectionListed(headers);
  return headers.filter(([written]) => {
    const name = written.toLowerCase();
    return !(
      HOP_BY_HOP_HEADERS.has(name) ||
      listed.has(name) ||
      name === 'host' ||
      name === 'content-length' ||
      name === 'expect' ||
      name.startsWith('x-mock-')
    );
  });
}

/**
 * Record mode: the headers `withoutJanusHeaders` removes are dropped, and
 * `Accept-Encoding` becomes `identity` so the body can be stored as a fixture body.
 */
export function planRecordRequest(request: SendRequest): SendRequest {
  const headers = withoutJanusHeaders(request.headers).filter(([name]) => name.toLowerCase() !== 'accept-encoding');
  headers.push(['Accept-Encoding', 'identity']);
  return Object.freeze({ ...request, headers: Object.freeze(headers) });
}

/**
 * Upstream mode: the same removals as record mode, but `Accept-Encoding` is
 * sent as written, since nothing is stored. A compressed answer is decoded by
 * the host's `send` port.
 */
export function planUpstreamModeRequest(request: SendRequest): SendRequest {
  return Object.freeze({ ...request, headers: Object.freeze(withoutJanusHeaders(request.headers)) });
}

/** The nearest `stripPrefix` the URL's path starts with, segment for segment, or null. */
export function matchingPrefix(path: string, prefixes: readonly string[]): string | null {
  for (const prefix of prefixes) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return prefix;
  }
  return null;
}

/** The request's own `X-Mock-Scenario`, trimmed, or null when it has none (or an empty one). */
export function headerScenario(headers: readonly HeaderLine[]): string | null {
  for (const [name, value] of headers) {
    if (name.toLowerCase() === SCENARIO_HEADER && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Mock mode: the scheme, authority and nearest `stripPrefix`
 * are replaced by Janus's base path, and `X-Mock-*` headers are sent as
 * written. A request's own `X-Mock-Scenario` wins; without one, the run's
 * scenario, when one was picked, is added. Returns the target Janus resolves.
 */
export function planMockRequest(
  request: SendRequest,
  scenario: string | null,
  basePath: string,
  prefixes: readonly string[],
): { readonly target: string; readonly request: SendRequest } {
  const url = new URL(request.url);
  const prefix = matchingPrefix(url.pathname, prefixes);
  const rest = prefix === null ? url.pathname : url.pathname.slice(prefix.length) || '/';
  const base = basePath.replace(/\/+$/, '');
  const target = `${base}${rest.startsWith('/') ? rest : `/${rest}`}${url.search}`;
  const headers: HeaderLine[] = request.headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return lower !== 'host' && lower !== 'content-length';
  });
  if (scenario !== null && headerScenario(headers) === null) headers.push([SCENARIO_HEADER, scenario]);
  return { target, request: Object.freeze({ ...request, headers: Object.freeze(headers) }) };
}

/**
 * The route a record-mode capture is filed under: the
 * request's `route`, which must match the path after the prefix segment for
 * segment; otherwise that path with each `:name` written `{name}`. Checked
 * against the template rules by the caller.
 */
export function deriveRoute(
  urlTemplate: string,
  sentUrl: string,
  route: string | undefined,
  prefixes: readonly string[],
): { readonly route: string; readonly prefix: string | null } {
  const sent = new URL(sentUrl);
  const prefix = matchingPrefix(sent.pathname, prefixes);
  const path = prefix === null ? sent.pathname : sent.pathname.slice(prefix.length) || '/';
  const sentSegments = path === '/' ? [] : path.slice(1).split('/');
  if (route !== undefined) {
    const routeSegments = route === '/' ? [] : route.replace(/^\//, '').split('/');
    const matches =
      routeSegments.length === sentSegments.length &&
      routeSegments.every((segment, index) => /^\{[^}]*\}$/.test(segment) || segment === sentSegments[index]);
    if (!matches) {
      throw new StepFailure('route-invalid', `The route ${route} does not match the path ${path} segment for segment`);
    }
    return { route, prefix };
  }
  const names = pathParameterNames(urlTemplate);
  if (names.length === 0) return { route: path, prefix };
  // Find the template's path, then align its segments with the sent ones from the end.
  const templatePath = templatePathSegments(urlTemplate);
  const derived = [...sentSegments];
  for (let index = 1; index <= Math.min(templatePath.length, derived.length); index++) {
    const name = /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(templatePath[templatePath.length - index] ?? '')?.[1];
    if (name !== undefined) derived[derived.length - index] = `{${name}}`;
  }
  return { route: `/${derived.join('/')}`, prefix };
}

/** The path segments a URL template writes after its authority (or its leading variable). */
function templatePathSegments(template: string): string[] {
  const withoutQuery = template.split(/[?#]/, 1)[0] ?? '';
  const afterScheme = withoutQuery.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, '');
  const parts = afterScheme.split('/');
  // `{{baseUrl}}/v1/x`: the first part is the base, not a segment.
  if (parts.length > 0 && !withoutQuery.startsWith('/') && afterScheme === withoutQuery) parts.shift();
  else if (parts[0] === '') parts.shift();
  return parts;
}
