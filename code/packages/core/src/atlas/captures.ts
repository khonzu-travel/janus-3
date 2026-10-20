import { fromBase64, utf8DecodeStrict } from '../bytes.js';
import { compareStrings } from '../canonical.js';
import { parseFileName } from '../fixtures/filename.js';
import { isScenarioName } from '../fixtures/flow.js';
import { captureDigest } from '../recording/capture.js';
import {
  isUpstreamFailureReason,
  type CaptureLogEntry,
  type CaptureOutcome,
  type CaptureSourceKind,
} from '../recording/ports.js';
import { previewBody } from './atlas.js';
import type { AtlasPreview, AtlasResponseHeader } from './types.js';

/** Exchange IDs are eight random lowercase hex digits; captures from older servers keep six decimal digits. */
export const EXCHANGE_PATTERN = /^(?:[0-9a-f]{8}|[0-9]{6})$/;

/** The outcomes `?outcome=` filters on; `unreadable` lists log lines that do not parse. */
export const CAPTURE_LIST_OUTCOMES: readonly (CaptureOutcome | 'unreadable')[] = Object.freeze([
  'captured',
  'capture-failed',
  'upstream-failed',
  'upstream-timeout',
  'response-too-large',
  'unreadable',
]);

/** `?limit` bounds and default. */
export const CAPTURE_LIST_LIMIT = Object.freeze({ min: 1, max: 500, default: 100 });

/** One scenario's `log.jsonl`, split into lines, as the server read it. */
export interface CaptureLog {
  readonly scenario: string;
  /** Without line terminators; a trailing empty line is not included. */
  readonly lines: readonly string[];
}

/** One item of `GET /_janus/captures`. */
export type AtlasCaptureItem =
  | (CaptureLogEntry & {
      readonly id: string;
      readonly scenario: string;
      /** Always present in the list. */
      readonly source: CaptureSourceKind;
      readonly detailHref?: string;
    })
  | { readonly outcome: 'unreadable'; readonly scenario: string; readonly line: number };

export interface AtlasCaptureList {
  readonly items: readonly AtlasCaptureItem[];
  /** The `before` value of the next page, or null. */
  readonly next: string | null;
}

export interface CaptureListQuery {
  readonly scenario?: string;
  readonly outcome?: CaptureOutcome | 'unreadable';
  /** Unreadable lines have no source and are left out when it is set. */
  readonly source?: CaptureSourceKind;
  readonly limit: number;
  /** From `next`: after a capture, or after an unreadable line (review D5). */
  readonly before?: CaptureCursor;
}

export type CaptureCursor =
  { readonly scenario: string; readonly exchange: string } | { readonly scenario: string; readonly line: number };

/** A part of a capture that is missing or no longer parses. */
export interface AtlasUnreadable {
  readonly state: 'unreadable';
}

/** `GET /_janus/captures/{scenario}/{exchange}`. */
export interface AtlasCaptureDetail {
  readonly id: string;
  readonly source: CaptureSourceKind;
  /** Runner captures: the run that sent it and the request ID. */
  readonly run?: string;
  readonly requestId?: string;
  readonly request:
    | {
        readonly state: 'available';
        readonly method: string;
        readonly target: string;
        readonly registration: { readonly method: string; readonly path: string };
        /** Runner captures: the URL as sent. */
        readonly url?: string;
        readonly params: readonly { readonly name: string; readonly value: string }[];
        readonly headers: readonly AtlasResponseHeader[];
        readonly body: AtlasPreview;
      }
    | AtlasUnreadable;
  readonly response:
    | {
        readonly state: 'available';
        readonly status: number;
        readonly fileName: string;
        readonly headers: readonly AtlasResponseHeader[];
        readonly body: AtlasPreview;
        /** True when the file no longer matches the provenance digest. */
        readonly modified: boolean;
      }
    | AtlasUnreadable;
  /** The meta file, as written. */
  readonly provenance: ({ readonly state: 'available' } & Readonly<Record<string, unknown>>) | AtlasUnreadable;
}

/** What a file of an exchange directory is, or null for a name the reader must not open. */
export function captureFileKind(name: string, status: number): 'request' | 'response' | 'headers' | 'meta' | null {
  if (name === 'request.json') return 'request';
  if (name === `${String(status)}.meta.json`) return 'meta';
  if (name === `${String(status)}.headers.json`) return 'headers';
  const parsed = parseFileName(name);
  return parsed.kind === 'response' && parsed.status === status && parsed.variant === null ? 'response' : null;
}

/** A `log.jsonl` line, or null when it is not one. */
export function parseCaptureLogLine(text: string): CaptureLogEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const { exchange, at, method, target, registration, outcome, status, reason, durationMs, source, run, request } =
    entry;
  if (typeof exchange !== 'string' || !EXCHANGE_PATTERN.test(exchange)) return null;
  if (typeof at !== 'string' || typeof method !== 'string' || typeof target !== 'string') return null;
  // A non-negative integer, as the UI decodes it: one hand-edited line must not break the list (review D4).
  if (typeof registration !== 'string' || typeof durationMs !== 'number') return null;
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) return null;
  if (!CAPTURE_LIST_OUTCOMES.includes(outcome as CaptureOutcome) || outcome === 'unreadable') return null;
  if (status !== undefined && (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 999))
    return null;
  if (outcome === 'captured' && status === undefined) return null;
  // Runner lines carry their source, run and request; recording lines carry none.
  if (source !== undefined && source !== 'recording' && source !== 'runner') return null;
  if ((run !== undefined && typeof run !== 'string') || (request !== undefined && typeof request !== 'string'))
    return null;
  return Object.freeze({
    exchange,
    at,
    method,
    target,
    registration,
    outcome: outcome as CaptureOutcome,
    ...(status === undefined ? {} : { status }),
    // An unrecognised reason is dropped rather than failing the line.
    ...(outcome === 'upstream-failed' && isUpstreamFailureReason(reason) ? { reason } : {}),
    durationMs,
    ...(source === 'runner' ? { source } : {}),
    ...(typeof run === 'string' ? { run } : {}),
    ...(typeof request === 'string' ? { request } : {}),
  });
}

/** The `captured` line for an exchange, which a detail view needs; null otherwise. */
export function capturedEntry(log: CaptureLog, exchange: string): CaptureLogEntry | null {
  for (const line of log.lines) {
    const entry = parseCaptureLogLine(line);
    if (entry?.exchange === exchange && entry.outcome === 'captured') return entry;
  }
  return null;
}

/**
 * The capture list: every scenario's log, newest first,
 * filtered and paged. Unreadable lines follow the readable ones, by scenario
 * and line, and are paged with them (review D5), so a broken line never
 * hides the rest.
 */
export function projectCaptureList(logs: readonly CaptureLog[], query: CaptureListQuery): AtlasCaptureList {
  const readable: (CaptureLogEntry & { readonly scenario: string; readonly line: number })[] = [];
  const unreadable: (AtlasCaptureItem & { readonly outcome: 'unreadable' })[] = [];
  for (const log of logs) {
    if (!isScenarioName(log.scenario)) continue;
    if (query.scenario !== undefined && log.scenario !== query.scenario) continue;
    for (const [index, text] of log.lines.entries()) {
      if (text.trim() === '') continue;
      const entry = parseCaptureLogLine(text);
      if (entry === null) {
        if ((query.outcome === undefined || query.outcome === 'unreadable') && query.source === undefined) {
          unreadable.push(Object.freeze({ outcome: 'unreadable' as const, scenario: log.scenario, line: index + 1 }));
        }
        continue;
      }
      if (query.outcome !== undefined && entry.outcome !== query.outcome) continue;
      if (query.source !== undefined && (entry.source ?? 'recording') !== query.source) continue;
      readable.push({ ...entry, scenario: log.scenario, line: index + 1 });
    }
  }
  readable.sort(
    (a, b) =>
      compareStrings(b.at, a.at) ||
      compareStrings(a.scenario, b.scenario) ||
      compareStrings(b.exchange, a.exchange) ||
      b.line - a.line,
  );
  unreadable.sort((a, b) => compareStrings(a.scenario, b.scenario) || a.line - b.line);
  const items: AtlasCaptureItem[] = [
    ...readable.map(({ line: _line, ...entry }) => {
      const id = `${entry.scenario}/${entry.exchange}`;
      return Object.freeze({
        id,
        ...entry,
        source: entry.source ?? ('recording' as const),
        ...(entry.outcome === 'captured' ? { detailHref: `captures/${id}` } : {}),
      });
    }),
    ...unreadable,
  ];
  let start = 0;
  if (query.before !== undefined) {
    const before = query.before;
    if ('exchange' in before) {
      const index = readable.findIndex(
        (entry) => entry.scenario === before.scenario && entry.exchange === before.exchange,
      );
      // An anchor that no longer exists ends the readable part rather than restarting it.
      start = index === -1 ? readable.length : index + 1;
    } else {
      const index = unreadable.findIndex((entry) => entry.scenario === before.scenario && entry.line === before.line);
      start = index === -1 ? items.length : readable.length + index + 1;
    }
  }
  const page = items.slice(start, start + query.limit);
  const last = page.at(-1);
  const more = start + query.limit < items.length && last !== undefined;
  return Object.freeze({
    items: Object.freeze(page),
    next: !more ? null : last.outcome === 'unreadable' ? `${last.scenario}/line-${String(last.line)}` : last.id,
  });
}

/**
 * Parses a `before` value: a capture ID, or `<scenario>/line-<n>` after an
 * unreadable line (review D5); null when it is neither.
 */
export function parseCaptureCursor(value: string): CaptureCursor | null {
  const match = /^([^/]*)\/line-([1-9][0-9]{0,8})$/.exec(value);
  if (match === null) return parseCaptureId(value);
  const scenario = match[1] ?? '';
  return isScenarioName(scenario) ? { scenario, line: Number(match[2]) } : null;
}

/** Parses a capture ID into a validated scenario and exchange; null when it is not one. */
export function parseCaptureId(value: string): { readonly scenario: string; readonly exchange: string } | null {
  const slash = value.indexOf('/');
  if (slash === -1) return null;
  const scenario = value.slice(0, slash);
  const exchange = value.slice(slash + 1);
  return isScenarioName(scenario) && EXCHANGE_PATTERN.test(exchange) ? { scenario, exchange } : null;
}

/**
 * The capture detail from the files the reader found under
 * the allowlisted names. A missing or broken file makes only its part
 * unreadable. `null` bytes mean the file exists but could not be read.
 */
export function projectCaptureDetail(
  scenario: string,
  entry: CaptureLogEntry,
  files: ReadonlyMap<string, Uint8Array | null>,
): AtlasCaptureDetail {
  const status = entry.status ?? 0;
  const named = (kind: ReturnType<typeof captureFileKind>): [string, Uint8Array | null] | undefined =>
    [...files].filter(([name]) => captureFileKind(name, status) === kind).sort(([a], [b]) => compareStrings(a, b))[0];

  const meta = jsonObject(named('meta')?.[1]);
  const request = jsonObject(named('request')?.[1]);
  const sidecarFile = named('headers');
  const sidecar = sidecarFile === undefined ? {} : jsonObject(sidecarFile[1]);
  const responseFile = named('response');

  return Object.freeze({
    id: `${scenario}/${entry.exchange}`,
    source: entry.source ?? 'recording',
    ...(entry.run === undefined ? {} : { run: entry.run }),
    ...(entry.request === undefined ? {} : { requestId: entry.request }),
    request: request === null ? UNREADABLE : (requestPart(request) ?? UNREADABLE),
    response:
      responseFile === undefined || responseFile[1] === null || sidecar === null
        ? UNREADABLE
        : responsePart(status, responseFile[0], responseFile[1], sidecar, meta),
    provenance: meta === null ? UNREADABLE : Object.freeze({ state: 'available' as const, ...meta }),
  });
}

const UNREADABLE: AtlasUnreadable = Object.freeze({ state: 'unreadable' });

function requestPart(document: Readonly<Record<string, unknown>>): AtlasCaptureDetail['request'] | null {
  const { method, target, registration, params, headers, body, url } = document;
  if (typeof method !== 'string' || typeof target !== 'string') return null;
  const reg = registration as { method?: unknown; path?: unknown } | null;
  if (typeof reg?.method !== 'string' || typeof reg.path !== 'string') return null;
  const lines = headerList(headers);
  if (lines === null || typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  const paramList = Object.entries(params as Record<string, unknown>).map(([name, value]) => ({
    name,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }));
  let bytes: Uint8Array | null = null;
  if (body !== null) {
    const encoded = body as { encoding?: unknown; data?: unknown } | undefined;
    if (typeof encoded?.data !== 'string') return null;
    if (encoded.encoding === 'utf8') bytes = new TextEncoder().encode(encoded.data);
    else if (encoded.encoding === 'base64') bytes = fromBase64(encoded.data);
    if (bytes === null) return null;
  }
  const contentType = lines.find((line) => line.name === 'content-type')?.value ?? null;
  return Object.freeze({
    state: 'available' as const,
    method,
    target,
    registration: { method: reg.method, path: reg.path },
    ...(typeof url === 'string' ? { url } : {}),
    params: paramList,
    headers: lines,
    // A text body is shown whole; it is bounded by limits.maxBodyBytes already.
    body: previewBody(bytes, contentType, Number.POSITIVE_INFINITY),
  });
}

function responsePart(
  status: number,
  fileName: string,
  bytes: Uint8Array,
  sidecar: Readonly<Record<string, unknown>>,
  meta: Readonly<Record<string, unknown>> | null,
): AtlasCaptureDetail['response'] {
  const headers = headerList(
    Object.fromEntries(
      Object.entries(sidecar).map(([name, value]) => [name.toLowerCase(), typeof value === 'string' ? [value] : value]),
    ),
  );
  if (headers === null) return UNREADABLE;
  const parsed = parseFileName(fileName);
  const mediaType =
    headers.find((line) => line.name === 'content-type')?.value ??
    (parsed.kind === 'response' ? parsed.mediaType : null);
  const digest = (meta?.['response'] as { digest?: unknown } | undefined)?.digest;
  return Object.freeze({
    state: 'available' as const,
    status,
    fileName,
    headers,
    // A text body is shown whole; it is bounded by recording.maxResponseBytes already.
    body: previewBody(
      parsed.kind === 'response' && parsed.mediaType === null ? null : bytes,
      mediaType,
      Number.POSITIVE_INFINITY,
    ),
    modified: typeof digest === 'string' && digest !== captureDigest(bytes),
  });
}

/** `{ name: [values] }` as one `{ name, value }` per value, in order; null when malformed. */
function headerList(value: unknown): AtlasResponseHeader[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const lines: AtlasResponseHeader[] = [];
  for (const [name, values] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(values)) return null;
    for (const item of values) {
      if (typeof item !== 'string') return null;
      lines.push({ name, value: item });
    }
  }
  return lines;
}

function jsonObject(bytes: Uint8Array | null | undefined): Readonly<Record<string, unknown>> | null {
  if (bytes === null || bytes === undefined) return null;
  const text = utf8DecodeStrict(bytes);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
