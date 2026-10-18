/**
 * Runtime configuration. The page may define
 * `globalThis.__JANUS_ATLAS_CONFIG__` in `atlas-config.js` before the
 * application starts; nothing about the server is compiled into the bundle.
 */

export interface AtlasConfig {
  /** Normalized server URL, always ending in "/". */
  readonly serverUrl: URL;
  /** `new URL("_janus/", serverUrl)`; every Atlas request and link resolves inside it. */
  readonly atlasRoot: URL;
}

export type ConfigResult =
  { readonly ok: true; readonly config: AtlasConfig } | { readonly ok: false; readonly message: string };

const KNOWN_KEYS: readonly string[] = ['serverUrl'];

/**
 * Decodes and normalizes the raw configuration object. `pageUrl` is the page's
 * own URL: the default server is its origin, and a relative `serverUrl`
 * resolves against it.
 */
export function decodeConfig(raw: unknown, pageUrl: string): ConfigResult {
  if (raw === undefined) raw = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: '__JANUS_ATLAS_CONFIG__ must be an object' };
  }
  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.includes(key));
  if (unknown.length > 0) {
    return { ok: false, message: `Unknown configuration key: ${unknown.map((key) => JSON.stringify(key)).join(', ')}` };
  }

  const value = (raw as { serverUrl?: unknown }).serverUrl;
  let serverUrl: URL;
  if (value === undefined) {
    serverUrl = new URL('/', pageUrl);
  } else {
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, message: 'serverUrl must be a non-empty string' };
    }
    if (value.includes('?') || value.includes('#')) {
      return { ok: false, message: 'serverUrl must not contain a query or fragment' };
    }
    try {
      serverUrl = new URL(value, pageUrl);
    } catch {
      return { ok: false, message: 'serverUrl is not a valid URL' };
    }
  }
  if (serverUrl.protocol !== 'http:' && serverUrl.protocol !== 'https:') {
    return { ok: false, message: 'serverUrl must use http: or https:' };
  }
  if (serverUrl.username !== '' || serverUrl.password !== '') {
    return { ok: false, message: 'serverUrl must not contain credentials' };
  }
  if (!serverUrl.pathname.endsWith('/')) serverUrl.pathname += '/';
  return { ok: true, config: { serverUrl, atlasRoot: new URL('_janus/', serverUrl) } };
}

declare global {
  var __JANUS_ATLAS_CONFIG__: unknown;
}

/** Reads the configuration the page provided, if any. */
export function readRuntimeConfig(pageUrl: string): ConfigResult {
  return decodeConfig(globalThis.__JANUS_ATLAS_CONFIG__, pageUrl);
}
