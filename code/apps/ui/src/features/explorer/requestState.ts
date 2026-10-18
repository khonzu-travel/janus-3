import type { ResolveEnvelope } from '../../atlas/client.js';
import type { NameValue, RequestBody, RequestDocument } from '../../atlas/runner.js';
import { scenarioFromSearch } from '../../scenarios/selection.js';
import { hasScenarioHeader } from '../requests/fields.js';

/**
 * The explorer's request editor state and its hash form. The
 * method, target and headers are shareable; the body never enters the link.
 */

/** Methods offered in the method list; any other token can be typed. */
export const COMMON_METHODS: readonly string[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

export interface HeaderRow {
  readonly id: number;
  readonly name: string;
  readonly value: string;
  /** Unchecked rows stay in the editor and the link but are not sent. */
  readonly enabled: boolean;
}

export interface RequestDraft {
  readonly method: string;
  readonly target: string;
  readonly headers: readonly HeaderRow[];
  readonly includeBody: boolean;
  readonly body: string;
  readonly bodyEncoding: 'utf8' | 'base64';
  readonly bodyContentType: string;
  /** RFC 3339, or empty for the server's clock. */
  readonly now: string;
  /** The scenario to simulate in, or empty for a request with no scenario. */
  readonly scenario: string;
}

export const EMPTY_DRAFT: RequestDraft = {
  method: 'GET',
  target: '/',
  headers: [],
  includeBody: false,
  body: '',
  bodyEncoding: 'utf8',
  bodyContentType: '',
  now: '',
  scenario: '',
};

/** Hash query names. Distinct from the inventory's (`q`, `method`, …), which share the hash. */
export const PARAMS = { method: 'm', target: 't', header: 'h', tryIt: 'try' } as const;

let nextRow = 1;
export function headerRow(name = '', value = '', enabled = true): HeaderRow {
  return { id: nextRow++, name, value, enabled };
}

/** Marks a disabled header in the link. `#` is not a token character, so no header name starts with it. */
const DISABLED = '#';

/** The draft a link describes, or null when it names no request. */
export function draftFromSearch(search: URLSearchParams): RequestDraft | null {
  const method = search.get(PARAMS.method);
  const target = search.get(PARAMS.target);
  if (method === null && target === null) return null;
  const headers: HeaderRow[] = [];
  for (const line of search.getAll(PARAMS.header)) {
    const enabled = !line.startsWith(DISABLED);
    const entry = enabled ? line : line.slice(DISABLED.length);
    const colon = entry.indexOf(':');
    if (colon <= 0) continue;
    headers.push(headerRow(entry.slice(0, colon).trim(), entry.slice(colon + 1).trim(), enabled));
  }
  return { ...EMPTY_DRAFT, method: method ?? 'GET', target: target ?? '/', headers, scenario: initialScenario(search) };
}

/** The explorer starts in the scenario selected in the app, if one is. */
export function initialScenario(search: URLSearchParams): string {
  return scenarioFromSearch(search) ?? '';
}

/** Only the explorer's entries, so changes to the rest of the hash (e.g. the inventory search) are not mistaken for a new request. */
export function explorerKey(search: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const [name, value] of search) {
    if ((Object.values(PARAMS) as string[]).includes(name)) kept.append(name, value);
  }
  return kept.toString();
}

/** Writes the shareable part of a draft into `search`, replacing the explorer's previous entries. */
export function draftToSearch(draft: RequestDraft, search: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(search);
  for (const name of Object.values(PARAMS)) next.delete(name);
  next.set(PARAMS.method, draft.method);
  next.set(PARAMS.target, draft.target);
  for (const row of draft.headers) {
    const name = row.name.trim();
    if (name !== '') next.append(PARAMS.header, `${row.enabled ? '' : DISABLED}${name}: ${row.value}`);
  }
  return next;
}

/**
 * The scenario a simulation asks for: the one picked in the top bar (from
 * the link's `scenario`), or none, leaving it to Janus (a session pin, else
 * `scenarios.default`). Null when the draft cannot be simulated: an
 * `X-Mock-Scenario` row is an error until removed, as the top bar picks the
 * scenario.
 */
export function simulatedScenario(draft: RequestDraft, picked: string | null): string | null {
  return hasScenarioHeader(draft.headers) ? null : (picked ?? '');
}

/** The rows as a saved request's headers: an unchecked row stays, disabled. */
export function savedHeaders(draft: RequestDraft): NameValue[] {
  return draft.headers
    .filter((row) => row.name.trim() !== '')
    .map((row) => ({ name: row.name.trim(), value: row.value, ...(row.enabled ? {} : { disabled: true }) }));
}

/**
 * The draft as a saved request: the target after
 * `{{baseUrl}}`, the headers, and a UTF-8 body typed by its Content-Type. A
 * base64 body is refused because request files have no inline binary body form.
 */
export function documentOf(draft: RequestDraft): RequestDocument {
  if (draft.includeBody && draft.bodyEncoding === 'base64') throw new Error('Base64 bodies cannot be saved as text');
  const headers = savedHeaders(draft);
  const target = draft.target.trim();
  const contentType = draft.bodyContentType.trim();
  let body: RequestBody | undefined;
  if (draft.includeBody && draft.bodyEncoding === 'utf8') {
    const type = /json/i.test(contentType) ? 'json' : /xml/i.test(contentType) ? 'xml' : 'text';
    body = { type, text: draft.body };
    if (contentType !== '' && !headers.some((entry) => entry.name.toLowerCase() === 'content-type')) {
      headers.push({ name: 'Content-Type', value: contentType });
    }
  }
  return {
    name: '',
    method: draft.method.trim() === '' ? 'GET' : draft.method.trim().toUpperCase(),
    url: `{{baseUrl}}${target.startsWith('/') ? target : `/${target}`}`,
    ...(headers.length === 0 ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  };
}

/** The request to send, from the editor's state. */
export function envelopeOf(draft: RequestDraft): ResolveEnvelope {
  const headers = Object.create(null) as Record<string, string[]>;
  const add = (name: string, value: string) => {
    const key = name.trim().toLowerCase();
    (headers[key] ??= []).push(value);
  };
  for (const row of draft.headers) {
    if (row.enabled && row.name.trim() !== '') add(row.name, row.value);
  }
  if (draft.includeBody && draft.bodyContentType.trim() !== '' && headers['content-type'] === undefined) {
    add('content-type', draft.bodyContentType.trim());
  }
  return {
    method: draft.method.trim(),
    target: draft.target.trim(),
    headers,
    ...(draft.includeBody ? { body: { encoding: draft.bodyEncoding, data: draft.body } } : {}),
    ...(draft.now.trim() === '' ? {} : { nowMs: draft.now.trim() }),
    ...(draft.scenario === '' ? {} : { scenario: draft.scenario }),
  };
}

/**
 * The unsaved request's link for an endpoint's "Try it", in Explore: method
 * and template, placeholders selected on arrival.
 */
export function tryItSearch(method: string, path: string, current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const name of Object.values(PARAMS)) next.delete(name);
  next.delete('id');
  next.set('mode', 'explore');
  next.set(PARAMS.method, method);
  next.set(PARAMS.target, path);
  next.set(PARAMS.tryIt, '1');
  return next;
}

/** The first `{name}` placeholder in a target, as a selection range. */
export function firstPlaceholder(target: string): { start: number; end: number } | null {
  const match = /\{[A-Za-z_][A-Za-z0-9_]*\}/.exec(target);
  return match === null ? null : { start: match.index, end: match.index + match[0].length };
}
