import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import type { EngineConfig } from '../config/merge.js';
import { createEngine } from '../create-engine.js';
import { buildSnapshot } from '../fixtures/build.js';
import { endpointId } from '../ids.js';
import type {
  Engine,
  FixtureSnapshot,
  HeaderMap,
  HttpMethod,
  RequestDescription,
  ResponseDescription,
  StartupError,
} from '../types/index.js';

// Choosing between responses.

const T0 = Date.UTC(2030, 0, 1);

const ORDERS = {
  'default/v1/orders/{orderId}/GET/200.json': '{"order":"{{$path.orderId}}","state":"done"}',
  'default/v1/orders/{orderId}/GET/200.shipped.json': '{"state":"shipped"}',
  'default/v1/orders/{orderId}/GET/200.shipped-priority.json': '{"state":"shipped","priority":true}',
  'default/v1/orders/{orderId}/GET/202.pending.json': '{"state":"pending","step":"{{$sequence.position}}"}',
  'default/v1/orders/{orderId}/GET/404.missing.json': '{"error":"missing"}',
  'default/v1/orders/{orderId}/GET/304.fresh': '',
  'default/v1/orders/{orderId}/GET/304.fresh.headers.json': '{"ETag":"\\"o-v2\\""}',
  'default/v1/orders/{orderId}/GET/200.headers.json': '{"ETag":"\\"o-v2\\""}',
  'default/v1/orders/{orderId}/GET/variants.yaml': [
    'rules:',
    '  - when: { path.orderId: ord-missing }',
    '    serve: 404.missing',
    '  - when: { header.if-none-match: { matchesETag: \'"o-v2"\' } }',
    '    serve: 304.fresh',
    '  - when:',
    '      header.x-tier: { in: [gold, platinum] }',
    '      query.status: shipped',
    '    serve: 200.shipped-priority',
    '  - when: { query.status: shipped }',
    '    serve: 200.shipped',
    '  - when: { query.express: "true" }',
    '    serve: [202.pending, 200.shipped]',
    '',
  ].join('\n'),
  'default/v1/orders/{orderId}/GET/sequence.yaml': 'steps: [202.pending, 202.pending, 200]\n',
  'default/v1/items/GET/200.json': '{"page":1}',
  'default/v1/items/GET/200.page-2.json': '{"page":2}',
  'default/v1/items/GET/200.empty.json': '{"page":null}',
  'default/v1/items/GET/pages.yaml':
    'by: query.page\nwhenAbsent: "1"\npages:\n  "1": 200\n  "2": 200.page-2\notherwise: 200.empty\n',
  'default/v1/payments/POST/201.json': '{"id":"pay_{{$uuid}}","scenario":"{{$scenario.name}}"}',
  'default/v1/payments/POST/400.unexpected.json': '{"error":"unexpected"}',
  'declined/flow.yaml': 'description: Declined\nids:\n  orderId: ord-7\n',
  'declined/v1/payments/POST/expect.yaml': [
    'expect:',
    '  header.idempotency-key: { present: true }',
    '  body.$.orderId: "{{$scenario.ids.orderId}}"',
    '  body.$.amount.currency: EUR',
    '',
  ].join('\n'),
  'strict/flow.yaml': 'extends: declined\n',
  'strict/v1/payments/POST/expect.yaml': 'expect:\n  body.$.amount.currency: EUR\nonMismatch: 400.unexpected\n',
};

function build(entries: Readonly<Record<string, string>>) {
  return buildSnapshot(new Map(Object.entries(entries).map(([path, text]) => [path, utf8Encode(text)])));
}

function snapshotOf(entries: Readonly<Record<string, string>>): FixtureSnapshot {
  const result = build(entries);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.snapshot;
}

function errorsOf(entries: Readonly<Record<string, string>>): readonly StartupError[] {
  const result = build(entries);
  if (result.ok) throw new Error('expected the build to fail');
  return result.errors;
}

function engineOf(entries: Readonly<Record<string, string>> = ORDERS, config: Partial<EngineConfig> = {}): Engine {
  let calls = 0;
  return createEngine({
    snapshot: snapshotOf(entries),
    config: { seed: 1, ...config },
    clock: () => T0,
    randomBytes: (count) => {
      calls += 1;
      return Uint8Array.from({ length: count }, (_, index) => (calls * 16 + index) & 0xff);
    },
  });
}

/** Creates a session and returns its write key. */
function session(engine: Engine, id: string, scenario?: string): string {
  const value = scenario === undefined ? {} : { scenario };
  const answer = engine.sessions.write(
    'POST',
    { 'x-mock-session': [id], 'content-type': ['application/json'] },
    utf8Encode(JSON.stringify(value)),
  );
  if (!answer.ok || answer.writeKey === undefined) throw new Error(JSON.stringify(answer));
  return answer.writeKey;
}

const request = (
  method: HttpMethod,
  target: string,
  headers: HeaderMap = {},
  body?: unknown,
  extra: Partial<RequestDescription> = {},
): RequestDescription => ({
  method,
  target,
  headers: body === undefined ? headers : { 'content-type': ['application/json'], ...headers },
  ...(body === undefined ? {} : { body: utf8Encode(typeof body === 'string' ? body : JSON.stringify(body)) }),
  ...extra,
});

const text = (response: ResponseDescription): string => new TextDecoder().decode(response.body ?? new Uint8Array());
const json = (response: ResponseDescription): Record<string, unknown> =>
  JSON.parse(text(response)) as Record<string, unknown>;
const choiceOf = (response: ResponseDescription): string | undefined => response.headers['x-mock-choice']?.[0];

describe('variant files and identities', () => {
  it('keeps plain fixture IDs and gives named variants their own', async () => {
    const plainTree = { 'default/a/GET/200.json': '1' };
    const tree = {
      ...plainTree,
      'default/a/GET/200.x.json': '2',
      'default/a/GET/variants.yaml': 'rules:\n  - when: { query.x: "1" }\n    serve: 200.x\n',
    };
    const idOf = async (engine: Engine, target: string) =>
      (await engine.resolve(request('GET', target))).trace.headers?.identity;
    const plain = await idOf(engineOf(plainTree), '/a');
    expect(await idOf(engineOf(tree), '/a')).toBe(plain);
    const named = await idOf(engineOf(tree), '/a?x=1');
    expect(named).not.toBe(plain);
    const moved = {
      ...plainTree,
      'default/a/GET/201.x.json': '2',
      'default/a/GET/variants.yaml': tree['default/a/GET/variants.yaml'].replace('200.x', '201.x'),
    };
    expect(await idOf(engineOf(moved), '/a?x=1')).toBe(named);
  });

  it('reports duplicate variants, a missing plain response and orphan variant sidecars', () => {
    const codes = (entries: Record<string, string>) => errorsOf(entries).map((error) => error.code);
    expect(
      codes({ 'default/a/GET/200.json': '1', 'default/a/GET/200.x.json': '1', 'default/a/GET/404.x.json': '2' }),
    ).toContain('duplicate-variant');
    expect(codes({ 'default/a/GET/200.x.json': '1' })).toContain('missing-response');
    expect(codes({ 'default/a/GET/200.json': '1', 'default/a/GET/200.x.headers.json': '{}' })).toContain(
      'orphan-header-sidecar',
    );
  });

  it('checks every identity a control file names, with a suggestion', () => {
    const errors = errorsOf({
      'default/a/GET/200.json': '1',
      'default/a/GET/200.empty.json': '[]',
      'default/a/GET/sequence.yaml': 'steps: [200, 200.emtpy]\n',
    });
    expect(errors).toMatchObject([
      { code: 'unknown-identity', message: expect.stringContaining('200.empty') as unknown },
    ]);
  });

  it('warns when a matchesETag rule names a tag the plain 200 never sends', () => {
    const tree = (etag: string) => ({
      'default/a/GET/200.json': '1',
      'default/a/GET/200.headers.json': `{"ETag":${JSON.stringify(etag)}}`,
      'default/a/GET/304.fresh': '',
      'default/a/GET/variants.yaml':
        'rules:\n  - when: { header.if-none-match: { matchesETag: \'"v2"\' } }\n    serve: 304.fresh\n',
    });
    const warned = build(tree('"v1"'));
    expect(warned.warnings.map((warning) => warning.code)).toEqual(['etag-mismatch']);
    expect(build(tree('W/"v2"')).warnings).toEqual([]);
  });

  it('rejects pages.yaml beside sequence.yaml', () => {
    const errors = errorsOf({
      'default/a/GET/200.json': '1',
      'default/a/GET/sequence.yaml': 'steps: [200]\n',
      'default/a/GET/pages.yaml': 'by: query.page\npages:\n  "1": 200\n',
    });
    expect(errors.map((error) => error.code)).toContain('conflicting-controls');
  });

  it('checks path parameters and scenario IDs in every effective tree', () => {
    expect(
      errorsOf({
        'default/v1/{id}/GET/200.json': '1',
        'default/v1/{id}/GET/200.x.json': '2',
        'default/v1/{id}/GET/variants.yaml': 'rules:\n  - when: { path.nope: a }\n    serve: 200.x\n',
      }).map((error) => error.code),
    ).toContain('unknown-path-parameter');
    const errors = errorsOf({
      'default/a/GET/200.json': '{"id":"{{$scenario.ids.orderId}}"}',
      'child/flow.yaml': 'ids:\n  orderId: ord-1\n',
    });
    expect(errors).toMatchObject([
      { code: 'unknown-scenario-id', message: expect.stringContaining('scenario "default"') as unknown },
    ]);
  });

  it('replaces an inherited control file whole', async () => {
    const engine = engineOf({
      ...ORDERS,
      'calm/flow.yaml': 'description: Calm\n',
      'calm/v1/orders/{orderId}/GET/sequence.yaml': 'steps: [200]\n',
    });
    session(engine, 'a', 'calm');
    const response = await engine.resolve(request('GET', '/v1/orders/ord-1', { 'x-mock-session': ['a'] }));
    expect(response.status).toBe(200);
    expect(choiceOf(response)).toBe('200; by=sequence; step=1');
  });
});

describe('rules', () => {
  it('serves the first matching rule, in order', async () => {
    const engine = engineOf();
    const missing = await engine.resolve(request('GET', '/v1/orders/ord-missing'));
    expect(missing.status).toBe(404);
    expect(choiceOf(missing)).toBe('404.missing; by=rule; rule=1');
    expect(missing.trace.choice).toEqual({ identity: '404.missing', by: 'rule', rule: 1, rulesTried: 1 });

    const gold = await engine.resolve(request('GET', '/v1/orders/ord-1?status=shipped', { 'x-tier': ['gold'] }));
    expect(json(gold)).toEqual({ state: 'shipped', priority: true });
    expect(gold.trace.choice).toMatchObject({ rule: 3, rulesTried: 3 });

    const bronze = await engine.resolve(request('GET', '/v1/orders/ord-1?status=shipped', { 'x-tier': ['bronze'] }));
    expect(json(bronze)).toEqual({ state: 'shipped' });
    expect(choiceOf(bronze)).toBe('200.shipped; by=rule; rule=4');
  });

  it('falls through to the sequence when no rule matches', async () => {
    const engine = engineOf();
    const response = await engine.resolve(request('GET', '/v1/orders/ord-1'));
    expect(response.status).toBe(202);
    expect(response.trace.choice).toEqual({ identity: '202.pending', by: 'sequence', step: 1, rulesTried: 5 });
  });

  it('serves 304 with its ETag for a matching If-None-Match, weakly compared', async () => {
    const engine = engineOf();
    for (const value of ['"o-v2"', 'W/"o-v2"', '"x", W/"o-v2"', '*']) {
      const response = await engine.resolve(request('GET', '/v1/orders/ord-1', { 'if-none-match': [value] }));
      expect(response.status).toBe(304);
      expect(response.headers.etag).toEqual(['"o-v2"']);
    }
    for (const value of ['"o-v1"', 'o-v2', '']) {
      const response = await engine.resolve(request('GET', '/v1/orders/ord-1', { 'if-none-match': [value] }));
      expect(response.status).toBe(202);
    }
  });

  it.each([
    ['rule', 'GET', '/v1/orders/ord-1?status=shipped'],
    ['sequence', 'GET', '/v1/orders/ord-1'],
    ['page', 'GET', '/v1/items?page=2'],
    ['expect', 'POST', '/v1/payments'],
  ] as const)(
    'requires an acceptable representation for a %s choice even with ignore configured',
    async (by, method, target) => {
      const engine = engineOf(ORDERS, { onUnacceptable: 'ignore' });
      const headers = { accept: ['text/csv'] };
      const response = await engine.resolve(
        request(method, target, headers, undefined, by === 'expect' ? { scenario: 'strict' } : {}),
      );
      expect(response.status).toBe(406);
      expect(response.trace.choice?.by).toBe(by);
      const plain = await engine.resolve(request('POST', '/v1/payments', headers));
      expect(plain.status).toBe(201);
      expect(plain.trace.choice?.by).toBe('plain');
    },
  );

  it('answers 406 from the chosen identity rather than falling through', async () => {
    const engine = engineOf();
    const response = await engine.resolve(request('GET', '/v1/orders/ord-1?status=shipped', { accept: ['text/csv'] }));
    expect(response.status).toBe(406);
  });
});

describe('sequences', () => {
  it.each(['removed', 'changed'] as const)(
    'discards %s sequences before a later reload restores them',
    async (change) => {
      const engine = engineOf();
      for (const id of ['a', 'b']) {
        session(engine, id);
        const headers = { 'x-mock-session': [id] };
        await engine.resolve(request('GET', '/v1/orders/ord-1', headers));
        await engine.resolve(request('GET', '/v1/orders/ord-1?express=true', headers));
      }
      const edited: Record<string, string> = { ...ORDERS };
      const sequence = 'default/v1/orders/{orderId}/GET/sequence.yaml';
      const rules = 'default/v1/orders/{orderId}/GET/variants.yaml';
      if (change === 'removed') {
        delete edited['default/v1/orders/{orderId}/GET/sequence.yaml'];
        edited['default/v1/orders/{orderId}/GET/202.pending.json'] = '{"state":"pending"}';
        edited[rules] = ORDERS[rules].replace('    serve: [202.pending, 200.shipped]', '    serve: 200.shipped');
      } else {
        edited[sequence] = 'steps: [202.pending, 200]';
        edited[rules] = ORDERS[rules].replace(
          '    serve: [202.pending, 200.shipped]',
          '    serve: [200.shipped, 202.pending]',
        );
      }
      engine.replaceSnapshot(snapshotOf(edited));
      engine.replaceSnapshot(snapshotOf(ORDERS));
      for (const id of ['a', 'b']) {
        const headers = { 'x-mock-session': [id] };
        expect((await engine.resolve(request('GET', '/v1/orders/ord-1', headers))).trace.sequence?.position).toBe(1);
        expect(
          (await engine.resolve(request('GET', '/v1/orders/ord-1?express=true', headers))).trace.sequence?.position,
        ).toBe(1);
      }
    },
  );

  it('advances per session, repeats the last step and never advances for HEAD or the default session', async () => {
    const engine = engineOf();
    session(engine, 'a');
    session(engine, 'b');
    const poll = (id: string | null, method: HttpMethod = 'GET') =>
      engine.resolve(request(method, '/v1/orders/ord-1', id === null ? {} : { 'x-mock-session': [id] }));

    const first = await poll('a');
    expect([first.status, json(first)]).toEqual([202, { state: 'pending', step: 1 }]);
    expect(first.trace.sequence).toEqual({ rule: null, position: 1, steps: 3, advanced: true });
    const head = await poll('a', 'HEAD');
    expect(head.trace.sequence).toMatchObject({ position: 2, advanced: false, notAdvancedBecause: 'head' });
    expect(json(await poll('a'))).toEqual({ state: 'pending', step: 2 });
    expect((await poll('a')).status).toBe(200);
    expect((await poll('a')).status).toBe(200);

    expect(json(await poll('b'))).toEqual({ state: 'pending', step: 1 });
    const anonymous = await poll(null);
    expect(anonymous.trace.sequence).toMatchObject({ position: 1, advanced: false, notAdvancedBecause: 'no-session' });
    expect(json(await poll(null))).toEqual({ state: 'pending', step: 1 });
  });

  it('keeps a rule sequence apart from sequence.yaml', async () => {
    const engine = engineOf();
    session(engine, 'a');
    const headers = { 'x-mock-session': ['a'] };
    await engine.resolve(request('GET', '/v1/orders/ord-1', headers));
    const express = await engine.resolve(request('GET', '/v1/orders/ord-1?express=true', headers));
    expect(choiceOf(express)).toBe('202.pending; by=rule; rule=5; step=1');
    expect(express.trace.sequence).toMatchObject({ rule: 5, position: 1, advanced: true });
    expect(choiceOf(await engine.resolve(request('GET', '/v1/orders/ord-1?express=true', headers)))).toBe(
      '200.shipped; by=rule; rule=5; step=2',
    );
    const plain = await engine.resolve(request('GET', '/v1/orders/ord-1', headers));
    expect(plain.trace.sequence).toMatchObject({ rule: null, position: 2 });
  });

  it('reports a sequence that did not choose and leaves it in place', async () => {
    const engine = engineOf();
    session(engine, 'a');
    const response = await engine.resolve(request('GET', '/v1/orders/ord-missing', { 'x-mock-session': ['a'] }));
    expect(response.trace.sequence).toMatchObject({
      rule: null,
      position: 1,
      advanced: false,
      notAdvancedBecause: 'not-chosen',
    });
  });

  it('keeps positions across a reload of an unchanged sequence and restarts a changed one', async () => {
    const engine = engineOf();
    session(engine, 'a');
    const headers = { 'x-mock-session': ['a'] };
    await engine.resolve(request('GET', '/v1/orders/ord-1', headers));
    engine.replaceSnapshot(snapshotOf({ ...ORDERS, 'default/v1/orders/{orderId}/GET/200.json': '{"edited":true}' }));
    expect((await engine.resolve(request('GET', '/v1/orders/ord-1', headers))).trace.sequence?.position).toBe(2);
    engine.replaceSnapshot(
      snapshotOf({ ...ORDERS, 'default/v1/orders/{orderId}/GET/sequence.yaml': 'steps: [202.pending, 200]\n' }),
    );
    expect((await engine.resolve(request('GET', '/v1/orders/ord-1', headers))).trace.sequence?.position).toBe(1);
  });

  it('drops positions when a reload renames the path parameter (review C4)', async () => {
    const engine = engineOf();
    session(engine, 'a');
    const headers = { 'x-mock-session': ['a'] };
    await engine.resolve(request('GET', '/v1/orders/ord-1', headers));
    const listed = () => {
      const described = engine.sessions.describe(headers);
      return described.ok ? described.document.sequences : null;
    };
    expect(listed()).toHaveLength(1);
    const renamed = Object.fromEntries(
      Object.entries(ORDERS).map(([path, text]) => [
        path.replace('{orderId}', '{id}'),
        text.replaceAll('path.orderId', 'path.id'),
      ]),
    );
    engine.replaceSnapshot(snapshotOf(renamed));
    expect(listed()).toEqual([]);
    expect((await engine.resolve(request('GET', '/v1/orders/ord-1', headers))).trace.sequence?.position).toBe(1);
  });

  it('resets one session’s positions with its write key', async () => {
    const engine = engineOf();
    const key = session(engine, 'a');
    const headers = { 'x-mock-session': ['a'] };
    await engine.resolve(request('GET', '/v1/orders/ord-1', headers));
    expect(engine.sessions.resetSequences(headers, null)).toMatchObject({
      ok: false,
      status: 403,
      code: 'session-forbidden',
    });
    expect(engine.sessions.resetSequences({ ...headers, 'x-mock-session-key': ['wk_0'] }, null)).toMatchObject({
      status: 403,
    });
    expect(engine.sessions.resetSequences({}, null)).toMatchObject({ status: 400, code: 'session-required' });
    expect(engine.sessions.resetSequences({ 'x-mock-session': ['nope'] }, null)).toMatchObject({
      status: 404,
      code: 'session-not-found',
    });
    const write = { ...headers, 'x-mock-session-key': [key] };
    expect(engine.sessions.resetSequences(write, 'nope')).toMatchObject({
      status: 404,
      code: 'atlas-resource-not-found',
    });
    const done = engine.sessions.resetSequences(write, endpointId('default', 'GET', ['v1', 'orders', '{orderId}']));
    expect(done).toMatchObject({ ok: true, status: 200 });
    expect((await engine.resolve(request('GET', '/v1/orders/ord-1', headers))).trace.sequence?.position).toBe(1);
  });

  it('changes no position when explaining', async () => {
    const engine = engineOf();
    session(engine, 'a');
    const headers = { 'x-mock-session': ['a'] };
    const explained = await engine.atlas.explain(request('GET', '/v1/orders/ord-1', headers));
    expect(explained.trace.sequence).toMatchObject({ position: 1, advanced: false, notAdvancedBecause: 'simulation' });
    expect((await engine.atlas.explain(request('GET', '/v1/orders/ord-1', headers))).trace.sequence?.position).toBe(1);
  });
});

describe('pages', () => {
  it('looks up the key, whenAbsent and otherwise', async () => {
    const engine = engineOf();
    const page = async (target: string) => {
      const response = await engine.resolve(request('GET', target));
      return [json(response), response.trace.choice?.page];
    };
    expect(await page('/v1/items')).toEqual([{ page: 1 }, { key: '1', via: 'whenAbsent' }]);
    expect(await page('/v1/items?page=2')).toEqual([{ page: 2 }, { key: '2', via: 'value' }]);
    expect(await page('/v1/items?page=zzz')).toEqual([{ page: null }, { key: null, via: 'otherwise' }]);
  });
});

describe('expectations', () => {
  const pay = (engine: Engine, scenario: string, body: unknown, headers: HeaderMap = { 'idempotency-key': ['k1'] }) =>
    engine.resolve(request('POST', '/v1/payments', { 'x-mock-scenario': [scenario], ...headers }, body));

  it('passes a matching request and names only the failing references otherwise', async () => {
    const engine = engineOf();
    const passed = await pay(engine, 'declined', { orderId: 'ord-7', amount: { currency: 'EUR' } });
    expect(passed.status).toBe(201);
    expect(json(passed)).toMatchObject({ scenario: 'declined' });
    expect(passed.trace.expect).toEqual({ passed: true, failed: [] });

    const failed = await pay(engine, 'declined', { orderId: 'ord-secret', amount: { currency: 'USD' } }, {});
    expect(failed.status).toBe(422);
    const error = json(failed).error as Record<string, unknown>;
    expect(error.code).toBe('expectation-failed');
    expect(error).toMatchObject({
      failed: [
        { reference: 'header.idempotency-key', expected: { present: true } },
        { reference: 'body.$.orderId', expected: 'ord-7' },
        { reference: 'body.$.amount.currency', expected: 'EUR' },
      ],
    });
    expect(text(failed)).not.toContain('ord-secret');
    expect(text(failed)).not.toContain('USD');
  });

  it('checks expectations against a deeply nested JSON body without failing (review X3)', async () => {
    const response = await pay(engineOf(), 'declined', `${'['.repeat(100_000)}${']'.repeat(100_000)}`);
    expect(response.status).toBe(422);
  });

  it('serves onMismatch instead of 422', async () => {
    const engine = engineOf();
    const response = await pay(engine, 'strict', { amount: { currency: 'USD' } });
    expect(response.status).toBe(400);
    expect(choiceOf(response)).toBe('400.unexpected; by=expect');
  });

  it('answers 415 before checking expectations', async () => {
    const engine = engineOf({ ...ORDERS, 'declined/v1/payments/POST/accepts.yaml': 'accepts: [application/json]\n' });
    const response = await engine.resolve(
      request('POST', '/v1/payments', { 'x-mock-scenario': ['declined'], 'content-type': ['text/plain'] }, 'x'),
    );
    expect(response.status).toBe(415);
  });
});

describe('idempotent replay', () => {
  const pay = (engine: Engine, headers: HeaderMap, body: unknown) =>
    engine.resolve(request('POST', '/v1/payments', headers, body));

  it('replays the stored response for the same key and request', async () => {
    const engine = engineOf();
    session(engine, 'a');
    const headers = { 'x-mock-session': ['a'], 'idempotency-key': ['k1'] };
    const first = await pay(engine, headers, { amount: 1, currency: 'EUR' });
    expect(first.trace.replay).toEqual({ outcome: 'stored' });
    const again = await pay(engine, headers, { currency: 'EUR', amount: 1 });
    expect(again.trace.replay).toEqual({ outcome: 'replayed' });
    expect(text(again)).toBe(text(first));
    expect(again.headers['x-mock-replayed']).toEqual(['true']);
    expect(again.headers['x-mock-choice']).toEqual(first.headers['x-mock-choice']);
    expect(again.headers['x-mock-warning']).toBeUndefined();

    const changed = await pay(engine, headers, { amount: 2, currency: 'EUR' });
    expect(changed.status).toBe(422);
    expect((json(changed).error as Record<string, unknown>).code).toBe('idempotency-key-reused');
  });

  it('fingerprints a JSON body nested past the depth cap by its bytes (review X3)', async () => {
    const engine = engineOf();
    session(engine, 'a');
    const headers = { 'x-mock-session': ['a'], 'idempotency-key': ['k1'] };
    const deep = (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`;
    const first = await pay(engine, headers, deep(100_000));
    expect(first.trace.replay).toEqual({ outcome: 'stored' });
    expect((await pay(engine, headers, deep(100_000))).trace.replay).toEqual({ outcome: 'replayed' });
    expect((await pay(engine, headers, deep(100_001))).status).toBe(422);
  });

  it('keeps records per session and never for the default session', async () => {
    const engine = engineOf();
    session(engine, 'a');
    session(engine, 'b');
    const first = await pay(engine, { 'x-mock-session': ['a'], 'idempotency-key': ['k1'] }, {});
    const other = await pay(engine, { 'x-mock-session': ['b'], 'idempotency-key': ['k1'] }, {});
    expect(other.trace.replay).toEqual({ outcome: 'stored' });
    expect(first.trace.replay).toEqual({ outcome: 'stored' });
    const anonymous = await pay(engine, { 'idempotency-key': ['k1'] }, {});
    expect(anonymous.trace.replay).toEqual({ outcome: 'no-session' });
  });

  it('drops only that session’s oldest record past maxEntries', async () => {
    const engine = engineOf(ORDERS, {
      idempotency: { enabled: true, header: 'idempotency-key', methods: ['POST'], maxEntries: 2 },
    });
    session(engine, 'a');
    session(engine, 'b');
    const post = (id: string, key: string) => pay(engine, { 'x-mock-session': [id], 'idempotency-key': [key] }, {});
    await post('b', 'k1');
    await post('a', 'k1');
    await post('a', 'k2');
    await post('a', 'k3');
    expect((await post('a', 'k1')).trace.replay).toEqual({ outcome: 'stored' });
    expect((await post('b', 'k1')).trace.replay).toEqual({ outcome: 'replayed' });
  });

  it('rejects a malformed key and does not store errors', async () => {
    const engine = engineOf();
    session(engine, 'a');
    const bad = await pay(engine, { 'x-mock-session': ['a'], 'idempotency-key': ['a', 'b'] }, {});
    expect(bad.status).toBe(400);
    const failing = await engine.resolve(
      request(
        'POST',
        '/v1/payments',
        { 'x-mock-session': ['a'], 'x-mock-scenario': ['declined'], 'idempotency-key': ['k9'] },
        {},
      ),
    );
    expect(failing.status).toBe(422);
    expect(failing.trace.replay).toEqual({ outcome: 'not-stored' });
  });

  it('removes every diagnostic header with diagnostics.headers false, on replays too', async () => {
    const engine = engineOf(ORDERS, { diagnosticHeaders: false });
    session(engine, 'a');
    const headers = { 'x-mock-session': ['a'], 'idempotency-key': ['k1'] };
    await pay(engine, headers, {});
    const again = await pay(engine, headers, {});
    expect(again.trace.replay).toEqual({ outcome: 'replayed' });
    expect(Object.keys(again.headers).filter((name) => name.startsWith('x-mock-'))).toEqual([]);
  });

  it('only simulates a replay when explaining', async () => {
    const engine = engineOf();
    session(engine, 'a');
    const headers = { 'x-mock-session': ['a'], 'idempotency-key': ['k1'] };
    await pay(engine, headers, {});
    expect((await engine.atlas.explain(request('POST', '/v1/payments', headers, {}))).trace.replay).toEqual({
      outcome: 'would-replay',
    });
    expect(
      (await engine.atlas.explain(request('POST', '/v1/payments', { ...headers, 'idempotency-key': ['k2'] }, {}))).trace
        .replay,
    ).toEqual({
      outcome: 'not-stored',
    });
    expect((await pay(engine, { ...headers, 'idempotency-key': ['k2'] }, {})).trace.replay).toEqual({
      outcome: 'stored',
    });
  });
});

describe('context tokens', () => {
  it('renders one inherited file per selected scenario', async () => {
    const engine = engineOf({
      'default/a/GET/200.json': '{"name":"{{$scenario.name}}","id":"{{$scenario.ids.orderId}}"}',
      'default/flow.yaml': 'ids:\n  orderId: ord-0\n',
      'child/flow.yaml': 'ids:\n  orderId: ord-1\n',
    });
    expect(json(await engine.resolve(request('GET', '/a')))).toEqual({ name: 'default', id: 'ord-0' });
    expect(json(await engine.resolve(request('GET', '/a', { 'x-mock-scenario': ['child'] })))).toEqual({
      name: 'child',
      id: 'ord-1',
    });
  });

  it('allows $sequence.position only where a sequence can choose the file', () => {
    expect(errorsOf({ 'default/a/GET/200.json': '{"n":"{{$sequence.position}}"}' }).map((error) => error.code)).toEqual(
      ['unknown-dynamic-token'],
    );
  });
});

describe('the Atlas projection', () => {
  const endpointOf = (engine: Engine, path: string, scenario = 'default') => {
    const item = engine.atlas.inventory(scenario)?.items.find((entry) => entry.path === path);
    const found = item === undefined ? undefined : engine.atlas.endpoint(item.id, engine.snapshot().version);
    if (found?.kind !== 'found') throw new Error(`no endpoint ${path}`);
    return found.value;
  };

  it('shows identities, their columns and every control as written', () => {
    const engine = engineOf();
    const orders = endpointOf(engine, '/v1/orders/{orderId}');
    expect(orders.matrix.identities.map((identity) => identity.identity)).toEqual([
      '200',
      '304.fresh',
      '404.missing',
      '202.pending',
      '200.shipped',
      '200.shipped-priority',
    ]);
    expect(orders.representationGroups.map((group) => group.variant)).toEqual([
      null,
      'fresh',
      'missing',
      'pending',
      'shipped',
      'shipped-priority',
    ]);
    expect(orders.fixtures.find((fixture) => fixture.variant === 'missing')).toMatchObject({
      identity: '404.missing',
      status: 404,
    });
    expect(orders.controls.rules).toEqual({
      scenario: 'default',
      items: [
        { when: [{ reference: 'path.orderId', test: 'equals', value: 'ord-missing' }], serve: '404.missing' },
        { when: [{ reference: 'header.if-none-match', test: 'matchesETag', tag: '"o-v2"' }], serve: '304.fresh' },
        {
          when: [
            { reference: 'header.x-tier', test: 'in', values: ['gold', 'platinum'] },
            { reference: 'query.status', test: 'equals', value: 'shipped' },
          ],
          serve: '200.shipped-priority',
        },
        { when: [{ reference: 'query.status', test: 'equals', value: 'shipped' }], serve: '200.shipped' },
        {
          when: [{ reference: 'query.express', test: 'equals', value: 'true' }],
          steps: ['202.pending', '200.shipped'],
        },
      ],
    });
    expect(orders.controls.sequence).toEqual({ scenario: 'default', steps: ['202.pending', '202.pending', '200'] });
    expect(orders.controls).toMatchObject({ pages: null, expect: null, idempotent: false });

    const payments = endpointOf(engine, '/v1/payments', 'strict');
    expect(payments.controls).toMatchObject({
      expect: {
        scenario: 'strict',
        conditions: [{ reference: 'body.$.amount.currency', test: 'equals', value: 'EUR' }],
        onMismatch: '400.unexpected',
      },
      idempotent: true,
    });
    expect(endpointOf(engine, '/v1/items').controls.pages).toEqual({
      scenario: 'default',
      by: 'query.page',
      pages: [
        { key: '1', identity: '200' },
        { key: '2', identity: '200.page-2' },
      ],
      whenAbsent: '1',
      otherwise: '200.empty',
    });
  });

  it('lists a session’s positions past step 1 and its replay count, never keys', async () => {
    const engine = engineOf();
    session(engine, 'a');
    const headers = { 'x-mock-session': ['a'] };
    await engine.resolve(request('GET', '/v1/orders/ord-1', headers));
    await engine.resolve(request('POST', '/v1/payments', { ...headers, 'idempotency-key': ['secret-key'] }, {}));
    const described = engine.sessions.describe(headers);
    expect(described.ok && described.document).toMatchObject({
      sequences: [
        {
          scenario: 'default',
          endpointId: endpointOf(engine, '/v1/orders/{orderId}').id,
          rule: null,
          position: 2,
          steps: 3,
        },
      ],
      replays: { count: 1, max: 1000 },
    });
    expect(JSON.stringify(described)).not.toContain('secret-key');
  });
});

describe('onNoFixture', () => {
  it('answers a route miss with 501 not-mocked and leaves onUnknownMethod alone', async () => {
    const engine = engineOf(ORDERS, { onNoFixture: 501 });
    const miss = await engine.resolve(request('GET', '/v1/nothing'));
    expect(miss.status).toBe(501);
    expect((json(miss).error as Record<string, unknown>).code).toBe('not-mocked');
    expect((await engine.resolve(request('DELETE', '/v1/items'))).status).toBe(405);
    expect((await engineOf().resolve(request('GET', '/v1/nothing'))).status).toBe(404);
  });
});

describe('the trace carries no request value', () => {
  it('keeps secrets in headers, cookies, query and body out of the trace and X-Mock-Choice', async () => {
    const engine = engineOf();
    session(engine, 'a');
    const secret = 'sekr3t-value';
    const responses = [
      await engine.resolve(
        request('GET', `/v1/orders/ord-1?status=${secret}`, {
          'x-tier': [secret],
          cookie: [`token=${secret}`],
          'x-mock-session': ['a'],
        }),
      ),
      await engine.resolve(
        request(
          'POST',
          '/v1/payments',
          { 'x-mock-scenario': ['declined'], 'x-mock-session': ['a'], 'idempotency-key': [secret] },
          { orderId: secret, amount: { currency: secret } },
        ),
      ),
    ];
    for (const response of responses) {
      expect(JSON.stringify(response.trace)).not.toContain(secret);
      expect(JSON.stringify(response.headers)).not.toContain(secret);
    }
    const described = engine.sessions.describe({ 'x-mock-session': ['a'] });
    expect(JSON.stringify(described)).not.toContain(secret);
  });
});
