import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  buildSnapshot,
  createEngine,
  reloadProblem,
  type AtlasReloadResult,
  type AtlasSnapshotEvent,
  type FixtureSnapshot,
} from '@janus/core';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpAdapter, type HttpAdapterOptions, type RequestRecord } from './adapter.js';
import type { AtlasReloadService } from './atlas.js';

// The Atlas routes: POST /_janus/resolve, /_janus/reload,
// /_janus/events and the health additions.

function snapshotOf(entries: Readonly<Record<string, string>>): FixtureSnapshot {
  const built = buildSnapshot(new Map(Object.entries(entries).map(([key, value]) => [key, utf8(value)])));
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return built.snapshot;
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const TOKEN = 'example-token-91aa';

const snapshot = snapshotOf({
  'default/v1/products/GET/200_{application-json}.json': '[{"id":"p-1"}]',
  'default/v1/products/GET/200.headers.json': JSON.stringify({ 'Set-Cookie': `s=${TOKEN}`, 'X-Example': 'x' }),
  'default/v1/products/featured/GET/200_{application-json}.json': '{"featured":true}',
  'default/v1/products/{productId}/GET/200_{application-json}.json': '{"id":"{{$path.productId}}"}',
  'default/v1/products/{productId}/GET/200_{application-yaml}.yaml': 'id: "{{$path.productId}}"\n',
  'default/v1/products/{productId}/reviews/GET/200_{application-json}.json': '[]',
  'default/v1/echo/POST/200_{application-json}.json': '{"got":"{{$body.$.name}}"}',
  'default/v1/p-1/DELETE/204': '',
});

let app: FastifyInstance | undefined;
const records: RequestRecord[] = [];

function adapter(overrides: Partial<HttpAdapterOptions> = {}): FastifyInstance {
  records.length = 0;
  app = createHttpAdapter({
    engine: createEngine({ snapshot, config: { now: Date.UTC(2026, 0, 1), seed: 1 } }),
    onRequestComplete: (record) => records.push(record),
    ...overrides,
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const resolve = (envelope: unknown, options: Partial<InjectOptions> = {}) =>
  (app ?? adapter()).inject({
    method: 'POST',
    url: '/_janus/resolve',
    headers: { 'content-type': 'application/json' },
    payload: typeof envelope === 'string' ? envelope : JSON.stringify(envelope),
    ...options,
  });

describe('POST /_janus/resolve', () => {
  it('answers 200 with the simulated response, trace, fixture link and notes', async () => {
    const response = await resolve({
      method: 'GET',
      target: '/v1/products/featured/reviews',
      headers: { accept: ['application/json'] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      apiVersion: 'atlas.v1',
      snapshotVersion: snapshot.version,
      response: {
        status: 200,
        body: { state: 'available', encoding: 'utf8', value: '[]', byteLength: 2, truncated: false },
      },
      trace: {
        outcome: { kind: 'matched' },
        route: {
          template: '/v1/products/{productId}/reviews',
          params: { productId: 'featured' },
          considered: ['/v1/products/featured'],
        },
      },
      notes: ['transport limits (413, 414, 431) are not simulated'],
    });
    const fixture = body['fixture'] as { endpointId: string; fixtureId: string; detailHref: string };
    expect(fixture.detailHref).toBe(`fixtures/${fixture.fixtureId}?at=${snapshot.version}`);
    // The link opens the fixture's Atlas detail.
    const detail = await app?.inject({ method: 'GET', url: `/_janus/${fixture.detailHref}` });
    expect(detail?.json()).toMatchObject({ id: fixture.fixtureId, endpointId: fixture.endpointId });
  });

  it.each([
    ['route-not-found', { method: 'GET', target: '/v1/nowhere' }, 404],
    ['method-not-allowed', { method: 'PATCH', target: '/v1/products' }, 405],
    ['not-acceptable', { method: 'GET', target: '/v1/products', headers: { accept: 'text/csv' } }, 406],
    ['invalid-request', { method: 'GET', target: '/v1/../x' }, 400],
    ['the Atlas namespace', { method: 'GET', target: '/_janus/health' }, 404],
    ['a bodyless status', { method: 'DELETE', target: '/v1/p-1' }, 204],
    ['HEAD', { method: 'HEAD', target: '/v1/products' }, 200],
  ])('answers 200 for a simulated %s', async (_label, envelope, status) => {
    const response = await resolve(envelope);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ response: { status: number; body: unknown }; fixture: unknown }>();
    expect(body.response.status).toBe(status);
    if (status === 204 || envelope.method === 'HEAD') {
      expect(body.response.body).toEqual({ state: 'unavailable', reason: 'bodyless' });
    }
    if (status >= 400) expect(body.fixture).toBeNull();
  });

  it('simulates a body in either encoding, and the clock override', async () => {
    const utf8Body = await resolve({
      method: 'POST',
      target: '/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: { encoding: 'utf8', data: '{"name":"Chair"}' },
    });
    expect(utf8Body.json()).toMatchObject({ response: { body: { value: '{"got":"Chair"}' } } });
    const base64 = await resolve({
      method: 'POST',
      target: '/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: { encoding: 'base64', data: Buffer.from('{"name":"Desk"}').toString('base64') },
      nowMs: 0,
    });
    expect(base64.json()).toMatchObject({ response: { body: { value: '{"got":"Desk"}' } } });
  });

  it('shows every response header value and never echoes request values in the trace', async () => {
    const response = await resolve({
      method: 'GET',
      target: '/v1/products',
      headers: { authorization: `Bearer ${TOKEN}-request`, cookie: 'c=1' },
    });
    const body = response.json<{ response: { headers: unknown[] }; trace: unknown }>();
    expect(body.response.headers).toContainEqual({ name: 'set-cookie', value: `s=${TOKEN}` });
    expect(JSON.stringify(body.trace)).not.toContain(`${TOKEN}-request`);
  });

  it('logs the call as an Atlas read, never the simulated request', async () => {
    adapter();
    await resolve({ method: 'GET', target: '/v1/products' });
    expect(records).toEqual([expect.objectContaining({ method: 'POST', path: '/_janus/resolve', status: 200 })]);
  });

  it.each([
    ['no Content-Type', {}],
    ['text/plain', { 'content-type': 'text/plain' }],
    ['application/jsonx', { 'content-type': 'application/jsonx' }],
  ])('answers 415 for %s', async (_label, headers) => {
    const response = await resolve({ method: 'GET', target: '/' }, { headers });
    expect(response.statusCode).toBe(415);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ error: { code: 'unsupported-media-type' } });
  });

  it('accepts the JSON media type in any case and with parameters', async () => {
    const response = await resolve(
      { method: 'GET', target: '/v1/products' },
      { headers: { 'content-type': 'Application/JSON; charset=utf-8' } },
    );
    expect(response.statusCode).toBe(200);
  });

  it.each([
    ['malformed JSON', '{"method":', ''],
    ['an empty body', '', ''],
    ['an array', '[]', ''],
    ['an unknown key', { method: 'GET', target: '/', session: 'x' }, 'session'],
    ['a missing target', { method: 'GET' }, 'target'],
    ['invalid base64', { method: 'POST', target: '/', body: { encoding: 'base64', data: '***' } }, 'body.data'],
    ['an invalid instant', { method: 'GET', target: '/', nowMs: 'yesterday' }, 'nowMs'],
    ['case-colliding headers', { method: 'GET', target: '/', headers: { A: 'x', a: 'y' } }, 'headers.a'],
  ])('answers 400 atlas-invalid-request for %s', async (_label, envelope, field) => {
    const response = await resolve(envelope);
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('atlas-invalid-request');
    if (field !== '') expect(body.error.message).toContain(`"${field}"`);
  });

  it('limits the decoded body by maxBodyBytes and the envelope by twice that plus 64 KiB', async () => {
    adapter({ limits: { maxBodyBytes: 16 } });
    const decoded = await resolve({ method: 'POST', target: '/', body: { encoding: 'utf8', data: 'x'.repeat(17) } });
    expect(decoded.statusCode).toBe(413);
    expect(decoded.json()).toMatchObject({ error: { code: 'request-too-large' } });
    expect(
      (await resolve({ method: 'POST', target: '/', body: { encoding: 'utf8', data: 'x'.repeat(16) } })).statusCode,
    ).toBe(200);
    // An envelope beyond 2 × 16 + 65536 bytes never reaches decoding.
    const huge = await resolve({ method: 'GET', target: '/', headers: { 'x-pad': 'a'.repeat(70_000) } });
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toMatchObject({ error: { code: 'request-too-large' } });
    // An envelope larger than maxBodyBytes but within its own limit is fine.
    const padded = await resolve({ method: 'GET', target: '/v1/products', headers: { 'x-pad': 'a'.repeat(1000) } });
    expect(padded.statusCode).toBe(200);
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'])('answers %s with 405 and Allow: POST', async (method) => {
    const response = await adapter().inject({ method: method as 'GET', url: '/_janus/resolve' });
    expect(response.statusCode).toBe(405);
    expect(response.headers['allow']).toBe('POST');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('is not mounted with atlas.resolve: false, and health says so', async () => {
    adapter({ resolve: false });
    for (const method of ['POST', 'GET'] as const) {
      const response = await resolve({ method: 'GET', target: '/' }, { method });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'route-not-found' } });
    }
    const health = await app?.inject({ method: 'GET', url: '/_janus/health' });
    expect(health?.json()).toMatchObject({ capabilities: { resolve: false } });
  });

  it('changes nothing a real request receives', async () => {
    adapter();
    const before = await app?.inject({ method: 'GET', url: '/v1/products/p-9' });
    await resolve({ method: 'GET', target: '/v1/products/p-9' });
    await resolve({ method: 'POST', target: '/v1/echo', body: { encoding: 'utf8', data: '{"name":"x"}' } });
    const after = await app?.inject({ method: 'GET', url: '/v1/products/p-9' });
    expect(after?.body).toBe(before?.body);
    expect(after?.statusCode).toBe(before?.statusCode);
  });
});

/** A reload service the test controls. */
function fakeReload(overrides: Partial<AtlasReloadService> = {}) {
  const listeners = new Set<(event: AtlasSnapshotEvent) => void>();
  let last: AtlasReloadResult | null = null;
  let watching = true;
  const service: AtlasReloadService = {
    trigger: () => Promise.resolve(result('swapped')),
    last: () => last,
    watching: () => watching,
    subscribe: (listener) => {
      listeners.add(listener);
      return {
        state: { snapshotVersion: snapshot.version, lastReload: null },
        unsubscribe: () => listeners.delete(listener),
      };
    },
    ...overrides,
  };
  return {
    service,
    listeners,
    emit: (event: AtlasSnapshotEvent) => {
      for (const listener of listeners) listener(event);
    },
    setLast: (value: AtlasReloadResult | null) => {
      last = value;
    },
    setWatching: (value: boolean) => {
      watching = value;
    },
  };
}

function result(outcome: AtlasReloadResult['outcome']): AtlasReloadResult {
  return {
    outcome,
    triggers: ['watch', 'request'],
    finishedAt: '2026-09-29T10:14:03Z',
    activeSnapshotVersion: snapshot.version,
    candidateSnapshotVersion: outcome === 'failed' ? null : snapshot.version,
    errors:
      outcome === 'failed'
        ? [
            reloadProblem({
              code: 'invalid-json',
              source: 'fixtures',
              path: 'default/v1/products/{productId}/GET/200_{application-json}.json',
              line: 3,
              column: 15,
              message: 'invalid JSON: unexpected "}"',
            }),
          ]
        : [],
    warnings: [],
  };
}

describe('/_janus/reload', () => {
  it('reports no result before the first reload', async () => {
    adapter({ reload: fakeReload().service });
    const response = await app?.inject({ method: 'GET', url: '/_janus/reload' });
    expect(response?.statusCode).toBe(200);
    expect(response?.headers['cache-control']).toBe('no-store');
    expect(response?.json()).toEqual({ apiVersion: 'atlas.v1', outcome: null });
    const head = await app?.inject({ method: 'HEAD', url: '/_janus/reload' });
    expect(head?.statusCode).toBe(200);
    expect(head?.body).toBe('');
  });

  it('answers POST with 200 for swapped and unchanged, and 422 for failed', async () => {
    for (const outcome of ['swapped', 'unchanged', 'failed'] as const) {
      const fake = fakeReload({ trigger: () => Promise.resolve(result(outcome)) });
      adapter({ reload: fake.service });
      const response = await app?.inject({ method: 'POST', url: '/_janus/reload' });
      expect(response?.statusCode).toBe(outcome === 'failed' ? 422 : 200);
      expect(response?.json()).toEqual({ apiVersion: 'atlas.v1', ...result(outcome) });
      await app?.close();
    }
  });

  it('identifies errors by endpoint and file, never by filesystem path', async () => {
    const fake = fakeReload({ trigger: () => Promise.resolve(result('failed')) });
    fake.setLast(result('failed'));
    adapter({ reload: fake.service });
    const response = await app?.inject({ method: 'GET', url: '/_janus/reload' });
    expect(response?.json()).toMatchObject({
      outcome: 'failed',
      errors: [
        {
          code: 'invalid-json',
          endpoint: { method: 'GET', path: '/v1/products/{productId}' },
          file: '200_{application-json}.json',
          line: 3,
          column: 15,
        },
      ],
    });
    expect(response?.body).not.toContain('default/');
  });

  it('refuses a request body', async () => {
    const trigger = vi.fn(() => Promise.resolve(result('swapped')));
    adapter({ reload: fakeReload({ trigger }).service });
    const response = await app?.inject({ method: 'POST', url: '/_janus/reload', payload: 'x' });
    expect(response?.statusCode).toBe(400);
    expect(response?.json()).toMatchObject({ error: { code: 'atlas-invalid-request' } });
    expect(trigger).not.toHaveBeenCalled();
    const empty = await app?.inject({ method: 'POST', url: '/_janus/reload', payload: '' });
    expect(empty?.statusCode).toBe(200);
  });

  it('answers 503 when the server is shutting down', async () => {
    const unavailable = Object.assign(new Error('shutting down'), { code: 'service-unavailable' });
    adapter({ reload: fakeReload({ trigger: () => Promise.reject(unavailable) }).service });
    const response = await app?.inject({ method: 'POST', url: '/_janus/reload' });
    expect(response?.statusCode).toBe(503);
    expect(response?.json()).toMatchObject({ error: { code: 'service-unavailable' } });
  });

  it.each(['PUT', 'DELETE', 'OPTIONS'])('answers %s with 405 and Allow: GET, HEAD, POST', async (method) => {
    adapter({ reload: fakeReload().service });
    const response = await app?.inject({ method: method as 'PUT', url: '/_janus/reload' });
    expect(response?.statusCode).toBe(405);
    expect(response?.headers['allow']).toBe('GET, HEAD, POST');
  });

  it('is not mounted without a reload service', async () => {
    adapter();
    for (const url of ['/_janus/reload', '/_janus/events']) {
      const response = await app?.inject({ method: 'GET', url });
      expect(response?.statusCode).toBe(404);
      expect(response?.json()).toMatchObject({ error: { code: 'route-not-found' } });
    }
  });

  it('finishes a reload whose caller disconnected', async () => {
    let finish: (value: AtlasReloadResult) => void = () => undefined;
    const done = vi.fn();
    const trigger = () =>
      new Promise<AtlasReloadResult>((resolve) => {
        finish = (value) => {
          done();
          resolve(value);
        };
      });
    adapter({ reload: fakeReload({ trigger }).service });
    const port = await listen();
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/_janus/reload' });
    req.on('error', () => undefined);
    req.end();
    await vi.waitFor(() => {
      if (finish.length === 0) throw new Error('not triggered');
    });
    req.destroy();
    finish(result('swapped'));
    expect(done).toHaveBeenCalled();
  });
});

describe('health capabilities and lastReload', () => {
  it('reports what is mounted and running, and the last reload in brief', async () => {
    const fake = fakeReload();
    adapter({ reload: fake.service });
    const health = async () => (await app?.inject({ method: 'GET', url: '/_janus/health' }))?.json<unknown>();
    expect(await health()).toMatchObject({
      capabilities: { resolve: true, reload: true, watch: true, events: true, ui: false, cors: { origins: 0 } },
      lastReload: null,
    });
    fake.setWatching(false);
    fake.setLast(result('failed'));
    expect(await health()).toMatchObject({
      capabilities: { resolve: true, reload: true, watch: false, events: true, ui: false, cors: { origins: 0 } },
      lastReload: { outcome: 'failed', errorCount: 1, finishedAt: '2026-09-29T10:14:03Z' },
      snapshotVersion: snapshot.version,
    });
  });
});

async function listen(): Promise<number> {
  await app?.listen({ host: '127.0.0.1', port: 0 });
  return (app?.server.address() as AddressInfo).port;
}

interface Stream {
  readonly response: IncomingMessage;
  text: string;
  ended: boolean;
  close(): void;
}

function openStream(port: number, method = 'GET'): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path: '/_janus/events' }, (response) => {
      const stream: Stream = {
        response,
        text: '',
        ended: false,
        close: () => {
          req.destroy();
        },
      };
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        stream.text += chunk;
      });
      response.on('end', () => {
        stream.ended = true;
      });
      response.on('error', () => {
        stream.ended = true;
      });
      resolve(stream);
    });
    req.on('error', reject);
    req.end();
  });
}

const until = (condition: () => boolean) =>
  vi.waitFor(
    () => {
      if (!condition()) throw new Error('not yet');
    },
    { timeout: 3000, interval: 5 },
  );

describe('GET /_janus/events', () => {
  it('opens with the retry hint and the state, then sends only new changes', async () => {
    const fake = fakeReload();
    fake.emit({ type: 'snapshot', snapshotVersion: 'before-anyone-listened', previousVersion: '' });
    adapter({ reload: fake.service });
    const stream = await openStream(await listen());
    expect(stream.response.statusCode).toBe(200);
    expect(stream.response.headers['content-type']).toBe('text/event-stream');
    expect(stream.response.headers['cache-control']).toBe('no-store');
    expect(stream.response.headers['content-encoding']).toBeUndefined();
    expect(stream.response.headers['content-length']).toBeUndefined();
    await until(() => stream.text.includes('\n\n'));
    expect(stream.text).toBe(
      `retry: 3000\nevent: state\ndata: {"snapshotVersion":"${snapshot.version}","lastReload":null}\n\n`,
    );
    fake.emit({ type: 'snapshot', snapshotVersion: 'b', previousVersion: 'a' });
    fake.emit({ type: 'reload-failed', errorCount: 2, finishedAt: '2026-09-29T10:14:03Z' });
    await until(() => stream.text.includes('reload-failed'));
    expect(stream.text.split('\n\n').slice(1)).toEqual([
      'event: snapshot\ndata: {"snapshotVersion":"b","previousVersion":"a"}',
      'event: reload-failed\ndata: {"errorCount":2,"finishedAt":"2026-09-29T10:14:03Z"}',
      '',
    ]);
    // The retry hint is sent once, not with each event.
    expect(stream.text.match(/retry:/g)).toHaveLength(1);
    expect(stream.text).not.toContain('before-anyone-listened');
    stream.close();
  });

  it('sends a heartbeat comment', async () => {
    adapter({ reload: fakeReload().service, events: { heartbeatMs: 20 } });
    const stream = await openStream(await listen());
    await until(() => stream.text.includes(': keep-alive\n\n'));
    stream.close();
  });

  it('allows at most maxStreams streams and frees a slot when a client goes away', async () => {
    const fake = fakeReload();
    adapter({ reload: fake.service, events: { maxStreams: 2, heartbeatMs: 10 } });
    const port = await listen();
    const first = await openStream(port);
    const second = await openStream(port);
    const third = await openStream(port);
    expect(third.response.statusCode).toBe(503);
    expect(third.response.headers['cache-control']).toBe('no-store');
    await until(() => third.ended);
    expect(JSON.parse(third.text)).toMatchObject({ error: { code: 'service-unavailable' } });
    expect(fake.listeners.size).toBe(2);

    first.close();
    // The failed write (or the close) releases the slot and the subscription.
    await until(() => fake.listeners.size === 1);
    const fourth = await openStream(port);
    expect(fourth.response.statusCode).toBe(200);
    second.close();
    fourth.close();
  });

  it('answers HEAD with the stream headers and no stream, and other methods with 405', async () => {
    const fake = fakeReload();
    adapter({ reload: fake.service });
    const head = await app?.inject({ method: 'HEAD', url: '/_janus/events' });
    expect(head?.statusCode).toBe(200);
    expect(head?.headers['content-type']).toBe('text/event-stream');
    expect(head?.headers['cache-control']).toBe('no-store');
    expect(head?.body).toBe('');
    expect(fake.listeners.size).toBe(0);
    for (const method of ['POST', 'DELETE', 'OPTIONS'] as const) {
      const response = await app?.inject({ method, url: '/_janus/events' });
      expect(response?.statusCode).toBe(405);
      expect(response?.headers['allow']).toBe('GET, HEAD');
    }
  });

  it('closes open streams on shutdown without waiting for them', async () => {
    const fake = fakeReload();
    adapter({ reload: fake.service });
    const stream = await openStream(await listen());
    await until(() => stream.text.length > 0);
    const started = Date.now();
    await app?.close();
    app = undefined;
    await until(() => stream.ended);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fake.listeners.size).toBe(0);
  });
});
