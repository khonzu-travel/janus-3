import { buildSnapshot, createEngine, type EngineConfig, type FixtureSnapshot } from '@janus/core';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createHttpAdapter, type HttpAdapterOptions } from './adapter.js';
import type { SessionWriteRecord } from './atlas.js';

// Scenarios and sessions over HTTP.

function snapshotOf(entries: Readonly<Record<string, string>>): FixtureSnapshot {
  const built = buildSnapshot(new Map(Object.entries(entries).map(([key, value]) => [key, utf8(value)])));
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return built.snapshot;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

const TREE = {
  'default/v1/cart/GET/200.json': '{"from":"default"}',
  'default/v1/when/GET/200.json': '{"now":"{{$now}}"}',
  'declined/flow.yaml': 'description: The card is declined\noverrides: [/v1/cart/GET]\n',
  'declined/v1/cart/GET/402.json': '{"from":"declined"}',
  'declined/v1/cart/GET/402_[fr].json': '{"from":"declined-fr"}',
  'declined-late/flow.yaml': 'extends: declined\nremoves:\n  - /v1/cart/GET/402_[fr].json\n',
};
const snapshot = snapshotOf(TREE);
const LISTED = 'http://localhost:5173';
const T0 = Date.UTC(2030, 0, 1);

let app: FastifyInstance | undefined;
let writes: SessionWriteRecord[] = [];

afterEach(async () => {
  await app?.close();
  app = undefined;
  writes = [];
});

function adapter(config: Partial<EngineConfig> = {}, overrides: Partial<HttpAdapterOptions> = {}): FastifyInstance {
  let draw = 0;
  app = createHttpAdapter({
    engine: createEngine({
      snapshot,
      config,
      clock: () => T0,
      randomBytes: (count) => {
        draw += 1;
        return Uint8Array.from({ length: count }, () => draw);
      },
    }),
    cors: { origins: [LISTED], maxAge: 600 },
    onSessionWrite: (record) => writes.push(record),
    ...overrides,
  });
  return app;
}

const inject = (options: InjectOptions): Promise<LightMyRequestResponse> => (app ?? adapter()).inject(options);

const json = (response: LightMyRequestResponse): Record<string, unknown> => response.json();
const errorOf = (response: LightMyRequestResponse): Record<string, unknown> =>
  response.json<{ error: Record<string, unknown> }>().error;

function post(session: string, body: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return inject({
    method: 'POST',
    url: '/_janus/session',
    headers: { 'x-mock-session': session, 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

async function create(session: string, body: unknown = {}): Promise<string> {
  const response = await post(session, body);
  expect(response.statusCode).toBe(201);
  return String(response.headers['x-mock-session-key']);
}

describe('selecting a scenario over HTTP', () => {
  it('serves the scenario named by X-Mock-Scenario, with the diagnostic headers', async () => {
    adapter();
    const plain = await inject({ url: '/v1/cart' });
    expect(plain.body).toBe('{"from":"default"}');
    expect(plain.headers['x-mock-scenario']).toBe('default');
    expect(plain.headers['x-mock-resolved-from']).toBe('default');

    const child = await inject({ url: '/v1/cart', headers: { 'x-mock-scenario': 'declined-late' } });
    expect(child.body).toBe('{"from":"declined"}');
    expect(child.headers['x-mock-scenario']).toBe('declined-late');
    expect(child.headers['x-mock-resolved-from']).toBe('declined');

    const head = await inject({ method: 'HEAD', url: '/v1/cart', headers: { 'x-mock-scenario': 'declined' } });
    expect(head.body).toBe('');
    expect(head.headers['x-mock-scenario']).toBe('declined');
    expect(head.headers['x-mock-resolved-from']).toBe('declined');
  });

  it('answers a mistyped or repeated X-Mock-Scenario with 400, still naming no scenario', async () => {
    adapter();
    const unknown = await inject({ url: '/v1/cart', headers: { 'x-mock-scenario': 'declinde' } });
    expect(unknown.statusCode).toBe(400);
    expect(errorOf(unknown)).toMatchObject({
      code: 'unknown-scenario',
      source: 'request-header',
      known: ['declined', 'declined-late', 'default'],
    });
    expect(unknown.headers['x-mock-scenario']).toBeUndefined();

    const repeated = await inject({
      url: '/v1/cart',
      headers: { 'x-mock-scenario': ['default', 'declined'] },
    });
    expect(repeated.statusCode).toBe(400);
    expect(errorOf(repeated)['code']).toBe('invalid-request');

    const session = await inject({ url: '/v1/cart', headers: { 'x-mock-session': 'not valid' } });
    expect(session.statusCode).toBe(400);
  });

  it('drops both headers with diagnostics.headers false', async () => {
    adapter({ diagnosticHeaders: false });
    const response = await inject({ url: '/v1/cart', headers: { 'x-mock-scenario': 'declined' } });
    expect(response.body).toBe('{"from":"declined"}');
    expect(Object.keys(response.headers).filter((name) => name.startsWith('x-mock-'))).toEqual([]);
  });
});

describe('/_janus/session', () => {
  it('creates a session, returning the key only in the creating POST header', async () => {
    adapter();
    const response = await post('team-a', { scenario: 'declined', clock: { now: '2026-01-01T00:00:00Z' } });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const key = String(response.headers['x-mock-session-key']);
    expect(key).toBe(`wk_${'01'.repeat(16)}`);
    expect(response.body).not.toContain(key);
    expect(json(response)).toEqual({
      apiVersion: 'atlas.v1',
      session: {
        id: 'team-a',
        source: 'header',
        exists: true,
        scenario: { name: 'declined', known: true },
        clock: { now: '2026-01-01T00:00:00Z', mode: 'frozen', boundAt: '2030-01-01T00:00:00Z' },
        createdAt: '2030-01-01T00:00:00Z',
        lastSeenAt: '2030-01-01T00:00:00Z',
        expiresAt: '2030-01-01T00:30:00Z',
        sequences: [],
        replays: { count: 0, max: 1000 },
      },
    });
    expect(response.headers['access-control-expose-headers']).toBeUndefined();

    const described = await inject({ url: '/_janus/session', headers: { 'x-mock-session': 'team-a' } });
    expect(described.statusCode).toBe(200);
    expect(described.headers['x-mock-session-key']).toBeUndefined();
    expect(described.body).not.toContain(key);
    const head = await inject({ method: 'HEAD', url: '/_janus/session', headers: { 'x-mock-session': 'team-a' } });
    expect([head.statusCode, head.body]).toEqual([200, '']);

    const served = await inject({ url: '/v1/when', headers: { 'x-mock-session': 'team-a' } });
    expect(served.body).toBe('{"now":"2026-01-01T00:00:00Z"}');
    expect(served.headers['x-mock-scenario']).toBe('declined');

    expect(writes).toEqual([
      {
        requestId: expect.any(String) as unknown,
        route: '/_janus/session',
        method: 'POST',
        source: 'header',
        id: 'team-a',
        status: 201,
        outcome: 'created',
      },
    ]);
    expect(JSON.stringify(writes)).not.toContain(key);
  });

  it('exposes the key header to a listed origin, and checks the origin of every write', async () => {
    adapter();
    const listed = await post('a', {}, { origin: LISTED });
    expect(listed.statusCode).toBe(201);
    expect(listed.headers['access-control-allow-origin']).toBe(LISTED);
    expect(listed.headers['access-control-expose-headers']).toBe('X-Mock-Session-Key');
    const key = String(listed.headers['x-mock-session-key']);

    const foreign = { origin: 'https://evil.example', host: 'localhost:4010' };
    expect((await post('b', {}, foreign)).statusCode).toBe(403);
    for (const method of ['PATCH', 'DELETE'] as const) {
      const response = await inject({
        method,
        url: '/_janus/session',
        headers: { ...foreign, 'x-mock-session': 'a', 'x-mock-session-key': key, 'content-type': 'application/json' },
        ...(method === 'PATCH' ? { payload: '{"scenario":null}' } : {}),
      });
      expect(response.statusCode).toBe(403);
      expect(errorOf(response)['code']).toBe('atlas-origin-forbidden');
    }
    const read = await inject({ url: '/_janus/session', headers: { ...foreign, 'x-mock-session': 'a' } });
    expect(read.statusCode).toBe(200);
    expect(writes.map((record) => record.outcome)).toEqual(['created']);
  });

  it('allows the session headers in a preflight', async () => {
    adapter();
    const response = await inject({
      method: 'OPTIONS',
      url: '/_janus/session',
      headers: {
        origin: LISTED,
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type, x-mock-session, x-mock-session-key, x-mock-scenario',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-methods']).toBe('GET, HEAD, POST, PATCH, DELETE');
  });

  it('checks the errors in order', async () => {
    adapter();
    const required = await inject({
      method: 'POST',
      url: '/_janus/session',
      headers: { 'content-type': 'application/json' },
      payload: '{"scenario":"nope"}',
    });
    expect([required.statusCode, errorOf(required)['code']]).toEqual([400, 'session-required']);
    const missing = await inject({
      method: 'PATCH',
      url: '/_janus/session',
      headers: { 'x-mock-session': 'a', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect([missing.statusCode, errorOf(missing)['code']]).toEqual([404, 'session-not-found']);

    const key = await create('a', { scenario: 'declined' });
    const other = await create('b');
    const patch = (headers: Record<string, string | string[]>, payload: string, type = 'application/json') =>
      inject({
        method: 'PATCH',
        url: '/_janus/session',
        headers: { 'x-mock-session': 'a', 'content-type': type, ...headers },
        payload,
      });
    for (const keys of [
      {},
      { 'x-mock-session-key': [key, key] },
      { 'x-mock-session-key': 'wk_1' },
      { 'x-mock-session-key': other },
    ]) {
      const response = await patch(keys, '{"scenario":null}');
      expect([response.statusCode, errorOf(response)['code']]).toEqual([403, 'session-forbidden']);
    }
    const auth = { 'x-mock-session-key': key };
    const invalid = await patch(auth, '{"scenario":null,"clock":{"advance":"soon"}}');
    expect([invalid.statusCode, errorOf(invalid)['code']]).toEqual([400, 'atlas-invalid-request']);
    expect(errorOf(invalid)['message']).toContain('"clock.advance"');
    const unknown = await patch(auth, '{"scenario":"nope"}');
    expect(errorOf(unknown)).toMatchObject({ code: 'unknown-scenario', source: 'session' });
    expect((await patch(auth, '{"scenario":null}', 'text/plain')).statusCode).toBe(415);
    expect((await patch(auth, JSON.stringify({ scenario: 'x'.repeat(5000) }))).statusCode).toBe(413);
    const noClock = await patch(auth, '{"clock":{"advance":"+1d"}}');
    expect([noClock.statusCode, errorOf(noClock)['code']]).toEqual([409, 'no-session-clock']);
    expect((await post('a', {})).statusCode).toBe(409);

    // None of the rejected writes changed the session.
    const described = json(await inject({ url: '/_janus/session', headers: { 'x-mock-session': 'a' } }));
    expect(described['session']).toMatchObject({ scenario: { name: 'declined' }, clock: null });
  });

  it('changes only the members a PATCH sends, and DELETE drops the session', async () => {
    adapter();
    const key = await create('a', { scenario: 'declined', clock: { now: T0 } });
    const headers = { 'x-mock-session': 'a', 'x-mock-session-key': key, 'content-type': 'application/json' };
    const advanced = await inject({
      method: 'PATCH',
      url: '/_janus/session',
      headers,
      payload: '{"clock":{"advance":"+1d"}}',
    });
    expect(advanced.statusCode).toBe(200);
    expect(json(advanced)['session']).toMatchObject({
      scenario: { name: 'declined' },
      clock: { now: '2030-01-02T00:00:00Z' },
    });
    expect(advanced.headers['x-mock-session-key']).toBeUndefined();

    const dropped = await inject({ method: 'DELETE', url: '/_janus/session', headers });
    expect(dropped.statusCode).toBe(200);
    expect(json(dropped)['session']).toMatchObject({ id: 'a', exists: false });
    expect((await inject({ url: '/v1/cart', headers: { 'x-mock-session': 'a' } })).body).toBe('{"from":"default"}');
    expect(writes.map((record) => [record.method, record.status, record.outcome])).toEqual([
      ['POST', 201, 'created'],
      ['PATCH', 200, 'updated'],
      ['DELETE', 200, 'deleted'],
    ]);
  });

  it('answers other methods with 405 and Allow', async () => {
    adapter();
    const response = await inject({ method: 'PUT', url: '/_janus/session' });
    expect(response.statusCode).toBe(405);
    expect(response.headers['allow']).toBe('GET, HEAD, POST, PATCH, DELETE');
  });

  it('keeps a session alive through Atlas requests carrying its key', async () => {
    let now = T0;
    app = createHttpAdapter({
      engine: createEngine({
        snapshot,
        config: { idleTimeout: 60 },
        clock: () => now,
        randomBytes: (count) => new Uint8Array(count),
      }),
    });
    await create('a');
    now += 50_000;
    await inject({ url: '/_janus/health', headers: { 'x-mock-session': 'a' } });
    now += 50_000;
    const described = json(await inject({ url: '/_janus/session', headers: { 'x-mock-session': 'a' } }));
    expect(described['session']).toMatchObject({ exists: true });
  });

  it('reports the session clock at /_janus/clock', async () => {
    adapter();
    await create('a', { clock: { now: '2026-06-01T00:00:00Z', mode: 'offset' } });
    expect(json(await inject({ url: '/_janus/clock', headers: { 'x-mock-session': 'a' } }))).toMatchObject({
      now: '2026-06-01T00:00:00Z',
      mode: 'offset',
      source: 'session',
      session: 'a',
    });
  });
});

describe('scenario resources in Atlas', () => {
  it('lists the scenarios with links to their inventories', async () => {
    adapter();
    const body = json(await inject({ url: '/_janus/scenarios' }));
    expect(body).toMatchObject({
      apiVersion: 'atlas.v1',
      snapshotVersion: snapshot.version,
      configuredDefault: 'default',
    });
    const items = body['items'] as Record<string, unknown>[];
    expect(items.map((item) => item['name'])).toEqual(['declined', 'declined-late', 'default']);
    expect(items[1]).toEqual({
      name: 'declined-late',
      description: null,
      extends: 'declined',
      chain: ['declined-late', 'declined', 'default'],
      ids: [],
      overrides: [],
      removes: ['/v1/cart/GET/402_[fr].json'],
      endpoints: { own: 0, inherited: 2, total: 2 },
      latency: { own: null, effective: null },
      endpointsHref: `endpoints?scenario=declined-late&at=${snapshot.version}`,
    });
  });

  it('serves one scenario inventory, with origins and the matrix', async () => {
    adapter();
    const inventory = json(await inject({ url: '/_janus/endpoints?scenario=declined' }));
    expect(inventory['scenario']).toBe('declined');
    const items = inventory['items'] as { path: string; origin: string; detailHref: string }[];
    expect(items.map((item) => [item.path, item.origin])).toEqual([
      ['/v1/cart', 'own'],
      ['/v1/when', 'inherited'],
    ]);
    const cart = json(await inject({ url: `/_janus/${items[0]?.detailHref ?? ''}` }));
    const matrix = cart['matrix'] as { identities: unknown[]; rows: { scenario: string; cells: unknown[] }[] };
    expect(matrix.identities).toEqual([
      { identity: '200', status: 200, variant: null },
      { identity: '402', status: 402, variant: null },
    ]);
    expect(matrix.rows.map((row) => [row.scenario, row.cells.map((cell) => cell !== null)])).toEqual([
      ['declined', [false, true]],
      ['declined-late', [false, true]],
      ['default', [true, false]],
    ]);

    expect((await inject({ url: '/_janus/endpoints?scenario=nope' })).statusCode).toBe(404);
    expect((await inject({ url: '/_janus/endpoints?scenario=Nope' })).statusCode).toBe(400);
    expect((await inject({ url: '/_janus/endpoints?scenario=default&scenario=declined' })).statusCode).toBe(400);
  });

  it('simulates the envelope scenario and session headers without touching the session', async () => {
    let now = T0;
    app = createHttpAdapter({
      engine: createEngine({
        snapshot,
        config: { idleTimeout: 60 },
        clock: () => now,
        randomBytes: (count) => new Uint8Array(count),
      }),
    });
    await create('a', { scenario: 'declined' });
    const simulate = (envelope: unknown) =>
      inject({
        method: 'POST',
        url: '/_janus/resolve',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(envelope),
      });
    now += 50_000;
    const pinned = json(await simulate({ method: 'GET', target: '/v1/cart', headers: { 'x-mock-session': ['a'] } }));
    expect(pinned['trace']).toMatchObject({ scenario: 'declined', selection: { source: 'session' } });
    const caller = json(await simulate({ method: 'GET', target: '/v1/cart', scenario: 'declined-late' }));
    expect(caller['trace']).toMatchObject({ selection: { source: 'caller' }, resolvedFrom: 'declined' });
    // The files the scenario hid, linked to their documents.
    const shadowed = caller['shadowed'] as readonly Record<string, unknown>[];
    expect(shadowed).toHaveLength((caller['trace'] as { shadowed: unknown[] }).shadowed.length);
    expect(shadowed.length).toBeGreaterThan(0);
    for (const entry of shadowed) {
      expect(entry).toEqual({
        endpointId: expect.stringMatching(/^ep_/) as unknown,
        fixtureId: entry['fixtureId'],
        detailHref: `fixtures/${String(entry['fixtureId'])}?at=${String(caller['snapshotVersion'])}`,
      });
    }
    const unknown = await simulate({ method: 'GET', target: '/v1/cart', scenario: 'nope' });
    expect(unknown.statusCode).toBe(200);
    expect(json(unknown)['trace']).toMatchObject({ outcome: { kind: 'unknown-scenario', source: 'caller' } });
    now += 50_000;
    // The simulation was not a request of session a, so it expired on time.
    const described = json(await inject({ url: '/_janus/session', headers: { 'x-mock-session': 'a' } }));
    expect(described['session']).toMatchObject({ exists: false });
  });

  it('reports the scenario count and capabilities in health', async () => {
    adapter({ defaultScenario: 'declined' });
    expect(json(await inject({ url: '/_janus/health' }))).toMatchObject({
      scenarioCount: 3,
      configuredDefaultScenario: 'declined',
      capabilities: { scenarios: true, sessions: true },
    });
    expect(json(await inject({ url: '/_janus/endpoints' }))['scenario']).toBe('declined');
  });
});
