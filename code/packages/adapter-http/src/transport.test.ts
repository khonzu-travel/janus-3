import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import zlib from 'node:zlib';

import { buildSnapshot, createEngine, type EngineConfig, type FixtureSnapshot } from '@janus/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createHttpAdapter, type HttpAdapterOptions, type RequestRecord } from './adapter.js';
import { compressBody, createHoldCapacity, decodeBody, faultBytes } from './transport.js';

// Faults, delays, codings, 100-continue and fixture CORS over HTTP.

const BIG = JSON.stringify({ items: Array.from({ length: 80 }, (_, index) => ({ id: index, name: 'item' })) });

const TREE: Readonly<Record<string, string>> = {
  'default/v1/orders/POST/201.json': '{"echo":"-"}',
  'default/v1/echo/POST/201.json': '{"echo":"{{$body.$.q}}"}',
  'default/v1/orders/POST/fault.yaml': [
    'rules:',
    '  - when: { header.x-simulate: reset }',
    '    fault: reset',
    '  - when: { header.x-simulate: hold }',
    '    fault: timeout',
    '  - when: { header.x-simulate: cut }',
    '    fault: { truncate: { bytes: 4 } }',
    '  - when: { header.x-simulate: half }',
    '    fault: truncate',
    '  - when: { header.x-simulate: status-line }',
    '    fault: { malformed: status-line }',
    '  - when: { header.x-simulate: header-line }',
    '    fault: { malformed: header-line }',
    '  - when: { header.x-simulate: conflicting-length }',
    '    fault: { malformed: conflicting-length }',
    '  - when: { header.x-simulate: bad-chunk }',
    '    fault: { malformed: bad-chunk }',
    '  - when: { header.x-simulate: steps }',
    '    fault: [timeout, none]',
    '',
  ].join('\n'),
  'default/v1/orders/{orderId}/GET/200.json': BIG,
  'default/v1/orders/{orderId}/GET/200.headers.json': '{"ETag":"\\"v1\\"","X-Trace":"t"}',
  'default/v1/orders/{orderId}/GET/fault.yaml': 'rules:\n  - when: { header.x-simulate: cut }\n    fault: truncate\n',
  'default/v1/slow/GET/200.json': '{"slow":true}',
  'default/v1/slow/GET/fault.yaml': 'latency: { ms: 150 }\n',
  'default/v1/xml/POST/201.json': '{"ok":true}',
  'default/v1/xml/POST/accepts.yaml': 'accepts: [application/xml]\n',
};

function snapshotOf(entries: Readonly<Record<string, string>>): FixtureSnapshot {
  const built = buildSnapshot(new Map(Object.entries(entries).map(([key, value]) => [key, Buffer.from(value)])));
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return built.snapshot;
}

let app: FastifyInstance | undefined;
const records: RequestRecord[] = [];

function adapter(
  config: Partial<EngineConfig> = {},
  overrides: Partial<HttpAdapterOptions> = {},
  slots = 4,
): FastifyInstance {
  records.length = 0;
  const transport = createHoldCapacity(slots);
  app = createHttpAdapter({
    engine: createEngine({
      snapshot: snapshotOf(TREE),
      config: { seed: 1, ...config },
      transport,
      clock: () => 0,
      randomBytes: (count) => new Uint8Array(count),
    }),
    onRequestComplete: (record) => records.push(record),
    ...overrides,
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function listen(instance: FastifyInstance): Promise<number> {
  if (!instance.server.listening) await instance.listen({ host: '127.0.0.1', port: 0 });
  const address = instance.server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

interface Answer {
  readonly status?: number | undefined;
  readonly headers?: IncomingHttpHeaders;
  readonly body?: Buffer;
  readonly error?: string;
  readonly ms: number;
}

/** A request through Node's HTTP client: the answer, or the client error. */
async function send(
  instance: FastifyInstance,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: Buffer | string,
): Promise<Answer> {
  const port = await listen(instance);
  const started = Date.now();
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
          ms: Date.now() - started,
        });
      });
      res.on('error', (error: Error & { code?: string }) => {
        resolve({ status: res.statusCode, error: error.code ?? error.message, ms: Date.now() - started });
      });
    });
    req.on('error', (error: Error & { code?: string }) => {
      resolve({ error: error.code ?? error.message, ms: Date.now() - started });
    });
    req.end(body);
  });
}

/** Raw bytes over a socket: everything the server wrote until it closed, and how it closed. */
async function raw(
  instance: FastifyInstance,
  text: string,
  options: { readonly closeAfterMs?: number } = {},
): Promise<{ bytes: Buffer; reset: boolean; ms: number }> {
  const port = await listen(instance);
  const started = Date.now();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let reset = false;
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(text);
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error: Error & { code?: string }) => {
      if (error.code === 'ECONNRESET') reset = true;
    });
    socket.on('close', () => {
      resolve({ bytes: Buffer.concat(chunks), reset, ms: Date.now() - started });
    });
    if (options.closeAfterMs !== undefined) {
      setTimeout(() => socket.destroy(), options.closeAfterMs);
    }
  });
}

const post = (simulate: string, extra = ''): string =>
  `POST /v1/orders HTTP/1.1\r\nHost: localhost\r\nX-Simulate: ${simulate}\r\nContent-Length: 0\r\n${extra}\r\n`;

describe('faults', () => {
  it('resets the connection without a byte', async () => {
    const instance = adapter();
    expect(await send(instance, 'POST', '/v1/orders', { 'x-simulate': 'reset' })).toMatchObject({
      error: 'ECONNRESET',
    });
    const answer = await raw(instance, post('reset'));
    expect(answer.bytes.length).toBe(0);
    expect(answer.reset).toBe(true);
    expect(records.at(-1)?.transport?.fault).toEqual({ kind: 'reset', rule: 1 });
    expect(records.at(-1)?.status).toBe(0);
    expect(records).toHaveLength(2);
  });

  it('holds a timeout until holdMs, then closes and releases the slot', async () => {
    const capacity = createHoldCapacity(1);
    records.length = 0;
    app = createHttpAdapter({
      engine: createEngine({
        snapshot: snapshotOf(TREE),
        config: { faults: { enabled: true, timeoutMs: 1000, maxHeldConnections: 1, latency: null } },
        transport: capacity,
      }),
      onRequestComplete: (record) => records.push(record),
    });
    const held = raw(app, post('hold'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(capacity.held()).toBe(1);
    // A second hold finds no free slot and gets the classified 503 instead.
    const refused = await send(app, 'POST', '/v1/orders', { 'x-simulate': 'hold' });
    expect(refused.status).toBe(503);
    expect(refused.headers?.['connection']).toBe('close');
    expect(JSON.parse(refused.body?.toString() ?? '')).toMatchObject({ error: { code: 'fault-capacity-exceeded' } });
    const answer = await held;
    expect(answer.bytes.length).toBe(0);
    expect(answer.ms).toBeGreaterThanOrEqual(900);
    expect(answer.ms).toBeLessThan(3000);
    expect(capacity.held()).toBe(0);
  });

  it('releases a held slot when the client closes, and closes holds at shutdown', async () => {
    const capacity = createHoldCapacity(2);
    app = createHttpAdapter({ engine: createEngine({ snapshot: snapshotOf(TREE), transport: capacity }) });
    await raw(app, post('hold'), { closeAfterMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(capacity.held()).toBe(0);
    const held = raw(app, post('hold'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(capacity.held()).toBe(1);
    const started = Date.now();
    await app.close();
    app = undefined;
    await held;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(capacity.held()).toBe(0);
  });

  it('truncates the body with and without bytes, keeping the full Content-Length', async () => {
    const instance = adapter();
    const cut = await raw(instance, post('cut'));
    const text = cut.bytes.toString('latin1');
    expect(text).toMatch(/^HTTP\/1\.1 201 Created\r\n/);
    expect(text).toMatch(/\r\ncontent-length: 12\r\n/);
    expect(text).toMatch(/\r\nx-mock-fault: truncate; rule=3\r\n/);
    expect(text.split('\r\n\r\n')[1]).toBe('{"ec');
    const half = await raw(instance, post('half'));
    expect(half.bytes.toString('latin1').split('\r\n\r\n')[1]).toBe('{"echo');
    expect(await send(instance, 'POST', '/v1/orders', { 'x-simulate': 'cut' })).toMatchObject({ error: 'ECONNRESET' });
  });

  it('truncates the compressed bytes, and writes HEAD without the blank line', async () => {
    const instance = adapter();
    const coded = await raw(
      instance,
      'GET /v1/orders/o-1 HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\nX-Simulate: cut\r\n\r\n',
    );
    const [head, body = ''] = coded.bytes.toString('latin1').split('\r\n\r\n');
    const length = Number(/content-length: (\d+)/.exec(head ?? '')?.[1]);
    expect(length).toBe(compressBody(Buffer.from(BIG), 'gzip').length);
    expect(head).toMatch(/content-encoding: gzip/);
    expect(body.length).toBe(Math.floor(length / 2));
    const headOnly = await raw(instance, 'HEAD /v1/orders/o-1 HTTP/1.1\r\nHost: localhost\r\nX-Simulate: cut\r\n\r\n');
    const text = headOnly.bytes.toString('latin1');
    expect(text).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(text).toMatch(new RegExp(`content-length: ${String(Buffer.byteLength(BIG))}\\r\\nconnection: close\\r\\n$`));
    expect(text).not.toContain('\r\n\r\n');
  });

  it.each([
    [
      'status-line',
      /^HTTP\/1\.1 9999 Malformed\r\n[\s\S]*content-length: 12\r\nconnection: close\r\n\r\n\{"echo":"-"\}$/,
    ],
    ['header-line', /^HTTP\/1\.1 201 Created\r\n[\s\S]*\r\nMalformed header line\r\n\r\n\{"echo":"-"\}$/],
    [
      'conflicting-length',
      /^HTTP\/1\.1 201 Created\r\n[\s\S]*content-length: 12\r\ncontent-length: 13\r\n\r\n\{"echo":"-"\}$/,
    ],
    ['bad-chunk', /^HTTP\/1\.1 201 Created\r\n[\s\S]*transfer-encoding: chunked\r\n\r\nzz\r\n\{"echo":"-"\}$/],
  ])('writes the %s form byte for byte, rejected by Node’s client', async (form, pattern) => {
    const instance = adapter();
    const answer = await raw(instance, post(form));
    const text = answer.bytes.toString('latin1');
    expect(text).toMatch(pattern);
    if (form === 'bad-chunk') expect(text).not.toMatch(/content-length/);
    const client = await send(instance, 'POST', '/v1/orders', { 'x-simulate': form });
    expect(client.error).toBeDefined();
  });

  it('decides but performs nothing with faults.enabled false', async () => {
    const instance = adapter({
      faults: { enabled: false, timeoutMs: 1000, maxHeldConnections: 1, latency: { ms: 500 } },
    });
    const answer = await send(instance, 'POST', '/v1/orders', { 'x-simulate': 'reset' });
    expect(answer.status).toBe(201);
    expect(answer.ms).toBeLessThan(400);
    expect(records.at(-1)?.transport).toMatchObject({ latencyMs: 0, fault: null });
  });
});

describe('delays', () => {
  it('waits the latency before the first byte, with X-Mock-Latency', async () => {
    const instance = adapter();
    const answer = await send(instance, 'GET', '/v1/slow');
    expect(answer.status).toBe(200);
    expect(answer.headers?.['x-mock-latency']).toBe('150');
    expect(answer.ms).toBeGreaterThanOrEqual(140);
    expect(records.at(-1)?.transport).toMatchObject({ latencyMs: 150, fault: null });
  });

  it('stops when the client closes during the wait, consuming no fault step', async () => {
    const instance = adapter({
      faults: { enabled: true, timeoutMs: 1000, maxHeldConnections: 4, latency: { ms: 300 } },
    });
    const engineSession = await instance.inject({
      method: 'POST',
      url: '/_janus/session',
      headers: { 'x-mock-session': 's1', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(engineSession.statusCode).toBe(201);
    const abandoned = await raw(instance, post('steps', 'X-Mock-Session: s1\r\n'), { closeAfterMs: 50 });
    expect(abandoned.bytes.length).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 350));
    // The first step (timeout) is still unused, so this request is held, not answered.
    const next = await raw(instance, post('steps', 'X-Mock-Session: s1\r\n'), { closeAfterMs: 600 });
    expect(next.bytes.length).toBe(0);
  });
});

describe('request bodies', () => {
  const echo = (instance: FastifyInstance, body: Buffer, coding: string) =>
    instance.inject({
      method: 'POST',
      url: '/v1/echo',
      headers: { 'content-type': 'application/json', 'content-encoding': coding },
      payload: body,
    });
  const json = Buffer.from('{"q":"hi"}');

  it.each([
    ['gzip', zlib.gzipSync(json)],
    ['x-gzip', zlib.gzipSync(json)],
    ['deflate', zlib.deflateSync(json)],
    ['br', zlib.brotliCompressSync(json)],
    ['gzip, br', zlib.brotliCompressSync(zlib.gzipSync(json))],
    ['identity', json],
  ])('decodes %s before resolution', async (coding, body) => {
    const instance = adapter();
    const response = await echo(instance, body, coding);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ echo: 'hi' });
  });

  it('refuses unknown codings with Accept-Encoding, and malformed values', async () => {
    const instance = adapter();
    const unknown = await echo(instance, json, 'zstd');
    expect(unknown.statusCode).toBe(415);
    expect(unknown.headers['accept-encoding']).toBe('br, deflate, gzip');
    expect(unknown.json()).toMatchObject({ error: { code: 'unsupported-content-encoding' } });
    expect((await echo(instance, json, 'gzip, gzip, gzip, gzip, gzip')).statusCode).toBe(415);
    expect((await echo(instance, json, '"gzip"')).statusCode).toBe(400);
  });

  it('refuses corrupt, truncated and trailing data, naming the coding', async () => {
    const instance = adapter();
    const gzip = zlib.gzipSync(json);
    for (const [body, coding] of [
      [json, 'gzip'],
      [gzip.subarray(0, gzip.length - 4), 'gzip'],
      [Buffer.concat([zlib.deflateSync(json), Buffer.from('xx')]), 'deflate'],
      [Buffer.concat([zlib.brotliCompressSync(json), Buffer.from('xx')]), 'br'],
    ] as const) {
      const response = await echo(instance, body, coding);
      expect(response.statusCode).toBe(400);
      const { error } = response.json<{ error: { code: string; message: string } }>();
      expect(error.code).toBe('invalid-request');
      expect(error.message).toContain(coding);
    }
  });

  it('stops a compression bomb at maxDecodedBodyBytes', async () => {
    const instance = adapter({}, { limits: { maxBodyBytes: 64 * 1024, maxDecodedBodyBytes: 1024 * 1024 } });
    const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    const before = process.memoryUsage().rss;
    const response = await echo(instance, bomb, 'gzip');
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'decoded-body-too-large' } });
    expect(process.memoryUsage().rss - before).toBeLessThan(48 * 1024 * 1024);
    expect(await decodeBody(bomb, ['gzip'], 1024)).toEqual({ kind: 'too-large' });
  });

  it('ignores Content-Encoding on an empty body', async () => {
    const instance = adapter();
    const response = await instance.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { 'content-encoding': 'zstd' },
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('response compression', () => {
  it.each(['gzip', 'deflate', 'br'] as const)('compresses %s with the fixed levels and a weak ETag', async (coding) => {
    const instance = adapter();
    const response = await instance.inject({
      method: 'GET',
      url: '/v1/orders/o-1',
      headers: { 'accept-encoding': coding },
    });
    expect(response.headers['content-encoding']).toBe(coding);
    expect(response.headers['vary']).toBe('Accept, Accept-Encoding');
    expect(response.headers['etag']).toBe('W/"v1"');
    expect(response.rawPayload.equals(Buffer.from(compressBody(Buffer.from(BIG), coding)))).toBe(true);
    expect(Number(response.headers['content-length'])).toBe(response.rawPayload.length);
    const again = await instance.inject({
      method: 'GET',
      url: '/v1/orders/o-1',
      headers: { 'accept-encoding': coding },
    });
    expect(again.rawPayload.equals(response.rawPayload)).toBe(true);
    expect(records.at(-1)?.transport?.responseCoding).toBe(coding);
  });

  it('gives HEAD the compressed Content-Length, and leaves errors and the Atlas alone', async () => {
    const instance = adapter();
    const head = await instance.inject({
      method: 'HEAD',
      url: '/v1/orders/o-1',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(head.headers['content-encoding']).toBe('gzip');
    expect(Number(head.headers['content-length'])).toBe(compressBody(Buffer.from(BIG), 'gzip').length);
    expect(head.rawPayload.length).toBe(0);
    const miss = await instance.inject({ method: 'GET', url: '/nowhere', headers: { 'accept-encoding': 'gzip' } });
    expect(miss.headers['content-encoding']).toBeUndefined();
    const atlas = await instance.inject({
      method: 'GET',
      url: '/_janus/routes',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(atlas.headers['content-encoding']).toBeUndefined();
    const plain = await instance.inject({ method: 'GET', url: '/v1/orders/o-1' });
    expect(plain.body).toBe(BIG);
  });
});

describe('Expect: 100-continue', () => {
  const expectRequest = (path: string, contentType: string, extra = ''): string =>
    `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: ${contentType}\r\nContent-Length: 9\r\nExpect: 100-continue\r\n${extra}\r\n`;

  it('refuses from the head without 100 Continue and without reading the body', async () => {
    const instance = adapter();
    for (const [request, status] of [
      [expectRequest('/v1/xml', 'text/plain'), 415],
      [expectRequest('/nowhere', 'application/xml'), 404],
      [expectRequest('/v1/xml', 'application/xml', 'Content-Encoding: zstd\r\n'), 415],
      [expectRequest('/v1/xml', 'application/xml').replace('Content-Length: 9', 'Content-Length: 99999999'), 413],
    ] as const) {
      const answer = await raw(instance, request);
      const text = answer.bytes.toString('latin1');
      expect(text).not.toContain('100 Continue');
      expect(text).toMatch(new RegExp(`^HTTP/1\\.1 ${String(status)} `));
      expect(text.toLowerCase()).toContain('connection: close');
    }
  });

  it('sends 100 Continue, then the response', async () => {
    const instance = adapter();
    const port = await listen(instance);
    const text = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(expectRequest('/v1/xml', 'application/xml', 'Connection: close\r\n'));
      });
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (chunk.toString().startsWith('HTTP/1.1 100 Continue')) socket.write('<order/> ');
      });
      socket.on('close', () => {
        resolve(Buffer.concat(chunks).toString('latin1'));
      });
    });
    expect(text).toMatch(/^HTTP\/1\.1 100 Continue\r\n\r\nHTTP\/1\.1 201 Created\r\n/);
  });

  it('answers other expectations with 417, and ignores Expect on HTTP/1.0', async () => {
    const instance = adapter();
    const refused = await raw(instance, expectRequest('/v1/xml', 'application/xml').replace('100-continue', 'teapot'));
    expect(refused.bytes.toString('latin1')).toMatch(/^HTTP\/1\.1 417 /);
    expect(refused.bytes.toString('latin1')).toContain('unsupported-expectation');
    const old = await raw(
      instance,
      expectRequest('/v1/xml', 'application/xml').replace('HTTP/1.1', 'HTTP/1.0') + '<order/> ',
    );
    expect(old.bytes.toString('latin1')).toMatch(/^HTTP\/1\.1 201 /);
  });

  it('refuses mixed expectations without requesting the body', async () => {
    const instance = adapter();
    for (const expectation of ['100-continue, teapot', 'teapot, 100-continue']) {
      const answer = await raw(
        instance,
        expectRequest('/v1/xml', 'application/xml').replace('100-continue', expectation),
      );
      const text = answer.bytes.toString('latin1');
      expect(text).toMatch(/^HTTP\/1\.1 417 /);
      expect(text).not.toContain('100 Continue');
      expect(text).toContain('connection: close');
    }
  });
});

describe('fixture CORS', () => {
  const settings = { fixtureCors: { origins: ['http://page.test'], credentials: true, maxAge: 600 } };
  const listed = (config: Partial<EngineConfig> = settings) =>
    adapter(config, { fixtureCors: config.fixtureCors ?? { origins: [], credentials: false, maxAge: 600 } });

  it('answers a preflight and adds CORS to responses, errors included', async () => {
    const instance = listed();
    const preflight = await instance.inject({
      method: 'OPTIONS',
      url: '/v1/orders/o-1',
      headers: { origin: 'http://page.test', 'access-control-request-method': 'GET' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://page.test');
    expect(preflight.headers['access-control-allow-methods']).toBe('GET, HEAD');
    expect(preflight.headers['access-control-expose-headers']).toBeUndefined();

    const actual = await instance.inject({
      method: 'GET',
      url: '/v1/orders/o-1',
      headers: { origin: 'http://page.test' },
    });
    expect(actual.headers['access-control-allow-origin']).toBe('http://page.test');
    expect(actual.headers['access-control-allow-credentials']).toBe('true');
    expect(String(actual.headers['access-control-expose-headers'])).toContain('etag');
    expect(String(actual.headers['access-control-expose-headers'])).toContain('x-mock-identity');
    expect(String(actual.headers['vary'])).toContain('Origin');

    const error = await instance.inject({ method: 'GET', url: '/nowhere', headers: { origin: 'http://page.test' } });
    expect(error.headers['access-control-allow-origin']).toBe('http://page.test');
    const unlisted = await instance.inject({
      method: 'GET',
      url: '/v1/orders/o-1',
      headers: { origin: 'http://x.test' },
    });
    expect(unlisted.headers['access-control-allow-origin']).toBeUndefined();
    expect(String(unlisted.headers['vary'])).toContain('Origin');
  });

  it('answers a refused preflight as a plain OPTIONS, and never touches Atlas routes', async () => {
    const instance = listed();
    const refused = await instance.inject({
      method: 'OPTIONS',
      url: '/v1/orders/o-1',
      headers: { origin: 'http://page.test', 'access-control-request-method': 'DELETE' },
    });
    expect(refused.statusCode).toBe(204);
    expect(refused.headers['allow']).toBe('GET, HEAD, OPTIONS');
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
    const atlas = await instance.inject({
      method: 'GET',
      url: '/_janus/health',
      headers: { origin: 'http://page.test' },
    });
    expect(atlas.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('adds nothing with fixture CORS off', async () => {
    const instance = adapter();
    const response = await instance.inject({
      method: 'GET',
      url: '/v1/orders/o-1',
      headers: { origin: 'http://page.test' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(String(response.headers['vary'])).not.toContain('Origin');
  });
});

describe('transport helpers', () => {
  it('writes truncate bytes for an empty body without the blank line', () => {
    expect(
      faultBytes({ status: 204, headers: [['x-a', '1']], body: null }, { kind: 'truncate', bytes: null }).toString(
        'latin1',
      ),
    ).toBe('HTTP/1.1 204 No Content\r\nx-a: 1\r\n');
  });

  it('counts held slots and releases each ticket once', () => {
    const capacity = createHoldCapacity(1);
    const ticket = capacity.tryHold();
    expect(capacity.tryHold()).toBeNull();
    ticket?.release();
    ticket?.release();
    expect(capacity.held()).toBe(0);
  });
});
