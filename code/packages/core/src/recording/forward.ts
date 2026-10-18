import { HOP_BY_HOP_HEADERS } from '../http/headers.js';
import { PROMOTED_HEADER, RECORDED_HEADER } from '../http/record.js';
import { SCENARIO_HEADER } from '../http/session.js';
import { isBodylessStatus } from '../fixtures/status.js';
import type { HeaderMap } from '../types/index.js';
import type { HeaderLine, UpstreamRequest } from './ports.js';
import { upstreamUrl, type Registration } from './registrations.js';

/** Janus sets or handles these itself. */
const SET_BY_JANUS: ReadonlySet<string> = new Set(['host', 'content-length', 'expect']);

/** A caller must not impersonate a trusted proxy to the upstream. */
const PROXY_HEADERS: ReadonlySet<string> = new Set(['forwarded', 'via']);

/**
 * Headers a browser would apply to the Janus origin rather than the upstream.
 * They are captured but never relayed.
 */
export const ORIGIN_BOUND_HEADERS: ReadonlySet<string> = new Set([
  'set-cookie',
  'set-cookie2',
  'clear-site-data',
  'strict-transport-security',
  'alt-svc',
  'report-to',
  'reporting-endpoints',
  'nel',
  'timing-allow-origin',
]);

/**
 * Computed by the adapter for every response, including the
 * request ID, which must match the server log.
 */
const RELAY_COMPUTED: ReadonlySet<string> = new Set(['content-length', 'date', 'x-janus-request-id']);

/** Names listed in `Connection`, lower-cased: they are hop-by-hop for this message. */
export function connectionListed(lines: Iterable<HeaderLine>): ReadonlySet<string> {
  const listed = new Set<string>();
  for (const [name, value] of lines) {
    if (name.toLowerCase() !== 'connection') continue;
    for (const token of value.split(',')) {
      const trimmed = token.trim().toLowerCase();
      if (trimmed !== '') listed.add(trimmed);
    }
  }
  return listed;
}

/** A header map as field lines, in its order. */
export function headerLines(headers: HeaderMap): HeaderLine[] {
  const lines: HeaderLine[] = [];
  for (const [name, values] of Object.entries(headers)) for (const value of values) lines.push([name, value]);
  return lines;
}

/** True when the caller's header `name` is not forwarded upstream. */
function withheld(name: string, listed: ReadonlySet<string>): boolean {
  return (
    HOP_BY_HOP_HEADERS.has(name) ||
    listed.has(name) ||
    SET_BY_JANUS.has(name) ||
    PROXY_HEADERS.has(name) ||
    name.startsWith('x-forwarded-') ||
    name.startsWith('x-mock-') ||
    name === 'accept-encoding'
  );
}

/**
 * The upstream request: the configured URL, the caller's
 * method and body, and every caller header line except those Janus removes,
 * in the order received when `received` gives them, with
 * `Accept-Encoding: identity` in place of the caller's.
 */
export function planUpstreamRequest(
  registration: Registration,
  method: string,
  segments: readonly string[],
  target: string,
  headers: HeaderMap,
  body: Uint8Array | null,
  received?: readonly HeaderLine[],
): UpstreamRequest {
  const lines = received ?? headerLines(headers);
  const listed = connectionListed(lines);
  const forwarded: HeaderLine[] = lines.filter(([name]) => !withheld(name.toLowerCase(), listed));
  forwarded.push(['accept-encoding', 'identity']);
  return Object.freeze({
    url: upstreamUrl(registration, segments, target),
    method,
    headers: Object.freeze(forwarded),
    body,
  });
}

/** The names of the headers that would be sent upstream, in order and without repeats. */
export function forwardedHeaderNames(headers: HeaderMap): readonly string[] {
  const lines = headerLines(headers);
  const listed = connectionListed(lines);
  const names = new Set<string>();
  for (const [name] of lines) if (!withheld(name.toLowerCase(), listed)) names.add(name.toLowerCase());
  names.add('accept-encoding');
  return Object.freeze([...names]);
}

/**
 * The relayed response's headers: the upstream's lines
 * without hop-by-hop, `X-Mock-*`, origin-bound browser-policy and
 * adapter-computed headers, then the diagnostic headers.
 */
export function planRelayedHeaders(
  upstream: readonly HeaderLine[],
  diagnostics: {
    readonly scenario: string;
    readonly recorded: string;
    /** Set under `promotion.mode: auto`. */
    readonly promoted?: 'promoted' | 'skipped' | 'failed';
  } | null,
): HeaderMap {
  const listed = connectionListed(upstream);
  const headers: Record<string, string[]> = {};
  for (const [written, value] of upstream) {
    const name = written.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || listed.has(name) || name.startsWith('x-mock-')) continue;
    if (ORIGIN_BOUND_HEADERS.has(name) || name.startsWith('access-control-') || RELAY_COMPUTED.has(name)) continue;
    (headers[name] ??= []).push(value);
  }
  if (diagnostics !== null) {
    headers[SCENARIO_HEADER] = [diagnostics.scenario];
    headers[RECORDED_HEADER] = [diagnostics.recorded];
    if (diagnostics.promoted !== undefined) headers[PROMOTED_HEADER] = [diagnostics.promoted];
  }
  return headers;
}

/** The relayed body: none for a bodyless status, which no transport may send. */
export function relayedBody(status: number, body: Uint8Array): Uint8Array | null {
  return isBodylessStatus(status) ? null : body;
}
