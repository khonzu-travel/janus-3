import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import { createEngine } from '../create-engine.js';
import { buildSnapshot } from '../fixtures/build.js';
import type { Engine } from '../types/index.js';
import { endpointId, fixtureId } from '../ids.js';
import { PREVIEW_LIMIT, previewBody } from './atlas.js';
import type { AtlasEndpoint, AtlasFixture, AtlasLookup } from './types.js';

const TOKEN = 'example-token-4b1d';

type Tree = Readonly<Record<string, string | Uint8Array>>;

function engineFor(tree: Tree, order: 'forward' | 'reverse' = 'forward'): Engine {
  const entries = Object.entries(tree).map(
    ([path, value]) => [path, typeof value === 'string' ? utf8Encode(value) : value] as const,
  );
  if (order === 'reverse') entries.reverse();
  const built = buildSnapshot(new Map(entries));
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return createEngine({ snapshot: built.snapshot });
}

const TREE: Tree = {
  'default/v1-beta/GET/200_{text-plain}.txt': 'beta',
  'default/v1/a/GET/200_{text-plain}.txt': 'a',
  'default/v1/GET/200_{application-json}.json': '{"v":1}',
  'default/v1/POST/201_{application-json}.json': '{"id":"p-2"}',
  'default/v1/POST/201.headers.json': JSON.stringify({
    Location: '/v1/p-2',
    'Set-Cookie': [`session=${TOKEN}`, 'theme=dark'],
    Authorization: `Bearer ${TOKEN}`,
    'WWW-Authenticate': `Basic realm="${TOKEN}"`,
  }),
  'default/v1/p-1/DELETE/204': '',
  'default/v1/greeting/GET/200_[fr]_{text-plain}.txt': 'Bonjour',
  'default/v1/greeting/GET/200_[en-US]_{text-plain}.txt': 'Hello',
  'default/v1/greeting/GET/200_{text-plain}.txt': 'Hi',
  'default/v1/binary/GET/200_{application-octet-stream}.bin': new Uint8Array([0, 1, 2, 253, 254, 255]),
  // JavaScript is shown as text when it is UTF-8 but, as a binary body kind, need not be.
  'default/v1/latin1/GET/200_{application-javascript}.js': new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
  'default/v1/empty/GET/200_{text-plain}.txt': '',
  'default/v1/caf%C3%A9/GET/200_{text-plain}.txt': 'unicode',
};

const engine = engineFor(TREE);
const { atlas } = engine;
const version = atlas.health().snapshotVersion;

function found<T>(lookup: AtlasLookup<T>): T {
  if (lookup.kind !== 'found') throw new Error(`expected found, got ${lookup.kind}`);
  return lookup.value;
}

function endpointAt(path: string, method = 'GET', target: Engine = engine): AtlasEndpoint {
  const item = target.atlas.inventory().items.find((entry) => entry.path === path && entry.method === method);
  if (item === undefined) throw new Error(`no ${method} ${path}`);
  return found(target.atlas.endpoint(item.id, target.atlas.health().snapshotVersion));
}

function fixtureAt(path: string, method = 'GET', locale: string | null = null, target: Engine = engine): AtlasFixture {
  const summary = endpointAt(path, method, target).fixtures.find((entry) => entry.locale === locale);
  if (summary === undefined) throw new Error(`no ${locale ?? 'neutral'} fixture for ${method} ${path}`);
  return found(target.atlas.fixture(summary.id, target.atlas.health().snapshotVersion));
}

describe('engine.atlas', () => {
  it('reports health with the same version resolve serves', async () => {
    const response = await engine.resolve({ method: 'GET', target: '/v1', headers: {} });
    expect(atlas.health()).toEqual({
      status: 'ready',
      snapshotVersion: response.trace.snapshotVersion,
      fixtureCount: 10,
      routeCount: 9,
      configDigest: expect.stringMatching(/^cfg_[0-9a-f]{16}$/) as unknown,
      warnings: [],
      configuredDefaultScenario: 'default',
      scenarioCount: 1,
      idempotency: true,
      transport: {
        faults: { enabled: true, timeoutMs: 120000, maxHeldConnections: 128 },
        compression: { enabled: true, encodings: ['br', 'gzip', 'deflate'] },
        codecs: { xml: true },
        autoOptions: true,
        fixtureOrigins: 0,
      },
    });
    expect(atlas.inventory().snapshotVersion).toBe(version);
    expect(atlas.inventory().items).toHaveLength(atlas.health().fixtureCount);
  });

  it('orders endpoints by path segment by segment, then method', () => {
    expect(atlas.inventory().items.map((item) => `${item.method} ${item.path}`)).toEqual([
      'GET /v1',
      'POST /v1',
      'GET /v1/a',
      'GET /v1/binary',
      'GET /v1/caf%C3%A9',
      'GET /v1/empty',
      'GET /v1/greeting',
      'GET /v1/latin1',
      'DELETE /v1/p-1',
      'GET /v1-beta',
    ]);
    expect(atlas.inventory().items.every((item) => item.scenario === 'default')).toBe(true);
  });

  it('lists the neutral representation first, then locales by lower-cased tag', () => {
    const greeting = endpointAt('/v1/greeting');
    expect(greeting.fixtures.map((fixture) => fixture.locale)).toEqual([null, 'en-US', 'fr']);
    expect(greeting.fixtures.map((fixture) => fixture.mediaType)).toEqual(['text/plain', 'text/plain', 'text/plain']);
    expect(greeting.fixtures.map((fixture) => fixture.byteLength)).toEqual([2, 5, 7]);
  });

  it('builds IDs from logical identity, independent of enumeration order and content', () => {
    const reordered = engineFor(TREE, 'reverse');
    expect(reordered.atlas.inventory().items).toEqual(atlas.inventory().items);

    const edited = engineFor({ ...TREE, 'default/v1/GET/200_{application-json}.json': '{"v":2}' });
    expect(edited.atlas.health().snapshotVersion).not.toBe(version);
    expect(edited.atlas.inventory().items).toEqual(atlas.inventory().items);
    expect(endpointAt('/v1/greeting', 'GET', edited).fixtures.map((fixture) => fixture.id)).toEqual(
      endpointAt('/v1/greeting').fixtures.map((fixture) => fixture.id),
    );

    const ids = atlas.inventory().items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^ep_[0-9a-f]{16}$/);
    for (const fixture of endpointAt('/v1/greeting').fixtures) expect(fixture.id).toMatch(/^fx_[0-9a-f]{16}$/);
  });

  it('changes IDs when the path, method, scenario, or locale changes', () => {
    const base = endpointId('default', 'GET', ['v1', 'a']);
    expect(endpointId('default', 'GET', ['v1', 'b'])).not.toBe(base);
    expect(endpointId('default', 'POST', ['v1', 'a'])).not.toBe(base);
    expect(endpointId('staging', 'GET', ['v1', 'a'])).not.toBe(base);
    expect(endpointId('default', 'GET', ['v1/a'])).not.toBe(base);
    expect(endpointId('default', 'GET', ['v1', '{id}'])).not.toBe(endpointId('default', 'GET', ['v1', '{key}']));
    const json = 'application/json';
    expect(fixtureId(base, 'fr', json)).not.toBe(fixtureId(base, null, json));
    expect(fixtureId(base, 'FR', json)).toBe(fixtureId(base, 'fr', json));
    expect(fixtureId(base, null, json)).not.toBe(fixtureId(endpointId('default', 'GET', ['v1', 'b']), null, json));
    expect(fixtureId(base, null, json)).not.toBe(fixtureId(base, null, 'application/yaml'));
    expect(fixtureId(base, null, 'Application/JSON')).toBe(fixtureId(base, null, json));
    expect(fixtureId(base, null, null)).not.toBe(fixtureId(base, null, json));
  });

  it('projects status, media type, locale, byte length, and headers', () => {
    const french = fixtureAt('/v1/greeting', 'GET', 'fr');
    expect(french).toMatchObject({
      snapshotVersion: version,
      endpointId: endpointAt('/v1/greeting').id,
      scenario: 'default',
      method: 'GET',
      path: '/v1/greeting',
      status: 200,
      mediaType: 'text/plain',
      wireContentType: 'text/plain',
      locale: 'fr',
      byteLength: 7,
      headers: [
        { name: 'content-language', value: 'fr', treatment: 'replayed' },
        { name: 'content-type', value: 'text/plain', treatment: 'replayed' },
        { name: 'vary', value: 'Accept, Accept-Language', treatment: 'replayed' },
      ],
    });
  });

  it('shows every header value as served, credentials included', () => {
    const created = fixtureAt('/v1', 'POST');
    expect(created.headers).toEqual([
      { name: 'authorization', value: `Bearer ${TOKEN}`, treatment: 'replayed' },
      { name: 'content-type', value: 'application/json', treatment: 'replayed' },
      { name: 'location', value: '/v1/p-2', treatment: 'replayed' },
      { name: 'set-cookie', value: `session=${TOKEN}`, treatment: 'replayed' },
      { name: 'set-cookie', value: 'theme=dark', treatment: 'replayed' },
      { name: 'vary', value: 'Accept', treatment: 'replayed' },
      { name: 'www-authenticate', value: `Basic realm="${TOKEN}"`, treatment: 'replayed' },
    ]);
    expect(endpointAt('/v1', 'POST').fixtures[0]?.headers).toEqual(created.headers);
  });

  it('discloses no fixture paths anywhere', () => {
    const everything: unknown[] = [atlas.health(), atlas.config(), atlas.inventory()];
    for (const item of atlas.inventory().items) {
      const endpoint = found(atlas.endpoint(item.id, version));
      everything.push(endpoint);
      for (const fixture of endpoint.fixtures) everything.push(found(atlas.fixture(fixture.id, version)));
    }
    const serialized = JSON.stringify(everything);
    expect(serialized).not.toContain('default/');
    expect(serialized).not.toContain('.txt');
    expect(serialized).not.toContain('headers.json');
  });

  describe('previews', () => {
    it('shows JSON and text bodies as UTF-8', () => {
      expect(fixtureAt('/v1').preview).toEqual({
        state: 'available',
        encoding: 'utf8',
        value: '{"v":1}',
        byteLength: 7,
        truncated: false,
      });
      expect(fixtureAt('/v1/caf%C3%A9').preview).toMatchObject({ encoding: 'utf8', value: 'unicode' });
    });

    it('uses base64 for binary media types and invalid UTF-8 text', () => {
      expect(fixtureAt('/v1/binary').preview).toEqual({
        state: 'available',
        encoding: 'base64',
        value: 'AAEC/f7/',
        byteLength: 6,
        truncated: false,
      });
      expect(fixtureAt('/v1/latin1').preview).toEqual({
        state: 'available',
        encoding: 'base64',
        value: 'Y2Fm6Q==',
        byteLength: 4,
        truncated: false,
      });
    });

    it('distinguishes an empty body from a bodyless response', () => {
      expect(fixtureAt('/v1/empty').preview).toEqual({
        state: 'available',
        encoding: 'utf8',
        value: '',
        byteLength: 0,
        truncated: false,
      });
      const deleted = fixtureAt('/v1/p-1', 'DELETE');
      expect(deleted.preview).toEqual({ state: 'unavailable', reason: 'bodyless' });
      expect(deleted).toMatchObject({ status: 204, mediaType: null, byteLength: 0, headers: [] });
    });

    it('truncates UTF-8 at 64 KiB on a character boundary', () => {
      // 65,535 ASCII bytes then "é" (2 bytes) straddles the limit.
      const text = 'a'.repeat(PREVIEW_LIMIT - 1) + 'é' + 'tail';
      const big = engineFor({ 'default/GET/200_{text-plain}.txt': text });
      const preview = fixtureAt('/', 'GET', null, big).preview;
      expect(preview).toMatchObject({ encoding: 'utf8', truncated: true, byteLength: PREVIEW_LIMIT + 5 });
      expect(preview.state === 'available' && preview.value).toBe('a'.repeat(PREVIEW_LIMIT - 1));
    });

    it('truncates base64 previews at 64 KiB of the original bytes', () => {
      const bytes = new Uint8Array(PREVIEW_LIMIT + 10).fill(0xff);
      const big = engineFor({ 'default/GET/200_{application-octet-stream}.bin': bytes });
      const preview = fixtureAt('/', 'GET', null, big).preview;
      expect(preview).toMatchObject({ encoding: 'base64', truncated: true, byteLength: PREVIEW_LIMIT + 10 });
      const value = preview.state === 'available' ? preview.value : '';
      expect(atob(value)).toHaveLength(PREVIEW_LIMIT);
    });

    it('cuts text at a given limit and keeps base64 at 64 KiB', () => {
      const text = new TextEncoder().encode('y'.repeat(PREVIEW_LIMIT * 2));
      expect(previewBody(text, 'text/plain', Number.POSITIVE_INFINITY)).toMatchObject({
        encoding: 'utf8',
        truncated: false,
        byteLength: PREVIEW_LIMIT * 2,
      });
      expect(previewBody(text, 'text/plain', 10)).toMatchObject({ value: 'y'.repeat(10), truncated: true });
      const bytes = new Uint8Array(PREVIEW_LIMIT + 1).fill(0xff);
      expect(previewBody(bytes, 'image/png', Number.POSITIVE_INFINITY)).toMatchObject({ truncated: true });
    });

    it('keeps a body of exactly 64 KiB whole', () => {
      const big = engineFor({ 'default/GET/200_{text-plain}.txt': 'x'.repeat(PREVIEW_LIMIT) });
      expect(fixtureAt('/', 'GET', null, big).preview).toMatchObject({ truncated: false, byteLength: PREVIEW_LIMIT });
    });
  });

  describe('lookups', () => {
    const endpoint = endpointAt('/v1');
    const fixture = endpoint.fixtures[0]?.id ?? '';
    const other = version === '0000000000000000' ? '1111111111111111' : '0000000000000000';

    it('rejects malformed IDs and versions first', () => {
      for (const [id, at] of [
        ['ep_123', version],
        [fixture, version],
        [endpoint.id.toUpperCase(), version],
        [endpoint.id, ''],
        [endpoint.id, version.toUpperCase()],
        ['ep_zzzzzzzzzzzzzzzz', other],
      ] as const) {
        expect(atlas.endpoint(id, at), `${id} ${at}`).toEqual({ kind: 'invalid' });
      }
      expect(atlas.fixture(endpoint.id, version)).toEqual({ kind: 'invalid' });
    });

    it('reports a stale version before looking up the ID', () => {
      expect(atlas.endpoint(endpoint.id, other)).toEqual({ kind: 'stale' });
      expect(atlas.endpoint('ep_0000000000000000', other)).toEqual({ kind: 'stale' });
      expect(atlas.fixture(fixture, other)).toEqual({ kind: 'stale' });
    });

    it('reports unknown IDs in the current snapshot as not found', () => {
      expect(atlas.endpoint('ep_0000000000000000', version)).toEqual({ kind: 'not-found' });
      expect(atlas.fixture('fx_0000000000000000', version)).toEqual({ kind: 'not-found' });
    });
  });

  it('returns deeply frozen projections', () => {
    const fixture = fixtureAt('/v1', 'POST');
    for (const value of [
      atlas,
      atlas.health(),
      atlas.inventory(),
      atlas.inventory().items,
      atlas.inventory().items[0],
      endpointAt('/v1', 'POST'),
      endpointAt('/v1', 'POST').fixtures,
      fixture,
      fixture.headers,
      fixture.headers[0],
      fixture.preview,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => {
      (atlas.inventory().items as unknown[]).push({});
    }).toThrow(TypeError);
  });
});

describe('engine.atlas configuration', () => {
  const built = buildSnapshot(new Map([['default/GET/204', new Uint8Array()]]));
  if (!built.ok) throw new Error('invalid');

  it('describes the defaults when the engine has no configuration', () => {
    const config = createEngine({ snapshot: built.snapshot }).atlas.config();
    expect(config).toEqual({
      configDigest: expect.stringMatching(/^cfg_[0-9a-f]{16}$/) as unknown,
      configFile: false,
      settings: [
        { key: 'atlas.resolve', value: true, source: 'default' },
        { key: 'codecs.xml', value: true, source: 'default' },
        { key: 'compression.enabled', value: true, source: 'default' },
        { key: 'compression.encodings', value: ['br', 'gzip', 'deflate'], source: 'default' },
        { key: 'compression.minBytes', value: 1024, source: 'default' },
        { key: 'cors.fixtures.credentials', value: false, source: 'default' },
        { key: 'cors.fixtures.maxAge', value: 600, source: 'default' },
        { key: 'cors.fixtures.origins', value: [], source: 'default' },
        { key: 'cors.maxAge', value: 600, source: 'default' },
        { key: 'cors.origins', value: [], source: 'default' },
        { key: 'diagnostics.headers', value: true, source: 'default' },
        { key: 'dynamic.aliases', value: {}, source: 'default' },
        { key: 'dynamic.clockMode', value: 'frozen', source: 'default' },
        { key: 'dynamic.now', value: null, source: 'default' },
        { key: 'dynamic.seed', value: null, source: 'default' },
        { key: 'dynamic.strictRefs', value: false, source: 'default' },
        { key: 'dynamic.timezone', value: 'UTC', source: 'default' },
        { key: 'faults.enabled', value: true, source: 'default' },
        { key: 'faults.latency', value: null, source: 'default' },
        { key: 'faults.maxHeldConnections', value: 128, source: 'default' },
        { key: 'faults.timeoutMs', value: 120000, source: 'default' },
        { key: 'fixtures.watch', value: false, source: 'default' },
        { key: 'idempotency.enabled', value: true, source: 'default' },
        { key: 'idempotency.header', value: 'Idempotency-Key', source: 'default' },
        { key: 'idempotency.maxEntries', value: 1000, source: 'default' },
        { key: 'idempotency.methods', value: ['POST', 'PATCH'], source: 'default' },
        { key: 'limits.maxBodyBytes', value: 1048576, source: 'default' },
        { key: 'limits.maxDecodedBodyBytes', value: 4194304, source: 'default' },
        { key: 'limits.maxHeaderBytes', value: 16384, source: 'default' },
        { key: 'limits.maxUrlBytes', value: 8192, source: 'default' },
        { key: 'negotiation.mediaTypePreference', value: [], source: 'default' },
        { key: 'negotiation.onUnacceptable', value: 406, source: 'default' },
        { key: 'negotiation.onUnusableAccept', value: 400, source: 'default' },
        { key: 'onNoFixture', value: 404, source: 'default' },
        { key: 'onUnknownMethod', value: 405, source: 'default' },
        { key: 'promotion.mode', value: 'staged', source: 'default' },
        { key: 'recording.allowNonLoopback', value: false, source: 'default' },
        { key: 'recording.captures', value: 'set', source: 'default' },
        { key: 'recording.endpoints', value: [], source: 'default' },
        { key: 'recording.maxConcurrent', value: 4, source: 'default' },
        { key: 'recording.maxResponseBytes', value: 10485760, source: 'default' },
        { key: 'recording.timeoutMs', value: 30000, source: 'default' },
        { key: 'runner.allowNonLoopback', value: false, source: 'default' },
        { key: 'runner.extraCaCerts', value: [], source: 'default' },
        { key: 'runner.keepRuns', value: 50, source: 'default' },
        { key: 'runner.maxActiveRuns', value: 2, source: 'default' },
        { key: 'runner.maxImportBytes', value: 52428800, source: 'default' },
        { key: 'runner.root', value: 'set', source: 'default' },
        { key: 'runner.scriptMemoryBytes', value: 33554432, source: 'default' },
        { key: 'runner.scriptTimeoutMs', value: 1000, source: 'default' },
        { key: 'runner.skipTlsVerify', value: false, source: 'default' },
        { key: 'scenarios.default', value: 'default', source: 'default' },
        { key: 'server.autoOptions', value: true, source: 'default' },
        { key: 'server.strictTrailingSlash', value: true, source: 'default' },
        { key: 'sessions.idleTimeout', value: 1800, source: 'default' },
        { key: 'sessions.keyFrom', value: [], source: 'default' },
        { key: 'sessions.max', value: 1000, source: 'default' },
        { key: 'ui.enabled', value: true, source: 'default' },
      ],
    });
    expect(Object.isFrozen(config.settings[0])).toBe(true);
  });

  it('digests a non-default engine configuration differently', () => {
    const plain = createEngine({ snapshot: built.snapshot }).atlas.health().configDigest;
    const custom = createEngine({
      snapshot: built.snapshot,
      config: { strictTrailingSlash: true, onUnknownMethod: 404 },
    });
    expect(custom.atlas.health().configDigest).not.toBe(plain);
    for (const config of [
      { mediaTypePreference: ['application/yaml'] },
      { onUnusableAccept: 'any' as const },
      { onUnacceptable: 'ignore' as const },
      { diagnosticHeaders: false },
    ]) {
      const engine = createEngine({ snapshot: built.snapshot, config });
      expect(engine.atlas.health().configDigest).not.toBe(plain);
      expect(engine.atlas.config().settings.filter((setting) => setting.source === 'file')).toHaveLength(1);
    }
  });

  it('publishes diagnostics without locations, paths, or private settings', () => {
    const engine = createEngine({
      snapshot: built.snapshot,
      diagnostics: {
        configDigest: 'cfg_0123456789abcdef',
        configFile: true,
        settings: [
          { key: 'server.port', value: 4020, source: 'file' },
          { key: 'fixtures.root', value: '/secret/data', source: 'cli' },
          { key: 'onUnknownMethod', value: 404, source: 'file' },
        ],
        warnings: [
          {
            code: 'redundant-content-type',
            source: 'fixtures',
            path: 'default/v1/GET/200.headers.json',
            line: 3,
            column: 3,
            message: 'repeats the media type',
          },
        ],
      },
    });
    expect(engine.atlas.health()).toMatchObject({
      configDigest: 'cfg_0123456789abcdef',
      warnings: [{ code: 'redundant-content-type', source: 'fixtures', message: 'repeats the media type' }],
    });
    expect(engine.atlas.config()).toEqual({
      configDigest: 'cfg_0123456789abcdef',
      configFile: true,
      settings: [{ key: 'onUnknownMethod', value: 404, source: 'file' }],
    });
    const serialized = JSON.stringify([engine.atlas.health(), engine.atlas.config()]);
    expect(serialized).not.toContain('default/');
    expect(serialized).not.toContain('/secret/data');
    expect(serialized).not.toContain('"line"');
  });
});
