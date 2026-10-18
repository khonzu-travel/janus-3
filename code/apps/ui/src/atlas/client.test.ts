import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIG,
  DIGEST,
  ENDPOINTS,
  FakeAtlas,
  GREETING,
  PRODUCT_BY_ID,
  V1,
  V2,
} from '../../test/fake-atlas.js';
import { decodeConfig } from '../config.js';
import { AtlasError, createAtlasClient, type AtlasClientOptions, type DiagnosticEntry } from './client.js';
import { NO_CAPABILITIES } from './wire.js';

function clientFor(serverUrl: string, options: AtlasClientOptions) {
  const config = decodeConfig({ serverUrl }, 'http://page.test/');
  if (!config.ok) throw new Error(config.message);
  return createAtlasClient(config.config, options);
}

function setup(fake = new FakeAtlas(), timeoutMs?: number) {
  const diagnostics: DiagnosticEntry[] = [];
  const client = clientFor('http://janus.test', {
    fetch: fake.fetch,
    onDiagnostic: (entry) => diagnostics.push(entry),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { fake, client, diagnostics };
}

const respond =
  (status: number, body: string, contentType = 'application/json'): typeof fetch =>
  () =>
    Promise.resolve(new Response(body, { status, headers: { 'content-type': contentType } }));

async function failure(promise: Promise<unknown>): Promise<AtlasError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AtlasError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

describe('createAtlasClient', () => {
  it('requests health and inventory inside the Atlas root and resolves relative links', async () => {
    const { client, fake } = setup();
    expect(await client.health()).toEqual({
      status: 'ready',
      snapshotVersion: V1,
      fixtureCount: 5,
      routeCount: 5,
      configDigest: DIGEST,
      warnings: [],
      capabilities: { ...NO_CAPABILITIES, resolve: true, reload: true, events: true },
      lastReload: null,
      configuredDefaultScenario: 'default',
      scenarioCount: 1,
    });
    const inventory = await client.inventory(null);
    expect(inventory.items[0]).toEqual({
      id: GREETING.id,
      scenario: 'default',
      method: 'GET',
      path: '/v1/greeting',
      // No parameters reported: an empty list, not an error.
      pathParameters: [],
      origin: 'own' as const,
      review: null,
      hasFaults: false,
      detailUrl: `http://janus.test/_janus/endpoints/${GREETING.id}?at=${V1}`,
    });
    const endpoint = await client.endpoint(inventory.items[0] ?? never());
    expect(endpoint.fixtures.map((fixture) => fixture.detailUrl)).toEqual([
      `http://janus.test/_janus/fixtures/fx_0000000000000021?at=${V1}`,
      `http://janus.test/_janus/fixtures/fx_0000000000000022?at=${V1}`,
    ]);
    const fixture = await client.fixture(endpoint.fixtures[1] ?? never());
    expect(fixture.preview).toMatchObject({ encoding: 'utf8', value: 'Bonjour' });
    expect(fake.requests).toEqual([
      '/_janus/health',
      '/_janus/endpoints',
      `/_janus/endpoints/${GREETING.id}?at=${V1}`,
      `/_janus/fixtures/fx_0000000000000022?at=${V1}`,
    ]);
  });

  it('keeps a server path when resolving links (reverse-proxy mount)', async () => {
    const fake = new FakeAtlas('http://proxy.test/mock/_janus/');
    const client = clientFor('http://proxy.test/mock', { fetch: fake.fetch });
    const inventory = await client.inventory(null);
    expect(inventory.items[0]?.detailUrl).toBe(`http://proxy.test/mock/_janus/endpoints/${GREETING.id}?at=${V1}`);
  });

  it('accepts the `snapshot` field when `snapshotVersion` is absent', async () => {
    const fake = new FakeAtlas();
    fake.healthOverride = { snapshotVersion: undefined };
    expect((await setup(fake).client.health()).snapshotVersion).toBe(V1);
  });

  it.each([
    ['a parent path', '../outside?at=x'],
    ['another origin', 'http://evil.test/_janus/endpoints/x'],
    ['an absolute path', '/v1/products'],
    ['a fragment', 'endpoints/x#frag'],
  ])('rejects a link to %s as a decoding error', async (_label, href) => {
    const body = JSON.stringify({
      apiVersion: 'atlas.v1',
      snapshotVersion: V1,
      items: [{ id: GREETING.id, scenario: 'default', method: 'GET', path: '/', detailHref: href }],
    });
    const error = await failure(clientWith(respond(200, body)).inventory(null));
    expect(error.kind).toBe('decode');
  });

  it('rejects snapshot-bound links that disagree with their containing document', async () => {
    const body = JSON.stringify({
      apiVersion: 'atlas.v1',
      snapshotVersion: V1,
      items: [
        {
          id: GREETING.id,
          scenario: 'default',
          method: 'GET',
          path: GREETING.path,
          detailHref: `endpoints/${GREETING.id}?at=${V2}`,
        },
      ],
    });
    expect((await failure(clientWith(respond(200, body)).inventory(null))).kind).toBe('decode');
  });

  describe('failures', () => {
    it('classifies a network failure', async () => {
      const fake = new FakeAtlas();
      fake.down = true;
      const { client, diagnostics } = setup(fake);
      expect((await failure(client.health())).kind).toBe('network');
      expect(diagnostics).toEqual([{ kind: 'network', url: 'http://janus.test/_janus/health' }]);
    });

    it('distinguishes a timeout from an HTTP error', async () => {
      const fake = new FakeAtlas();
      fake.hold.add('/_janus/health');
      const error = await failure(setup(fake, 20).client.health());
      expect(error.kind).toBe('timeout');
      expect(fake.aborted).toEqual(['/_janus/health']);
    });

    it('rejects with the abort reason and no diagnostic when cancelled', async () => {
      const fake = new FakeAtlas();
      fake.hold.add('/_janus/endpoints');
      const { client, diagnostics } = setup(fake);
      const controller = new AbortController();
      const pending = client.inventory(null, controller.signal);
      controller.abort(new DOMException('navigated away', 'AbortError'));
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(fake.aborted).toEqual(['/_janus/endpoints']);
      expect(diagnostics).toEqual([]);
    });

    it('rejects at once when the signal is already aborted', async () => {
      const { client, diagnostics } = setup();
      const controller = new AbortController();
      controller.abort(new DOMException('gone', 'AbortError'));
      await expect(client.health(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(diagnostics).toEqual([]);
    });

    it('reports non-ready health', async () => {
      const fake = new FakeAtlas();
      fake.healthOverride = { status: 'starting' };
      const error = await failure(setup(fake).client.health());
      expect(error).toMatchObject({ kind: 'not-ready', message: 'The server reported status "starting"' });
    });

    it.each([
      [{ apiVersion: 'atlas.v2' }, 'The server speaks atlas.v2; this UI needs atlas.v1'],
      [{ apiVersion: undefined }, 'The server does not speak the Atlas API (this UI needs atlas.v1)'],
    ])('reports an incompatible API version %j', async (override, message) => {
      const fake = new FakeAtlas();
      fake.healthOverride = override;
      expect(await failure(setup(fake).client.health())).toMatchObject({ kind: 'incompatible', message });
    });

    it.each([
      ['malformed JSON', '{"apiVersion":'],
      ['a schema mismatch', JSON.stringify({ apiVersion: 'atlas.v1', status: 'ready', fixtureCount: -1 })],
      ['a bad version', JSON.stringify({ apiVersion: 'atlas.v1', status: 'ready', snapshotVersion: 'x' })],
    ])('treats %s as a decoding error', async (_label, body) => {
      const error = await failure(clientWith(respond(200, body)).health());
      expect(error.kind).toBe('decode');
    });

    it('never passes partial data through', async () => {
      const body = JSON.stringify({
        apiVersion: 'atlas.v1',
        snapshotVersion: V1,
        items: [{ id: GREETING.id, scenario: 'default', method: 'GET', path: '/', detailHref: 'endpoints/x' }, {}],
      });
      expect((await failure(clientWith(respond(200, body)).inventory(null))).kind).toBe('decode');
    });

    it('does not surface an unverified error body', async () => {
      const error = await failure(
        clientWith(respond(502, '<h1>Bad gateway: secret-upstream</h1>', 'text/html')).health(),
      );
      expect(error).toMatchObject({ kind: 'http', message: 'The server answered HTTP 502', details: { status: 502 } });
      expect(JSON.stringify(error.details) + error.message).not.toContain('secret-upstream');
    });

    it('uses the message and code of a decoded Atlas envelope', async () => {
      const body = JSON.stringify({ error: { code: 'internal-error', message: 'Janus failed', requestId: 'r-1' } });
      const error = await failure(clientWith(respond(500, body)).health());
      expect(error).toMatchObject({ kind: 'http', message: 'Janus failed', details: { code: 'internal-error' } });
    });

    it('classifies stale and missing resources', async () => {
      const { client, fake } = setup();
      const [item] = (await client.inventory(null)).items;
      fake.version = V2;
      expect(await failure(client.endpoint(item ?? never()))).toMatchObject({
        kind: 'stale',
        details: { status: 409, code: 'atlas-snapshot-stale' },
      });
      fake.version = V1;
      fake.endpoints = [];
      expect(await failure(client.endpoint(item ?? never()))).toMatchObject({
        kind: 'not-found',
        details: { status: 404, code: 'atlas-resource-not-found' },
      });
    });

    it('rejects incoherent successful endpoint documents', async () => {
      const item = {
        id: GREETING.id,
        scenario: 'default',
        method: 'GET',
        path: GREETING.path,
        pathParameters: [],
        origin: 'own' as const,
        review: null,
        hasFaults: false,
        detailUrl: `http://janus.test/_janus/endpoints/${GREETING.id}?at=${V1}`,
      };
      const document = {
        apiVersion: 'atlas.v1',
        snapshotVersion: V2,
        id: GREETING.id,
        scenario: 'default',
        method: 'GET',
        path: GREETING.path,
        fixtures: [],
      };
      const error = await failure(clientWith(respond(200, JSON.stringify(document))).endpoint(item));
      expect(error).toMatchObject({ kind: 'stale', message: 'The fixture snapshot changed' });
    });

    it('rejects a successful resource whose identity differs from the selected item', async () => {
      const item = {
        id: GREETING.id,
        scenario: 'default',
        method: 'GET',
        path: GREETING.path,
        pathParameters: [],
        origin: 'own' as const,
        review: null,
        hasFaults: false,
        detailUrl: `http://janus.test/_janus/endpoints/${GREETING.id}?at=${V1}`,
      };
      const document = {
        apiVersion: 'atlas.v1',
        snapshotVersion: V1,
        id: 'ep_0000000000000099',
        scenario: 'default',
        method: 'GET',
        path: '/wrong',
        fixtures: [],
      };
      expect((await failure(clientWith(respond(200, JSON.stringify(document))).endpoint(item))).kind).toBe('decode');
    });

    it('rejects fixture links that disagree with their endpoint document', async () => {
      const item = {
        id: GREETING.id,
        scenario: 'default',
        method: 'GET',
        path: GREETING.path,
        pathParameters: [],
        origin: 'own' as const,
        review: null,
        hasFaults: false,
        detailUrl: `http://janus.test/_janus/endpoints/${GREETING.id}?at=${V1}`,
      };
      const document = {
        apiVersion: 'atlas.v1',
        snapshotVersion: V1,
        id: GREETING.id,
        scenario: 'default',
        method: 'GET',
        path: GREETING.path,
        fixtures: [{ ...fixtureSummary, detailHref: `fixtures/${fixtureSummary.id}?at=${V2}` }],
      };
      expect((await failure(clientWith(respond(200, JSON.stringify(document))).endpoint(item))).kind).toBe('decode');
    });

    it('reports a fixture document from another snapshot as stale', async () => {
      const error = await failure(
        clientWith(respond(200, JSON.stringify({ ...fixtureDocument, snapshotVersion: V2 }))).fixture(fixtureItem),
      );
      expect(error).toMatchObject({ kind: 'stale', message: 'The fixture snapshot changed' });
    });

    it.each([
      ['id', { id: 'fx_0000000000000099' }],
      ['status', { status: 404 }],
      ['media type', { mediaType: 'application/json' }],
      ['locale', { locale: 'en' }],
      ['byte length', { byteLength: 8 }],
    ])('rejects a fixture document whose %s differs from the selected response', async (_label, change) => {
      const document = JSON.stringify({ ...fixtureDocument, ...change });
      expect((await failure(clientWith(respond(200, document)).fixture(fixtureItem))).kind).toBe('decode');
    });

    it('accepts a fixture document that matches the selected response', async () => {
      const fixture = await clientWith(respond(200, JSON.stringify(fixtureDocument))).fixture(fixtureItem);
      expect(fixture.preview).toMatchObject({ value: 'Bonjour' });
    });

    it('logs only the origin and path, never query strings or credentials', async () => {
      const fake = new FakeAtlas();
      const diagnostics: DiagnosticEntry[] = [];
      const client = clientFor('http://janus.test', {
        fetch: fake.fetch,
        onDiagnostic: (entry) => diagnostics.push(entry),
      });
      const [item] = (await client.inventory(null)).items;
      fake.version = V2;
      await failure(client.endpoint(item ?? never()));
      expect(diagnostics).toEqual([
        {
          kind: 'stale',
          url: `http://janus.test/_janus/endpoints/${GREETING.id}`,
          status: 409,
          code: 'atlas-snapshot-stale',
        },
      ]);
    });
  });

  describe('configuration', () => {
    it('decodes the config digest and warnings in health', async () => {
      const fake = new FakeAtlas();
      fake.warnings = [{ code: 'redundant-content-type', source: 'fixtures', message: 'remove it' }];
      expect(await setup(fake).client.health()).toMatchObject({
        configDigest: DIGEST,
        warnings: [{ code: 'redundant-content-type', message: 'remove it' }],
      });
    });

    it('treats a health document without them as "not reported"', async () => {
      const fake = new FakeAtlas();
      fake.config = null;
      fake.capabilities = null;
      const health = await setup(fake).client.health();
      expect(health).toEqual({
        status: 'ready',
        snapshotVersion: V1,
        fixtureCount: 5,
        routeCount: 5,
        capabilities: NO_CAPABILITIES,
        lastReload: null,
        configuredDefaultScenario: 'default',
        scenarioCount: 1,
      });
      expect('configDigest' in health).toBe(false);
    });

    it.each([
      [{ configDigest: 'cfg_nothex' }, 'configDigest: expected a configuration digest'],
      [{ warnings: 'none' }, 'warnings: expected an array'],
      [{ warnings: [{ code: 'x' }] }, 'warnings[0].message: expected a string'],
    ])('rejects malformed configuration fields in health: %j', async (override, message) => {
      const fake = new FakeAtlas();
      fake.healthOverride = override;
      const error = await failure(setup(fake).client.health());
      expect(error.kind).toBe('decode');
      expect(error.message).toContain(message);
    });

    it('requests /_janus/config inside the Atlas root and decodes it', async () => {
      const { client, fake } = setup();
      expect(await client.config()).toEqual(DEFAULT_CONFIG);
      expect(fake.requests).toEqual(['/_janus/config']);
    });

    it('classifies an older server without the resource as an http 404 route-not-found', async () => {
      const fake = new FakeAtlas();
      fake.config = null;
      expect(await failure(setup(fake).client.config())).toMatchObject({
        kind: 'http',
        details: { status: 404, code: 'route-not-found' },
      });
    });

    it.each([
      [{ ...DEFAULT_CONFIG, configFile: 'yes' }, 'configFile'],
      [{ ...DEFAULT_CONFIG, settings: [{ key: 'a', value: [1], source: 'default' }] }, 'settings[0].value'],
      [{ ...DEFAULT_CONFIG, settings: [{ key: 'a', value: 1, source: 'env' }] }, 'settings[0].source'],
    ])('rejects a malformed config document (%#)', async (document, path) => {
      const fake = new FakeAtlas();
      fake.config = document;
      const error = await failure(setup(fake).client.config());
      expect(error.kind).toBe('decode');
      expect(error.message).toContain(path);
    });
  });
});

const fixtureSummary = {
  id: 'fx_0000000000000022',
  status: 200,
  variant: null,
  identity: '200',
  mediaType: 'text/plain',
  wireContentType: 'text/plain',
  locale: 'fr',
  byteLength: 7,
  headers: [{ name: 'content-type', value: 'text/plain', treatment: 'replayed' as const }],
};

const fixtureItem = {
  ...fixtureSummary,
  digest: null,
  promotion: null,
  sidecar: null,
  holder: null,
  origin: 'own' as const,
  detailUrl: `http://janus.test/_janus/fixtures/${fixtureSummary.id}?at=${V1}`,
};

const fixtureDocument = {
  apiVersion: 'atlas.v1',
  snapshotVersion: V1,
  ...fixtureSummary,
  endpointId: GREETING.id,
  scenario: 'default',
  method: 'GET',
  path: GREETING.path,
  preview: { state: 'available', encoding: 'utf8', value: 'Bonjour', byteLength: 7, truncated: false },
};

function clientWith(fetchImpl: typeof fetch) {
  return clientFor('http://janus.test', { fetch: fetchImpl });
}

function never(): never {
  throw new Error('missing test data');
}

describe('fixture variation fields', () => {
  const setupVariations = () => {
    const fake = new FakeAtlas();
    fake.endpoints = [...ENDPOINTS, PRODUCT_BY_ID];
    return setup(fake);
  };

  it('decodes templates, representation groups, accepts, header treatment and the wire Content-Type', async () => {
    const { client } = setupVariations();
    const item = (await client.inventory(null)).items.find((entry) => entry.id === PRODUCT_BY_ID.id) ?? never();
    expect(item.pathParameters).toEqual(['productId']);
    const endpoint = await client.endpoint(item);
    expect(endpoint.accepts).toEqual({
      mediaTypes: ['application/json'],
      allowMissingContentType: null,
      scenario: null,
    });
    expect(
      endpoint.representationGroups.map((group) => [
        group.status,
        group.locale,
        group.representations.map((entry) => entry.id),
      ]),
    ).toEqual([
      [200, null, ['fx_0000000000000061', 'fx_0000000000000062']],
      [200, 'fr', ['fx_0000000000000063']],
    ]);
    // Groups hold the same items as the flat list, links resolved.
    expect(endpoint.representationGroups[0]?.representations[0]).toBe(endpoint.fixtures[0]);
    const fixture = await client.fixture(endpoint.fixtures[0] ?? never());
    expect(fixture).toMatchObject({ mediaType: 'application/json', wireContentType: 'text/plain; charset=utf-8' });
    expect(fixture.headers.map((header) => header.treatment)).toEqual(['replayed', 'replayed', 'dropped']);
  });

  it('fills the new fields for an older server', async () => {
    const { client } = setup();
    const item = (await client.inventory(null)).items[0] ?? never();
    const endpoint = await client.endpoint(item);
    expect(endpoint.pathParameters).toEqual([]);
    expect(endpoint.accepts).toBeUndefined();
    expect(endpoint.representationGroups.map((group) => [group.status, group.locale])).toEqual([
      [200, null],
      [200, 'fr'],
    ]);
    const fixture = await client.fixture(endpoint.fixtures[1] ?? never());
    expect(fixture.wireContentType).toBe(fixture.mediaType);
    expect(fixture.headers.every((header) => header.treatment === 'replayed')).toBe(true);
  });

  it('rejects representation groups that name a response the endpoint does not list', async () => {
    const item = {
      id: GREETING.id,
      scenario: 'default',
      method: 'GET',
      path: GREETING.path,
      pathParameters: [],
      origin: 'own' as const,
      review: null,
      hasFaults: false,
      detailUrl: `http://janus.test/_janus/endpoints/${GREETING.id}?at=${V1}`,
    };
    const document = {
      apiVersion: 'atlas.v1',
      snapshotVersion: V1,
      id: GREETING.id,
      scenario: 'default',
      method: 'GET',
      path: GREETING.path,
      fixtures: [],
      representationGroups: [
        { status: 200, locale: null, representations: [{ ...fixtureSummary, detailHref: `fixtures/x?at=${V1}` }] },
      ],
      accepts: null,
    };
    expect((await failure(clientWith(respond(200, JSON.stringify(document))).endpoint(item))).kind).toBe('decode');
  });

  it.each([
    ['a header treatment', { headers: [{ name: 'x', value: 'y', treatment: 'maybe' }] }],
    ['a wire Content-Type', { wireContentType: 5 }],
  ])('rejects an invalid %s', async (_label, change) => {
    const document = JSON.stringify({ ...fixtureDocument, ...change });
    expect((await failure(clientWith(respond(200, document)).fixture(fixtureItem))).kind).toBe('decode');
  });
});

describe('resources', () => {
  it('posts the resolve envelope as JSON and checks the fixture link', async () => {
    const { client, fake } = setup();
    const calls: RequestInit[] = [];
    const recording: typeof fetch = (input, init) => {
      calls.push(init ?? {});
      return fake.fetch(input, init);
    };
    const recorded = clientFor('http://janus.test', { fetch: recording });
    const explanation = await recorded.resolve({ method: 'GET', target: '/v1/products' });
    expect(calls[0]?.method).toBe('POST');
    expect(new Headers(calls[0]?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(calls[0]?.body as string)).toEqual({ method: 'GET', target: '/v1/products' });
    expect(explanation.fixture).toEqual({
      endpointId: 'ep_0000000000000004',
      fixtureId: 'fx_0000000000000011',
      detailUrl: `http://janus.test/_janus/fixtures/fx_0000000000000011?at=${V1}`,
    });
    expect(explanation.trace.route?.considered).toEqual(['/v1/products/p-1']);
    expect((await client.resolve({ method: 'GET', target: '/x' })).fixture).toBeNull();
  });

  it('refuses a fixture link outside the Atlas root', async () => {
    const fake = new FakeAtlas();
    const original = fake.resolver;
    fake.resolver = (envelope) => {
      const document = original?.(envelope) as Record<string, unknown>;
      return {
        ...document,
        fixture: {
          endpointId: 'ep_0000000000000004',
          fixtureId: 'fx_0000000000000011',
          detailHref: 'http://evil.test/x',
        },
      };
    };
    const error = await failure(setup(fake).client.resolve({ method: 'GET', target: '/v1/products' }));
    expect(error.kind).toBe('decode');
  });

  it('decodes the reload result, before and after the first reload', async () => {
    const fake = new FakeAtlas();
    const { client } = setup(fake);
    expect(await client.reloadResult()).toEqual({ outcome: null });
    fake.reloadResult = {
      outcome: 'unchanged',
      triggers: ['request'],
      finishedAt: '2026-09-29T10:14:03Z',
      activeSnapshotVersion: V1,
      candidateSnapshotVersion: V1,
      errors: [],
      warnings: [],
    };
    expect(await client.reloadResult()).toMatchObject({ outcome: 'unchanged', triggers: ['request'] });
    expect(client.eventsUrl.href).toBe('http://janus.test/_janus/events');
  });

  it('decodes capabilities and the last reload from health', async () => {
    const fake = new FakeAtlas();
    fake.lastReload = { outcome: 'failed', errorCount: 2, finishedAt: '2026-09-29T10:14:03Z' };
    expect(await setup(fake).client.health()).toMatchObject({
      capabilities: { resolve: true, reload: true, watch: false, events: true },
      lastReload: { outcome: 'failed', errorCount: 2 },
    });
    fake.healthOverride = { lastReload: { outcome: 'exploded', errorCount: 0, finishedAt: '' } };
    expect((await failure(setup(fake).client.health())).kind).toBe('decode');
  });
});
