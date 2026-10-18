import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import { createEngine } from '../create-engine.js';
import { buildSnapshot } from '../fixtures/build.js';
import type { Engine, RequestDescription, ResponseDescription } from '../types/index.js';

const PRODUCTS_JSON = '[ {"id":"p-1",  "name":"Example"} ]\n';

function engineFor(entries: Readonly<Record<string, string>>): { engine: Engine; version: string } {
  const result = buildSnapshot(new Map(Object.entries(entries).map(([path, text]) => [path, utf8Encode(text)])));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return { engine: createEngine({ snapshot: result.snapshot }), version: result.snapshot.version };
}

const { engine, version } = engineFor({
  'default/GET/200_{text-plain}.txt': 'root',
  'default/v1/products/GET/200_{application-json}.json': PRODUCTS_JSON,
  'default/v1/products/GET/200.headers.json': '{"Set-Cookie":["a=1","b=2"],"X-Example":"fixture"}',
  'default/v1/products/POST/201_{application-json}.json': '{"id":"p-2"}',
  'default/v1/products/POST/201.headers.json': '{"Location":"/v1/products/p-2"}',
  'default/v1/products/p-1/DELETE/204': '',
  'default/v1/products/p-1/PUT/205': '',
  'default/v1/cached/GET/304': '',
  'default/v1/explicit-head/HEAD/200_{text-plain}.txt': 'head body',
  'default/v1/explicit-head/GET/200_{application-json}.json': '{}',
  'default/v1/café/GET/200_{text-plain}.txt': 'unicode',
  'default/v1/a b/GET/200_{text-plain}.txt': 'space',
});

const request = (method: string, target: string, extra: Partial<RequestDescription> = {}): RequestDescription => ({
  method,
  target,
  headers: {},
  ...extra,
});

const text = (response: ResponseDescription): string | null =>
  response.body === null ? null : new TextDecoder().decode(response.body);

const envelope = (response: ResponseDescription): unknown => JSON.parse(text(response) ?? 'null');

describe('engine.resolve', () => {
  it('returns a promise', () => {
    const pending = engine.resolve(request('GET', '/'));
    expect(pending).toBeInstanceOf(Promise);
    return pending;
  });

  it('replays an exact match: status, headers, content type, and exact bytes', async () => {
    const response = await engine.resolve(request('GET', '/v1/products?page=2'));
    expect(response).toMatchObject({
      kind: 'response',
      status: 200,
      headers: {
        'content-type': ['application/json'],
        'set-cookie': ['a=1', 'b=2'],
        'x-example': ['fixture'],
      },
      trace: {
        snapshotVersion: version,
        scenario: 'default',
        normalizedPath: '/v1/products',
        outcome: { kind: 'matched', fixture: { path: 'default/v1/products/GET/200_{application-json}.json' } },
      },
    });
    expect(text(response)).toBe(PRODUCTS_JSON);
  });

  it('matches the root path and each method separately', async () => {
    expect(text(await engine.resolve(request('GET', '/')))).toBe('root');
    const created = await engine.resolve(request('post', '/v1/products'));
    expect(created.status).toBe(201);
    expect(created.headers['location']).toEqual(['/v1/products/p-2']);
  });

  it('matches percent-encoded and Unicode paths after normalisation', async () => {
    expect(text(await engine.resolve(request('GET', '/v1/caf%C3%A9')))).toBe('unicode');
    expect(text(await engine.resolve(request('GET', '/v1/cafe%CC%81')))).toBe('unicode');
    expect(text(await engine.resolve(request('GET', '/v1/a%20b')))).toBe('space');
  });

  it('is case-sensitive and does not treat a trailing slash as the same path', async () => {
    expect((await engine.resolve(request('GET', '/V1/products'))).status).toBe(404);
    expect((await engine.resolve(request('GET', '/v1/products/'))).status).toBe(404);
  });

  it('returns no body for bodyless statuses', async () => {
    for (const [method, target, status] of [
      ['DELETE', '/v1/products/p-1', 204],
      ['PUT', '/v1/products/p-1', 205],
      ['GET', '/v1/cached', 304],
    ] as const) {
      const response = await engine.resolve(request(method, target));
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(response.headers).not.toHaveProperty('content-type');
    }
  });

  it('answers HEAD from GET with the same status and headers, plus the GET length, but no body', async () => {
    const get = await engine.resolve(request('GET', '/v1/products'));
    const head = await engine.resolve(request('HEAD', '/v1/products'));
    expect(head.status).toBe(get.status);
    // HEAD states the Content-Length GET would send.
    expect(head.headers).toEqual({ ...get.headers, 'content-length': [String(get.body?.length)] });
    expect(head.body).toBeNull();
    expect(head.trace.outcome).toEqual(get.trace.outcome);
  });

  it('prefers an explicit HEAD fixture, still without a body', async () => {
    const head = await engine.resolve(request('HEAD', '/v1/explicit-head'));
    expect(head.headers['content-type']).toEqual(['text/plain']);
    expect(head.body).toBeNull();
  });

  it('classifies an unknown path as route-not-found without disclosing methods', async () => {
    const response = await engine.resolve(request('GET', '/v1/missing', { requestId: 'req-1' }));
    expect(response.status).toBe(404);
    // A Janus-generated error after selection names the scenario.
    expect(response.headers).toEqual({ 'content-type': ['application/json'], 'x-mock-scenario': ['default'] });
    expect(response.trace).toEqual({
      snapshotVersion: version,
      scenario: 'default',
      normalizedPath: '/v1/missing',
      outcome: { kind: 'route-not-found' },
      // The /v1 prefix was entered and abandoned.
      route: { template: null, params: {}, considered: ['/v1'] },
      session: { id: null, source: 'default', exists: false },
      selection: { source: 'default', chain: ['default'] },
      // Present for every request to a fixture path.
      transport: {
        latency: null,
        fault: null,
        rulesTried: 0,
        performed: true,
        requestCodings: [],
        responseCoding: null,
      },
    });
    expect(envelope(response)).toEqual({
      error: { code: 'route-not-found', message: 'No fixture matches GET /v1/missing', requestId: 'req-1' },
    });
  });

  it('treats a prefix of a route as route-not-found', async () => {
    expect((await engine.resolve(request('GET', '/v1'))).trace.outcome.kind).toBe('route-not-found');
  });

  it('classifies a known path with another method as method-not-allowed, with a sorted Allow', async () => {
    const response = await engine.resolve(request('PATCH', '/v1/products'));
    expect(response.status).toBe(405);
    // Allow includes OPTIONS, which Janus answers itself.
    expect(response.headers['allow']).toEqual(['GET, HEAD, OPTIONS, POST']);
    expect(response.trace.outcome).toEqual({
      kind: 'method-not-allowed',
      allowed: ['GET', 'HEAD', 'OPTIONS', 'POST'],
    });
    expect(envelope(response)).toMatchObject({ error: { code: 'method-not-allowed' } });

    const noGet = await engine.resolve(request('GET', '/v1/products/p-1'));
    expect(noGet.headers['allow']).toEqual(['DELETE, OPTIONS, PUT']);
  });

  it('suppresses error bodies for HEAD, stating the length GET would send (review A10)', async () => {
    const response = await engine.resolve(request('HEAD', '/v1/missing', { requestId: 'r-1' }));
    expect(response.status).toBe(404);
    expect(response.body).toBeNull();
    const envelope =
      '{"error":{"code":"route-not-found","message":"No fixture matches HEAD /v1/missing","requestId":"r-1"}}';
    expect(response.headers['content-length']).toEqual([String(envelope.length)]);
  });

  it.each([
    ['GET', '/v1/%zz', 'malformed'],
    ['GET', '/v1/../etc', 'dot-segment'],
    ['GET', 'v1/products', 'must be a path'],
    ['BAD METHOD', '/', 'method'],
    ['', '/', 'method'],
  ])('rejects %s %s as invalid-request without lookup', async (method, target, reason) => {
    const response = await engine.resolve(request(method, target));
    expect(response.status).toBe(400);
    expect(response.trace.normalizedPath).toBe('');
    expect(response.trace.outcome.kind).toBe('invalid-request');
    if (response.trace.outcome.kind === 'invalid-request') expect(response.trace.outcome.reason).toContain(reason);
    expect(envelope(response)).toMatchObject({ error: { code: 'invalid-request' } });
    expect(JSON.stringify(envelope(response))).not.toContain('requestId');
  });

  it('rejects scenarios other than default', async () => {
    const response = await engine.resolve(request('GET', '/', { scenario: 'checkout' }));
    expect(response.status).toBe(400);
    expect(response.trace.scenario).toBe('checkout');
  });

  it('rejects when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(engine.resolve(request('GET', '/'), { signal: controller.signal })).rejects.toThrow();
  });

  it('does not mutate the request or let callers mutate the snapshot', async () => {
    const makeRequest = (): RequestDescription => ({
      method: 'get',
      target: '/v1/products?x=1',
      headers: { accept: ['application/json'] },
      body: new Uint8Array([1, 2, 3]),
      requestId: 'req-1',
    });
    const input = makeRequest();
    const first = await engine.resolve(input);
    expect(input).toStrictEqual(makeRequest());

    first.body?.fill(0);
    expect(() => {
      (first.headers['x-example'] as string[]).push('mutated');
    }).toThrow();
    const second = await engine.resolve(makeRequest());
    expect(text(second)).toBe(PRODUCTS_JSON);
    expect(second.headers['x-example']).toEqual(['fixture']);
  });

  it('returns identical results for concurrent requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => engine.resolve(request('GET', '/v1/products'))),
    );
    for (const response of responses) expect(text(response)).toBe(PRODUCTS_JSON);
  });

  it('refuses a snapshot that buildSnapshot did not create', () => {
    expect(() => createEngine({ snapshot: { version: 'x', fixtureCount: 0, routeCount: 0 } })).toThrow(TypeError);
  });
});

describe('engine.resolve with localized responses', () => {
  const { engine: localized } = engineFor({
    'default/greeting/GET/200_[en-US]_{application-json}.json': '{"text":"Hello"}',
    'default/greeting/GET/200_[fr]_{application-json}.json': '{"text":"Bonjour"}',
    'default/greeting/GET/200_{application-json}.json': '{"text":"Hi"}',
    'default/greeting/GET/200.headers.json': '{"Vary":"Origin","X-Example":"shared"}',
    'default/strict/GET/200_[de]_{text-plain}.txt': 'Hallo',
    'default/strict/GET/200_[en-GB]_{text-plain}.txt': 'Hello',
    'default/article/GET/200_[en]_{text-html}.html': '<p>Article</p>',
    'default/article/GET/404_[fr]_{application-json}.json': '{"error":"pas traduit"}',
    'default/article/GET/404.headers.json': '{"X-Reason":"untranslated"}',
  });
  const get = (target: string, acceptLanguage?: string, method = 'GET'): Promise<ResponseDescription> =>
    localized.resolve(
      request(method, target, acceptLanguage === undefined ? {} : { headers: { 'accept-language': [acceptLanguage] } }),
    );

  it('selects the representation named by Accept-Language', async () => {
    const response = await get('/greeting', 'fr-CA, en;q=0.5');
    expect(response).toMatchObject({
      status: 200,
      headers: {
        'content-type': ['application/json'],
        'content-language': ['fr'],
        vary: ['Origin', 'Accept, Accept-Language'],
        'x-example': ['shared'],
      },
      trace: {
        outcome: { kind: 'matched', fixture: { path: 'default/greeting/GET/200_[fr]_{application-json}.json' } },
      },
    });
    expect(text(response)).toBe('{"text":"Bonjour"}');
    expect((await get('/greeting', 'en-us')).headers['content-language']).toEqual(['en-US']);
  });

  it('uses the language-neutral response when nothing matches or no language is asked for', async () => {
    for (const header of [undefined, 'it', '*']) {
      const response = await get('/greeting', header);
      expect(text(response)).toBe('{"text":"Hi"}');
      expect(response.headers['content-language']).toBeUndefined();
      expect(response.headers['vary']).toEqual(['Origin', 'Accept, Accept-Language']);
    }
  });

  it('extends a bare language to a regional tag, and serves any locale when none is asked for', async () => {
    expect(text(await get('/strict', 'en'))).toBe('Hello');
    expect(text(await get('/strict'))).toBe('Hallo');
  });

  it('answers 406 not-acceptable when no locale matches and there is no neutral response', async () => {
    const response = await get('/strict', 'it, fr;q=0.5');
    expect(response).toMatchObject({
      status: 406,
      headers: { 'content-type': ['application/json'], vary: ['Accept-Language'] },
      trace: { outcome: { kind: 'not-acceptable', axis: 'language', available: ['de', 'en-GB'] } },
    });
    expect(envelope(response)).toEqual({
      error: {
        code: 'not-acceptable',
        message: 'No response for GET /strict matches Accept-Language; available: de, en-GB',
      },
    });
    expect((await get('/strict', 'it', 'HEAD')).body).toBeNull();
  });

  it('replays the status, media type, and sidecar of the selected locale', async () => {
    const english = await get('/article', 'en');
    expect(english).toMatchObject({
      status: 200,
      headers: { 'content-type': ['text/html'], 'content-language': ['en'], vary: ['Accept, Accept-Language'] },
    });
    expect(english.headers['x-reason']).toBeUndefined();
    const french = await get('/article', 'fr-FR');
    expect(french).toMatchObject({
      status: 404,
      headers: {
        'content-type': ['application/json'],
        'content-language': ['fr'],
        'x-reason': ['untranslated'],
      },
      trace: {
        outcome: { kind: 'matched', fixture: { path: 'default/article/GET/404_[fr]_{application-json}.json' } },
      },
    });
    expect(text(french)).toBe('{"error":"pas traduit"}');
  });

  it('negotiates HEAD like GET', async () => {
    const response = await get('/greeting', 'fr', 'HEAD');
    expect(response.headers['content-language']).toEqual(['fr']);
    expect(response.body).toBeNull();
  });

  it('leaves non-localized routes unaffected by Accept-Language', async () => {
    const response = await engine.resolve(request('GET', '/', { headers: { 'accept-language': ['fr'] } }));
    expect(text(response)).toBe('root');
    expect(response.headers['vary']).toEqual(['Accept']);
  });
});

describe('engine configuration', () => {
  const tree = {
    'default/GET/200_{text-plain}.txt': 'root',
    'default/a/GET/200_{text-plain}.txt': 'a',
    'default/a/POST/201_{text-plain}.txt': 'created',
  };
  const configured = (config: Parameters<typeof createEngine>[0]['config']): Engine => {
    const result = buildSnapshot(new Map(Object.entries(tree).map(([path, value]) => [path, utf8Encode(value)])));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return createEngine({ snapshot: result.snapshot, ...(config === undefined ? {} : { config }) });
  };

  it('keeps the default: "/a/" never matches "/a"', async () => {
    const response = await configured(undefined).resolve(request('GET', '/a/'));
    expect(response.status).toBe(404);
    expect(response.trace.normalizedPath).toBe('/a/');
  });

  describe('strictTrailingSlash: false', () => {
    const lenient = configured({ strictTrailingSlash: false, onUnknownMethod: 405 });

    it('drops exactly one trailing "/" before matching', async () => {
      const response = await lenient.resolve(request('GET', '/a/?x=1'));
      expect(response.status).toBe(200);
      expect(text(response)).toBe('a');
      expect(response.trace).toMatchObject({ normalizedPath: '/a', outcome: { kind: 'matched' } });
    });

    it('still rejects "/a//" and leaves "/" unchanged', async () => {
      expect((await lenient.resolve(request('GET', '/a//'))).trace.outcome.kind).toBe('invalid-request');
      expect(text(await lenient.resolve(request('GET', '/')))).toBe('root');
    });
  });

  describe('onUnknownMethod: 404', () => {
    const hidden = configured({ strictTrailingSlash: true, onUnknownMethod: 404 });

    it('answers OPTIONS on a known path with 204 and no Allow', async () => {
      const response = await hidden.resolve(request('OPTIONS', '/a'));
      expect(response.status).toBe(204);
      expect(response.headers['allow']).toBeUndefined();
      expect(response.body).toBeNull();
    });

    it.each(['DELETE', 'PATCH'])('answers %s on a known path as route-not-found without Allow', async (method) => {
      const response = await hidden.resolve(request(method, '/a'));
      expect(response.status).toBe(404);
      expect(response.headers['allow']).toBeUndefined();
      expect(response.trace.outcome).toEqual({ kind: 'route-not-found' });
      expect(JSON.parse(text(response) ?? '')).toMatchObject({
        error: { code: 'route-not-found', message: `No fixture matches ${method} /a` },
      });
    });

    it('still lets HEAD fall back to GET, and answers HEAD without GET as a bodyless 404', async () => {
      expect((await hidden.resolve(request('HEAD', '/a'))).status).toBe(200);
      const result = buildSnapshot(new Map([['default/p/POST/201_{text-plain}.txt', utf8Encode('x')]]));
      if (!result.ok) throw new Error('invalid');
      const postOnly = createEngine({
        snapshot: result.snapshot,
        config: { strictTrailingSlash: true, onUnknownMethod: 404 },
      });
      const head = await postOnly.resolve(request('HEAD', '/p'));
      expect(head.status).toBe(404);
      expect(head.body).toBeNull();
      expect(head.headers['allow']).toBeUndefined();
      expect(head.trace.outcome).toEqual({ kind: 'route-not-found' });
    });

    it('is byte-identical to a miss on an unknown path', async () => {
      const unknown = await hidden.resolve(request('PUT', '/nowhere', { requestId: 'r' }));
      const known = await hidden.resolve(request('PUT', '/a', { requestId: 'r' }));
      expect(known.status).toBe(unknown.status);
      expect(Object.keys(known.headers)).toEqual(Object.keys(unknown.headers));
      expect(text(known)?.replace('/a', '/nowhere')).toBe(text(unknown));
    });
  });
});
