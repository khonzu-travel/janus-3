import { buildSnapshot, createEngine, type EngineConfig, type FixtureSnapshot } from '@janus/core';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createHttpAdapter } from './adapter.js';
import type { SessionWriteRecord } from './atlas.js';

// Choosing between responses over HTTP.

const utf8 = (text: string) => new TextEncoder().encode(text);

function snapshotOf(entries: Readonly<Record<string, string>>): FixtureSnapshot {
  const built = buildSnapshot(new Map(Object.entries(entries).map(([key, value]) => [key, utf8(value)])));
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return built.snapshot;
}

const TREE = {
  'default/v1/orders/{orderId}/GET/200.json': '{"state":"done"}',
  'default/v1/orders/{orderId}/GET/202.pending.json': '{"state":"pending"}',
  'default/v1/orders/{orderId}/GET/404.missing.json': '{"error":"missing"}',
  'default/v1/orders/{orderId}/GET/variants.yaml':
    'rules:\n  - when: { path.orderId: ord-missing }\n    serve: 404.missing\n',
  'default/v1/orders/{orderId}/GET/sequence.yaml': 'steps: [202.pending, 200]\n',
  'default/v1/payments/POST/201.json': '{"id":"pay_{{$uuid}}"}',
};
const LISTED = 'http://localhost:5173';
const T0 = Date.UTC(2030, 0, 1);

let app: FastifyInstance | undefined;
let writes: SessionWriteRecord[] = [];

afterEach(async () => {
  await app?.close();
  app = undefined;
  writes = [];
});

function adapter(config: Partial<EngineConfig> = {}): FastifyInstance {
  let draw = 0;
  app = createHttpAdapter({
    engine: createEngine({
      snapshot: snapshotOf(TREE),
      config: { seed: 1, ...config },
      clock: () => T0,
      randomBytes: (count) => {
        draw += 1;
        return Uint8Array.from({ length: count }, () => draw);
      },
    }),
    cors: { origins: [LISTED], maxAge: 600 },
    onSessionWrite: (record) => writes.push(record),
  });
  return app;
}

const inject = (options: InjectOptions): Promise<LightMyRequestResponse> => (app ?? adapter()).inject(options);
const errorOf = (response: LightMyRequestResponse): Record<string, unknown> =>
  response.json<{ error: Record<string, unknown> }>().error;

async function create(session: string): Promise<string> {
  const response = await inject({
    method: 'POST',
    url: '/_janus/session',
    headers: { 'x-mock-session': session, 'content-type': 'application/json' },
    payload: '{}',
  });
  expect(response.statusCode).toBe(201);
  return String(response.headers['x-mock-session-key']);
}

const poll = (session?: string, method: 'GET' | 'HEAD' = 'GET') =>
  inject({ method, url: '/v1/orders/ord-1', headers: session === undefined ? {} : { 'x-mock-session': session } });

describe('diagnostic headers', () => {
  it('sends X-Mock-Choice on fixture responses and HEAD alike', async () => {
    adapter();
    const missing = await inject({ url: '/v1/orders/ord-missing' });
    expect([missing.statusCode, missing.headers['x-mock-choice']]).toEqual([404, '404.missing; by=rule; rule=1']);
    const head = await inject({ method: 'HEAD', url: '/v1/orders/ord-missing' });
    expect(head.headers['x-mock-choice']).toBe('404.missing; by=rule; rule=1');
    expect((await poll()).headers['x-mock-choice']).toBe('202.pending; by=sequence; step=1');
  });

  it('replays with X-Mock-Replayed and drops every diagnostic header when disabled', async () => {
    adapter();
    await create('a');
    const pay = (key: string, payload = '{"amount":1}') =>
      inject({
        method: 'POST',
        url: '/v1/payments',
        headers: { 'x-mock-session': 'a', 'idempotency-key': key, 'content-type': 'application/json' },
        payload,
      });
    const first = await pay('k1');
    const again = await pay('k1');
    expect(again.body).toBe(first.body);
    expect(again.headers['x-mock-replayed']).toBe('true');
    expect(first.headers['x-mock-replayed']).toBeUndefined();
    expect(again.headers['x-mock-choice']).toBe(first.headers['x-mock-choice']);
    const reused = await pay('k1', '{"amount":2}');
    expect([reused.statusCode, errorOf(reused)['code']]).toEqual([422, 'idempotency-key-reused']);
    const invalid = await inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { 'x-mock-session': 'a', 'idempotency-key': 'k 1', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect([invalid.statusCode, errorOf(invalid)['code']]).toEqual([400, 'invalid-request']);

    await app?.close();
    adapter({ diagnosticHeaders: false });
    await create('a');
    await pay('k1');
    const replayed = await pay('k1');
    expect(Object.keys(replayed.headers).filter((name) => name.startsWith('x-mock-'))).toEqual([]);
  });

  it('answers a route miss with 501 not-mocked under onNoFixture: 501', async () => {
    adapter({ onNoFixture: 501 });
    const response = await inject({ url: '/v1/nothing' });
    expect([response.statusCode, errorOf(response)['code']]).toEqual([501, 'not-mocked']);
  });
});

describe('DELETE /_janus/sequences', () => {
  it('restarts only the caller’s own positions, with its write key', async () => {
    adapter();
    const key = await create('a');
    await create('b');
    await poll('a');
    await poll('b');
    expect((await poll('a', 'HEAD')).headers['x-mock-choice']).toBe('200; by=sequence; step=2');

    const reset = (headers: Record<string, string | string[]>, url = '/_janus/sequences') =>
      inject({ method: 'DELETE', url, headers });
    expect((await reset({})).statusCode).toBe(400);
    expect(errorOf(await reset({ 'x-mock-session': 'nope' }))['code']).toBe('session-not-found');
    for (const writeKey of [undefined, [key, key], 'wk_bad', `wk_${'0'.repeat(32)}`]) {
      const headers: Record<string, string | string[]> = { 'x-mock-session': 'a' };
      if (writeKey !== undefined) headers['x-mock-session-key'] = writeKey;
      const forbidden = await reset(headers);
      expect([forbidden.statusCode, errorOf(forbidden)['code']]).toEqual([403, 'session-forbidden']);
    }
    expect(
      (await reset({ 'x-mock-session': 'a', 'x-mock-session-key': key, origin: 'http://evil.test' })).statusCode,
    ).toBe(403);
    expect((await poll('a', 'HEAD')).headers['x-mock-choice']).toBe('200; by=sequence; step=2');

    const unknown = await reset(
      { 'x-mock-session': 'a', 'x-mock-session-key': key },
      '/_janus/sequences?endpoint=ep_0000000000000000',
    );
    expect([unknown.statusCode, errorOf(unknown)['code']]).toEqual([404, 'atlas-resource-not-found']);

    const done = await reset({ 'x-mock-session': 'a', 'x-mock-session-key': key });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ apiVersion: 'atlas.v1', session: { id: 'a', sequences: [] } });
    expect((await poll('a')).headers['x-mock-choice']).toBe('202.pending; by=sequence; step=1');
    expect((await poll('b', 'HEAD')).headers['x-mock-choice']).toBe('200; by=sequence; step=2');
    expect(writes.filter((record) => record.route === '/_janus/sequences').map((record) => record.outcome)).toEqual([
      'session-required',
      'session-not-found',
      'session-forbidden',
      'session-forbidden',
      'session-forbidden',
      'session-forbidden',
      'atlas-resource-not-found',
      'reset',
    ]);
  });

  it('resets one endpoint by ID and answers other methods with 405', async () => {
    adapter();
    const key = await create('a');
    await poll('a');
    const inventory = (await inject({ url: '/_janus/endpoints' })).json<{ items: { id: string; path: string }[] }>();
    const orders = inventory.items.find((item) => item.path === '/v1/orders/{orderId}');
    const reset = await inject({
      method: 'DELETE',
      url: `/_janus/sequences?endpoint=${orders?.id ?? ''}`,
      headers: { 'x-mock-session': 'a', 'x-mock-session-key': key },
    });
    expect(reset.statusCode).toBe(200);
    expect((await poll('a', 'HEAD')).headers['x-mock-choice']).toBe('202.pending; by=sequence; step=1');
    const get = await inject({ url: '/_janus/sequences' });
    expect([get.statusCode, get.headers['allow']]).toEqual([405, 'DELETE']);
  });
});

describe('Atlas documents', () => {
  it('serves controls in endpoint detail and the new health capabilities', async () => {
    adapter({ idempotency: { enabled: false, header: 'idempotency-key', methods: ['POST'], maxEntries: 10 } });
    const health = (await inject({ url: '/_janus/health' })).json<{ capabilities: Record<string, unknown> }>();
    expect(health.capabilities).toMatchObject({
      variants: true,
      sequences: true,
      pages: true,
      expectations: true,
      idempotency: false,
    });
    const inventory = (await inject({ url: '/_janus/endpoints' })).json<{
      items: { path: string; detailHref: string }[];
    }>();
    const orders = inventory.items.find((item) => item.path === '/v1/orders/{orderId}');
    const detail = (await inject({ url: `/_janus/${orders?.detailHref ?? ''}` })).json<Record<string, unknown>>();
    expect(detail['controls']).toEqual({
      rules: {
        scenario: 'default',
        items: [{ when: [{ reference: 'path.orderId', test: 'equals', value: 'ord-missing' }], serve: '404.missing' }],
      },
      pages: null,
      sequence: { scenario: 'default', steps: ['202.pending', '200'] },
      expect: null,
      idempotent: false,
    });
    expect((detail['fixtures'] as { identity: string }[]).map((fixture) => fixture.identity)).toEqual([
      '200',
      '404.missing',
      '202.pending',
    ]);
  });
});
