import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import type { EngineConfig } from '../config/merge.js';
import { createEngine } from '../create-engine.js';
import { buildSnapshot } from '../fixtures/build.js';
import { derivedSessionId, resolveSessionKey } from '../http/session.js';
import type { Engine, FixtureSnapshot, HeaderMap, RequestDescription, ResponseDescription } from '../types/index.js';
import type { SessionAnswer } from './api.js';
import { constantTimeEqual, SessionStore } from './store.js';

// Scenario selection, sessions and the session clock.

const T0 = Date.UTC(2030, 0, 1);
const MINUTE = 60_000;

const TREE = {
  'default/v1/cart/GET/200.json': '{"from":"default"}',
  'default/v1/when/GET/200.json': '{"now":"{{$now}}"}',
  'declined/flow.yaml': 'description: Declined\n',
  'declined/v1/cart/GET/200.json': '{"from":"declined"}',
  'declined-late/flow.yaml': 'extends: declined\n',
  'declined-late/v1/extra/GET/204': '',
};

function snapshotOf(entries: Readonly<Record<string, string>>): FixtureSnapshot {
  const result = buildSnapshot(new Map(Object.entries(entries).map(([path, text]) => [path, utf8Encode(text)])));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.snapshot;
}

interface Harness {
  readonly engine: Engine;
  /** Moves the fake wall clock. */
  readonly advance: (ms: number) => void;
  /** The number of `randomBytes` calls so far. */
  readonly draws: () => number;
}

function harness(config: Partial<EngineConfig> = {}, entries: Readonly<Record<string, string>> = TREE): Harness {
  let now = T0;
  let calls = 0;
  const engine = createEngine({
    snapshot: snapshotOf(entries),
    config,
    clock: () => now,
    randomBytes: (count) => {
      calls += 1;
      return Uint8Array.from({ length: count }, (_, index) => (calls * 16 + index) & 0xff);
    },
  });
  return {
    engine,
    advance: (ms) => {
      now += ms;
    },
    draws: () => calls,
  };
}

const body = (value: unknown): Uint8Array => utf8Encode(JSON.stringify(value));
const JSON_TYPE = { 'content-type': ['application/json'] };

function write(
  engine: Engine,
  method: 'POST' | 'PATCH' | 'DELETE',
  headers: HeaderMap,
  value?: unknown,
): SessionAnswer {
  const withType = value === undefined ? headers : { ...JSON_TYPE, ...headers };
  return engine.sessions.write(method, withType, value === undefined ? null : body(value));
}

/** Creates a session and returns its write key. */
function create(engine: Engine, id: string, value: unknown = {}): string {
  const answer = write(engine, 'POST', { 'x-mock-session': [id] }, value);
  if (!answer.ok || answer.writeKey === undefined) throw new Error(JSON.stringify(answer));
  return answer.writeKey;
}

const get = (target: string, headers: HeaderMap = {}, extra: Partial<RequestDescription> = {}): RequestDescription => ({
  method: 'GET',
  target,
  headers,
  ...extra,
});

const text = (response: ResponseDescription): string => new TextDecoder().decode(response.body ?? new Uint8Array());
const errorOf = (response: ResponseDescription): Record<string, unknown> =>
  (JSON.parse(text(response)) as { error: Record<string, unknown> }).error;

describe('scenario selection', () => {
  it('takes the caller, then X-Mock-Scenario, then the pin, then scenarios.default, then default', async () => {
    const { engine } = harness({ defaultScenario: 'declined' });
    const key = create(engine, 'a', { scenario: 'declined-late' });
    expect(key).toMatch(/^wk_[0-9a-f]{32}$/);

    const cases: [RequestDescription, string, string][] = [
      [
        get('/v1/cart', { 'x-mock-scenario': ['declined'], 'x-mock-session': ['a'] }, { scenario: 'default' }),
        'caller',
        'default',
      ],
      [get('/v1/cart', { 'x-mock-scenario': ['default'], 'x-mock-session': ['a'] }), 'request-header', 'default'],
      [get('/v1/cart', { 'x-mock-session': ['a'] }), 'session', 'declined-late'],
      [get('/v1/cart'), 'config', 'declined'],
    ];
    for (const [request, source, scenario] of cases) {
      const response = await engine.resolve(request);
      expect(response.trace.selection?.source).toBe(source);
      expect(response.trace.scenario).toBe(scenario);
      expect(response.headers['x-mock-scenario']).toEqual([scenario]);
    }
    const plain = await harness().engine.resolve(get('/v1/cart'));
    expect(plain.trace.selection).toEqual({ source: 'default', chain: ['default'] });
  });

  it('reports the chain, the supplying scenario and the hidden file', async () => {
    const { engine } = harness();
    const response = await engine.resolve(get('/v1/cart', { 'x-mock-scenario': ['declined-late'] }));
    expect(text(response)).toBe('{"from":"declined"}');
    expect(response.trace.selection?.chain).toEqual(['declined-late', 'declined', 'default']);
    expect(response.trace.resolvedFrom).toBe('declined');
    expect(response.headers['x-mock-resolved-from']).toEqual(['declined']);
    expect(response.trace.shadowed).toEqual([
      { scenario: 'default', fixtureId: expect.any(String) as unknown, by: 'replaced' },
    ]);
    const inherited = await engine.resolve(
      get('/v1/when', { 'x-mock-scenario': ['declined-late'], 'x-mock-now': ['2030-01-01T00:00:00Z'] }),
    );
    expect(inherited.trace.resolvedFrom).toBe('default');
    expect(inherited.trace.shadowed).toEqual([]);
  });

  it('answers an unknown name with 400 from each source, never falling back to a later one', async () => {
    const { engine } = harness();
    create(engine, 'a', { scenario: 'declined' });

    const caller = await engine.resolve(get('/v1/cart', { 'x-mock-session': ['a'] }, { scenario: 'nope' }));
    expect(caller.status).toBe(400);
    expect(errorOf(caller)).toMatchObject({
      code: 'unknown-scenario',
      source: 'caller',
      known: ['declined', 'declined-late', 'default'],
    });
    expect(caller.trace.selection).toBeUndefined();

    const header = await engine.resolve(get('/v1/cart', { 'x-mock-scenario': ['nope'], 'x-mock-session': ['a'] }));
    expect(errorOf(header)).toMatchObject({ code: 'unknown-scenario', source: 'request-header' });
    expect(header.trace.outcome).toMatchObject({ kind: 'unknown-scenario', source: 'request-header' });

    const malformed = await engine.resolve(get('/v1/cart', { 'x-mock-scenario': ['Nope'] }));
    expect(malformed.status).toBe(400);
    expect(errorOf(malformed)['code']).toBe('invalid-request');
    const repeated = await engine.resolve(get('/v1/cart', { 'x-mock-scenario': ['default', 'default'] }));
    expect(errorOf(repeated)['code']).toBe('invalid-request');
  });

  it('keeps a pin across a reload that drops its scenario, failing loudly with source session', async () => {
    const { engine } = harness();
    create(engine, 'a', { scenario: 'declined' });
    engine.replaceSnapshot(snapshotOf({ 'default/v1/cart/GET/200.json': '{"from":"default"}' }));
    const pinned = await engine.resolve(get('/v1/cart', { 'x-mock-session': ['a'] }));
    expect(pinned.status).toBe(400);
    expect(errorOf(pinned)).toMatchObject({ code: 'unknown-scenario', source: 'session', known: ['default'] });
    expect((await engine.resolve(get('/v1/cart', { 'x-mock-session': ['b'] }))).status).toBe(200);
    const described = engine.sessions.describe({ 'x-mock-session': ['a'] });
    expect(described.ok && described.document.scenario).toEqual({ name: 'declined', known: false });
  });

  it('lists at most 64 hidden files and adds shadowedCount', async () => {
    const entries: Record<string, string> = {
      'default/v1/cart/GET/200.json': '{}',
      'big/flow.yaml': 'overrides: [/v1/cart/GET]\n',
      'big/v1/cart/GET/200.json': '{"own":true}',
    };
    for (let index = 0; index < 70; index++) {
      const locale = String.fromCharCode(97 + Math.floor(index / 26), 97 + (index % 26));
      entries[`default/v1/cart/GET/200_[${locale}].json`] = '{}';
    }
    const { engine } = harness({}, entries);
    const response = await engine.resolve(get('/v1/cart', { 'x-mock-scenario': ['big'] }));
    expect(text(response)).toBe('{"own":true}');
    expect(response.trace.shadowed).toHaveLength(64);
    expect(response.trace.shadowedCount).toBe(71);
    expect(response.trace.shadowed?.every((entry) => entry.scenario === 'default')).toBe(true);
  });

  it('cuts the known list at 50 and adds knownCount', async () => {
    const entries: Record<string, string> = { 'default/v1/cart/GET/200.json': '{}' };
    for (let index = 0; index < 60; index++) entries[`s${String(index).padStart(2, '0')}/flow.yaml`] = '{}';
    const { engine } = harness({}, entries);
    const error = errorOf(await engine.resolve(get('/v1/cart', { 'x-mock-scenario': ['nope'] })));
    expect(error['known']).toHaveLength(50);
    expect(error['knownCount']).toBe(61);
  });
});

describe('session keys', () => {
  it('reads X-Mock-Session with its grammar and the reserved default', () => {
    expect(resolveSessionKey({ 'x-mock-session': ['team-a.7~f_3'] }, [])).toEqual({
      ok: true,
      key: { id: 'team-a.7~f_3', source: 'header' },
    });
    for (const bad of [[''], ['a b'], ['default'], ['a', 'a'], ['x'.repeat(129)]]) {
      expect(resolveSessionKey({ 'x-mock-session': bad }, []).ok).toBe(false);
    }
    expect(resolveSessionKey({}, [])).toEqual({ ok: true, key: { id: null, source: 'default' } });
  });

  it('derives a key from the first present keyFrom entry, header or cookie, never keeping the value', () => {
    const keyFrom = ['header.Authorization', 'cookie.cart'];
    const cookie = resolveSessionKey({ cookie: ['x=1; cart="c-9"', 'cart=later'] }, keyFrom);
    expect(cookie).toEqual({ ok: true, key: { id: derivedSessionId('cookie.cart', 'c-9'), source: 'derived' } });
    const both = resolveSessionKey({ authorization: ['Bearer a,b'], cookie: ['cart=c-9'] }, keyFrom);
    expect(both).toEqual({
      ok: true,
      key: { id: derivedSessionId('header.Authorization', 'Bearer a,b'), source: 'derived' },
    });
    if (both.ok) expect(both.key.id).toMatch(/^k_[0-9a-f]{16}$/);
    expect(resolveSessionKey({ authorization: ['a', 'b'] }, keyFrom).ok).toBe(false);
    expect(resolveSessionKey({ 'x-mock-session': ['s'], authorization: ['a'] }, keyFrom)).toEqual({
      ok: true,
      key: { id: 's', source: 'header' },
    });
  });

  it('reserves the k_ prefix for derived keys, so an explicit ID cannot squat one (review C1)', async () => {
    const derived = derivedSessionId('cookie.cart', 'c-9');
    for (const id of [derived, 'k_', 'k_mine']) {
      expect(resolveSessionKey({ 'x-mock-session': [id] }, [])).toMatchObject({ ok: false });
    }
    expect(resolveSessionKey({ 'x-mock-session': ['K_mine'] }, []).ok).toBe(true);
    expect(resolveSessionKey({ 'x-mock-session': ['kk_1'] }, []).ok).toBe(true);
    const { engine } = harness({ keyFrom: ['cookie.cart'] });
    expect(write(engine, 'POST', { 'x-mock-session': [derived] }, {})).toMatchObject({ status: 400 });
    const response = await engine.resolve(get('/v1/cart', { 'x-mock-session': [derived] }));
    expect(response.status).toBe(400);
    expect(errorOf(response)['code']).toBe('invalid-request');
  });

  it('answers a malformed X-Mock-Session with 400 before selection', async () => {
    const response = await harness().engine.resolve(get('/v1/cart', { 'x-mock-session': ['default'] }));
    expect(response.status).toBe(400);
    expect(response.trace.selection).toBeUndefined();
    expect(response.trace.session).toBeUndefined();
  });
});

describe('the session store', () => {
  it('serves a key that names no session as empty and stores nothing', async () => {
    const { engine } = harness();
    const response = await engine.resolve(get('/v1/cart', { 'x-mock-session': ['ghost'] }));
    expect(response.trace.session).toEqual({ id: 'ghost', source: 'header', exists: false });
    expect(response.trace.selection?.source).toBe('default');
    const described = engine.sessions.describe({ 'x-mock-session': ['ghost'] });
    expect(described.ok && described.document).toEqual({
      id: 'ghost',
      source: 'header',
      exists: false,
      scenario: null,
      clock: null,
      createdAt: null,
      lastSeenAt: null,
      expiresAt: null,
      sequences: [],
      replays: { count: 0, max: 1000 },
    });
    expect(write(engine, 'PATCH', { 'x-mock-session': ['ghost'] }, { scenario: null })).toMatchObject({
      ok: false,
      status: 404,
      code: 'session-not-found',
    });
  });

  it('describes the default session with nulls', () => {
    const described = harness().engine.sessions.describe({});
    expect(described.ok && described.document).toMatchObject({ id: null, source: 'default', exists: false });
  });

  it('expires a session after its idle timeout, and requests keep it alive', async () => {
    const { engine, advance } = harness({ idleTimeout: 60 });
    create(engine, 'a', { scenario: 'declined' });
    advance(59_000);
    expect((await engine.resolve(get('/v1/cart', { 'x-mock-session': ['a'] }))).trace.scenario).toBe('declined');
    advance(59_000);
    const described = engine.sessions.describe({ 'x-mock-session': ['a'] });
    expect(described.ok && described.document.expiresAt).toBe(
      new Date(T0 + 59_000 + 59_000 + 60_000).toISOString().replace('.000', ''),
    );
    advance(61_000);
    const expired = await engine.resolve(get('/v1/cart', { 'x-mock-session': ['a'] }));
    expect(expired.trace.session?.exists).toBe(false);
    expect(expired.trace.scenario).toBe('default');
  });

  it('refuses a session past sessions.max without evicting, and makes room once one expires', () => {
    const { engine, advance } = harness({ maxSessions: 2, idleTimeout: 60 });
    create(engine, 'a');
    advance(30_000);
    create(engine, 'b');
    expect(write(engine, 'POST', { 'x-mock-session': ['c'] }, {})).toMatchObject({
      status: 503,
      code: 'session-limit',
    });
    // a, idle since the start, expires; b stays.
    advance(31_000);
    expect(write(engine, 'POST', { 'x-mock-session': ['c'] }, {})).toMatchObject({ ok: true, status: 201 });
    expect(engine.sessions.describe({ 'x-mock-session': ['a'] })).toMatchObject({ document: { exists: false } });
    expect(engine.sessions.describe({ 'x-mock-session': ['b'] })).toMatchObject({ document: { exists: true } });
  });

  it('keeps sessions across a snapshot swap', () => {
    const { engine } = harness();
    create(engine, 'a', { scenario: 'declined' });
    engine.replaceSnapshot(snapshotOf({ ...TREE, 'default/v1/new/GET/204': '' }));
    expect(engine.sessions.describe({ 'x-mock-session': ['a'] })).toMatchObject({
      document: { exists: true, scenario: { name: 'declined', known: true } },
    });
  });

  it('answers 409 to a second POST and leaves the session unchanged', () => {
    const { engine } = harness();
    const key = create(engine, 'a', { scenario: 'declined' });
    expect(write(engine, 'POST', { 'x-mock-session': ['a'] }, { scenario: 'default' })).toMatchObject({
      status: 409,
      code: 'session-exists',
    });
    expect(engine.sessions.describe({ 'x-mock-session': ['a'] })).toMatchObject({
      document: { scenario: { name: 'declined' } },
    });
    expect(
      write(engine, 'PATCH', { 'x-mock-session': ['a'], 'x-mock-session-key': [key] }, { scenario: null }).ok,
    ).toBe(true);
  });

  it('keeps an existing session alive when a write is rejected', () => {
    const { engine, advance } = harness({ idleTimeout: 60 });
    create(engine, 'a');
    advance(50_000);

    expect(write(engine, 'POST', { 'x-mock-session': ['a'] }, {})).toMatchObject({
      status: 409,
      code: 'session-exists',
    });

    // The rejected POST is still a real request carrying this session key,
    // so expiry is measured from that request rather than from creation.
    advance(20_000);
    expect(engine.sessions.describe({ 'x-mock-session': ['a'] })).toMatchObject({
      document: { exists: true },
    });
  });

  it('keeps the write key of an emptied session, and DELETE drops both', () => {
    const { engine } = harness();
    const key = create(engine, 'a', { scenario: 'declined', clock: { now: T0 } });
    const auth = { 'x-mock-session': ['a'], 'x-mock-session-key': [key] };
    const emptied = write(engine, 'PATCH', auth, { scenario: null, clock: null });
    expect(emptied).toMatchObject({ ok: true, status: 200, document: { exists: true, scenario: null, clock: null } });
    expect(write(engine, 'PATCH', auth, { scenario: 'declined' }).ok).toBe(true);
    expect(write(engine, 'DELETE', auth)).toMatchObject({ ok: true, status: 200, document: { exists: false } });
    expect(write(engine, 'DELETE', auth)).toMatchObject({ status: 404, code: 'session-not-found' });
    const again = create(engine, 'a');
    expect(again).not.toBe(key);
  });

  it('derives the session of a credential named in keyFrom', async () => {
    const { engine } = harness({ keyFrom: ['cookie.cart'] });
    const headers = { cookie: ['cart=c-9'] };
    const answer = write(engine, 'POST', headers, { scenario: 'declined' });
    expect(answer).toMatchObject({
      ok: true,
      document: { id: derivedSessionId('cookie.cart', 'c-9'), source: 'derived' },
    });
    expect((await engine.resolve(get('/v1/cart', headers))).trace.scenario).toBe('declined');
    expect(JSON.stringify(answer)).not.toContain('c-9');
  });
});

describe('session writes', () => {
  it('checks the errors in order', () => {
    const { engine } = harness();
    expect(write(engine, 'POST', {}, { scenario: 'x' })).toMatchObject({ status: 400, code: 'session-required' });
    expect(write(engine, 'PATCH', { 'x-mock-session': ['a'] }, 'not an object')).toMatchObject({
      status: 404,
      code: 'session-not-found',
    });
    const key = create(engine, 'a');
    const other = create(engine, 'b');
    for (const keys of [undefined, [key, key], ['wk_short'], [other]]) {
      const headers: HeaderMap = {
        'x-mock-session': ['a'],
        ...(keys === undefined ? {} : { 'x-mock-session-key': keys }),
      };
      expect(write(engine, 'PATCH', headers, 'not an object')).toMatchObject({
        status: 403,
        code: 'session-forbidden',
      });
      expect(write(engine, 'DELETE', headers)).toMatchObject({ status: 403, code: 'session-forbidden' });
    }
    const auth = { 'x-mock-session': ['a'], 'x-mock-session-key': [key] };
    expect(write(engine, 'PATCH', auth, {})).toMatchObject({ status: 400, code: 'atlas-invalid-request' });
    expect(write(engine, 'PATCH', auth, { scenario: 'nope' })).toMatchObject({ status: 400, code: 'unknown-scenario' });
    expect(write(engine, 'PATCH', auth, { clock: { advance: '+1d' } })).toMatchObject({
      status: 409,
      code: 'no-session-clock',
    });
    expect(engine.sessions.write('PATCH', auth, body({ scenario: null }))).toMatchObject({
      status: 415,
      code: 'unsupported-media-type',
    });
    expect(write(engine, 'PATCH', auth, { scenario: 'x'.repeat(5000) })).toMatchObject({
      status: 413,
      code: 'request-too-large',
    });
    expect(engine.sessions.write('DELETE', auth, utf8Encode('{}'))).toMatchObject({ status: 400 });
  });

  it('validates the whole body before changing anything', () => {
    const { engine } = harness();
    const key = create(engine, 'a', { scenario: 'declined' });
    const auth = { 'x-mock-session': ['a'], 'x-mock-session-key': [key] };
    const rejected = [
      { scenario: null, clock: { now: 'yesterday' } },
      { scenario: null, extra: 1 },
      { clock: { now: T0, advance: '+1d' } },
      { clock: { now: T0, mode: 'live' } },
      { clock: { advance: '1d' } },
      { scenario: 'Bad' },
    ];
    for (const value of rejected) {
      expect(write(engine, 'PATCH', auth, value)).toMatchObject({ status: 400, code: 'atlas-invalid-request' });
    }
    expect(engine.sessions.describe({ 'x-mock-session': ['a'] })).toMatchObject({
      document: { scenario: { name: 'declined' }, clock: null },
    });
    for (const value of [{ scenario: null }, { clock: null }, { clock: { advance: '+1d' } }, [], 'x']) {
      expect(write(engine, 'POST', { 'x-mock-session': ['z'] }, value)).toMatchObject({ status: 400 });
    }
  });

  it('creates an empty session from an empty POST body', () => {
    const { engine } = harness();
    expect(engine.sessions.write('POST', { 'x-mock-session': ['a'] }, null)).toMatchObject({
      ok: true,
      status: 201,
      document: { exists: true, scenario: null, clock: null },
    });
  });
});

describe('write keys', () => {
  it('draws 16 bytes per key and returns the key only from the creating POST', async () => {
    const { engine, draws } = harness();
    const created = write(engine, 'POST', { 'x-mock-session': ['a'] }, {});
    expect(draws()).toBe(1);
    expect(created.ok && created.writeKey).toBe('wk_101112131415161718191a1b1c1d1e1f');
    const key = created.ok ? (created.writeKey ?? '') : '';
    expect(JSON.stringify(created.ok && created.document)).not.toContain(key);
    const auth = { 'x-mock-session': ['a'], 'x-mock-session-key': [key] };
    for (const answer of [
      engine.sessions.describe(auth),
      write(engine, 'PATCH', auth, { scenario: 'declined' }),
      write(engine, 'DELETE', auth),
    ]) {
      expect(JSON.stringify(answer)).not.toContain(key);
      expect('writeKey' in answer).toBe(false);
    }
    const response = await engine.resolve(get('/v1/cart', auth));
    expect(JSON.stringify(response.trace)).not.toContain(key);
  });

  it('stores only the digest and compares digests whole', () => {
    const store = new SessionStore({
      idleTimeoutMs: 60_000,
      max: 10,
      now: () => 0,
      randomBytes: () => new Uint8Array(16),
    });
    const created = store.create('a', 'header', { scenario: null, clock: null });
    if (created.kind !== 'created') throw new Error('expected created');
    expect(JSON.stringify(created.state)).not.toContain(created.writeKey);
    expect(store.authorize('a', created.writeKey)).toBe(true);
    expect(store.authorize('a', `${created.writeKey.slice(0, -1)}1`)).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it('cannot create a session without an entropy source', () => {
    const engine = createEngine({ snapshot: snapshotOf(TREE), clock: () => T0 });
    expect(() => write(engine, 'POST', { 'x-mock-session': ['a'] }, {})).toThrow(/randomBytes/);
  });
});

describe('the session clock', () => {
  const nowOf = async (engine: Engine, headers: HeaderMap): Promise<string> =>
    (JSON.parse(text(await engine.resolve(get('/v1/when', headers)))) as { now: string }).now;

  it('renders between X-Mock-Now and the server default', async () => {
    const { engine, advance } = harness({ now: Date.UTC(2020, 0, 1), clockMode: 'frozen' });
    create(engine, 'a', { clock: { now: '2026-01-01T00:00:00+01:00', mode: 'frozen' } });
    const a = { 'x-mock-session': ['a'] };
    expect(await nowOf(engine, a)).toBe('2025-12-31T23:00:00Z');
    expect((await engine.resolve(get('/v1/when', a))).trace.render?.clockSource).toBe('session');
    expect(await nowOf(engine, { ...a, 'x-mock-now': ['2040-01-01T00:00:00Z'] })).toBe('2040-01-01T00:00:00Z');
    expect(await nowOf(engine, { 'x-mock-session': ['b'] })).toBe('2020-01-01T00:00:00Z');
    advance(MINUTE);
    expect(await nowOf(engine, a)).toBe('2025-12-31T23:00:00Z');
  });

  it('moves an offset clock with the wall clock, and advance moves it again each time', async () => {
    const { engine, advance } = harness();
    const key = create(engine, 'a', { clock: { now: Date.UTC(2026, 0, 31), mode: 'offset' } });
    const a = { 'x-mock-session': ['a'] };
    advance(MINUTE);
    expect(await nowOf(engine, a)).toBe('2026-01-31T00:01:00Z');
    const auth = { ...a, 'x-mock-session-key': [key] };
    expect(write(engine, 'PATCH', auth, { clock: { advance: '+1mo' } })).toMatchObject({
      document: { clock: { now: '2026-02-28T00:01:00Z', mode: 'offset' } },
    });
    write(engine, 'PATCH', auth, { clock: { advance: '+1d' } });
    expect(await nowOf(engine, a)).toBe('2026-03-01T00:01:00Z');
    write(engine, 'PATCH', auth, { clock: { now: '2027-01-01T00:00:00Z' } });
    expect(engine.sessions.describe(a)).toMatchObject({
      document: { clock: { now: '2027-01-01T00:00:00Z', mode: 'frozen' } },
    });
  });

  it('reports an offset clock that has run past the Date range as an error, never a NaN date (review C2)', async () => {
    const { engine, advance } = harness();
    const key = create(engine, 'a', { clock: { now: 8_640_000_000_000_000, mode: 'offset' } });
    const a = { 'x-mock-session': ['a'] };
    expect(engine.sessions.describe(a)).toMatchObject({ document: { clock: { now: '+275760-09-13T00:00:00Z' } } });
    advance(1000);
    const reason = 'the session clock has run past the end of the Date range';
    expect(engine.sessions.describe(a)).toMatchObject({ ok: false, status: 409, code: 'no-session-clock' });
    expect(engine.atlas.clock(a)).toMatchObject({
      kind: 'bad-input',
      message: expect.stringContaining(reason) as unknown,
    });
    const auth = { ...a, 'x-mock-session-key': [key] };
    expect(write(engine, 'PATCH', auth, { clock: { advance: '-1d' } })).toMatchObject({ status: 409 });
    expect(write(engine, 'PATCH', auth, { scenario: 'declined' })).toMatchObject({ status: 409 });
    const response = await engine.resolve(get('/v1/when', a));
    expect(response.status).toBe(500);
    expect(response.trace.outcome).toMatchObject({ kind: 'render-failed', token: 'now', reason });
    expect(text(response)).not.toContain('NaN');
    // A requested instant still wins over the broken clock, and binding it again repairs it.
    expect(await nowOf(engine, { ...a, 'x-mock-now': ['2040-01-01T00:00:00Z'] })).toBe('2040-01-01T00:00:00Z');
    expect(write(engine, 'PATCH', auth, { clock: { now: '2027-01-01T00:00:00Z' } })).toMatchObject({ ok: true });
    expect(await nowOf(engine, a)).toBe('2027-01-01T00:00:00Z');
  });

  it('reports the session clock in GET /_janus/clock', () => {
    const { engine } = harness();
    create(engine, 'a', { clock: { now: T0 } });
    const clock = engine.atlas.clock({ 'x-mock-session': ['a'] });
    expect(clock).toMatchObject({
      kind: 'found',
      value: { source: 'session', session: 'a', now: '2030-01-01T00:00:00Z' },
    });
  });
});

describe('simulations leave sessions unchanged', () => {
  it('reads the pin and clock without extending, expiring or creating a session', async () => {
    const { engine, advance } = harness({ idleTimeout: 60 });
    create(engine, 'a', { scenario: 'declined' });
    advance(30_000);
    const explained = await engine.atlas.explain(get('/v1/cart', { 'x-mock-session': ['a'] }));
    expect(explained.trace.scenario).toBe('declined');
    await engine.atlas.explain(get('/v1/cart', { 'x-mock-session': ['new'] }));
    const described = engine.sessions.describe({ 'x-mock-session': ['new'] });
    expect(described.ok && described.document.exists).toBe(false);
    advance(31_000);
    // The explain call did not count as a request, so the session expired on time.
    const after = await engine.atlas.explain(get('/v1/cart', { 'x-mock-session': ['a'] }));
    expect(after.trace.session?.exists).toBe(false);
  });
});
