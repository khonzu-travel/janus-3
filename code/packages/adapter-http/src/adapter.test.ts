import { connect } from 'node:net';

import { buildSnapshot, createEngine, type Engine, type FixtureSnapshot } from '@janus/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createHttpAdapter,
  DEFAULT_LIMITS,
  REQUEST_ID_HEADER,
  type HttpAdapterOptions,
  type RequestRecord,
} from './adapter.js';

const PRODUCTS_JSON = '[ {"id":"p-1",   "name":"Example"} ]\n';
const BINARY = new Uint8Array([0, 1, 2, 253, 254, 255]);

function snapshotOf(entries: Readonly<Record<string, string | Uint8Array>>): FixtureSnapshot {
  const built = buildSnapshot(
    new Map(
      Object.entries(entries).map(([key, value]) => [
        key,
        typeof value === 'string' ? new TextEncoder().encode(value) : value,
      ]),
    ),
  );
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return built.snapshot;
}

const snapshot = snapshotOf({
  'default/v1/products/GET/200_{application-json}.json': PRODUCTS_JSON,
  'default/v1/products/GET/200.headers.json': '{"Set-Cookie":["a=1","b=2"],"X-Example":"fixture"}',
  'default/v1/products/POST/201_{application-json}.json': '{"id":"p-2"}',
  'default/v1/products/POST/201.headers.json': '{"Location":"/v1/products/p-2"}',
  'default/v1/products/p-1/DELETE/204': '',
  'default/v1/reset/POST/205': '',
  'default/v1/cached/GET/304': '',
  'default/v1/empty/GET/200_{text-plain}.txt': '',
  'default/v1/binary/GET/200_{application-octet-stream}.bin': BINARY,
  'default/v1/purge/PURGE/200_{text-plain}.txt': 'purged',
  'default/v1/echo/GET/200_{application-json}.json': '{"q":"{{$body.$.q}}"}',
  'default/v1/echo/OPTIONS/200_{application-json}.json': '{"q":"{{$body.$.q}}"}',
  'default/v1/echo/DELETE/200_{application-json}.json': '{"q":"{{$body.$.q}}"}',
  'default/v1/echo/TRACE/200_{application-json}.json': '{"q":"{{$body.$.q}}"}',
  'default/v1/echo/PURGE/200_{application-json}.json': '{"q":"{{$body.$.q}}"}',
  'default/v1/echo/QUERY/200_{application-json}.json': '{"q":"{{$body.$.q}}"}',
  'default/v1/greeting/GET/200_[en-US]_{text-plain}.txt': 'Hello',
  'default/v1/greeting/GET/200_[fr]_{text-plain}.txt': 'Bonjour',
});

let app: FastifyInstance | undefined;
const records: RequestRecord[] = [];

function adapter(overrides: Partial<HttpAdapterOptions> = {}): FastifyInstance {
  records.length = 0;
  app = createHttpAdapter({
    engine: createEngine({ snapshot }),
    onRequestComplete: (record) => records.push(record),
    ...overrides,
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Sends raw HTTP/1.x bytes over a real socket to `instance` listening on `host`, and splits the answer. */
async function exchange(
  instance: FastifyInstance,
  request: string | ((port: number) => string),
  host = '127.0.0.1',
): Promise<{ head: string; body: string }> {
  if (!instance.server.listening) await instance.listen({ host, port: 0 });
  const address = instance.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(typeof request === 'string' ? request : request(port));
    });
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (received += chunk));
    socket.on('close', () => {
      resolve(received);
    });
    socket.on('error', reject);
  });
  const split = raw.indexOf('\r\n\r\n');
  return { head: raw.slice(0, split), body: raw.slice(split + 4) };
}

describe('createHttpAdapter', () => {
  it('writes fixture status, content type, repeated headers, and exact JSON bytes', async () => {
    const response = await adapter().inject({ method: 'GET', url: '/v1/products' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(response.headers['x-example']).toBe('fixture');
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength(PRODUCTS_JSON)));
    expect(response.body).toBe(PRODUCTS_JSON);
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends non-ASCII sidecar header values as their UTF-8 bytes (review A9)', async () => {
    const instance = adapter({
      engine: createEngine({
        snapshot: snapshotOf({
          'default/v1/note/GET/204': '',
          'default/v1/note/GET/204.headers.json': '{"X-Note":"café €"}',
        }),
      }),
    });
    const { head } = await exchange(instance, 'GET /v1/note HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    expect(head).toMatch(/^HTTP\/1\.1 204/);
    expect(head).toContain('\r\nx-note: café €');
  });

  it('preserves UTF-8 Content-Type parameters when Fastify sends the response', async () => {
    const instance = adapter({
      engine: createEngine({
        snapshot: snapshotOf({
          'default/v1/note/GET/200.txt': 'ok',
          'default/v1/note/GET/200.headers.json': JSON.stringify({ 'Content-Type': 'text/plain; note="café €"' }),
        }),
      }),
    });
    const { head, body } = await exchange(
      instance,
      'GET /v1/note HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
    );
    expect(head).toMatch(/^HTTP\/1\.1 200/);
    expect(head).toContain('\r\ncontent-type: text/plain; note="café €"');
    expect(body).toBe('ok');
  });

  it('counts padded header whitespace against maxHeaderBytes', async () => {
    const instance = adapter({ limits: { maxHeaderBytes: 1024 } });
    const { head, body } = await exchange(
      instance,
      `GET /v1/products HTTP/1.1\r\nHost: localhost\r\nX-Pad:${' '.repeat(2000)}a\r\nConnection: close\r\n\r\n`,
    );
    expect(head).toMatch(/^HTTP\/1\.1 431/);
    expect(head.toLowerCase()).toContain('connection: close');
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'headers-too-large' } });
  });

  it('negotiates localized responses from the Accept-Language request header', async () => {
    const french = await adapter().inject({
      method: 'GET',
      url: '/v1/greeting',
      headers: { 'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8' },
    });
    expect(french.statusCode).toBe(200);
    expect(french.headers['content-language']).toBe('fr');
    expect(french.headers['vary']).toBe('Accept, Accept-Language');
    expect(french.body).toBe('Bonjour');

    const missing = await adapter().inject({
      method: 'GET',
      url: '/v1/greeting',
      headers: { 'accept-language': 'de' },
    });
    expect(missing.statusCode).toBe(406);
    expect(missing.json()).toMatchObject({ error: { code: 'not-acceptable' } });
  });

  it('writes arbitrary bytes unchanged', async () => {
    const response = await adapter().inject({ method: 'GET', url: '/v1/binary' });
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect([...response.rawPayload]).toEqual([...BINARY]);
  });

  it('distinguishes an empty body from no body', async () => {
    const response = await adapter().inject({ method: 'GET', url: '/v1/empty' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-length']).toBe('0');
    expect(response.body).toBe('');
  });

  it('writes fixture headers such as Location', async () => {
    const response = await adapter().inject({ method: 'POST', url: '/v1/products', payload: '{"name":"x"}' });
    expect(response.statusCode).toBe(201);
    expect(response.headers['location']).toBe('/v1/products/p-2');
  });

  it.each([
    ['DELETE', '/v1/products/p-1', 204],
    ['POST', '/v1/reset', 205],
    ['GET', '/v1/cached', 304],
  ])('sends no body for %s %s (%i)', async (method, url, status) => {
    const response = await adapter().inject({ method: method as 'GET', url });
    expect(response.statusCode).toBe(status);
    expect(response.body).toBe('');
    expect(response.headers['content-type']).toBeUndefined();
  });

  it('answers HEAD with GET headers and no body', async () => {
    const response = await adapter().inject({ method: 'HEAD', url: '/v1/products' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['x-example']).toBe('fixture');
    expect(response.body).toBe('');
  });

  it('answers HEAD for an error with the length of the envelope it withholds (review A10)', async () => {
    const instance = adapter({ limits: { maxUrlBytes: 300 } });
    const url = `/v1/products?${'x'.repeat(300)}`;
    const head = await instance.inject({ method: 'HEAD', url });
    const get = await instance.inject({ method: 'GET', url });
    expect(head.statusCode).toBe(414);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(get.headers['content-length']);
    // Core's envelope names the method, so its length is that of the HEAD envelope.
    const missing = await instance.inject({ method: 'HEAD', url: '/v1/missing' });
    expect(missing.headers['content-length']).toBe(
      String(
        JSON.stringify({
          error: {
            code: 'route-not-found',
            message: 'No fixture matches HEAD /v1/missing',
            requestId: missing.headers[REQUEST_ID_HEADER],
          },
        }).length,
      ),
    );
  });

  it('serves methods that Fastify does not route natively', async () => {
    const response = await adapter().inject({ method: 'PURGE' as 'GET', url: '/v1/purge' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('purged');
  });

  it('returns 404 route-not-found with the stable envelope', async () => {
    const response = await adapter().inject({ method: 'GET', url: '/v1/missing' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['allow']).toBeUndefined();
    expect(response.json()).toEqual({
      error: {
        code: 'route-not-found',
        message: 'No fixture matches GET /v1/missing',
        requestId: response.headers[REQUEST_ID_HEADER],
      },
    });
  });

  it('returns 405 method-not-allowed with Allow', async () => {
    const response = await adapter().inject({ method: 'PUT', url: '/v1/products' });
    expect(response.statusCode).toBe(405);
    expect(response.headers['allow']).toBe('GET, HEAD, OPTIONS, POST');
    expect(response.json()).toMatchObject({ error: { code: 'method-not-allowed' } });
  });

  // `inject()` resolves dot-segments itself; the acceptance test covers them over a real socket.
  it.each(['/v1/%zz', '/v1/a%2Fb', '/v1//products', '/v1/%C3'])('returns 400 invalid-request for %s', async (url) => {
    const response = await adapter().inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.json()).toMatchObject({ error: { code: 'invalid-request' } });
  });

  it('returns 413 request-too-large past the body limit', async () => {
    const response = await adapter({ limits: { maxBodyBytes: 8 } }).inject({
      method: 'POST',
      url: '/v1/products',
      payload: 'x'.repeat(9),
      headers: { 'content-type': 'text/plain' },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'request-too-large' } });
  });

  it('accepts bodies of any content type within the limit', async () => {
    const response = await adapter({ limits: { maxBodyBytes: 8 } }).inject({
      method: 'POST',
      url: '/v1/products',
      payload: Buffer.from([1, 2, 3]),
      headers: { 'content-type': 'application/x-anything' },
    });
    expect(response.statusCode).toBe(201);
  });

  describe('request bodies on every method (review X2)', () => {
    it.each(['GET', 'OPTIONS', 'DELETE', 'TRACE', 'PURGE', 'QUERY'])(
      'passes a %s body to core, as the explorer would',
      async (method) => {
        // Rendering needs a clock, even for a token that reads none.
        const response = await adapter({ engine: createEngine({ snapshot, clock: () => 0 }) }).inject({
          method: method as 'GET',
          url: '/v1/echo',
          payload: '{"q":1}',
          headers: { 'content-type': 'application/json' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ q: 1 });
      },
    );

    it('bounds a GET or HEAD body by maxBodyBytes', async () => {
      const instance = adapter({ limits: { maxBodyBytes: 8 } });
      const get = await instance.inject({ method: 'GET', url: '/v1/echo', payload: 'x'.repeat(9) });
      expect(get.statusCode).toBe(413);
      expect(get.json()).toMatchObject({ error: { code: 'request-too-large' } });
      const head = await instance.inject({ method: 'HEAD', url: '/v1/products', payload: 'x'.repeat(9) });
      expect(head.statusCode).toBe(413);
      expect(head.body).toBe('');
      expect((await instance.inject({ method: 'GET', url: '/v1/products', payload: 'x'.repeat(8) })).statusCode).toBe(
        200,
      );
    });

    it('bounds a streamed body without Content-Length too', async () => {
      const { head } = await exchange(
        adapter({ limits: { maxBodyBytes: 8 } }),
        'GET /v1/echo HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n' +
          '5\r\nxxxxx\r\n5\r\nxxxxx\r\n0\r\n\r\n',
      );
      expect(head).toMatch(/^HTTP\/1\.1 413 /);
    });
  });

  it.each(['text', 'text/', ';', 'a b/c'])(
    'lets core decide on a malformed Content-Type %j (review A4)',
    async (contentType) => {
      const response = await adapter().inject({
        method: 'POST',
        url: '/v1/products',
        payload: '{"name":"x"}',
        headers: { 'content-type': contentType },
      });
      expect(response.statusCode).toBe(201);
    },
  );

  it('refuses any body at maxBodyBytes 0 and still serves without one', async () => {
    const instance = adapter({ limits: { maxBodyBytes: 0 } });
    expect((await instance.inject({ method: 'GET', url: '/v1/products' })).statusCode).toBe(200);
    expect((await instance.inject({ method: 'GET', url: '/v1/products', payload: 'x' })).statusCode).toBe(413);
  });

  it.each([
    ['an unknown method', 'FOO /v1/products HTTP/1.1'],
    ['a lowercase method', 'get /v1/products HTTP/1.1'],
    ['a raw non-ASCII byte in the path', 'GET /v1/caf\xe9 HTTP/1.1'],
    ['a malformed version', 'GET /v1/products HTTP/9'],
  ])('answers a parser-level 400 for %s with the envelope (review A3)', async (_name, line) => {
    const instance = adapter();
    const { head, body } = await exchange(instance, `${line}\r\nHost: localhost\r\n\r\n`);
    expect(head).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    expect(head).toContain('Content-Type: application/json');
    expect(head).toContain('Connection: close');
    expect(head).toContain(`Content-Length: ${String(Buffer.byteLength(body))}`);
    const requestId = /x-janus-request-id: (\S+)/.exec(head)?.[1];
    expect(JSON.parse(body)).toEqual({ error: { code: 'invalid-request', message: 'Invalid request', requestId } });
    expect(records).toEqual([{ requestId, method: '-', path: '-', status: 400, durationMs: 0 }]);
  });

  it('turns an engine failure into 500 internal-error without leaking details', async () => {
    const failures: unknown[] = [];
    const failing: Engine = {
      ...createEngine({ snapshot }),
      resolve: () => Promise.reject(new Error('boom at /home/secret/data')),
    };
    const response = await adapter({ engine: failing, onInternalError: (_id, error) => failures.push(error) }).inject({
      method: 'GET',
      url: '/v1/products',
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'internal-error' } });
    expect(response.body).not.toContain('/home/secret');
    expect(response.body).not.toContain('boom');
    expect(failures).toHaveLength(1);
  });

  describe('Host on a loopback listener', () => {
    const get = (path: string, host: string | null, version = '1.1'): string =>
      `GET ${path} HTTP/${version}\r\n${host === null ? '' : `Host: ${host}\r\n`}Connection: close\r\n\r\n`;

    it.each(['/v1/products', '/_janus/health', '/_janus/endpoints'])(
      'answers 421 host-not-allowed to a rebound name on %s',
      async (path) => {
        const { head, body } = await exchange(adapter(), (port) => get(path, `evil.example:${String(port)}`));
        expect(head).toMatch(/^HTTP\/1\.1 421 Misdirected Request\r\n/);
        expect(head).toContain('content-type: application/json');
        const requestId = /x-janus-request-id: (\S+)/.exec(head)?.[1];
        expect(JSON.parse(body)).toEqual({
          error: {
            code: 'host-not-allowed',
            message: 'The Host header does not name this loopback server',
            requestId,
          },
        });
        expect(records).toEqual([expect.objectContaining({ path: '-', status: 421 })]);
      },
    );

    it('refuses a state-changing Atlas request from a rebound page, Origin and all', async () => {
      const { head } = await exchange(
        adapter(),
        (port) =>
          `POST /_janus/resolve HTTP/1.1\r\nHost: evil.example:${String(port)}\r\nOrigin: http://evil.example:${String(port)}\r\n` +
          'Content-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}',
      );
      expect(head).toMatch(/^HTTP\/1\.1 421 /);
    });

    it.each(['localhost', 'atlas.localhost', '127.0.0.1', '127.0.0.2', '[::1]', 'LOCALHOST'])(
      'serves Host %s, with or without the port',
      async (host) => {
        const instance = adapter();
        expect((await exchange(instance, (port) => get('/v1/products', `${host}:${String(port)}`))).head).toMatch(
          /^HTTP\/1\.1 200 /,
        );
        expect((await exchange(instance, get('/v1/products', host))).head).toMatch(/^HTTP\/1\.1 200 /);
      },
    );

    it('serves the configured server.host and a request without Host', async () => {
      const instance = adapter({ host: 'janus.test' });
      expect((await exchange(instance, get('/v1/products', 'janus.test'))).head).toMatch(/^HTTP\/1\.1 200 /);
      expect((await exchange(instance, get('/v1/products', null, '1.0'))).head).toMatch(/^HTTP\/1\.1 200 /);
      expect((await exchange(instance, get('/v1/products', 'other.test'))).head).toMatch(/^HTTP\/1\.1 421 /);
    });

    it('refuses a malformed Host and answers HEAD without a body', async () => {
      const instance = adapter();
      expect((await exchange(instance, get('/v1/products', 'bad_host!'))).head).toMatch(/^HTTP\/1\.1 421 /);
      const head = await exchange(
        instance,
        'HEAD /v1/products HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n',
      );
      expect(head.head).toMatch(/^HTTP\/1\.1 421 /);
      expect(head.body).toBe('');
    });

    it('leaves a non-loopback listener unchanged', async () => {
      const { head } = await exchange(adapter(), get('/v1/products', 'evil.example'), '0.0.0.0');
      expect(head).toMatch(/^HTTP\/1\.1 200 /);
    });
  });

  describe('/_janus/health', () => {
    it('reports readiness and the active snapshot without private details', async () => {
      const response = await adapter().inject({ method: 'GET', url: '/_janus/health' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/json');
      expect(response.headers['cache-control']).toBe('no-store');
      // Every field and header is unchanged, with `apiVersion`, `snapshotVersion`,
      // `capabilities` and `lastReload`.
      expect(response.json()).toEqual({
        apiVersion: 'atlas.v1',
        status: 'ready',
        snapshot: snapshot.version,
        snapshotVersion: snapshot.version,
        fixtureCount: snapshot.fixtureCount,
        routeCount: snapshot.routeCount,
        configDigest: expect.stringMatching(/^cfg_[0-9a-f]{16}$/) as unknown,
        warnings: [],
        scenarioCount: 1,
        configuredDefaultScenario: 'default',
        capabilities: {
          resolve: true,
          reload: false,
          watch: false,
          events: false,
          ui: false,
          cors: { origins: 0, fixtures: 0 },
          scenarios: true,
          sessions: true,
          variants: true,
          sequences: true,
          pages: true,
          expectations: true,
          idempotency: true,
          recording: { available: false, endpoints: 0 },
          promotion: { available: false, mode: 'staged', pending: 0 },
          // The transport capabilities.
          faults: { enabled: true, timeoutMs: 120000, maxHeldConnections: 128 },
          compression: { enabled: true, encodings: ['br', 'gzip', 'deflate'] },
          codecs: { xml: true },
          autoOptions: true,
          runner: { available: false, collections: 0 },
        },
        lastReload: null,
      });
    });

    it('supports HEAD and rejects other methods with 405', async () => {
      const head = await adapter().inject({ method: 'HEAD', url: '/_janus/health' });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      const post = await app?.inject({ method: 'POST', url: '/_janus/health' });
      expect(post?.statusCode).toBe(405);
      expect(post?.headers['allow']).toBe('GET, HEAD');
    });

    it('returns a normal 404 for unknown paths under /_janus', async () => {
      const response = await adapter().inject({ method: 'GET', url: '/_janus/unknown' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'route-not-found' } });
    });
  });

  it('records one completion per request with the normalised path and no header values', async () => {
    const instance = adapter();
    await instance.inject({ method: 'GET', url: '/v1/products?token=secret', headers: { authorization: 'Bearer x' } });
    const bad = await instance.inject({ method: 'GET', url: '/v1/%zz' });
    expect(bad.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    expect(records).toEqual([
      expect.objectContaining({ method: 'GET', path: '/v1/products', status: 200 }),
      expect.objectContaining({ method: 'GET', path: '-', status: 400 }),
    ]);
    expect(JSON.stringify(records)).not.toContain('Bearer');
    expect(JSON.stringify(records)).not.toContain('secret');
  });

  it('returns deterministic results for concurrent requests', async () => {
    const instance = adapter();
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        instance.inject({ method: index % 2 === 0 ? 'GET' : 'PUT', url: '/v1/products' }),
      ),
    );
    responses.forEach((response, index) => {
      if (index % 2 === 0) expect(response.body).toBe(PRODUCTS_JSON);
      else expect(response.statusCode).toBe(405);
    });
  });

  describe('request limits', () => {
    it('keeps the defaults, with the decoded body limit', () => {
      expect(DEFAULT_LIMITS).toEqual({
        maxUrlBytes: 8192,
        maxHeaderBytes: 16384,
        maxBodyBytes: 1024 * 1024,
        maxDecodedBodyBytes: 4 * 1024 * 1024,
      });
    });

    describe('maxBodyBytes', () => {
      const post = (bytes: number) =>
        adapter({ limits: { maxBodyBytes: 16 } }).inject({
          method: 'POST',
          url: '/v1/products',
          payload: 'x'.repeat(bytes),
          headers: { 'content-type': 'text/plain' },
        });

      it.each([15, 16])('accepts %i bytes at a 16-byte limit', async (bytes) => {
        expect((await post(bytes)).statusCode).toBe(201);
      });

      it('answers 413 request-too-large one byte above it', async () => {
        const response = await post(17);
        expect(response.statusCode).toBe(413);
        expect(response.json()).toMatchObject({ error: { code: 'request-too-large' } });
      });

      describe('at 0, no request body is allowed', () => {
        const send = (payload: string, headers: Record<string, string> = { 'content-type': 'text/plain' }) =>
          adapter({ limits: { maxBodyBytes: 0 } }).inject({ method: 'POST', url: '/v1/products', payload, headers });

        it('accepts an empty body', async () => {
          expect((await send('')).statusCode).toBe(201);
        });

        it.each([
          ['with', { 'content-type': 'text/plain' }],
          ['without', {}],
        ])('answers 413 request-too-large for one byte %s a content type', async (_label, headers) => {
          const response = await send('x', headers);
          expect(response.statusCode).toBe(413);
          expect(response.json()).toMatchObject({ error: { code: 'request-too-large' } });
        });
      });
    });

    describe('maxUrlBytes', () => {
      /** A target of exactly `bytes` bytes that matches /v1/products. */
      const target = (bytes: number): string => {
        const base = '/v1/products?q=';
        return base + 'x'.repeat(bytes - base.length);
      };

      it.each([299, 300])('serves a %i-byte target at a 300-byte limit', async (bytes) => {
        const response = await adapter({ limits: { maxUrlBytes: 300 } }).inject({ method: 'GET', url: target(bytes) });
        expect(response.statusCode).toBe(200);
      });

      it('answers 414 url-too-long one byte above it, before resolution', async () => {
        const instance = adapter({ limits: { maxUrlBytes: 300 } });
        const response = await instance.inject({ method: 'GET', url: target(301) });
        expect(response.statusCode).toBe(414);
        expect(response.headers['content-type']).toBe('application/json');
        expect(response.json()).toEqual({
          error: {
            code: 'url-too-long',
            message: 'The request target exceeds the configured limit',
            requestId: response.headers[REQUEST_ID_HEADER],
          },
        });
        expect(records).toEqual([expect.objectContaining({ path: '-', status: 414 })]);
      });

      it('applies to Atlas and HEAD requests too, without a body for HEAD', async () => {
        const instance = adapter({ limits: { maxUrlBytes: 300 } });
        const atlas = await instance.inject({ method: 'GET', url: `/_janus/health?${'x'.repeat(300)}` });
        expect(atlas.statusCode).toBe(414);
        const head = await instance.inject({ method: 'HEAD', url: target(301) });
        expect(head.statusCode).toBe(414);
        expect(head.body).toBe('');
      });

      it('counts percent-encoded bytes as sent', async () => {
        const encoded = '/v1/products?q=' + '%C3%A9'.repeat(50);
        expect(encoded.length).toBe(315);
        const response = await adapter({ limits: { maxUrlBytes: 300 } }).inject({ method: 'GET', url: encoded });
        expect(response.statusCode).toBe(414);
      });
    });

    describe('maxHeaderBytes', () => {
      /** Sends raw HTTP/1.1 over a real socket: Node enforces the header limit in its parser, which inject() skips. */
      async function send(headerValueBytes: number, maxHeaderBytes = 2048): Promise<{ head: string; body: string }> {
        const instance = adapter({ limits: { maxHeaderBytes } });
        const answer = await exchange(
          instance,
          `GET /v1/products HTTP/1.1\r\nHost: localhost\r\nX-Padding: ${'a'.repeat(headerValueBytes)}\r\nConnection: close\r\n\r\n`,
        );
        await instance.close();
        return answer;
      }

      it('serves requests whose headers are within the limit', async () => {
        expect((await send(1900)).head).toMatch(/^HTTP\/1\.1 200 /);
      });

      it.each([
        ['counted by Janus', 2048],
        ["past Node's own parser limit", 20_000],
      ])('answers 431 headers-too-large with the JSON envelope and Connection: close, %s', async (_name, bytes) => {
        const { head, body } = await send(bytes);
        expect(head).toMatch(/^HTTP\/1\.1 431 Request Header Fields Too Large\r\n/);
        expect(head).toMatch(/^Content-Type: application\/json\r?$/im);
        expect(head).toMatch(/^Connection: close\r?$/im);
        const requestId = /x-janus-request-id: (\S+)/i.exec(head)?.[1];
        expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(JSON.parse(body)).toEqual({
          error: { code: 'headers-too-large', message: 'The request headers exceed the configured limit', requestId },
        });
        expect(head).toMatch(new RegExp(`^Content-Length: ${String(Buffer.byteLength(body))}\\r?$`, 'im'));
        expect(records).toEqual([expect.objectContaining({ requestId, path: '-', status: 431 })]);
      });

      it('does not count the request line (review A5)', async () => {
        const instance = adapter({ limits: { maxHeaderBytes: 2048, maxUrlBytes: 4096 } });
        const line = (bytes: number): string =>
          `GET /v1/products?q=${'x'.repeat(bytes - 15)} HTTP/1.1\r\nHost: localhost\r\nX-Padding: ${'a'.repeat(1900)}\r\nConnection: close\r\n\r\n`;
        expect((await exchange(instance, line(4096))).head).toMatch(/^HTTP\/1\.1 200 /);
        expect((await exchange(instance, line(4097))).head).toMatch(/^HTTP\/1\.1 414 /);
      });

      it('follows the configured limit', async () => {
        expect((await send(3000, 4096)).head).toMatch(/^HTTP\/1\.1 200 /);
        expect((await send(3000, 2048)).head).toMatch(/^HTTP\/1\.1 431 /);
      });
    });
  });
});
