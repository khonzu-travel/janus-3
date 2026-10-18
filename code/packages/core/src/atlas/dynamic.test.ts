import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import { createEngine, type CreateEngineOptions } from '../create-engine.js';
import { buildSnapshot } from '../fixtures/build.js';
import type { Engine } from '../types/index.js';
import type { AtlasLookup } from './types.js';

// Atlas token annotations, rendered previews and the clock resource.

const PRODUCT = '{\n  "id": "{{$path.productId}}",\n  "due": "on {{$ tomorrow }}",\n  "n": "{{$randomInt(1,9)}}"\n}';
const TREE: Readonly<Record<string, string>> = {
  'default/v1/products/{productId}/GET/200_{application-json}.json': PRODUCT,
  'default/v1/products/{productId}/GET/200.headers.json':
    '{"X-Trace":"{{$header.x-trace}}","Set-Cookie":"s={{$uuid}}"}',
  'default/v1/text/GET/200_{text-plain}.txt': 'hello\n{{$now}} {{$uuid:unique}}',
  'default/v1/static/GET/200_{text-plain}.txt': 'static',
};

function engineFor(options: Omit<CreateEngineOptions, 'snapshot'> = {}): Engine {
  const result = buildSnapshot(new Map(Object.entries(TREE).map(([path, value]) => [path, utf8Encode(value)])));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return createEngine({ ...options, snapshot: result.snapshot });
}

function found<T>(lookup: AtlasLookup<T> | { kind: 'bad-input'; message: string }): T {
  if (lookup.kind !== 'found') throw new Error(`expected found, got ${lookup.kind}`);
  return lookup.value;
}

const WALL = Date.UTC(2030, 0, 1);
const engine = engineFor({ config: { seed: 42 }, clock: () => WALL, randomBytes: (n) => new Uint8Array(n).fill(9) });
const version = engine.atlas.health().snapshotVersion;
const fixtureId = (path: string): string => {
  const item = engine.atlas.inventory().items.find((entry) => entry.path === path);
  const endpoint = found(engine.atlas.endpoint(item?.id ?? '', version));
  return endpoint.fixtures[0]?.id ?? '';
};
const productId = fixtureId('/v1/products/{productId}');

describe('token annotations', () => {
  it('lists every token with its pointer, category, uniqueness and span in the raw preview', () => {
    const fixture = found(engine.atlas.fixture(productId, version));
    expect(fixture.dynamic).toBe(true);
    expect(fixture.tokens).toEqual([
      {
        location: 'body',
        pointer: '/id',
        header: null,
        expression: 'path.productId',
        category: 'request',
        unique: false,
        span: { start: 11, end: 30 },
      },
      {
        location: 'body',
        pointer: '/due',
        header: null,
        expression: 'tomorrow',
        category: 'clock',
        unique: false,
        span: { start: 46, end: 61 },
      },
      {
        location: 'body',
        pointer: '/n',
        header: null,
        expression: 'randomInt(1,9)',
        category: 'generator',
        unique: false,
        span: { start: 72, end: 91 },
      },
      {
        location: 'header',
        pointer: '/X-Trace',
        header: 'x-trace',
        expression: 'header.x-trace',
        category: 'request',
        unique: false,
        span: { start: 0, end: 19 },
      },
      {
        location: 'header',
        pointer: '/Set-Cookie',
        header: 'set-cookie',
        expression: 'uuid',
        category: 'generator',
        unique: false,
        span: { start: 2, end: 11 },
      },
    ]);
    const raw = fixture.preview.state === 'available' ? fixture.preview.value : '';
    for (const token of fixture.tokens.filter((entry) => entry.location === 'body')) {
      expect(raw.slice(token.span.start, token.span.end)).toMatch(/^\{\{\$.*\}\}$/);
    }
  });

  it('uses line:column pointers for text bodies and marks :unique', () => {
    const fixture = found(engine.atlas.fixture(fixtureId('/v1/text'), version));
    expect(fixture.tokens.map(({ pointer, expression, unique }) => ({ pointer, expression, unique }))).toEqual([
      { pointer: '2:1', expression: 'now', unique: false },
      { pointer: '2:10', expression: 'uuid:unique', unique: true },
    ]);
  });

  it('reports a fixture without tokens as static', () => {
    const fixture = found(engine.atlas.fixture(fixtureId('/v1/static'), version));
    expect(fixture.dynamic).toBe(false);
    expect(fixture.tokens).toEqual([]);
  });
});

describe('rendered previews', () => {
  it('renders against the given instant and parameters, like a real request', async () => {
    const preview = found(
      engine.atlas.renderedFixture(productId, version, { now: '2026-01-01T00:00:00Z', params: { productId: 'p-42' } }),
    );
    const response = await engine.resolve({
      method: 'GET',
      target: '/v1/products/p-42',
      headers: { 'x-mock-now': ['2026-01-01T00:00:00Z'] },
    });
    const body = new TextDecoder().decode(response.body ?? new Uint8Array());
    expect(preview.rendered).toMatchObject({
      preview: { state: 'available', encoding: 'utf8', value: body },
      instant: '2026-01-01T00:00:00Z',
      clockSource: 'caller',
      seed: 42,
      nondeterministic: false,
      unresolved: ['header.x-trace'],
      error: null,
    });
    expect(preview.rendered.headers).toContainEqual({
      name: 'set-cookie',
      value: expect.stringMatching(/^s=[0-9a-f-]{36}$/) as string,
      treatment: 'replayed',
    });
    expect(preview.rendered.headers).toContainEqual({
      name: 'x-trace',
      value: '',
      treatment: 'replayed',
    });
    const spans = preview.rendered.spans.map((span) => body.slice(span.start, span.end));
    // A whole-value token's span covers its JSON value, quotes included.
    expect(spans[0]).toBe('"p-42"');
    expect(spans[1]).toBe('2026-01-02');
    expect(Number(spans[2])).toBeGreaterThan(0);
  });

  it('uses the server instant without "now", and lists missing parameters as unresolved', () => {
    const preview = found(engine.atlas.renderedFixture(productId, version, {}));
    expect(preview.rendered).toMatchObject({
      instant: '2030-01-01T00:00:00Z',
      clockSource: 'wall-clock',
      nondeterministic: true,
      unresolved: ['path.productId', 'header.x-trace'],
    });
  });

  it('marks :unique previews nondeterministic', () => {
    const preview = found(
      engine.atlas.renderedFixture(fixtureId('/v1/text'), version, { now: '2026-01-01T00:00:00Z' }),
    );
    expect(preview.rendered.nondeterministic).toBe(true);
  });

  it('returns a static fixture unchanged', () => {
    const preview = found(engine.atlas.renderedFixture(fixtureId('/v1/static'), version, {}));
    expect(preview.rendered).toMatchObject({ preview: { value: 'static' }, instant: null, clockSource: null });
  });

  it('reports a render failure instead of a preview', () => {
    const noClock = engineFor();
    const preview = found(noClock.atlas.renderedFixture(productId, noClock.atlas.health().snapshotVersion, {}));
    expect(preview.rendered.preview).toEqual({ state: 'unavailable', reason: 'render-failed' });
    expect(preview.rendered.error).toContain('no clock');
  });

  it.each([
    [{ now: 'tomorrow' }, '"now" must be an RFC 3339 instant'],
    [{ params: { id: 'x' } }, '"param.id" is not a parameter of /v1/products/{productId}'],
  ])('rejects %j', (input, message) => {
    const result = engine.atlas.renderedFixture(productId, version, input);
    expect(result).toEqual({ kind: 'bad-input', message: expect.stringContaining(message) as unknown });
  });

  it('checks the ID and snapshot first', () => {
    expect(engine.atlas.renderedFixture('fx_0000000000000000', version, {}).kind).toBe('not-found');
    expect(engine.atlas.renderedFixture(productId, '0000000000000000', {}).kind).toBe('stale');
    expect(engine.atlas.renderedFixture('nope', version, {}).kind).toBe('invalid');
  });
});

describe('the clock resource', () => {
  it('reports a request header, frozen', () => {
    expect(found(engine.atlas.clock({ 'x-mock-now': ['2026-01-01T09:00:00+09:00'] }))).toEqual({
      now: '2026-01-01T00:00:00Z',
      mode: 'frozen',
      source: 'request-header',
      session: null,
      timezone: 'UTC',
      seed: 42,
      seedSource: 'config',
      serverDefault: { now: null, mode: 'live' },
    });
  });

  it('reports the live wall clock, or null without one', () => {
    expect(found(engine.atlas.clock({}))).toMatchObject({
      now: '2030-01-01T00:00:00Z',
      mode: 'live',
      source: 'wall-clock',
    });
    expect(found(engineFor().atlas.clock({}))).toMatchObject({
      now: null,
      mode: 'live',
      source: 'wall-clock',
      seed: 0,
    });
  });

  it('reports the server default and its mode', () => {
    const offset = engineFor({
      clock: () => WALL,
      seedSource: 'generated',
      config: { now: Date.UTC(2026, 0, 1), clockMode: 'offset', timezone: 'Europe/Paris', seed: 7 },
    });
    expect(found(offset.atlas.clock({}))).toEqual({
      now: '2026-01-01T00:00:00Z',
      mode: 'offset',
      source: 'server-default',
      session: null,
      timezone: 'Europe/Paris',
      seed: 7,
      seedSource: 'generated',
      serverDefault: { now: '2026-01-01T00:00:00Z', mode: 'offset' },
    });
  });

  it('rejects an invalid X-Mock-Now', () => {
    expect(engine.atlas.clock({ 'x-mock-now': ['soon'] })).toEqual({
      kind: 'bad-input',
      message: expect.stringContaining('X-Mock-Now') as unknown,
    });
  });
});
