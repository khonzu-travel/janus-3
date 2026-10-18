import { buildSnapshot, createEngine, type CreateEngineOptions, type Engine } from '@janus/core';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createHttpAdapter } from './adapter.js';

// HTTP translation of dynamic values, the clock resource and rendered previews.

const NOW = '2026-01-01T00:00:00Z';
const TREE: Readonly<Record<string, string>> = {
  'default/v1/products/{productId}/GET/200_{application-json}.json':
    '{"id":"{{$path.productId}}","name":"{{$faker.commerce.productName}}","restockDate":"{{$today+14d}}","updatedAt":"{{$now}}"}',
  'default/v1/products/{productId}/GET/200.headers.json': '{"ETag":"\\"{{$uuid}}\\"","X-Echo":"{{$header.x-in}}"}',
  'default/v1/unique/GET/200_{text-plain}.txt': '{{$uuid:unique}}',
  'default/v1/static/GET/200_{text-plain}.txt': 'static',
};

function engineFor(options: Omit<CreateEngineOptions, 'snapshot'> = {}): Engine {
  const built = buildSnapshot(
    new Map(Object.entries(TREE).map(([key, value]) => [key, new TextEncoder().encode(value)])),
  );
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return createEngine({
    config: { seed: 42 },
    clock: () => Date.UTC(2030, 0, 1),
    randomBytes: (count) => crypto.getRandomValues(new Uint8Array(count)),
    ...options,
    snapshot: built.snapshot,
  });
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function inject(
  request: { method?: string; url: string; headers?: Record<string, string | string[]> },
  engine: Engine = engineFor(),
): Promise<LightMyRequestResponse> {
  app ??= createHttpAdapter({ engine });
  return app.inject({ method: (request.method ?? 'GET') as 'GET', url: request.url, headers: request.headers ?? {} });
}

describe('rendering over HTTP', () => {
  it('renders against X-Mock-Now and reproduces the same bytes', async () => {
    const first = await inject({ url: '/v1/products/p-42', headers: { 'x-mock-now': NOW } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: 'p-42', restockDate: '2026-01-15', updatedAt: NOW });
    const second = await inject({ url: '/v1/products/p-42', headers: { 'x-mock-now': NOW } });
    expect(second.body).toBe(first.body);
    expect(second.headers['etag']).toBe(first.headers['etag']);
    expect(first.headers['content-length']).toBe(String(Buffer.byteLength(first.body)));
    expect(first.headers['x-mock-nondeterministic']).toBeUndefined();
  });

  it('marks responses rendered against the live clock or with :unique', async () => {
    expect((await inject({ url: '/v1/products/p-42' })).headers['x-mock-nondeterministic']).toBe('true');
    const unique = await inject({ url: '/v1/unique', headers: { 'x-mock-now': NOW } });
    expect(unique.headers['x-mock-nondeterministic']).toBe('true');
    expect((await inject({ url: '/v1/unique', headers: { 'x-mock-now': NOW } })).body).not.toBe(unique.body);
  });

  it('answers 400 for a bad or repeated X-Mock-Now', async () => {
    for (const value of ['tomorrow', ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z']]) {
      const response = await inject({ url: '/v1/products/p-42', headers: { 'x-mock-now': value } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'invalid-request' } });
    }
  });

  it('answers 500 render-failed instead of writing CR or LF into a header', async () => {
    const strict = engineFor({ config: { seed: 42, strictRefs: true } });
    const missing = await inject({ url: '/v1/products/p-42', headers: { 'x-mock-now': NOW } }, strict);
    expect(missing.statusCode).toBe(500);
    expect(missing.json()).toMatchObject({ error: { code: 'render-failed' } });
  });

  it('answers HEAD with the headers and Content-Length of GET, and no body', async () => {
    const got = await inject({ url: '/v1/products/p-42', headers: { 'x-mock-now': NOW } });
    const head = await inject({ method: 'HEAD', url: '/v1/products/p-42', headers: { 'x-mock-now': NOW } });
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(got.headers['content-length']);
    expect(head.headers['etag']).toBe(got.headers['etag']);
  });

  it('writes the same body and fixture headers as engine.resolve, under concurrency', async () => {
    const engine = engineFor();
    const transport = new Set(['date', 'content-length', 'connection', 'keep-alive', 'x-janus-request-id']);
    const described = await engine.resolve({
      method: 'GET',
      target: '/v1/products/p-7?x=1',
      headers: { 'x-mock-now': [NOW], 'x-in': ['v'] },
    });
    const wire = await Promise.all(
      Array.from({ length: 50 }, () =>
        inject({ url: '/v1/products/p-7?x=1', headers: { 'x-mock-now': NOW, 'x-in': 'v' } }, engine),
      ),
    );
    for (const response of wire) {
      expect(response.rawPayload.equals(Buffer.from(described.body ?? new Uint8Array()))).toBe(true);
      const headers = Object.fromEntries(
        Object.entries(response.headers)
          .filter(([name]) => !transport.has(name))
          .map(([name, value]) => [name, Array.isArray(value) ? value : [String(value)]]),
      );
      expect(headers).toEqual(described.headers);
    }
  });
});

describe('GET /_janus/clock', () => {
  it('reports the instant a request would render against, honouring X-Mock-Now', async () => {
    const response = await inject({ url: '/_janus/clock', headers: { 'x-mock-now': '2026-01-01T09:00:00+09:00' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      apiVersion: 'atlas.v1',
      now: NOW,
      mode: 'frozen',
      source: 'request-header',
      timezone: 'UTC',
      seed: 42,
      seedSource: 'config',
      serverDefault: { now: null, mode: 'live' },
      session: null,
    });
    expect((await inject({ url: '/_janus/clock' })).json()).toMatchObject({
      now: '2030-01-01T00:00:00Z',
      source: 'wall-clock',
    });
  });

  it('answers HEAD without a body, other methods with 405, and a bad header with 400', async () => {
    const head = await inject({ method: 'HEAD', url: '/_janus/clock' });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    const post = await inject({ method: 'POST', url: '/_janus/clock' });
    expect(post.statusCode).toBe(405);
    expect(post.headers['allow']).toBe('GET, HEAD');
    const bad = await inject({ url: '/_janus/clock', headers: { 'x-mock-now': 'soon' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: 'atlas-invalid-request' } });
    expect((await inject({ url: '/_janus/clock/x' })).statusCode).toBe(404);
  });
});

describe('fixture detail', () => {
  const fixtureHref = async (path: string): Promise<string> => {
    const items = (await inject({ url: '/_janus/endpoints' })).json<{ items: { path: string; detailHref: string }[] }>()
      .items;
    const endpoint = await inject({ url: `/_janus/${items.find((item) => item.path === path)?.detailHref ?? ''}` });
    return `/_janus/${endpoint.json<{ fixtures: { detailHref: string }[] }>().fixtures[0]?.detailHref ?? ''}`;
  };

  it('annotates tokens', async () => {
    const detail = (await inject({ url: await fixtureHref('/v1/products/{productId}') })).json<
      Record<string, unknown>
    >();
    expect(detail['dynamic']).toBe(true);
    const tokens = detail['tokens'] as { pointer: string; span: { start: number; end: number } }[];
    const token = tokens.find((entry) => entry.pointer === '/restockDate');
    expect(token).toMatchObject({
      location: 'body',
      header: null,
      expression: 'today+14d',
      category: 'clock',
      unique: false,
    });
    const raw = (detail['preview'] as { value: string }).value;
    expect(raw.slice(token?.span.start, token?.span.end)).toBe('{{$today+14d}}');
    expect(detail['rendered']).toBeUndefined();
  });

  it('renders with view=rendered, now and param.<name>, like a real request', async () => {
    const href = await fixtureHref('/v1/products/{productId}');
    const response = await inject({ url: `${href}&view=rendered&now=${encodeURIComponent(NOW)}&param.productId=p-42` });
    expect(response.statusCode).toBe(200);
    const rendered = response.json<{ rendered: Record<string, unknown> }>().rendered;
    const real = await inject({ url: '/v1/products/p-42', headers: { 'x-mock-now': NOW } });
    expect(rendered).toMatchObject({
      preview: { state: 'available', encoding: 'utf8', value: real.body },
      instant: NOW,
      clockSource: 'caller',
      seed: 42,
      nondeterministic: false,
      unresolved: ['header.x-in'],
      error: null,
    });
  });

  it.each([
    ['&view=rendered&now=tomorrow', '"now" must be an RFC 3339 instant'],
    ['&view=rendered&param.id=1', '"param.id" is not a parameter'],
    ['&view=raw', '"view" must be "rendered"'],
    ['&now=2026-01-01T00:00:00Z', 'need view=rendered'],
    ['&view=rendered&view=rendered', 'may appear only once'],
  ])('rejects %s with 400 atlas-invalid-request', async (query, message) => {
    const response = await inject({ url: `${await fixtureHref('/v1/products/{productId}')}${query}` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'atlas-invalid-request' } });
    expect(response.json<{ error: { message: string } }>().error.message).toContain(message);
  });
});
