import { isScenarioName } from '../fixtures/flow.js';
import { parseCaptureId } from '../atlas/captures.js';
import type { HeaderMap } from '../types/index.js';
import { PromotionError } from './errors.js';

/** Largest promotion or review body. */
export const PROMOTION_BODY_LIMIT = 64 * 1024;

/** A decoded `POST /_janus/promotions` body. */
export interface PromotionRequest {
  readonly capture: { readonly scenario: string; readonly exchange: string };
  readonly scenario?: string;
  readonly path?: string;
  readonly variant?: string;
  /** Declared name → captured value, in the order written. */
  readonly ids: readonly (readonly [string, string])[];
  /** File key → the digest the caller saw, if it gave one. */
  readonly replace: ReadonlyMap<string, string | null>;
  /** The response body as the caller edited it, in place of the captured one. */
  readonly body?: string;
  /** The response headers as the caller edited them, in place of the captured sidecar. */
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  readonly dryRun: boolean;
}

/** A decoded `POST /_janus/promotions/review` body. */
export interface ReviewRequest {
  readonly scenario: string;
  readonly files: readonly { readonly file: string; readonly digest: string }[];
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PROMOTION_MEMBERS: ReadonlySet<string> = new Set([
  'capture',
  'scenario',
  'path',
  'variant',
  'ids',
  'replace',
  'body',
  'headers',
  'dryRun',
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A decoded `POST /_janus/scenarios` body. */
export interface ScenarioRequest {
  readonly name: string;
  /** Absent: `scenarios.default`. */
  readonly extends?: string;
}

/** The JSON request rules: `application/json`, within the limit, valid UTF-8 JSON, an object. */
function jsonBody(
  headers: HeaderMap,
  body: Uint8Array | null,
  refuse: (field: string, message: string) => PromotionError = invalid,
): Record<string, unknown> {
  const contentType = headers['content-type'];
  const essence = contentType?.length === 1 ? (contentType[0] ?? '').split(';')[0]?.trim().toLowerCase() : undefined;
  if (essence !== 'application/json') {
    throw new PromotionError(415, 'unsupported-media-type', 'The body must be sent as application/json');
  }
  const bytes = body ?? new Uint8Array();
  if (bytes.length > PROMOTION_BODY_LIMIT) {
    throw new PromotionError(413, 'request-too-large', `The body is larger than ${String(PROMOTION_BODY_LIMIT)} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw refuse('', 'the body is not valid UTF-8 JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw refuse('', 'the body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function invalid(field: string, message: string): PromotionError {
  return new PromotionError(400, 'invalid-request', field === '' ? message : `"${field}" ${message}`, {
    ...(field === '' ? {} : { field }),
  });
}

/** An Atlas route's shape problem: `400 atlas-invalid-request`. */
function invalidAtlas(field: string, message: string): PromotionError {
  return new PromotionError(
    400,
    'atlas-invalid-request',
    `Invalid Atlas request: ${field === '' ? message : `"${field}" ${message}`}`,
    { ...(field === '' ? {} : { field }) },
  );
}

/**
 * Decodes a scenario creation request. The shape is checked here; the name
 * against the grammar is `422 scenario-invalid-name`, so a client can tell
 * a malformed request from a name to fix.
 */
export function parseScenarioRequest(headers: HeaderMap, body: Uint8Array | null): ScenarioRequest {
  const value = jsonBody(headers, body, invalidAtlas);
  const unknown = Object.keys(value).find((key) => key !== 'name' && key !== 'extends');
  if (unknown !== undefined) throw invalidAtlas(unknown, 'is not a member of a scenario request');
  const name = value['name'];
  if (typeof name !== 'string') throw invalidAtlas('name', 'must be a string');
  const parent = value['extends'];
  if (parent !== undefined && parent !== null && typeof parent !== 'string') {
    throw invalidAtlas('extends', 'must be a scenario name');
  }
  if (!isScenarioName(name)) {
    throw new PromotionError(
      422,
      'scenario-invalid-name',
      `"${name}" is not a scenario name: lowercase letters and digits in words joined by "-", at most 64 bytes`,
      { field: 'name' },
    );
  }
  return { name, ...(typeof parent === 'string' ? { extends: parent } : {}) };
}

/** Decodes a promotion request; every member is checked before anything is read. */
export function parsePromotionRequest(headers: HeaderMap, body: Uint8Array | null): PromotionRequest {
  const value = jsonBody(headers, body);
  const unknown = Object.keys(value).find((key) => !PROMOTION_MEMBERS.has(key));
  if (unknown !== undefined) throw invalid(unknown, 'is not a member of a promotion request');
  const captureText = value['capture'];
  if (typeof captureText !== 'string') throw invalid('capture', 'must be a capture ID such as default/000001');
  const capture = parseCaptureId(captureText);
  if (capture === null) {
    // Checked like the capture detail route's segments.
    throw new PromotionError(404, 'atlas-resource-not-found', 'No capture with this ID exists');
  }
  const optionalString = (name: string, check: (text: string) => boolean, rule: string): string | undefined => {
    const member = value[name];
    if (member === undefined) return undefined;
    if (typeof member !== 'string' || !check(member)) throw invalid(name, rule);
    return member;
  };
  const scenario = optionalString('scenario', isScenarioName, 'must be a scenario name');
  const path = optionalString('path', (text) => text.startsWith('/'), 'must be a route template starting with "/"');
  const variant = optionalString('variant', (text) => text !== '', 'must be a variant name');

  const ids: [string, string][] = [];
  const rawIds = value['ids'];
  if (rawIds !== undefined) {
    if (typeof rawIds !== 'object' || rawIds === null || Array.isArray(rawIds)) {
      throw invalid('ids', 'must be an object of declared ID names and captured values');
    }
    for (const [name, captured] of Object.entries(rawIds as Record<string, unknown>)) {
      if (!ID_NAME.test(name)) throw invalid(`ids.${name}`, 'is not an ID name');
      if (typeof captured !== 'string' || captured === '') throw invalid(`ids.${name}`, 'must be the captured value');
      ids.push([name, captured]);
    }
  }

  const replace = new Map<string, string | null>();
  const rawReplace = value['replace'];
  if (rawReplace !== undefined) {
    if (!Array.isArray(rawReplace)) throw invalid('replace', 'must be a list of {"file", "digest"} entries');
    for (const entry of rawReplace as unknown[]) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw invalid('replace', 'entries must be objects with "file" and an optional "digest"');
      }
      const record = entry as Record<string, unknown>;
      const extra = Object.keys(record).find((key) => key !== 'file' && key !== 'digest');
      if (extra !== undefined) throw invalid(`replace.${extra}`, 'is not a member of a replace entry');
      const file = record['file'];
      if (typeof file !== 'string' || !isFileKey(file))
        throw invalid('replace.file', 'must be a file key such as /v1/cart/GET/200.json');
      const digest = record['digest'];
      if (digest !== undefined && (typeof digest !== 'string' || !DIGEST.test(digest))) {
        throw invalid('replace.digest', 'must be sha256: and 64 lowercase hex digits');
      }
      if (replace.has(file)) throw invalid('replace', `names ${file} twice`);
      replace.set(file, digest ?? null);
    }
  }
  const edited = value['body'];
  if (edited !== undefined && typeof edited !== 'string') throw invalid('body', 'must be the response body as text');
  const rawHeaders = value['headers'];
  let headerValues: Record<string, string | readonly string[]> | undefined;
  if (rawHeaders !== undefined) {
    if (typeof rawHeaders !== 'object' || rawHeaders === null || Array.isArray(rawHeaders)) {
      throw invalid('headers', 'must be an object of header names and values');
    }
    headerValues = {};
    for (const [name, header] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (!HEADER_NAME.test(name)) throw invalid(`headers.${name}`, 'is not a header name');
      const ok =
        typeof header === 'string' || (Array.isArray(header) && header.every((item) => typeof item === 'string'));
      if (!ok) throw invalid(`headers.${name}`, 'must be a string or a list of strings');
      headerValues[name] = header;
    }
  }
  const dryRun = value['dryRun'];
  if (dryRun !== undefined && typeof dryRun !== 'boolean') throw invalid('dryRun', 'must be true or false');
  return {
    capture,
    ...(scenario === undefined ? {} : { scenario }),
    ...(path === undefined ? {} : { path }),
    ...(variant === undefined ? {} : { variant }),
    ids,
    replace,
    ...(edited === undefined ? {} : { body: edited }),
    ...(headerValues === undefined ? {} : { headers: headerValues }),
    dryRun: dryRun === true,
  };
}

/** Decodes a review request. */
export function parseReviewRequest(headers: HeaderMap, body: Uint8Array | null): ReviewRequest {
  const value = jsonBody(headers, body);
  const unknown = Object.keys(value).find((key) => key !== 'scenario' && key !== 'files');
  if (unknown !== undefined) throw invalid(unknown, 'is not a member of a review request');
  const scenario = value['scenario'];
  if (typeof scenario !== 'string' || !isScenarioName(scenario)) throw invalid('scenario', 'must be a scenario name');
  const files = value['files'];
  if (!Array.isArray(files) || files.length === 0) throw invalid('files', 'must list at least one file');
  const out: { file: string; digest: string }[] = [];
  for (const entry of files as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalid('files', 'entries must be objects with "file" and "digest"');
    }
    const record = entry as Record<string, unknown>;
    const extra = Object.keys(record).find((key) => key !== 'file' && key !== 'digest');
    if (extra !== undefined) throw invalid(`files.${extra}`, 'is not a member of a review entry');
    const { file, digest } = record;
    if (typeof file !== 'string' || !isFileKey(file))
      throw invalid('files.file', 'must be a file key such as /v1/cart/GET/200.json');
    if (typeof digest !== 'string' || !DIGEST.test(digest)) {
      throw invalid('files.digest', 'must be sha256: and 64 lowercase hex digits');
    }
    if (out.some((item) => item.file === file)) throw invalid('files', `names ${file} twice`);
    out.push({ file, digest });
  }
  return { scenario, files: out };
}

const METHOD = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/;

/** A file key: `/` directory names, an uppercase method directory and a file name. */
export function isFileKey(value: string): boolean {
  if (!value.startsWith('/')) return false;
  const parts = value.slice(1).split('/');
  if (parts.length < 2 || parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  return METHOD.test(parts[parts.length - 2] ?? '');
}
