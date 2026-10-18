import { buildSnapshot, createEngine, type Engine, type FixtureSnapshot } from '@janus/core';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHttpAdapter, REQUEST_ID_HEADER, type RequestRecord } from './adapter.js';

// Contract tests for the reserved Atlas routes.

const SECRET = 'not-a-real-secret-7c2e';
const TOKEN = 'example-token-7c2e';

function snapshotOf(entries: Readonly<Record<string, string | Uint8Array>>): FixtureSnapshot {
  const built = buildSnapshot(
    new Map(
      Object.entries(entries).map(([key, value]) => [
        key,
        typeof value === 'string' ? new TextEncoder().encode(value) : value,
      ]),
    ),
  );
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return built.snapshot;
}

const TREE = {
  'default/v1/products/GET/200_{application-json}.json': '[{"id":"p-1"}]',
  'default/v1/products/GET/200.headers.json': JSON.stringify({
    'Set-Cookie': `session=${TOKEN}`,
    Authorization: `Bearer ${TOKEN}`,
    'X-Example': 'fixture',
  }),
  'default/v1/products/p-1/DELETE/204': '',
  'default/v1/greeting/GET/200_[fr]_{text-plain}.txt': 'Bonjour',
  'default/v1/greeting/GET/200_{text-plain}.txt': 'Hi',
  'default/v1/logo/GET/200_{image-png}.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
};
const snapshot = snapshotOf(TREE);
const version = snapshot.version;

let app: FastifyInstance;
const records: RequestRecord[] = [];
const failures: unknown[] = [];

function start(engine: Engine = createEngine({ snapshot })): FastifyInstance {
  records.length = 0;
  failures.length = 0;
  app = createHttpAdapter({
    engine,
    onRequestComplete: (record) => records.push(record),
    onInternalError: (_id, error) => failures.push(error),
  });
  return app;
}

beforeEach(() => {
  start();
});

afterEach(async () => {
  await app.close();
});

async function get(url: string, method = 'GET'): Promise<LightMyRequestResponse> {
  return app.inject({ method: method as 'GET', url });
}

async function json(url: string): Promise<Record<string, unknown>> {
  const response = await get(url);
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

interface Item {
  readonly id: string;
  readonly path: string;
  readonly method: string;
  readonly detailHref: string;
}

async function inventoryItem(path: string, method = 'GET'): Promise<Item> {
  const items = (await json('/_janus/endpoints'))['items'] as Item[];
  const item = items.find((entry) => entry.path === path && entry.method === method);
  if (item === undefined) throw new Error(`no ${method} ${path}`);
  return item;
}

/** Resolves a relative link against the Atlas root, as the UI does. */
function follow(href: string): string {
  const url = new URL(href, 'http://janus.test/_janus/');
  return url.pathname + url.search;
}

function expectAtlasHeaders(response: LightMyRequestResponse): void {
  expect(response.headers['content-type']).toBe('application/json');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['access-control-allow-origin']).toBeUndefined();
  expect(response.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
}

describe('Atlas routes', () => {
  it('serves the complete inventory with relative detail links', async () => {
    const response = await get('/_janus/endpoints');
    expectAtlasHeaders(response);
    const body = response.json<{ items: Item[] }>();
    expect(body).toEqual({
      apiVersion: 'atlas.v1',
      snapshotVersion: version,
      scenario: 'default',
      items: [
        expect.objectContaining({ method: 'GET', path: '/v1/greeting' }),
        expect.objectContaining({ method: 'GET', path: '/v1/logo' }),
        expect.objectContaining({ method: 'GET', path: '/v1/products' }),
        expect.objectContaining({ method: 'DELETE', path: '/v1/products/p-1' }),
      ],
    });
    expect(body.items).toHaveLength(snapshot.fixtureCount);
    for (const item of body.items) {
      expect(Object.keys(item)).toEqual(['id', 'scenario', 'method', 'path', 'pathParameters', 'origin', 'detailHref']);
      expect(item.detailHref).toBe(`endpoints/${item.id}?at=${version}`);
    }
  });

  it('serves an empty inventory as a success', async () => {
    const empty = snapshotOf({ 'default/.gitkeep': '' });
    start(createEngine({ snapshot: empty }));
    expect(await json('/_janus/endpoints')).toEqual({
      apiVersion: 'atlas.v1',
      snapshotVersion: empty.version,
      scenario: 'default',
      items: [],
    });
    expect(await json('/_janus/health')).toMatchObject({ fixtureCount: 0, routeCount: 0 });
  });

  it('serves endpoint detail with fixture summaries and their headers', async () => {
    const item = await inventoryItem('/v1/products');
    const response = await get(follow(item.detailHref));
    expectAtlasHeaders(response);
    const body = response.json<{ fixtures: { id: string }[] }>();
    const fixtureId = body.fixtures[0]?.id ?? '';
    const summary = {
      id: fixtureId,
      status: 200,
      variant: null,
      identity: '200',
      mediaType: 'application/json',
      wireContentType: 'application/json',
      locale: null,
      byteLength: 14,
      headers: [
        { name: 'authorization', value: `Bearer ${TOKEN}`, treatment: 'replayed' },
        { name: 'content-type', value: 'application/json', treatment: 'replayed' },
        { name: 'set-cookie', value: `session=${TOKEN}`, treatment: 'replayed' },
        { name: 'vary', value: 'Accept', treatment: 'replayed' },
        { name: 'x-example', value: 'fixture', treatment: 'replayed' },
      ],
      scenario: 'default',
      origin: 'own',
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown,
      provenance: null,
      sidecar: { digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown, provenance: null },
      detailHref: `fixtures/${fixtureId}?at=${version}`,
    };
    expect(body).toEqual({
      apiVersion: 'atlas.v1',
      snapshotVersion: version,
      id: item.id,
      scenario: 'default',
      method: 'GET',
      path: '/v1/products',
      pathParameters: [],
      origin: 'own',
      fixtures: [summary],
      representationGroups: [{ status: 200, variant: null, locale: null, representations: [summary] }],
      accepts: null,
      controls: { rules: null, pages: null, sequence: null, expect: null, idempotent: false },
      matrix: {
        identities: [{ identity: '200', status: 200, variant: null }],
        rows: [
          {
            scenario: 'default',
            endpointId: item.id,
            detailHref: `endpoints/${item.id}?at=${version}`,
            cells: [
              {
                representations: [
                  {
                    fixtureId,
                    locale: null,
                    mediaType: 'application/json',
                    origin: 'own',
                    scenario: 'default',
                    detailHref: `fixtures/${fixtureId}?at=${version}`,
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it('serves fixture detail with a preview', async () => {
    const endpoint = await json(follow((await inventoryItem('/v1/greeting')).detailHref));
    const [neutral, french] = endpoint['fixtures'] as { id: string; locale: string | null; detailHref: string }[];
    expect([neutral?.locale, french?.locale]).toEqual([null, 'fr']);
    expect(await json(follow(french?.detailHref ?? ''))).toEqual({
      apiVersion: 'atlas.v1',
      snapshotVersion: version,
      id: french?.id,
      status: 200,
      variant: null,
      identity: '200',
      mediaType: 'text/plain',
      wireContentType: 'text/plain',
      locale: 'fr',
      byteLength: 7,
      headers: [
        { name: 'content-language', value: 'fr', treatment: 'replayed' },
        { name: 'content-type', value: 'text/plain', treatment: 'replayed' },
        { name: 'vary', value: 'Accept, Accept-Language', treatment: 'replayed' },
      ],
      scenario: 'default',
      origin: 'own',
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown,
      provenance: null,
      sidecar: null,
      endpointId: endpoint['id'],
      method: 'GET',
      path: '/v1/greeting',
      pathParameters: [],
      preview: { state: 'available', encoding: 'utf8', value: 'Bonjour', byteLength: 7, truncated: false },
      dynamic: false,
      tokens: [],
    });
  });

  it('serves binary and bodyless previews', async () => {
    const firstFixture = async (path: string, method = 'GET'): Promise<Record<string, unknown>> => {
      const endpoint = await json(follow((await inventoryItem(path, method)).detailHref));
      const [fixture] = endpoint['fixtures'] as { detailHref: string }[];
      return json(follow(fixture?.detailHref ?? ''));
    };
    expect((await firstFixture('/v1/logo'))['preview']).toEqual({
      state: 'available',
      encoding: 'base64',
      value: 'iVBORw==',
      byteLength: 4,
      truncated: false,
    });
    expect(await firstFixture('/v1/products/p-1', 'DELETE')).toMatchObject({
      status: 204,
      mediaType: null,
      byteLength: 0,
      preview: { state: 'unavailable', reason: 'bodyless' },
    });
  });

  it('matches percent-encoded spellings of the prefix and resources', async () => {
    expect((await json('/_janus/%68ealth'))['status']).toBe('ready');
    expect((await json('/%5Fjanus/endpoints'))['snapshotVersion']).toBe(version);
    expect((await json('/_j%61nus/health'))['snapshotVersion']).toBe(version);
  });

  describe('HEAD', () => {
    it.each(['/_janus/health', '/_janus/endpoints'])(
      'has the GET status and headers without a body: %s',
      async (url) => {
        const getResponse = await get(url);
        const head = await get(url, 'HEAD');
        expect(head.statusCode).toBe(200);
        expect(head.body).toBe('');
        expect(head.headers['content-type']).toBe(getResponse.headers['content-type']);
        expect(head.headers['cache-control']).toBe('no-store');
        // Review A10: HEAD states the length GET would send.
        expect(head.headers['content-length']).toBe(getResponse.headers['content-length']);
      },
    );

    it('applies to detail resources and their errors', async () => {
      const item = await inventoryItem('/v1/products');
      const head = await get(follow(item.detailHref), 'HEAD');
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      expect(head.headers['content-length']).toBe((await get(follow(item.detailHref))).headers['content-length']);
      const stale = await get(`/_janus/endpoints/${item.id}?at=0000000000000000`, 'HEAD');
      expect(stale.statusCode).toBe(409);
      expect(stale.body).toBe('');
      expect(Number(stale.headers['content-length'])).toBeGreaterThan(0);
    });
  });

  describe('methods', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'PURGE'])(
      'rejects %s with 405, Allow: GET, HEAD, and no CORS headers',
      async (method) => {
        for (const url of ['/_janus/health', '/_janus/endpoints', '/_janus/endpoints/ep_0000000000000000']) {
          const response = await get(url, method);
          expect(response.statusCode, `${method} ${url}`).toBe(405);
          expectAtlasHeaders(response);
          expect(response.headers['allow']).toBe('GET, HEAD');
          expect(response.headers['access-control-allow-methods']).toBeUndefined();
          expect(response.json()).toMatchObject({ error: { code: 'method-not-allowed' } });
        }
      },
    );

    it('never mutates state', async () => {
      const before = await json('/_janus/endpoints');
      await get('/_janus/endpoints', 'POST');
      await get('/_janus/endpoints', 'DELETE');
      expect(await json('/_janus/endpoints')).toEqual(before);
    });
  });

  describe('unknown paths', () => {
    it.each([
      '/_janus',
      '/_janus/',
      '/_janus/unknown',
      '/_janus/fixtures',
      '/_janus/health/extra',
      '/_janus/endpoints/ep_0000000000000000/extra',
    ])('keeps the 404 route-not-found for %s', async (url) => {
      const response = await get(url);
      expect(response.statusCode).toBe(404);
      expectAtlasHeaders(response);
      expect(response.json()).toEqual({
        error: {
          code: 'route-not-found',
          message: expect.stringMatching(/^No fixture matches GET \/_janus/) as unknown,
          requestId: response.headers[REQUEST_ID_HEADER],
        },
      });
    });

    it('answers 404 for any method, never resolving a fixture', async () => {
      const response = await get('/_janus/unknown', 'POST');
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'route-not-found' } });
    });
  });

  describe('snapshot guards', () => {
    it.each([
      ['a missing at', ''],
      ['an empty at', '?at='],
      ['a repeated at', `?at=${version}&at=${version}`],
      ['an uppercase at', `?at=${version.toUpperCase()}`],
      ['a short at', '?at=abc'],
    ])('rejects %s with 400', async (_label, query) => {
      const item = await inventoryItem('/v1/products');
      const response = await get(`/_janus/endpoints/${item.id}${query}`);
      expect(response.statusCode).toBe(400);
      expectAtlasHeaders(response);
      expect(response.json()).toMatchObject({ error: { code: 'atlas-invalid-request' } });
    });

    it('rejects malformed IDs with 400 even when the version is stale', async () => {
      for (const url of [
        '/_janus/endpoints/ep_123?at=0000000000000000',
        '/_janus/endpoints/fx_0000000000000000?at=0000000000000000',
        '/_janus/fixtures/ep_0000000000000000?at=0000000000000000',
      ]) {
        const response = await get(url);
        expect(response.statusCode, url).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: 'atlas-invalid-request' } });
      }
    });

    it('returns 409 for a stale version without substituting a resource or disclosing versions', async () => {
      const item = await inventoryItem('/v1/products');
      for (const url of [
        `/_janus/endpoints/${item.id}?at=0000000000000000`,
        '/_janus/endpoints/ep_0000000000000000?at=0000000000000000',
        '/_janus/fixtures/fx_0000000000000000?at=0000000000000000',
      ]) {
        const response = await get(url);
        expect(response.statusCode, url).toBe(409);
        expectAtlasHeaders(response);
        const body = response.json<{ error: Record<string, unknown> }>();
        expect(Object.keys(body)).toEqual(['error']);
        expect(Object.keys(body.error)).toEqual(['code', 'message', 'requestId']);
        expect(body.error['code']).toBe('atlas-snapshot-stale');
        expect(response.body).not.toContain(version);
      }
    });

    it('returns 404 atlas-resource-not-found for an unknown ID in the current snapshot', async () => {
      for (const url of [
        `/_janus/endpoints/ep_0000000000000000?at=${version}`,
        `/_janus/fixtures/fx_0000000000000000?at=${version}`,
      ]) {
        const response = await get(url);
        expect(response.statusCode, url).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: 'atlas-resource-not-found' } });
      }
    });

    it('ignores unknown query parameters', async () => {
      const item = await inventoryItem('/v1/products');
      expect((await json(`/_janus/endpoints/${item.id}?x=1&at=${version}&y`))['id']).toBe(item.id);
    });

    it('resolves a detail link issued by a different snapshot as stale', async () => {
      const item = await inventoryItem('/v1/products');
      start(createEngine({ snapshot: snapshotOf({ ...TREE, 'default/v1/greeting/GET/200_{text-plain}.txt': 'Hey' }) }));
      expect((await get(follow(item.detailHref))).statusCode).toBe(409);
      // The ID itself survives the content-only change.
      expect((await inventoryItem('/v1/products')).id).toBe(item.id);
    });
  });

  it('turns an Atlas failure into a safe 500 without affecting replay', async () => {
    const real = createEngine({ snapshot });
    const broken: Engine = {
      ...real,
      atlas: {
        ...real.atlas,
        inventory: () => {
          throw new Error(`projection failed at /home/${SECRET}`);
        },
      },
    };
    start(broken);
    const response = await get('/_janus/endpoints');
    expect(response.statusCode).toBe(500);
    expectAtlasHeaders(response);
    expect(response.json()).toMatchObject({ error: { code: 'internal-error' } });
    expect(response.body).not.toContain(SECRET);
    expect(failures).toHaveLength(1);
    expect((await get('/_janus/health')).statusCode).toBe(200);
    expect((await get('/v1/products')).statusCode).toBe(200);
  });

  it('discloses no fixture paths in any Atlas response or log record', async () => {
    const bodies: string[] = [];
    const collect = async (url: string): Promise<Record<string, unknown>> => {
      const response = await get(url);
      bodies.push(response.body);
      return response.json();
    };
    await collect('/_janus/health');
    await collect('/_janus/config');
    const inventory = await collect('/_janus/endpoints');
    for (const item of inventory['items'] as Item[]) {
      const endpoint = await collect(follow(item.detailHref));
      for (const fixture of endpoint['fixtures'] as { detailHref: string }[]) await collect(follow(fixture.detailHref));
    }
    const everything = bodies.join('\n') + JSON.stringify(records);
    expect(everything).not.toContain('default/');
    expect(everything).not.toContain('.headers.json');
    expect(records.every((record) => record.path.startsWith('/_janus/'))).toBe(true);
  });

  it('leaves fixture replay outside the namespace unchanged', async () => {
    const response = await get('/v1/products');
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBe(`session=${TOKEN}`);
    expect(response.headers['cache-control']).toBeUndefined();
    expect(response.body).toBe('[{"id":"p-1"}]');
    const janusLike = await get('/v1/_janus/health');
    expect(janusLike.statusCode).toBe(404);
    expect(janusLike.headers['cache-control']).toBeUndefined();
  });

  describe('configuration', () => {
    const configured = (): Engine =>
      createEngine({
        snapshot,
        config: { strictTrailingSlash: true, onUnknownMethod: 404 },
        diagnostics: {
          configDigest: 'cfg_0123456789abcdef',
          configFile: true,
          settings: [
            { key: 'server.strictTrailingSlash', value: true, source: 'default' },
            { key: 'onUnknownMethod', value: 404, source: 'file' },
            { key: 'server.port', value: 4020, source: 'cli' },
            { key: 'fixtures.root', value: `/home/${SECRET}/data`, source: 'file' },
            { key: 'limits.maxBodyBytes', value: 1048576, source: 'default' },
          ],
          warnings: [
            {
              code: 'redundant-content-type',
              source: 'fixtures',
              path: 'default/v1/products/GET/200.headers.json',
              line: 2,
              column: 3,
              message: '"Content-Type" repeats the media type the response file name already sets; remove it',
            },
          ],
        },
      });

    it('adds configDigest and warnings to health, keeping every field', async () => {
      start(configured());
      const response = await get('/_janus/health');
      expectAtlasHeaders(response);
      expect(response.json()).toEqual({
        apiVersion: 'atlas.v1',
        status: 'ready',
        snapshot: version,
        snapshotVersion: version,
        fixtureCount: snapshot.fixtureCount,
        routeCount: snapshot.routeCount,
        configDigest: 'cfg_0123456789abcdef',
        warnings: [
          {
            code: 'redundant-content-type',
            source: 'fixtures',
            message: '"Content-Type" repeats the media type the response file name already sets; remove it',
          },
        ],
        scenarioCount: 1,
        configuredDefaultScenario: 'default',
        capabilities: {
          resolve: true,
          reload: false,
          watch: false,
          events: false,
          ui: false,
          cors: { origins: 0, fixtures: 0 },
          scenarios: true,
          sessions: true,
          variants: true,
          sequences: true,
          pages: true,
          expectations: true,
          idempotency: true,
          recording: { available: false, endpoints: 0 },
          promotion: { available: false, mode: 'staged', pending: 0 },
          // The transport capabilities.
          faults: { enabled: true, timeoutMs: 120000, maxHeldConnections: 128 },
          compression: { enabled: true, encodings: ['br', 'gzip', 'deflate'] },
          codecs: { xml: true },
          autoOptions: true,
          runner: { available: false, collections: 0 },
        },
        lastReload: null,
      });
    });

    it('serves the effective settings sorted by key, without private settings or positions', async () => {
      start(configured());
      const response = await get('/_janus/config');
      expectAtlasHeaders(response);
      expect(response.json()).toEqual({
        apiVersion: 'atlas.v1',
        configDigest: 'cfg_0123456789abcdef',
        configFile: true,
        settings: [
          { key: 'limits.maxBodyBytes', value: 1048576, source: 'default' },
          { key: 'onUnknownMethod', value: 404, source: 'file' },
          { key: 'server.strictTrailingSlash', value: true, source: 'default' },
        ],
      });
      expect(response.body).not.toContain(SECRET);
      expect(response.body).not.toContain('server.port');
      expect(records).toEqual([expect.objectContaining({ path: '/_janus/config', status: 200 })]);
    });

    it('describes defaults when Janus runs without a file', async () => {
      const body = await json('/_janus/config');
      expect(body['configFile']).toBe(false);
      expect(body['configDigest']).toBe((await json('/_janus/health'))['configDigest']);
      expect((body['settings'] as { source: string }[]).every((setting) => setting.source === 'default')).toBe(true);
    });

    it('supports HEAD, rejects other methods, and ignores "at"', async () => {
      const head = await get('/_janus/config', 'HEAD');
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      expectAtlasHeaders(head);
      const post = await get('/_janus/config', 'POST');
      expect(post.statusCode).toBe(405);
      expect(post.headers['allow']).toBe('GET, HEAD');
      expect((await get('/_janus/config?at=0000000000000000')).statusCode).toBe(200);
      expect((await get('/_janus/config/x')).statusCode).toBe(404);
    });

    it('does not change the endpoint list when onUnknownMethod is 404', async () => {
      start(configured());
      const items = (await json('/_janus/endpoints'))['items'] as Item[];
      expect(items.map((item) => `${item.method} ${item.path}`)).toContain('DELETE /v1/products/p-1');
      const hidden = await get('/v1/products', 'DELETE');
      expect(hidden.statusCode).toBe(404);
      expect(hidden.headers['allow']).toBeUndefined();
    });
  });
});
