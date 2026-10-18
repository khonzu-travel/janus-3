import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import type { EngineConfig } from '../config/merge.js';
import { fixtureCorsHeaders } from './fixture-cors.js';
import { createEngine } from '../create-engine.js';
import { buildSnapshot } from '../fixtures/build.js';
import { endpointId } from '../ids.js';
import type {
  Engine,
  FixtureSnapshot,
  HeaderMap,
  HoldTicket,
  HttpMethod,
  RequestDescription,
  ResponseDescription,
  TransportCapacity,
} from '../types/index.js';

// Faults, latency, codings, automatic OPTIONS and fixture CORS in resolution.

const T0 = Date.UTC(2030, 0, 1);

const BIG = JSON.stringify({
  items: Array.from({ length: 80 }, (_, index) => ({ id: index, name: `item ${String(index)}` })),
});

const TREE: Readonly<Record<string, string>> = {
  'default/v1/orders/POST/201.json': '{"id":"o-{{$sequence.position}}"}',
  'default/v1/orders/POST/sequence.yaml': 'steps: [201, 201]\n',
  'default/v1/orders/POST/fault.yaml': [
    'rules:',
    '  - when: { header.x-simulate: reset }',
    '    fault: reset',
    '  - when: { header.x-simulate: hold }',
    '    fault: timeout',
    '  - when: { header.x-simulate: cut }',
    '    fault: { truncate: { bytes: 4 } }',
    '  - when: { header.x-simulate: broken }',
    '    fault: { malformed: bad-chunk }',
    '  - when: { body.$.order.@priority: high }',
    '    fault: malformed',
    '  - when: { header.x-simulate: steps }',
    '    fault: [reset, none, truncate]',
    '',
  ].join('\n'),
  'default/v1/orders/{orderId}/GET/200.json': BIG,
  'default/v1/orders/{orderId}/GET/200.headers.json': '{"ETag":"\\"v1\\"","X-Trace":"t"}',
  'default/v1/small/GET/200.json': '{"ok":true}',
  'default/v1/image/GET/200_{image-png}.png': 'x'.repeat(2000),
  'default/v1/options/OPTIONS/200.json': '{"own":true}',
  'default/v1/options/GET/200.json': '{}',
  'flaky-network/flow.yaml': 'latency: { ms: 300 }\n',
  'flaky-network/v1/orders/POST/fault.yaml': 'rules:\n  - fault: [reset, timeout, none]\n',
  'fast/flow.yaml': 'extends: flaky-network\n',
  'fast/v1/small/GET/fault.yaml': 'latency: { ms: 0 }\n',
  'other/v1/extra/DELETE/204': '',
};

function snapshotOf(entries: Readonly<Record<string, string>>): FixtureSnapshot {
  const result = buildSnapshot(new Map(Object.entries(entries).map(([path, text]) => [path, utf8Encode(text)])));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.snapshot;
}

function engineOf(
  config: Partial<EngineConfig> = {},
  options: { readonly transport?: TransportCapacity; readonly entries?: Readonly<Record<string, string>> } = {},
): Engine {
  return createEngine({
    snapshot: snapshotOf(options.entries ?? TREE),
    config: { seed: 1, ...config },
    clock: () => T0,
    randomBytes: (count) => new Uint8Array(count).fill(7),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  });
}

function session(engine: Engine, id: string, scenario?: string): string {
  const answer = engine.sessions.write(
    'POST',
    { 'x-mock-session': [id], 'content-type': ['application/json'] },
    utf8Encode(JSON.stringify(scenario === undefined ? {} : { scenario })),
  );
  if (!answer.ok || answer.writeKey === undefined) throw new Error(JSON.stringify(answer));
  return answer.writeKey;
}

const request = (
  method: HttpMethod,
  target: string,
  headers: HeaderMap = {},
  body?: string,
  extra: Partial<RequestDescription> = {},
): RequestDescription => ({
  method,
  target,
  headers,
  ...(body === undefined ? {} : { body: utf8Encode(body) }),
  ...extra,
});

const utf8Decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const json = (response: ResponseDescription): unknown => JSON.parse(utf8Decode(response.body ?? new Uint8Array()));

const XML = { 'content-type': ['application/xml'] };

function counting(slots: number): TransportCapacity & { held: number; calls: number } {
  const capacity = {
    held: 0,
    calls: 0,
    tryHold(): HoldTicket | null {
      capacity.calls++;
      if (capacity.held >= slots) return null;
      capacity.held++;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          capacity.held--;
        },
      };
    },
  };
  return capacity;
}

describe('fault rules', () => {
  it('tries rules in order, the first match deciding, and gives no fault without a match', async () => {
    const engine = engineOf();
    const plain = await engine.resolve(request('POST', '/v1/orders'));
    expect(plain.status).toBe(201);
    expect(plain.transport?.fault).toBeNull();
    expect(plain.trace.transport).toMatchObject({ fault: null, rulesTried: 6, performed: true });

    const reset = await engine.resolve(request('POST', '/v1/orders', { 'x-simulate': ['reset'] }));
    expect(reset.status).toBe(0);
    expect(reset.body).toBeNull();
    expect(reset.transport?.fault).toEqual({ kind: 'reset' });
    expect(reset.trace.outcome).toEqual({ kind: 'fault', fault: 'reset' });
    expect(reset.trace.transport).toMatchObject({ fault: { kind: 'reset', rule: 1 }, rulesTried: 1 });
  });

  it('holds a timeout with faults.timeoutMs and a ticket', async () => {
    const capacity = counting(2);
    const engine = engineOf({}, { transport: capacity });
    const hold = await engine.resolve(request('POST', '/v1/orders', { 'x-simulate': ['hold'] }));
    expect(hold.status).toBe(0);
    expect(hold.transport?.fault).toMatchObject({ kind: 'timeout', holdMs: 120000 });
    expect(capacity.held).toBe(1);
    const fault = hold.transport?.fault;
    if (fault?.kind === 'timeout') fault.ticket.release();
    expect(capacity.held).toBe(0);
  });

  it('answers 503 fault-capacity-exceeded with Connection: close when no slot is free, consuming no step', async () => {
    const capacity = counting(0);
    const engine = engineOf({}, { transport: capacity, entries: { ...TREE } });
    session(engine, 's1', 'flaky-network');
    const headers = { 'x-mock-session': ['s1'] };
    expect((await engine.resolve(request('POST', '/v1/orders', headers))).transport?.fault).toEqual({ kind: 'reset' });
    const refused = await engine.resolve(request('POST', '/v1/orders', headers));
    expect(refused.status).toBe(503);
    expect(refused.headers['connection']).toEqual(['close']);
    expect(refused.transport?.close).toBe(true);
    expect(refused.trace.outcome).toEqual({ kind: 'fault-capacity-exceeded' });
    expect(json(refused)).toMatchObject({ error: { code: 'fault-capacity-exceeded' } });
    expect(refused.trace.transport?.faultSequence).toMatchObject({ position: 2, advanced: false });
    expect((await engine.resolve(request('POST', '/v1/orders', headers))).trace.transport?.faultSequence).toMatchObject(
      { position: 2 },
    );
  });

  it('continues for truncate and malformed, with X-Mock-Fault', async () => {
    const engine = engineOf();
    const cut = await engine.resolve(request('POST', '/v1/orders', { 'x-simulate': ['cut'] }));
    expect(cut.status).toBe(201);
    expect(cut.transport?.fault).toEqual({ kind: 'truncate', bytes: 4 });
    expect(cut.headers['x-mock-fault']).toEqual(['truncate; rule=3']);
    const broken = await engine.resolve(request('POST', '/v1/orders', { 'x-simulate': ['broken'] }));
    expect(broken.transport?.fault).toEqual({ kind: 'malformed', form: 'bad-chunk' });
    expect(broken.headers['x-mock-fault']).toEqual(['malformed; form=bad-chunk; rule=4']);
  });

  it('reads XML bodies in conditions, attributes included', async () => {
    const engine = engineOf();
    const response = await engine.resolve(
      request('POST', '/v1/orders', XML, '<order id="o-9" priority="high"><item>a</item></order>'),
    );
    expect(response.transport?.fault).toEqual({ kind: 'malformed', form: 'status-line' });
    const low = await engine.resolve(request('POST', '/v1/orders', XML, '<order priority="low"/>'));
    expect(low.transport?.fault).toBeNull();
    const bad = await engine.resolve(request('POST', '/v1/orders', XML, '<!DOCTYPE x><order/>'));
    expect(bad.status).toBe(400);
    expect(json(bad)).toMatchObject({ error: { code: 'invalid-request' } });
  });

  it('describes faults in a simulation without performing them or calling tryHold', async () => {
    const capacity = counting(0);
    const engine = engineOf({}, { transport: capacity });
    const explained = await engine.atlas.explain(request('POST', '/v1/orders', { 'x-simulate': ['hold'] }));
    expect(explained.response).toBeNull();
    expect(explained.trace.transport).toMatchObject({ fault: { kind: 'timeout', rule: 2 }, performed: false });
    expect(capacity.calls).toBe(0);
  });
});

describe('fault sequences', () => {
  it('advances per session on every decided request including none, never for HEAD or the default session', async () => {
    const engine = engineOf();
    session(engine, 'a');
    session(engine, 'b');
    const post = (id: string | null) =>
      engine.resolve(
        request('POST', '/v1/orders', { 'x-simulate': ['steps'], ...(id === null ? {} : { 'x-mock-session': [id] }) }),
      );
    const first = await post('a');
    expect(first.transport?.fault).toEqual({ kind: 'reset' });
    expect(first.trace.transport?.faultSequence).toEqual({ position: 1, steps: 3, advanced: true });
    const second = await post('a');
    expect(second.status).toBe(201);
    expect(second.trace.transport).toMatchObject({ fault: { kind: 'none', step: 2 }, faultSequence: { position: 2 } });
    expect(second.headers['x-mock-fault']).toBeUndefined();
    expect((await post('a')).transport?.fault).toEqual({ kind: 'truncate', bytes: null });
    expect((await post('a')).trace.transport?.faultSequence).toMatchObject({ position: 3 });
    expect((await post('b')).trace.transport?.faultSequence).toMatchObject({ position: 1 });
    const anonymous = await post(null);
    expect(anonymous.trace.transport?.faultSequence).toMatchObject({
      position: 1,
      advanced: false,
      notAdvancedBecause: 'no-session',
    });
    expect((await post(null)).trace.transport?.faultSequence?.position).toBe(1);
  });

  it('keeps sequences per scenario and endpoint, lists them in the session, and resets them', async () => {
    const engine = engineOf();
    const key = session(engine, 's1', 'flaky-network');
    const headers = { 'x-mock-session': ['s1'] };
    await engine.resolve(request('POST', '/v1/orders', headers));
    const described = engine.sessions.describe(headers);
    expect(described.ok && described.document.sequences).toMatchObject([{ kind: 'fault', position: 2, steps: 3 }]);
    const done = engine.sessions.resetSequences(
      { ...headers, 'x-mock-session-key': [key] },
      endpointId('flaky-network', 'POST', ['v1', 'orders']),
    );
    expect(done).toMatchObject({ ok: true });
    expect(
      (await engine.resolve(request('POST', '/v1/orders', headers))).trace.transport?.faultSequence?.position,
    ).toBe(1);
  });

  it('keeps a position across a reload of an unchanged rule and restarts a changed one', async () => {
    const engine = engineOf();
    session(engine, 's1', 'flaky-network');
    const headers = { 'x-mock-session': ['s1'] };
    await engine.resolve(request('POST', '/v1/orders', headers));
    engine.replaceSnapshot(snapshotOf({ ...TREE, 'default/v1/small/GET/200.json': '{"ok":false}' }));
    expect(
      (await engine.resolve(request('POST', '/v1/orders', headers))).trace.transport?.faultSequence?.position,
    ).toBe(2);
    engine.replaceSnapshot(
      snapshotOf({ ...TREE, 'flaky-network/v1/orders/POST/fault.yaml': 'rules:\n  - fault: [reset, none]\n' }),
    );
    expect(
      (await engine.resolve(request('POST', '/v1/orders', headers))).trace.transport?.faultSequence?.position,
    ).toBe(1);
  });

  it('reads but never advances for HEAD, which uses GET’s fault.yaml', async () => {
    const engine = engineOf(
      {},
      {
        entries: {
          'default/a/GET/200.json': '{}',
          'default/a/GET/fault.yaml': 'rules:\n  - fault: [truncate, none]\n',
        },
      },
    );
    session(engine, 'a');
    const headers = { 'x-mock-session': ['a'] };
    const head = await engine.resolve(request('HEAD', '/a', headers));
    expect(head.transport?.fault).toEqual({ kind: 'truncate', bytes: null });
    expect(head.trace.transport?.faultSequence).toMatchObject({ advanced: false, notAdvancedBecause: 'head' });
    expect((await engine.resolve(request('GET', '/a', headers))).trace.transport?.faultSequence?.position).toBe(1);
  });
});

describe('what a fault changes', () => {
  it('advances no response sequence and stores no replay for reset and timeout', async () => {
    const engine = engineOf();
    session(engine, 'a');
    const headers = { 'x-mock-session': ['a'], 'idempotency-key': ['k1'] };
    const reset = await engine.resolve(request('POST', '/v1/orders', { ...headers, 'x-simulate': ['reset'] }));
    expect(reset.trace.sequence).toBeUndefined();
    expect(reset.trace.replay).toBeUndefined();
    const served = await engine.resolve(request('POST', '/v1/orders', headers));
    expect(json(served)).toEqual({ id: 'o-1' });
    expect(served.trace.replay).toEqual({ outcome: 'stored' });
  });

  it('advances sequences and stores replays for truncate, and truncates a replay', async () => {
    const engine = engineOf();
    session(engine, 'a');
    const headers = { 'x-mock-session': ['a'], 'idempotency-key': ['k1'], 'x-simulate': ['cut'] };
    const first = await engine.resolve(request('POST', '/v1/orders', headers));
    expect(first.trace.sequence).toMatchObject({ position: 1, advanced: true });
    expect(first.trace.replay).toEqual({ outcome: 'stored' });
    const again = await engine.resolve(request('POST', '/v1/orders', headers));
    expect(again.trace.replay).toEqual({ outcome: 'replayed' });
    expect(again.transport?.fault).toEqual({ kind: 'truncate', bytes: 4 });
  });

  it('decides but performs nothing with faults.enabled false', async () => {
    const engine = engineOf({
      faults: { enabled: false, timeoutMs: 1000, maxHeldConnections: 1, latency: { ms: 50 } },
    });
    session(engine, 's1', 'flaky-network');
    const headers = { 'x-mock-session': ['s1'] };
    const response = await engine.resolve(request('POST', '/v1/orders', headers));
    expect(response.status).toBe(201);
    expect(response.transport).toMatchObject({ delayMs: 0, fault: null });
    expect(response.headers['x-mock-latency']).toBeUndefined();
    expect(response.trace.transport).toMatchObject({
      performed: false,
      fault: { kind: 'reset' },
      latency: { ms: 300, source: 'scenario' },
    });
  });
});

describe('latency', () => {
  const config = (latency: EngineConfig['faults']['latency']): Partial<EngineConfig> => ({
    faults: { enabled: true, timeoutMs: 120000, maxHeldConnections: 128, latency },
  });

  it('takes fault.yaml, then the scenario chain, then faults.latency, then none', async () => {
    const none = await engineOf().resolve(request('GET', '/v1/small'));
    expect(none.transport?.delayMs).toBe(0);
    expect(none.trace.transport?.latency).toBeNull();
    expect(none.headers['x-mock-latency']).toBeUndefined();

    const engine = engineOf(config({ ms: 20 }));
    const server = await engine.resolve(request('GET', '/v1/small'));
    expect(server.trace.transport?.latency).toEqual({ ms: 20, source: 'config', profile: { ms: 20 } });
    expect(server.headers['x-mock-latency']).toEqual(['20']);

    const scenario = await engine.resolve(request('GET', '/v1/small', { 'x-mock-scenario': ['flaky-network'] }));
    expect(scenario.trace.transport?.latency).toEqual({
      ms: 300,
      source: 'scenario',
      scenario: 'flaky-network',
      profile: { ms: 300 },
    });
    expect(scenario.transport?.delayMs).toBe(300);

    const inherited = await engine.resolve(request('GET', '/v1/orders/o-1', { 'x-mock-scenario': ['fast'] }));
    expect(inherited.trace.transport?.latency).toMatchObject({ ms: 300, scenario: 'flaky-network' });

    const own = await engine.resolve(request('GET', '/v1/small', { 'x-mock-scenario': ['fast'] }));
    expect(own.trace.transport?.latency).toEqual({ ms: 0, source: 'fault-file', profile: { ms: 0 } });
    expect(own.headers['x-mock-latency']).toBeUndefined();
  });

  it('delays errors and route misses too, drawing a range deterministically', async () => {
    const engine = engineOf(config({ min: 10, max: 5000 }));
    const miss = await engine.resolve(request('GET', '/nowhere'));
    expect(miss.status).toBe(404);
    const ms = miss.transport?.delayMs ?? -1;
    expect(ms).toBeGreaterThanOrEqual(10);
    expect(ms).toBeLessThanOrEqual(5000);
    expect((await engine.resolve(request('GET', '/nowhere'))).transport?.delayMs).toBe(ms);
    expect(engineOf(config({ min: 10, max: 5000 })).planDelay(request('GET', '/nowhere'))).toBe(ms);
  });

  it('plans the delay without changing anything', async () => {
    const engine = engineOf();
    session(engine, 's1', 'flaky-network');
    const headers = { 'x-mock-session': ['s1'] };
    expect(engine.planDelay(request('POST', '/v1/orders', headers))).toBe(300);
    expect(engine.planDelay(request('POST', '/v1/orders', headers))).toBe(300);
    expect(
      (await engine.resolve(request('POST', '/v1/orders', headers))).trace.transport?.faultSequence?.position,
    ).toBe(1);
  });
});

describe('response codings', () => {
  const gzip = { 'accept-encoding': ['gzip'] };

  it('codes a large JSON body, with Vary, Content-Encoding and a weak ETag', async () => {
    const response = await engineOf().resolve(request('GET', '/v1/orders/o-1', gzip));
    expect(response.transport?.coding).toBe('gzip');
    expect(response.headers['content-encoding']).toEqual(['gzip']);
    expect(response.headers['vary']).toEqual(['Accept, Accept-Encoding']);
    expect(response.headers['etag']).toEqual(['W/"v1"']);
    expect(response.trace.transport?.responseCoding).toBe('gzip');
  });

  it('adds only Vary when no coding is acceptable, and nothing below minBytes, for binary or errors', async () => {
    const engine = engineOf();
    const identity = await engine.resolve(request('GET', '/v1/orders/o-1'));
    expect(identity.transport?.coding).toBeNull();
    expect(identity.headers['vary']).toEqual(['Accept, Accept-Encoding']);
    expect(identity.headers['etag']).toEqual(['"v1"']);
    for (const target of ['/v1/small', '/v1/image', '/nowhere']) {
      const response = await engine.resolve(request('GET', target, gzip));
      expect(response.transport?.coding).toBeNull();
      expect(response.headers['vary'] ?? []).not.toContain('Accept, Accept-Encoding');
    }
    const off = engineOf({ compression: { enabled: false, encodings: ['gzip'], minBytes: 0 } });
    expect((await off.resolve(request('GET', '/v1/orders/o-1', gzip))).headers['vary']).toEqual(['Accept']);
  });

  it('gives HEAD GET’s headers and the body to measure', async () => {
    const head = await engineOf().resolve(request('HEAD', '/v1/orders/o-1', gzip));
    expect(head.body).toBeNull();
    expect(head.headers['content-encoding']).toEqual(['gzip']);
    expect(head.headers['content-length']).toBeUndefined();
    expect(utf8Decode(head.transport?.headBody ?? new Uint8Array())).toBe(BIG);
  });

  it('reports request codings in the trace', async () => {
    const response = await engineOf().resolve(request('POST', '/v1/orders', {}, '{}', { bodyCodings: ['gzip'] }));
    expect(response.trace.transport?.requestCodings).toEqual(['gzip']);
  });
});

describe('automatic OPTIONS', () => {
  it('answers 204 with Allow, serves an OPTIONS directory, and leaves a miss to onNoFixture', async () => {
    const engine = engineOf();
    const auto = await engine.resolve(request('OPTIONS', '/v1/orders'));
    expect(auto.status).toBe(204);
    expect(auto.headers['allow']).toEqual(['OPTIONS, POST']);
    expect(auto.trace.outcome).toEqual({ kind: 'automatic-options', allowed: ['OPTIONS', 'POST'] });
    expect(json(await engine.resolve(request('OPTIONS', '/v1/options')))).toEqual({ own: true });
    expect((await engine.resolve(request('OPTIONS', '/nowhere'))).status).toBe(404);
    const star = await engine.resolve(request('OPTIONS', '*'));
    expect(star.status).toBe(204);
    expect(star.headers['allow']).toBeUndefined();
  });

  it('keeps 405 and the old Allow with autoOptions false', async () => {
    const engine = engineOf({ autoOptions: false });
    const response = await engine.resolve(request('OPTIONS', '/v1/orders'));
    expect(response.status).toBe(405);
    expect(response.headers['allow']).toEqual(['POST']);
  });
});

describe('fixture preflights', () => {
  const cors = (origins: readonly string[], credentials = false): Partial<EngineConfig> => ({
    fixtureCors: { origins, credentials, maxAge: 600 },
  });
  const preflight = (method: string, extra: HeaderMap = {}): HeaderMap => ({
    origin: ['http://page.test'],
    'access-control-request-method': [method],
    ...extra,
  });

  it('allows a listed origin the union of every scenario’s methods', async () => {
    const engine = engineOf(cors(['http://page.test'], true), {
      entries: { ...TREE, 'other/v1/orders/DELETE/204': '' },
    });
    const response = await engine.resolve(
      request(
        'OPTIONS',
        '/v1/orders',
        preflight('DELETE', { 'access-control-request-headers': ['X-Session, content-type'] }),
      ),
    );
    expect(response.status).toBe(204);
    expect(response.headers).toMatchObject({
      'access-control-allow-origin': ['http://page.test'],
      'access-control-allow-methods': ['DELETE, POST'],
      'access-control-allow-headers': ['x-session, content-type'],
      'access-control-allow-credentials': ['true'],
      'access-control-max-age': ['600'],
    });
    expect(response.trace.outcome).toEqual({ kind: 'preflight', allowed: ['DELETE', 'POST'] });
    expect(response.trace.transport?.cors).toBe('preflight');
  });

  it('answers a refused preflight as a plain OPTIONS without CORS', async () => {
    const engine = engineOf(cors(['http://page.test']));
    for (const headers of [
      preflight('PUT'),
      preflight('POST', { 'access-control-request-headers': ['x-mock-record'] }),
      preflight('POST', { origin: ['http://elsewhere.test'] }),
    ]) {
      const response = await engine.resolve(request('OPTIONS', '/v1/orders', headers));
      expect(response.status).toBe(204);
      expect(response.headers['allow']).toEqual(['OPTIONS, POST']);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.transport?.noCors).toBe(true);
      expect(response.trace.transport?.cors).toBe('preflight-refused');
    }
  });

  it('marks actual requests from a listed origin, and nothing when fixture CORS is off', async () => {
    const on = await engineOf(cors(['*'])).resolve(request('GET', '/v1/small', { origin: ['http://page.test'] }));
    expect(on.trace.transport?.cors).toBe('actual');
    const off = await engineOf().resolve(request('OPTIONS', '/v1/orders', preflight('POST')));
    expect(off.headers['access-control-allow-origin']).toBeUndefined();
    expect(off.trace.outcome.kind).toBe('automatic-options');
  });
});

describe('the transport trace', () => {
  it('holds no request value', async () => {
    const engine = engineOf();
    const response = await engine.resolve(
      request('POST', '/v1/orders', { 'x-simulate': ['cut'], authorization: ['Bearer s3cret'] }, '{"card":"4242"}'),
    );
    const text = JSON.stringify(response.trace.transport);
    for (const secret of ['cut', 's3cret', '4242']) expect(text).not.toContain(secret);
  });
});

describe('the head check', () => {
  it('refuses from the head what the head decides and passes the rest', () => {
    const engine = engineOf(
      {},
      {
        entries: {
          'default/v1/orders/POST/201.json': '{}',
          'default/v1/orders/POST/accepts.yaml': 'accepts: [application/xml]\n',
        },
      },
    );
    const refused = engine.checkHead(request('POST', '/v1/orders', { 'content-type': ['text/plain'] }));
    expect(refused?.status).toBe(415);
    expect(engine.checkHead(request('POST', '/v1/orders', XML))).toBeNull();
    expect(engine.checkHead(request('POST', '/nowhere', XML))?.status).toBe(404);
    expect(engine.checkHead(request('PUT', '/v1/orders', XML))?.status).toBe(405);
  });
});

describe('fixture CORS on responses', () => {
  const page = { origin: ['http://page.test'] };
  const names = [
    'Content-Type',
    'X-Mock-Identity',
    'ETag',
    'Set-Cookie',
    'Access-Control-Allow-Origin',
    'content-length',
  ];

  it('allows a listed origin and exposes every header a page could not read', () => {
    expect(fixtureCorsHeaders({ origins: ['http://page.test'], credentials: true, maxAge: 600 }, page, names)).toEqual({
      'access-control-allow-origin': 'http://page.test',
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': 'etag, x-mock-identity',
    });
    expect(fixtureCorsHeaders({ origins: ['*'], credentials: false, maxAge: 600 }, page, [])).toEqual({
      'access-control-allow-origin': '*',
    });
  });

  it('adds nothing for an unlisted, missing or repeated origin, or with fixture CORS off', () => {
    const settings = { origins: ['http://page.test'], credentials: false, maxAge: 600 };
    expect(fixtureCorsHeaders(settings, { origin: ['http://other.test'] }, names)).toEqual({});
    expect(fixtureCorsHeaders(settings, {}, names)).toEqual({});
    expect(fixtureCorsHeaders(settings, { origin: ['http://page.test', 'http://page.test'] }, names)).toEqual({});
    expect(fixtureCorsHeaders({ ...settings, origins: [] }, page, names)).toEqual({});
  });
});

describe('the Atlas projection', () => {
  const find = (engine: Engine, scenario: string, method: HttpMethod, path: string) => {
    const item = engine.atlas
      .inventory(scenario)
      ?.items.find((entry) => entry.method === method && entry.path === path);
    if (item === undefined) throw new Error(`no ${method} ${path}`);
    const lookup = engine.atlas.endpoint(item.id, engine.atlas.health().snapshotVersion);
    if (lookup.kind !== 'found') throw new Error('missing');
    return { item, endpoint: lookup.value };
  };

  it('shows fault.yaml with its scenario, latency and rules, and badges the inventory', () => {
    const engine = engineOf();
    const own = find(engine, 'flaky-network', 'POST', '/v1/orders');
    expect(own.item.hasFaults).toBe(true);
    expect(own.endpoint.faults).toEqual({
      file: '/v1/orders/POST/fault.yaml',
      scenario: 'flaky-network',
      inherited: false,
      latency: null,
      rules: [{ when: [], fault: [{ kind: 'reset' }, { kind: 'timeout' }, { kind: 'none' }] }],
    });
    const inherited = find(engine, 'fast', 'POST', '/v1/orders');
    expect(inherited.endpoint.faults).toMatchObject({ scenario: 'flaky-network', inherited: true });
    const rules = find(engine, 'default', 'POST', '/v1/orders').endpoint.faults?.rules;
    expect(rules?.[0]).toEqual({
      when: [{ reference: 'header.x-simulate', test: 'equals', value: 'reset' }],
      fault: [{ kind: 'reset' }],
    });
    expect(rules?.[2]?.fault).toEqual([{ kind: 'truncate', bytes: 4 }]);
    expect(rules?.[3]?.fault).toEqual([{ kind: 'malformed', form: 'bad-chunk' }]);
    const plain = find(engine, 'default', 'GET', '/v1/options');
    expect(plain.item.hasFaults).toBeUndefined();
    expect(plain.endpoint.faults).toBeUndefined();
  });

  it('lists fault.yaml in the scenario matrix, and latency in the scenario projection', () => {
    const engine = engineOf();
    const rows = find(engine, 'default', 'POST', '/v1/orders').endpoint.matrix.rows;
    expect(rows.map((row) => [row.scenario, row.fault])).toEqual([
      ['default', { origin: 'own', scenario: 'default' }],
      ['fast', { origin: 'inherited', scenario: 'flaky-network' }],
      ['flaky-network', { origin: 'own', scenario: 'flaky-network' }],
      ['other', { origin: 'inherited', scenario: 'default' }],
    ]);
    const scenarios = engine.atlas.scenarios().items;
    expect(scenarios.find((item) => item.name === 'fast')?.latency).toEqual({
      own: null,
      effective: { profile: { ms: 300 }, scenario: 'flaky-network' },
    });
    expect(scenarios.find((item) => item.name === 'flaky-network')?.latency.own).toEqual({ ms: 300 });
  });
});
