import { buildSnapshot, createEngine, type Engine, type EngineConfig } from '@janus/core';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createHttpAdapter } from './adapter.js';

// Adapter tests for fixture variations.

const STALE_DATE = 'Mon, 01 Jan 2001 00:00:00 GMT';

const TREE: Readonly<Record<string, string>> = {
  'default/v1/products/{productId}/GET/200_{application-json}.json': '{"id":"any"}',
  'default/v1/products/{productId}/GET/200_{application-yaml}.yaml': 'id: any\n',
  'default/v1/products/{productId}/GET/200.headers.json': JSON.stringify({
    'Content-Length': '999',
    Date: STALE_DATE,
    'Content-Encoding': 'gzip',
    'Set-Cookie': ['a=1', 'b=2'],
  }),
  'default/v1/products/p-1/GET/200_{application-json}.json': '{"id":"p-1"}',
  'default/v1/products/POST/accepts.yaml': 'accepts: [application/json]\n',
  'default/v1/products/POST/201_{application-json}.json': '{"id":"p-2"}',
  'default/v1/products/PATCH/accepts.yaml': 'accepts: [application/merge-patch+json]\n',
  'default/v1/products/PATCH/200_{application-json}.json': '{}',
  'default/v1/legacy/GET/200_{application-json}.json': '{"legacy":true}',
  'default/v1/legacy/GET/200.headers.json': '{"Content-Type":"text/plain; charset=utf-8"}',
};

function engineFor(config: Partial<EngineConfig> = {}): Engine {
  const built = buildSnapshot(
    new Map(Object.entries(TREE).map(([key, value]) => [key, new TextEncoder().encode(value)])),
  );
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return createEngine({ snapshot: built.snapshot, config });
}

let app: FastifyInstance | undefined;

function adapter(engine: Engine = engineFor()): FastifyInstance {
  app = createHttpAdapter({ engine });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const inject = (options: InjectOptions, engine?: Engine): Promise<LightMyRequestResponse> =>
  adapter(engine).inject(options);

const mockHeaders = (response: LightMyRequestResponse): string[] =>
  Object.keys(response.headers).filter((name) => name.startsWith('x-mock-'));

describe('fixture variations over HTTP', () => {
  it('serves template routes, preferring a literal sibling', async () => {
    expect((await inject({ method: 'GET', url: '/v1/products/p-1' })).json()).toEqual({ id: 'p-1' });
    expect((await inject({ method: 'GET', url: '/v1/products/p-42' })).json()).toEqual({ id: 'any' });
  });

  it('negotiates Accept and varies on it', async () => {
    const response = await inject({ method: 'GET', url: '/v1/products/p-42', headers: { accept: 'application/yaml' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/yaml');
    expect(response.headers['vary']).toBe('Accept');
    expect(response.body).toBe('id: any\n');
  });

  it('writes the 406 envelope as JSON, whatever Accept says', async () => {
    const response = await inject({ method: 'GET', url: '/v1/products/p-42', headers: { accept: 'text/csv' } });
    expect(response.statusCode).toBe(406);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['vary']).toBe('Accept');
    expect(response.json()).toMatchObject({
      error: {
        code: 'not-acceptable',
        message: expect.stringContaining('application/json, application/yaml') as unknown,
      },
    });
    expect(mockHeaders(response)).toEqual(['x-mock-scenario']);
  });

  it('writes the 400 envelope for an unusable Accept header', async () => {
    const response = await inject({ method: 'GET', url: '/v1/products/p-42', headers: { accept: 'nonsense' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid-request' } });
  });

  it('writes the 415 envelope with Accept-Post and Accept-Patch', async () => {
    const post = await inject({
      method: 'POST',
      url: '/v1/products',
      headers: { 'content-type': 'application/xml' },
      payload: '<p/>',
    });
    expect(post.statusCode).toBe(415);
    expect(post.headers['accept-post']).toBe('application/json');
    expect(post.json()).toMatchObject({ error: { code: 'unsupported-media-type' } });
    expect(mockHeaders(post)).toEqual(['x-mock-scenario']);

    const patch = await inject({
      method: 'PATCH',
      url: '/v1/products',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(patch.statusCode).toBe(415);
    expect(patch.headers['accept-patch']).toBe('application/merge-patch+json');

    const accepted = await inject({
      method: 'POST',
      url: '/v1/products',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      payload: '{}',
    });
    expect(accepted.statusCode).toBe(201);
  });

  it('writes a malformed Content-Type as 400', async () => {
    const response = await inject({
      method: 'POST',
      url: '/v1/products',
      headers: { 'content-type': 'json' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'invalid-request' } });
  });

  it('computes Content-Length and Date itself and sends no Content-Encoding, even when a sidecar sets them', async () => {
    const response = await inject({ method: 'GET', url: '/v1/products/p-42' });
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength('{"id":"any"}')));
    expect(response.headers['date']).toBeDefined();
    expect(response.headers['date']).not.toBe(STALE_DATE);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['set-cookie']).toEqual(['a=1', 'b=2']);
  });

  it('sends X-Mock-Identity, X-Mock-Representation and X-Mock-Warning', async () => {
    const response = await inject({
      method: 'GET',
      url: '/v1/products/p-42',
      headers: { accept: 'application/json;q=5, application/yaml' },
    });
    expect(response.headers['x-mock-identity']).toMatch(/^fx_[0-9a-f]{16}$/);
    expect(response.headers['x-mock-warning']).toBe('199 janus "ignored Accept range application/json;q=5"');
    expect(response.headers['x-mock-representation']).toBeUndefined();

    const legacy = await inject({ method: 'GET', url: '/v1/legacy' });
    expect(legacy.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(legacy.headers['x-mock-representation']).toBe('application/json');
  });

  it('sends the same diagnostic headers for HEAD, without a body', async () => {
    const get = await inject({ method: 'GET', url: '/v1/legacy' });
    const head = await inject({ method: 'HEAD', url: '/v1/legacy' });
    expect(head.body).toBe('');
    expect(head.headers['x-mock-identity']).toBe(get.headers['x-mock-identity']);
    expect(head.headers['x-mock-representation']).toBe(get.headers['x-mock-representation']);
  });

  it('sends no X-Mock-* header with diagnostics.headers false', async () => {
    const response = await inject(
      { method: 'GET', url: '/v1/legacy', headers: { accept: 'bad, application/json' } },
      engineFor({ diagnosticHeaders: false }),
    );
    expect(response.statusCode).toBe(200);
    expect(mockHeaders(response)).toEqual([]);
  });

  it('sends what engine.resolve describes, apart from transport-owned headers', async () => {
    const engine = engineFor();
    const cases: { method: string; url: string; headers?: Record<string, string>; payload?: string }[] = [
      { method: 'GET', url: '/v1/products/p-42', headers: { accept: 'application/yaml' } },
      { method: 'GET', url: '/v1/products/p-42', headers: { accept: 'text/csv' } },
      { method: 'GET', url: '/v1/legacy' },
      { method: 'POST', url: '/v1/products', headers: { 'content-type': 'text/xml' }, payload: '<x/>' },
      { method: 'DELETE', url: '/v1/legacy' },
    ];
    const transport = new Set(['date', 'content-length', 'connection', 'keep-alive', 'x-janus-request-id']);
    for (const { method, url, headers = {}, payload } of cases) {
      const wire = await inject(
        { method: method as 'GET', url, headers, ...(payload === undefined ? {} : { payload }) },
        engine,
      );
      const described = await engine.resolve({
        method,
        target: url,
        headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, [value]])),
        ...(payload === undefined ? {} : { body: new TextEncoder().encode(payload) }),
      });
      expect(wire.statusCode).toBe(described.status);
      const wireHeaders = Object.fromEntries(
        Object.entries(wire.headers)
          .filter(([name]) => !transport.has(name))
          .map(([name, value]) => [name, Array.isArray(value) ? value : [String(value)]]),
      );
      expect(wireHeaders).toEqual(described.headers);
      const body = described.body === null ? '' : new TextDecoder().decode(described.body);
      // Error envelopes carry the adapter's request ID; compare them without it.
      expect(wire.body.replace(/,"requestId":"[^"]*"/, '')).toBe(body);
    }
  });
});

describe('Atlas fields for fixture variations', () => {
  interface Item {
    readonly id: string;
    readonly path: string;
    readonly method: string;
    readonly pathParameters: readonly string[];
    readonly detailHref: string;
  }

  const atlasGet = async (path: string): Promise<Record<string, unknown>> =>
    (await inject({ method: 'GET', url: path })).json();

  const endpointFor = async (path: string, method = 'GET'): Promise<Record<string, unknown>> => {
    const inventory = (await atlasGet('/_janus/endpoints')) as { items: Item[] };
    const item = inventory.items.find((entry) => entry.path === path && entry.method === method);
    if (item === undefined) throw new Error(`no ${method} ${path}`);
    return atlasGet(`/_janus/${item.detailHref}`);
  };

  it('lists templates with their parameters, the literal sibling first', async () => {
    const inventory = (await atlasGet('/_janus/endpoints')) as { items: Item[] };
    expect(inventory.items.map((item) => [item.method, item.path, item.pathParameters])).toEqual([
      ['GET', '/v1/legacy', []],
      ['PATCH', '/v1/products', []],
      ['POST', '/v1/products', []],
      ['GET', '/v1/products/p-1', []],
      ['GET', '/v1/products/{productId}', ['productId']],
    ]);
  });

  it('groups representations, marks dropped headers, and shows accepted media types', async () => {
    const endpoint = (await endpointFor('/v1/products/{productId}')) as {
      pathParameters: string[];
      representationGroups: {
        status: number;
        locale: string | null;
        representations: { mediaType: string; headers: { name: string; treatment: string }[] }[];
      }[];
      accepts: unknown;
    };
    expect(endpoint.pathParameters).toEqual(['productId']);
    expect(endpoint.accepts).toBeNull();
    const [group] = endpoint.representationGroups;
    expect(group?.status).toBe(200);
    expect(group?.locale).toBeNull();
    expect(group?.representations.map((entry) => entry.mediaType)).toEqual(['application/json', 'application/yaml']);
    expect(
      group?.representations[0]?.headers
        .filter((header) => header.treatment === 'dropped')
        .map((header) => header.name),
    ).toEqual(['content-encoding', 'content-length', 'date']);

    expect((await endpointFor('/v1/products', 'POST'))['accepts']).toEqual({
      mediaTypes: ['application/json'],
      allowMissingContentType: null,
      scenario: 'default',
    });
  });

  it('shows the wire Content-Type beside the representation, and links the served identity', async () => {
    const endpoint = (await endpointFor('/v1/legacy')) as {
      fixtures: { id: string; mediaType: string; wireContentType: string; detailHref: string }[];
    };
    const [fixture] = endpoint.fixtures;
    expect(fixture).toMatchObject({ mediaType: 'application/json', wireContentType: 'text/plain; charset=utf-8' });
    const served = await inject({ method: 'GET', url: '/v1/legacy' });
    expect(served.headers['x-mock-identity']).toBe(fixture?.id);
    expect(await atlasGet(`/_janus/${fixture?.detailHref ?? ''}`)).toMatchObject({
      id: fixture?.id,
      path: '/v1/legacy',
      pathParameters: [],
    });
  });
});
