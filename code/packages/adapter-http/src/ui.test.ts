import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';

import { buildSnapshot, createEngine } from '@janus/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createHttpAdapter, type HttpAdapterOptions } from './adapter.js';
import { createUiAssets, UI_CONFIG_SCRIPT, UI_CSP } from './ui.js';

// Serving the UI.

const utf8 = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) => `"${createHash('sha256').update(text).digest('hex')}"`;

const BUILD: Readonly<Record<string, string>> = {
  'index.html': '<!doctype html><title>Janus Atlas</title>',
  'atlas-config.js': '// the template for static hosts',
  'theme.js': 'document.documentElement.dataset.theme = "light";',
  'tokens.css': ':root{--bg:#f6f7f8}',
  'assets/index-abc123.js': 'console.log(1);',
  'assets/index-abc123.js.map': '{"version":3}',
  'assets/index-def456.css': 'body{}',
  'assets/font-1a2b.woff2': 'wOF2',
  'assets/logo-9f8e.svg': '<svg/>',
  'assets/icon-77aa.png': 'PNG',
  'favicon.ico': 'ICO',
  'manifest.json': '{}',
  'LICENSE.txt': 'MIT',
};

const ui = createUiAssets(Object.entries(BUILD).map(([path, text]) => [path, utf8(text)]));

const built = buildSnapshot(new Map([['default/v1/products/GET/200_{application-json}.json', utf8('[]')]]));
if (!built.ok) throw new Error('fixture tree');
const snapshot = built.snapshot;

let app: FastifyInstance | undefined;

function adapter(overrides: Partial<HttpAdapterOptions> = {}): FastifyInstance {
  app = createHttpAdapter({ engine: createEngine({ snapshot }), ui, ...overrides });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const get = (url: string, method: 'GET' | 'HEAD' = 'GET', headers: Record<string, string> = {}) =>
  (app ?? adapter()).inject({ method, url, headers });

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': UI_CSP,
};

describe('/_janus/ui routes', () => {
  it.each([
    ['/_janus/ui', 'ui/'],
    ['/_janus/ui?', 'ui/'],
    ['/_janus/ui?a=1&b=2', 'ui/?a=1&b=2'],
    // Copied byte for byte: encoding, order, repeats and empty pairs survive.
    ['/_janus/ui?b=%2F&a=x+y&a=&&c', 'ui/?b=%2F&a=x+y&a=&&c'],
  ])('redirects %s with 308 to the relative %s', async (url, location) => {
    const response = await get(url);
    expect(response.statusCode).toBe(308);
    expect(response.headers['location']).toBe(location);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers).toMatchObject(SECURITY);
    expect(new URL(location, 'http://host/mock/_janus/ui').pathname).toBe('/mock/_janus/ui/');
  });

  it('serves index.html at /_janus/ui/', async () => {
    const response = await get('/_janus/ui/');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(BUILD['index.html']);
    expect(response.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      etag: sha(BUILD['index.html'] ?? ''),
      ...SECURITY,
    });
  });

  it("serves the generated atlas-config.js, never the build's copy", async () => {
    const response = await get('/_janus/ui/atlas-config.js');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(UI_CONFIG_SCRIPT);
    expect(response.body).toBe('globalThis.__JANUS_ATLAS_CONFIG__ = { serverUrl: "../../" };\n');
    expect(response.headers).toMatchObject({
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      etag: sha(UI_CONFIG_SCRIPT),
    });
    // Generated once: the same bytes and ETag every time.
    expect((await get('/_janus/ui/atlas-config.js')).headers['etag']).toBe(response.headers['etag']);
    const head = await get('/_janus/ui/atlas-config.js', 'HEAD');
    expect(head.headers['content-length']).toBe(String(UI_CONFIG_SCRIPT.length));
    const cached = await get('/_janus/ui/atlas-config.js', 'GET', { 'if-none-match': sha(UI_CONFIG_SCRIPT) });
    expect(cached.statusCode).toBe(304);
  });

  it.each([
    ['assets/index-abc123.js', 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable'],
    ['assets/index-abc123.js.map', 'application/json', 'public, max-age=31536000, immutable'],
    ['assets/index-def456.css', 'text/css; charset=utf-8', 'public, max-age=31536000, immutable'],
    ['assets/font-1a2b.woff2', 'font/woff2', 'public, max-age=31536000, immutable'],
    ['assets/logo-9f8e.svg', 'image/svg+xml', 'public, max-age=31536000, immutable'],
    ['assets/icon-77aa.png', 'image/png', 'public, max-age=31536000, immutable'],
    ['theme.js', 'text/javascript; charset=utf-8', 'no-cache'],
    // The design tokens, shared with the desktop app's pages.
    ['tokens.css', 'text/css; charset=utf-8', 'no-cache'],
    ['favicon.ico', 'image/x-icon', 'no-cache'],
    ['manifest.json', 'application/json', 'no-cache'],
    ['index.html', 'text/html; charset=utf-8', 'no-cache'],
    ['LICENSE.txt', 'application/octet-stream', 'no-cache'],
  ])('serves %s as %s with %s', async (path, contentType, cacheControl) => {
    const response = await get(`/_janus/ui/${path}`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(BUILD[path]);
    expect(response.headers).toMatchObject({
      'content-type': contentType,
      'cache-control': cacheControl,
      'content-length': String(BUILD[path]?.length),
      etag: sha(BUILD[path] ?? ''),
      ...SECURITY,
    });
  });

  it('answers HEAD with the GET status and headers, including Content-Length, and no body', async () => {
    for (const url of ['/_janus/ui/', '/_janus/ui/assets/index-abc123.js', '/_janus/ui/missing', '/_janus/ui']) {
      const [full, head] = [await get(url), await get(url, 'HEAD')];
      expect(head.statusCode).toBe(full.statusCode);
      expect(head.body).toBe('');
      const { date: _a, 'x-janus-request-id': _b, ...fullHeaders } = full.headers;
      const { date: _c, 'x-janus-request-id': _d, ...headHeaders } = head.headers;
      expect(headHeaders).toEqual(fullHeaders);
    }
  });

  it('answers a matching If-None-Match with 304, the ETag, Cache-Control and security headers', async () => {
    const etag = sha(BUILD['assets/index-abc123.js'] ?? '');
    for (const ifNoneMatch of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const response = await get('/_janus/ui/assets/index-abc123.js', 'GET', { 'if-none-match': ifNoneMatch });
      expect(response.statusCode).toBe(304);
      expect(response.body).toBe('');
      expect(response.headers).toMatchObject({
        etag,
        'cache-control': 'public, max-age=31536000, immutable',
        ...SECURITY,
      });
    }
    const stale = await get('/_janus/ui/assets/index-abc123.js', 'GET', { 'if-none-match': '"other"' });
    expect(stale.statusCode).toBe(200);
  });

  it.each([
    '/_janus/ui/missing.js',
    '/_janus/ui/assets/',
    '/_janus/ui/assets',
    '/_janus/ui/index.html/',
    '/_janus/ui//index.html',
    '/_janus/ui/assets%2Findex-abc123.js',
    '/_janus/ui/%69ndex.html',
    '/_janus/ui/INDEX.HTML',
  ])('answers %s with a plain-text 404', async (url) => {
    const response = await get(url);
    expect(response.statusCode).toBe(404);
    expect(response.headers).toMatchObject({
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...SECURITY,
    });
    expect(response.body).toBe('Not Found\n');
  });

  it.each(['/_janus/ui/assets/../index.html', '/_janus/ui/./index.html', '/_janus/ui/../ui/index.html'])(
    'answers the raw dot-segment path %s with 404',
    async (target) => {
      // Injected requests normalize the URL first, so this one goes over a socket as sent.
      adapter();
      await app?.listen({ host: '127.0.0.1', port: 0 });
      const port = (app?.server.address() as AddressInfo).port;
      const head = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
        });
        let text = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => (text += chunk));
        socket.on('end', () => {
          resolve(text);
        });
        socket.on('error', reject);
      });
      expect(head.split('\r\n')[0]).toBe('HTTP/1.1 404 Not Found');
    },
  );

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'] as const)('answers %s with 405', async (method) => {
    for (const url of ['/_janus/ui', '/_janus/ui/', '/_janus/ui/missing']) {
      const response = await (app ?? adapter()).inject({ method, url });
      expect(response.statusCode).toBe(405);
      expect(response.headers).toMatchObject({ allow: 'GET, HEAD', 'cache-control': 'no-store', ...SECURITY });
    }
  });

  it('never adds CORS headers to UI responses', async () => {
    adapter({ cors: { origins: ['*'], maxAge: 600 } });
    const response = await get('/_janus/ui/', 'GET', { origin: 'http://localhost:5173' });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['vary']).toBeUndefined();
  });

  it('reports capabilities.ui in health', async () => {
    expect((await get('/_janus/health')).json()).toMatchObject({ capabilities: { ui: true } });
  });
});

describe('without the UI', () => {
  it('answers 404 route-not-found like any unknown Atlas path', async () => {
    adapter({ ui: null });
    for (const url of ['/_janus/ui', '/_janus/ui/', '/_janus/ui/atlas-config.js']) {
      const response = await get(url);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'route-not-found' } });
    }
    expect((await get('/_janus/health')).json()).toMatchObject({ capabilities: { ui: false } });
  });
});
