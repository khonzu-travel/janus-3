import { createHash } from 'node:crypto';

import type { HeaderMap } from '@janus/core';

/**
 * Serving the built Atlas UI at `/_janus/ui/`. The server loads
 * the files once at startup; this module answers requests from that set and
 * never touches the filesystem.
 */

/** One file, ready to send. */
export interface UiFile {
  readonly bytes: Uint8Array;
  /** Quoted SHA-256 of the bytes. */
  readonly etag: string;
  readonly contentType: string;
  readonly cacheControl: string;
}

/** The loaded UI: files by path relative to the build directory, e.g. `assets/index-abc123.js`. */
export interface UiAssets {
  readonly files: ReadonlyMap<string, UiFile>;
  /** Sum of the file sizes, for the startup log. */
  readonly totalBytes: number;
}

export const UI_PATH = '/_janus/ui';

/** Fixed content types by extension; anything else is `application/octet-stream`. */
export const UI_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

/** The generated runtime configuration's path; the build's own copy is never served. */
export const UI_CONFIG_PATH = 'atlas-config.js';

export const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** On every UI response, whatever its status. */
export const UI_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': UI_CSP,
};

const NO_CACHE = 'no-cache';
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Vite writes content-hashed files under `assets/`. */
const HASHED_DIRECTORY = 'assets/';

/** The runtime configuration Janus serves: the Atlas of the server that served the page. */
export const UI_CONFIG_SCRIPT = 'globalThis.__JANUS_ATLAS_CONFIG__ = { serverUrl: "../../" };\n';

/**
 * Builds the served set from the build's files: each with its ETag, content
 * type and cache policy. The build's `atlas-config.js` is replaced by the
 * generated one.
 */
export function createUiAssets(entries: Iterable<readonly [path: string, bytes: Uint8Array]>): UiAssets {
  const files = new Map<string, UiFile>();
  let totalBytes = 0;
  const add = (path: string, bytes: Uint8Array): void => {
    const hashed = path.startsWith(HASHED_DIRECTORY) && path !== UI_CONFIG_PATH;
    files.set(path, {
      bytes,
      etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
      contentType: UI_CONTENT_TYPES[extension(path)] ?? 'application/octet-stream',
      cacheControl: hashed ? IMMUTABLE : NO_CACHE,
    });
    totalBytes += bytes.byteLength;
  };
  for (const [path, bytes] of entries) {
    if (path !== UI_CONFIG_PATH) add(path, bytes);
  }
  add(UI_CONFIG_PATH, new TextEncoder().encode(UI_CONFIG_SCRIPT));
  return { files, totalBytes };
}

/** True for a raw path the UI routes own: `/_janus/ui` and everything below `/_janus/ui/`. */
export function isUiPath(rawPath: string): boolean {
  return rawPath === UI_PATH || rawPath.startsWith(`${UI_PATH}/`);
}

export interface UiRequest {
  /** Uppercased. */
  readonly method: string;
  /** The raw request target, path and query, exactly as received. */
  readonly target: string;
  readonly headers: HeaderMap;
}

export interface UiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Null for `HEAD` and `304`. */
  readonly body: Uint8Array | null;
}

const UI_METHODS = 'GET, HEAD';

/**
 * Answers a request under `/_janus/ui`. Paths are matched
 * exactly against the loaded set, so encoded separators, dot-segments and
 * anything else not loaded are `404`s.
 */
export function handleUiRequest(assets: UiAssets, request: UiRequest): UiResponse {
  const { method, target } = request;
  const queryStart = target.indexOf('?');
  const rawPath = queryStart === -1 ? target : target.slice(0, queryStart);
  const rawQuery = queryStart === -1 ? '' : target.slice(queryStart + 1);
  const head = method === 'HEAD';

  const text = (status: number, message: string, extra: Readonly<Record<string, string>> = {}): UiResponse => {
    const bytes = new TextEncoder().encode(`${message}\n`);
    return {
      status,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(bytes.byteLength),
        'cache-control': 'no-store',
        ...UI_SECURITY_HEADERS,
        ...extra,
      },
      body: head ? null : bytes,
    };
  };

  if (method !== 'GET' && !head) return text(405, 'Method Not Allowed', { allow: UI_METHODS });

  if (rawPath === UI_PATH) {
    // Relative, so a prefix-stripping proxy keeps its prefix; the query is copied byte for byte.
    const location = rawQuery === '' ? 'ui/' : `ui/?${rawQuery}`;
    return text(308, 'Permanent Redirect', { location });
  }

  const name = rawPath.slice(UI_PATH.length + 1);
  const file = assets.files.get(name === '' ? 'index.html' : name);
  if (file === undefined) return text(404, 'Not Found');

  const headers = {
    'content-type': file.contentType,
    'content-length': String(file.bytes.byteLength),
    'cache-control': file.cacheControl,
    etag: file.etag,
    ...UI_SECURITY_HEADERS,
  };
  if (matchesEtag(request.headers['if-none-match'], file.etag)) {
    const { 'content-type': _type, 'content-length': _length, ...notModified } = headers;
    return { status: 304, headers: notModified, body: null };
  }
  return { status: 200, headers, body: head ? null : file.bytes };
}

/** `If-None-Match` (RFC 9110 §13.1.2): `*`, or a list of entity tags compared weakly. */
function matchesEtag(values: readonly string[] | undefined, etag: string): boolean {
  for (const value of values ?? []) {
    for (const item of value.split(',')) {
      const tag = item.trim();
      if (tag === '*' || tag === etag || tag === `W/${etag}`) return true;
    }
  }
  return false;
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}
