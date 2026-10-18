import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

import { APP_ORIGIN } from '../shared/bridge.js';

/** The CSP of the app's own pages: no network, nothing from elsewhere. */
export const APP_PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const APP_PAGES = {
  start: `${APP_ORIGIN}/start.html`,
  status: `${APP_ORIGIN}/status.html`,
  log: `${APP_ORIGIN}/log.html`,
} as const;

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * The bundled file a janus-app:// URL names, or null: only `janus-app://app/`,
 * only files of a known type inside the pages build, never a directory.
 */
export function appPageFile(url: string, root: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (`${parsed.protocol}//${parsed.host}` !== APP_ORIGIN) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  const relative = normalize(pathname).replace(/^[/\\]+/, '');
  if (relative === '' || relative.split(sep).includes('..')) return null;
  if (TYPES[extname(relative)] === undefined) return null;
  return join(root, relative);
}

/** Serves the app's own pages; anything else is a 404. */
export async function serveAppPage(url: string, root: string): Promise<Response> {
  const file = appPageFile(url, root);
  if (file !== null) {
    try {
      const body = await readFile(file);
      return new Response(body, {
        headers: {
          'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
          'content-security-policy': APP_PAGE_CSP,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    } catch {
      // Not found, or a directory: the same 404 as any unknown path.
    }
  }
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
