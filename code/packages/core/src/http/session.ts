import { toHex } from '../bytes.js';
import { CanonicalWriter } from '../canonical.js';
import { isScenarioName } from '../fixtures/flow.js';
import type { HeaderMap } from '../types/index.js';

/** Control headers, lower-cased. */
export const SCENARIO_HEADER = 'x-mock-scenario';
export const SESSION_HEADER = 'x-mock-session';
export const SESSION_KEY_HEADER = 'x-mock-session-key';
/** Diagnostic response headers. */
export const RESOLVED_FROM_HEADER = 'x-mock-resolved-from';

const SESSION_ID = /^[A-Za-z0-9._~-]{1,128}$/;
const WRITE_KEY = /^wk_[0-9a-f]{32}$/;

/** Where a request's session key came from. */
export type SessionSource = 'header' | 'derived' | 'default';

export interface SessionKey {
  /** Null for the `default` session. */
  readonly id: string | null;
  readonly source: SessionSource;
}

export type SessionKeyResult =
  { readonly ok: true; readonly key: SessionKey } | { readonly ok: false; readonly reason: string };

export const DEFAULT_SESSION_KEY: SessionKey = Object.freeze({ id: null, source: 'default' });

/**
 * Resolves a request's session key: `X-Mock-Session`, then
 * the first present `sessions.keyFrom` entry, hashed, then the `default`
 * session. A derived credential is never kept: only its hash leaves here.
 */
export function resolveSessionKey(headers: HeaderMap, keyFrom: readonly string[]): SessionKeyResult {
  const explicit = headers[SESSION_HEADER];
  if (explicit !== undefined && explicit.length > 0) {
    const value = explicit[0] ?? '';
    // `k_` is reserved for derived keys, so an explicit ID cannot squat one (review C1).
    if (explicit.length > 1 || !SESSION_ID.test(value) || value === 'default' || value.startsWith('k_')) {
      return {
        ok: false,
        reason:
          'the X-Mock-Session header must occur once, with 1 to 128 letters, digits or "._~-", cannot be "default" and cannot start with "k_"',
      };
    }
    return { ok: true, key: { id: value, source: 'header' } };
  }
  for (const entry of keyFrom) {
    const dot = entry.indexOf('.');
    const kind = entry.slice(0, dot);
    const name = entry.slice(dot + 1);
    let value: string | undefined;
    if (kind === 'header') {
      const values = headers[name.toLowerCase()];
      if (values !== undefined && values.length > 1) {
        return { ok: false, reason: `the ${name} header names the session, so it must occur on only one field line` };
      }
      value = values?.[0];
    } else {
      value = cookieValue(headers['cookie'], name);
    }
    if (value === undefined || value === '') continue;
    return { ok: true, key: { id: derivedSessionId(entry, value), source: 'derived' } };
  }
  return { ok: true, key: DEFAULT_SESSION_KEY };
}

/** `k_` + 16 hex digits of SHA-256 over a domain tag, the `keyFrom` entry and the value. */
export function derivedSessionId(entry: string, value: string): string {
  const digest = new CanonicalWriter().string('janus-session-key/1').string(entry).string(value).digest();
  return `k_${toHex(digest).slice(0, 16)}`;
}

/** The first value of a cookie in request order, across `Cookie` field lines; undefined when absent. */
function cookieValue(lines: readonly string[] | undefined, name: string): string | undefined {
  for (const line of lines ?? []) {
    for (const pair of line.split(';')) {
      const equals = pair.indexOf('=');
      if (equals === -1) continue;
      if (pair.slice(0, equals).trim() !== name) continue;
      let value = pair.slice(equals + 1).trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      return value;
    }
  }
  return undefined;
}

export type ScenarioHeader =
  | { readonly kind: 'absent' }
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/** `X-Mock-Scenario`: exactly once, one valid scenario name. */
export function parseScenarioHeader(headers: HeaderMap): ScenarioHeader {
  const values = headers[SCENARIO_HEADER];
  if (values === undefined || values.length === 0) return { kind: 'absent' };
  const value = (values[0] ?? '').trim();
  if (values.length > 1 || !isScenarioName(value)) {
    return {
      kind: 'invalid',
      reason:
        'the X-Mock-Scenario header must occur once, with one scenario name: lowercase letters and digits in words joined by "-"',
    };
  }
  return { kind: 'name', name: value };
}

/** `X-Mock-Session-Key`: exactly one well-formed write key, or null. */
export function parseWriteKey(headers: HeaderMap): string | null {
  const values = headers[SESSION_KEY_HEADER];
  if (values?.length !== 1) return null;
  const value = values[0] ?? '';
  return WRITE_KEY.test(value) ? value : null;
}

/** A `sessions.keyFrom` entry: `header.<field-name>` or `cookie.<cookie-name>`. */
export function isKeyFromEntry(entry: string): boolean {
  const match = /^(header|cookie)\.(.+)$/.exec(entry);
  if (match === null) return false;
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(match[2] ?? '');
}
