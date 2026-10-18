import { describe, expect, it } from 'vitest';

import { reloadProblem } from './atlas/reload.js';
import { utf8Encode } from './bytes.js';
import { createEngine } from './create-engine.js';
import { buildSnapshot } from './fixtures/build.js';
import type { FixtureSnapshot, StartupWarning } from './types/index.js';

// Snapshot replacement and reload problem locations.

function snapshot(tree: Readonly<Record<string, string>>): FixtureSnapshot {
  const built = buildSnapshot(new Map(Object.entries(tree).map(([path, text]) => [path, utf8Encode(text)])));
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return built.snapshot;
}

const V1 = { 'default/v1/products/GET/200_{text-plain}.txt': 'one' };
const V2 = { 'default/v1/products/GET/200_{text-plain}.txt': 'two' };
const get = { method: 'GET', target: '/v1/products', headers: {} };
const text = (body: Uint8Array | null) => (body === null ? null : new TextDecoder().decode(body));

const WARNING: StartupWarning = {
  code: 'redundant-content-type',
  source: 'fixtures',
  path: 'default/v1/products/GET/200.headers.json',
  message: 'the sidecar repeats Content-Type',
};

describe('engine.replaceSnapshot', () => {
  it('swaps atomically and returns the previous version', async () => {
    const first = snapshot(V1);
    const second = snapshot(V2);
    const engine = createEngine({ snapshot: first });
    expect(engine.replaceSnapshot(second)).toBe(first.version);
    expect(engine.snapshot()).toBe(second);
    expect(text((await engine.resolve(get)).body)).toBe('two');
    expect(engine.atlas.health().snapshotVersion).toBe(second.version);
    expect(engine.atlas.inventory().snapshotVersion).toBe(second.version);
  });

  it('lets a request that started before the swap finish on its snapshot', async () => {
    const first = snapshot(V1);
    const engine = createEngine({ snapshot: first });
    const pending = engine.resolve(get);
    const explaining = engine.atlas.explain(get);
    engine.replaceSnapshot(snapshot(V2));
    const response = await pending;
    expect(text(response.body)).toBe('one');
    expect(response.trace.snapshotVersion).toBe(first.version);
    expect((await explaining).snapshotVersion).toBe(first.version);
    expect((await explaining).response?.body).toMatchObject({ value: 'one' });
  });

  it('makes links issued for the old snapshot stale', () => {
    const first = snapshot(V1);
    const engine = createEngine({ snapshot: first });
    const [item] = engine.atlas.inventory().items;
    if (item === undefined) throw new Error('no endpoint');
    const endpoint = engine.atlas.endpoint(item.id, first.version);
    if (endpoint.kind !== 'found') throw new Error('not found');
    const fixture = endpoint.value.fixtures[0]?.id ?? '';
    engine.replaceSnapshot(snapshot(V2));
    expect(engine.atlas.endpoint(item.id, first.version)).toEqual({ kind: 'stale' });
    expect(engine.atlas.fixture(fixture, first.version)).toEqual({ kind: 'stale' });
    // IDs survive a content-only change.
    expect(engine.atlas.fixture(fixture, engine.snapshot().version).kind).toBe('found');
  });

  it('keeps the snapshot object for an unchanged version but replaces the warnings', () => {
    const first = snapshot(V1);
    const engine = createEngine({ snapshot: first });
    const again = snapshot(V1);
    expect(again).not.toBe(first);
    expect(engine.replaceSnapshot(again, { warnings: [WARNING] })).toBe(first.version);
    expect(engine.snapshot()).toBe(first);
    expect(engine.atlas.health().warnings).toEqual([
      { code: 'redundant-content-type', source: 'fixtures', message: 'the sidecar repeats Content-Type' },
    ]);
    engine.replaceSnapshot(snapshot(V2), { warnings: [] });
    expect(engine.atlas.health().warnings).toEqual([]);
  });

  it('refuses a snapshot that buildSnapshot did not create and changes nothing', () => {
    const first = snapshot(V1);
    const engine = createEngine({ snapshot: first });
    expect(() => engine.replaceSnapshot({ version: 'x', fixtureCount: 0, routeCount: 0 })).toThrow(TypeError);
    expect(engine.snapshot()).toBe(first);
  });
});

describe('reloadProblem', () => {
  const at = (path: string) =>
    reloadProblem({ code: 'invalid-json', source: 'fixtures', path, line: 3, column: 15, message: 'bad' });

  it('names the endpoint and file, never the path', () => {
    expect(at('default/v1/products/{productId}/GET/200_{application-json}.json')).toEqual({
      code: 'invalid-json',
      scenario: 'default',
      endpoint: { method: 'GET', path: '/v1/products/{productId}' },
      file: '200_{application-json}.json',
      line: 3,
      column: 15,
      message: 'bad',
    });
  });

  it.each([
    ['default/GET/200_{text-plain}.txt', 'default', { method: 'GET', path: '/' }, '200_{text-plain}.txt'],
    ['default/v1/p-1/DELETE/204', 'default', { method: 'DELETE', path: '/v1/p-1' }, '204'],
    ['default/v1/GET', 'default', { method: 'GET', path: '/v1' }, null],
    ['default/v1/stray.txt', 'default', { method: null, path: '/v1' }, null],
    ['default/v1/get', 'default', { method: null, path: '/v1/get' }, null],
    ['other/GET/204', 'other', { method: 'GET', path: '/' }, '204'],
    ['checkout-error/v1/cart/GET/200.json', 'checkout-error', { method: 'GET', path: '/v1/cart' }, '200.json'],
    ['staging', 'staging', { method: null, path: '/' }, null],
    ['Bad Name/GET/204', null, { method: null, path: '/' }, null],
    ['', null, { method: null, path: '/' }, null],
  ])('locates %j', (path, scenario, endpoint, file) => {
    expect(at(path)).toMatchObject({ scenario, endpoint, file });
  });

  it('has no scenario for a configuration problem', () => {
    expect(
      reloadProblem({ code: 'config-invalid-yaml', source: 'config', path: 'janus.config.yaml', message: 'bad' }),
    ).toMatchObject({ scenario: null, endpoint: { method: null, path: '/' }, file: null });
  });

  it('reports absent locations as null', () => {
    expect(reloadProblem(WARNING)).toMatchObject({ line: null, column: null, file: '200.headers.json' });
  });
});
