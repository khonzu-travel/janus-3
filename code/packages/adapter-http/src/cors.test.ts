import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { buildSnapshot, createEngine, type AtlasReloadResult, type FixtureSnapshot } from '@janus/core';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpAdapter, type HttpAdapterOptions } from './adapter.js';
import type { AtlasReloadService } from './atlas.js';
import type { CorsSettings } from './cors.js';

// Cross-origin access to Atlas.

function snapshotOf(entries: Readonly<Record<string, string>>): FixtureSnapshot {
  const built = buildSnapshot(new Map(Object.entries(entries).map(([key, value]) => [key, utf8(value)])));
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return built.snapshot;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

const snapshot = snapshotOf({
  'default/v1/products/GET/200_{application-json}.json': '[{"id":"p-1"}]',
  'default/v1/products/POST/201_{application-json}.json': '{"id":"p-2"}',
});

const LISTED = 'http://localhost:5173';
const OTHER = 'https://evil.example';
const CORS: CorsSettings = { origins: [LISTED, 'https://atlas.example.com'], maxAge: 600 };
const ENVELOPE = JSON.stringify({ method: 'GET', target: '/v1/products' });

let app: FastifyInstance | undefined;

function reloadService(trigger = vi.fn(() => Promise.resolve(swapped()))): AtlasReloadService {
  return {
    trigger,
    last: () => null,
    watching: () => false,
    subscribe: () => ({ state: { snapshotVersion: snapshot.version, lastReload: null }, unsubscribe: () => undefined }),
  };
}

function swapped(): AtlasReloadResult {
  return {
    outcome: 'swapped',
    triggers: ['request'],
    finishedAt: '2026-09-29T10:14:03Z',
    activeSnapshotVersion: snapshot.version,
    candidateSnapshotVersion: snapshot.version,
    errors: [],
    warnings: [],
  };
}

function adapter(overrides: Partial<HttpAdapterOptions> = {}): FastifyInstance {
  app = createHttpAdapter({
    engine: createEngine({ snapshot, config: { now: Date.UTC(2026, 0, 1), seed: 1 } }),
    reload: reloadService(),
    cors: CORS,
    ...overrides,
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const inject = (options: InjectOptions) => (app ?? adapter()).inject(options);

const cors = (headers: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('access-control-') || name === 'vary'));

describe('CORS on Atlas responses', () => {
  it('allows a listed origin, echoing it, with Vary: Origin', async () => {
    const response = await inject({ method: 'GET', url: '/_janus/health', headers: { origin: LISTED } });
    expect(response.statusCode).toBe(200);
    expect(cors(response.headers)).toEqual({ 'access-control-allow-origin': LISTED, vary: 'Origin' });
  });

  it('matches the normalized origin and echoes the header as sent', async () => {
    adapter({ cors: { origins: ['https://atlas.example.com'], maxAge: 600 } });
    const response = await inject({
      method: 'GET',
      url: '/_janus/health',
      headers: { origin: 'https://Atlas.example.com:443' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('https://Atlas.example.com:443');
  });

  it.each<[string, Record<string, string | string[]>]>([
    ['unlisted', { origin: OTHER }],
    ['absent', {}],
    ['malformed', { origin: 'null' }],
    ['a list', { origin: `${LISTED}, ${OTHER}` }],
    ['repeated', { origin: [LISTED, LISTED] }],
    ['with a path', { origin: `${LISTED}/` }],
  ])('adds only Vary: Origin for an %s origin', async (_name, headers) => {
    const response = await inject({ method: 'GET', url: '/_janus/health', headers });
    expect(response.statusCode).toBe(200);
    expect(cors(response.headers)).toEqual({ vary: 'Origin' });
  });

  it('answers any origin with * when the list is ["*"], and never allows credentials', async () => {
    adapter({ cors: { origins: ['*'], maxAge: 600 } });
    const response = await inject({ method: 'GET', url: '/_janus/config', headers: { origin: OTHER } });
    expect(cors(response.headers)).toEqual({ 'access-control-allow-origin': '*', vary: 'Origin' });
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('covers errors and unknown Atlas paths too', async () => {
    const missing = await inject({ method: 'GET', url: '/_janus/nope', headers: { origin: LISTED } });
    expect(missing.statusCode).toBe(404);
    expect(cors(missing.headers)).toEqual({ 'access-control-allow-origin': LISTED, vary: 'Origin' });
    const tooLarge = await inject({
      method: 'POST',
      url: '/_janus/resolve',
      headers: { origin: LISTED, 'content-type': 'application/json' },
      payload: 'x'.repeat(3 * 1024 * 1024),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(cors(tooLarge.headers)).toEqual({ 'access-control-allow-origin': LISTED, vary: 'Origin' });
  });

  it('adds nothing at all when cors.origins is empty', async () => {
    adapter({ cors: { origins: [], maxAge: 600 } });
    for (const url of ['/_janus/health', '/_janus/nope']) {
      const response = await inject({ method: 'GET', url, headers: { origin: LISTED } });
      expect(cors(response.headers)).toEqual({});
    }
    const options = await inject({
      method: 'OPTIONS',
      url: '/_janus/health',
      headers: { origin: LISTED, 'access-control-request-method': 'GET' },
    });
    expect(options.statusCode).toBe(405);
    expect(cors(options.headers)).toEqual({});
  });

  it('leaves fixture responses untouched', async () => {
    const response = await inject({ method: 'GET', url: '/v1/products', headers: { origin: LISTED } });
    expect(response.statusCode).toBe(200);
    // The fixture's own Vary, without Origin.
    expect(cors(response.headers)).toEqual({ vary: 'Accept' });
    const preflight = await inject({
      method: 'OPTIONS',
      url: '/v1/products',
      headers: { origin: LISTED, 'access-control-request-method': 'POST' },
    });
    expect(Object.keys(cors(preflight.headers)).filter((name) => name !== 'vary')).toEqual([]);
    expect(preflight.headers['vary'] ?? '').not.toContain('Origin');
  });
});

describe('preflight', () => {
  const preflight = (url: string, method: string, headers: Record<string, string | string[]> = {}) =>
    inject({
      method: 'OPTIONS',
      url,
      headers: { origin: LISTED, 'access-control-request-method': method, ...headers },
    });

  it.each([
    ['/_janus/health', 'GET', 'GET, HEAD'],
    ['/_janus/config', 'GET', 'GET, HEAD'],
    ['/_janus/endpoints', 'GET', 'GET, HEAD'],
    ['/_janus/clock', 'HEAD', 'GET, HEAD'],
    ['/_janus/events', 'GET', 'GET, HEAD'],
    ['/_janus/reload', 'POST', 'GET, HEAD, POST'],
    ['/_janus/resolve', 'POST', 'POST'],
    ['/_janus/recording', 'GET', 'GET, HEAD'],
    ['/_janus/captures', 'GET', 'GET, HEAD'],
    ['/_janus/captures/default/000001', 'DELETE', 'GET, HEAD, DELETE'],
  ])('succeeds for %s %s with the route methods', async (url, method, methods) => {
    const response = await preflight(url, method);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(cors(response.headers)).toEqual({
      'access-control-allow-origin': LISTED,
      'access-control-allow-methods': methods,
      'access-control-max-age': '600',
      vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    });
  });

  it('allows the requested headers, normalized, and sends the configured max age', async () => {
    adapter({ cors: { origins: [LISTED], maxAge: 86400 } });
    const response = await preflight('/_janus/resolve', 'POST', {
      'access-control-request-headers': ' Content-Type , x-mock-now,,CONTENT-TYPE',
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-headers']).toBe('content-type, x-mock-now');
    expect(response.headers['access-control-max-age']).toBe('86400');
  });

  it('treats an empty Access-Control-Request-Headers as no headers', async () => {
    const response = await preflight('/_janus/clock', 'GET', { 'access-control-request-headers': '' });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-headers']).toBeUndefined();
  });

  // Each failure is exactly the plain OPTIONS answer, with Vary: Origin and no Access-Control-* headers.
  it.each([
    ['a disallowed method', '/_janus/health', 'POST', {}],
    ['a lower-case method', '/_janus/reload', 'post', {}],
    ['a malformed method', '/_janus/reload', 'PO ST', {}],
    ['a disallowed header', '/_janus/resolve', 'POST', { 'access-control-request-headers': 'authorization' }],
    ['a malformed header', '/_janus/resolve', 'POST', { 'access-control-request-headers': 'content type' }],
    // A page on another origin can never make a visitor's browser record.
    ['x-mock-record', '/_janus/resolve', 'POST', { 'access-control-request-headers': 'content-type, x-mock-record' }],
    ['an unlisted origin', '/_janus/health', 'GET', { origin: OTHER }],
    ['a malformed origin', '/_janus/health', 'GET', { origin: 'null' }],
  ])('fails like a plain OPTIONS for %s', async (_name, url, method, headers) => {
    const response = await preflight(url, method, headers);
    expect(response.statusCode).toBe(405);
    expect(response.json()).toMatchObject({ error: { code: 'method-not-allowed' } });
    expect(response.headers['allow']).toBeDefined();
    expect(cors(response.headers)).toEqual({ vary: 'Origin' });
  });

  it('fails with 404 route-not-found on unknown and disabled routes', async () => {
    adapter({ resolve: false });
    for (const url of ['/_janus/nope', '/_janus/resolve']) {
      const response = await preflight(url, 'POST');
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'route-not-found' } });
      expect(cors(response.headers)).toEqual({ vary: 'Origin' });
    }
  });

  it('is not a preflight without Access-Control-Request-Method', async () => {
    const response = await inject({ method: 'OPTIONS', url: '/_janus/health', headers: { origin: LISTED } });
    expect(response.statusCode).toBe(405);
    expect(cors(response.headers)).toEqual({ 'access-control-allow-origin': LISTED, vary: 'Origin' });
  });
});

describe('Origin check on state-changing requests', () => {
  const requests = {
    reload: (headers: Record<string, string | string[]>) => inject({ method: 'POST', url: '/_janus/reload', headers }),
    resolve: (headers: Record<string, string | string[]>) =>
      inject({
        method: 'POST',
        url: '/_janus/resolve',
        headers: { 'content-type': 'application/json', ...headers },
        payload: ENVELOPE,
      }),
  };

  describe.each(['reload', 'resolve'] as const)('POST /_janus/%s', (route) => {
    const send = requests[route];

    it.each([
      ['no Origin', {}],
      ['the same authority', { origin: 'http://127.0.0.1:4010', host: '127.0.0.1:4010' }],
      ['the same authority over https', { origin: 'https://127.0.0.1:4010', host: '127.0.0.1:4010' }],
      ['a Host without a port', { origin: 'https://janus.example', host: 'janus.example' }],
      ['an upper-case Host', { origin: 'http://janus.example:8080', host: 'JANUS.example:8080' }],
      ['an IPv6 literal', { origin: 'http://[::1]:4010', host: '[::1]:4010' }],
      ['a listed origin', { origin: LISTED }],
    ])('allows %s', async (_name, headers) => {
      const response = await send(headers);
      expect(response.statusCode).toBe(200);
    });

    it('allows any origin with ["*"]', async () => {
      adapter({ cors: { origins: ['*'], maxAge: 600 } });
      expect((await send({ origin: OTHER })).statusCode).toBe(200);
    });

    it.each([
      ['another origin', { origin: OTHER }],
      ['null', { origin: 'null' }],
      ['a malformed origin', { origin: 'http://127.0.0.1:4010/' }],
      ['two Origin headers', { origin: [LISTED, LISTED] }],
      ['another port', { origin: 'http://127.0.0.1:4011', host: '127.0.0.1:4010' }],
      [
        'an explicit port that differs from the default',
        { origin: 'https://janus.example:8443', host: 'janus.example' },
      ],
      ['forwarded headers', { origin: OTHER, 'x-forwarded-host': 'evil.example', forwarded: 'host=evil.example' }],
    ])('refuses %s with 403 atlas-origin-forbidden', async (_name, headers) => {
      const trigger = vi.fn(() => Promise.resolve(swapped()));
      adapter({ reload: reloadService(trigger) });
      const response = await send(headers);
      expect(response.statusCode).toBe(403);
      expect(response.headers['content-type']).toBe('application/json');
      expect(response.json()).toMatchObject({ error: { code: 'atlas-origin-forbidden' } });
      expect(trigger).not.toHaveBeenCalled();
    });

    it('refuses an unlisted origin with CORS disabled, too', async () => {
      adapter({ cors: { origins: [], maxAge: 600 } });
      const response = await send({ origin: OTHER });
      expect(response.statusCode).toBe(403);
      expect(cors(response.headers)).toEqual({});
    });
  });

  it('does not check reads', async () => {
    const response = await inject({ method: 'GET', url: '/_janus/reload', headers: { origin: OTHER } });
    expect(response.statusCode).toBe(200);
  });
});

describe('the event stream', () => {
  it('carries CORS headers for a listed origin', async () => {
    adapter();
    await app?.listen({ host: '127.0.0.1', port: 0 });
    const port = (app?.server.address() as AddressInfo).port;
    const headers = await new Promise<IncomingHttpHeaders>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/_janus/events', headers: { origin: LISTED } },
        (response) => {
          resolve(response.headers);
          req.destroy();
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(headers['content-type']).toBe('text/event-stream');
    expect(cors(headers)).toEqual({ 'access-control-allow-origin': LISTED, vary: 'Origin' });
  });
});
