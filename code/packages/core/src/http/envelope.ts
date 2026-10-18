import { fromBase64, utf8Encode } from '../bytes.js';
import { parseRfc3339 } from '../dynamic/time.js';
import { isScenarioName } from '../fixtures/flow.js';
import type { RequestDescription } from '../types/index.js';
import { isFieldName, isFieldValue } from './headers.js';

/**
 * The wire form of a request to simulate: the JSON body of
 * `POST /_janus/resolve`. Every adapter decodes it here, so all agree.
 *
 * ```json
 * { "method": "GET", "target": "/v1/products?x=1", "headers": { "accept": ["*\/*"] },
 *   "body": { "encoding": "utf8", "data": "…" }, "nowMs": "2026-01-01T00:00:00Z", "scenario": "payment-declined" }
 * ```
 */
export interface ResolveEnvelopeOptions {
  /** `limits.maxBodyBytes`: a larger decoded body is `too-large`. */
  readonly maxBodyBytes: number;
}

export type ResolveEnvelopeResult =
  | { readonly ok: true; readonly request: RequestDescription }
  /** `invalid` is `400 atlas-invalid-request`; `too-large` is `413 request-too-large`. */
  | { readonly ok: false; readonly kind: 'invalid' | 'too-large'; readonly field: string; readonly message: string };

/** JavaScript's inclusive `Date` range, in epoch milliseconds. */
export const MAX_INSTANT_MS = 8_640_000_000_000_000;

const KEYS: ReadonlySet<string> = new Set(['method', 'target', 'headers', 'body', 'nowMs', 'scenario']);
const BODY_KEYS: ReadonlySet<string> = new Set(['encoding', 'data']);

/**
 * Decodes an already-parsed envelope. JSON parsing stays with the caller: for
 * an exact duplicate member name, the native decoder's last value wins before
 * this runs. `method` and `target` are passed through unchanged; resolution
 * normalises them exactly as it does for a served request. `scenario`,
 * `requestId` and any other key are refused.
 */
export function decodeResolveEnvelope(value: unknown, options: ResolveEnvelopeOptions): ResolveEnvelopeResult {
  const invalid = (field: string, message: string): ResolveEnvelopeResult => ({
    ok: false,
    kind: 'invalid',
    field,
    message: `"${field}" ${message}`,
  });
  if (!isRecord(value)) return { ok: false, kind: 'invalid', field: '', message: 'the envelope must be a JSON object' };
  const unknown = Object.keys(value).find((key) => !KEYS.has(key));
  if (unknown !== undefined) return invalid(unknown, 'is not a field of the resolve envelope');

  const { method, target } = value;
  if (typeof method !== 'string') return invalid('method', 'is required and must be a string');
  if (typeof target !== 'string') return invalid('target', 'is required and must be a string');

  const headers: Record<string, readonly string[]> = {};
  if (value['headers'] !== undefined) {
    const raw = value['headers'];
    if (!isRecord(raw)) return invalid('headers', 'must be an object of header names to values');
    for (const [name, entry] of Object.entries(raw)) {
      const field = `headers.${name}`;
      if (!isFieldName(name)) return invalid(field, 'is not a valid header name');
      const lower = name.toLowerCase();
      // Which spelling came first is not something JSON objects promise, so refuse rather than guess.
      if (headers[lower] !== undefined) return invalid(field, `repeats the header "${lower}" in another case`);
      const values = typeof entry === 'string' ? [entry] : entry;
      if (!Array.isArray(values) || values.length === 0) {
        return invalid(field, 'must be a string or a non-empty array of strings');
      }
      for (const item of values as unknown[]) {
        if (typeof item !== 'string') return invalid(field, 'must be a string or a non-empty array of strings');
        if (!isFieldValue(item)) return invalid(field, 'contains a character not allowed in a header value');
      }
      headers[lower] = Object.freeze([...(values as string[])]);
    }
  }

  let body: Uint8Array | undefined;
  if (value['body'] !== undefined) {
    const raw = value['body'];
    if (!isRecord(raw)) return invalid('body', 'must be an object with "encoding" and "data"');
    const extra = Object.keys(raw).find((key) => !BODY_KEYS.has(key));
    if (extra !== undefined) return invalid(`body.${extra}`, 'is not a field of the body');
    const { encoding, data } = raw;
    if (encoding !== 'utf8' && encoding !== 'base64') return invalid('body.encoding', 'must be "utf8" or "base64"');
    if (typeof data !== 'string') return invalid('body.data', 'must be a string');
    if (encoding === 'utf8') {
      body = utf8Encode(data);
    } else {
      const decoded = fromBase64(data);
      if (decoded === null) return invalid('body.data', 'is not valid, padded base64');
      body = decoded;
    }
    if (body.length > options.maxBodyBytes) {
      return {
        ok: false,
        kind: 'too-large',
        field: 'body',
        message: 'The simulated request body exceeds the configured limit',
      };
    }
  }

  let nowMs: number | undefined;
  if (value['nowMs'] !== undefined) {
    const raw = value['nowMs'];
    if (typeof raw === 'number') {
      if (!Number.isInteger(raw) || Math.abs(raw) > MAX_INSTANT_MS) {
        return invalid('nowMs', 'must be an integer number of epoch milliseconds within the Date range');
      }
      nowMs = raw;
    } else if (typeof raw === 'string') {
      const parsed = parseRfc3339(raw);
      if (parsed === null || Math.abs(parsed) > MAX_INSTANT_MS) {
        return invalid('nowMs', 'must be an RFC 3339 instant with an offset, e.g. 2026-01-01T00:00:00Z');
      }
      nowMs = parsed;
    } else {
      return invalid('nowMs', 'must be epoch milliseconds or an RFC 3339 instant');
    }
  }

  // The simulated request's scenario, ahead of every other source.
  const scenario = value['scenario'];
  if (scenario !== undefined && (typeof scenario !== 'string' || !isScenarioName(scenario))) {
    return invalid('scenario', 'must be a scenario name: lowercase letters and digits in words joined by "-"');
  }

  return {
    ok: true,
    request: {
      method,
      target,
      headers: Object.freeze(headers),
      ...(body === undefined ? {} : { body }),
      ...(nowMs === undefined ? {} : { nowMs }),
      ...(scenario === undefined ? {} : { scenario }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
