import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import type { EngineConfig } from '../config/merge.js';
import { createEngine } from '../create-engine.js';
import { buildSnapshot } from '../fixtures/build.js';
import type { Engine, HeaderMap, RequestDescription, ResponseDescription } from '../types/index.js';

// Resolution rules.

function engineFor(entries: Readonly<Record<string, string>>, config: Partial<EngineConfig> = {}): Engine {
  const result = buildSnapshot(new Map(Object.entries(entries).map(([path, text]) => [path, utf8Encode(text)])));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return createEngine({ snapshot: result.snapshot, config });
}

const request = (method: string, target: string, headers: HeaderMap = {}, body?: string): RequestDescription => ({
  method,
  target,
  headers,
  ...(body === undefined ? {} : { body: utf8Encode(body) }),
});

const text = (response: ResponseDescription): string | null =>
  response.body === null ? null : new TextDecoder().decode(response.body);

const envelope = (response: ResponseDescription): unknown => JSON.parse(text(response) ?? 'null');

/** The `X-Mock-*` headers a response carries, apart scenario headers. */
const fixtureHeaders = (response: ResponseDescription): string[] =>
  Object.keys(response.headers).filter(
    (name) => name.startsWith('x-mock-') && name !== 'x-mock-scenario' && name !== 'x-mock-resolved-from',
  );

describe('path parameters', () => {
  const engine = engineFor({
    'default/v1/products/{productId}/GET/200_{text-plain}.txt': 'product',
    'default/v1/products/{productId}/reviews/GET/200_{text-plain}.txt': 'reviews',
    'default/v1/products/{productId}/reviews/{reviewId}/GET/200_{text-plain}.txt': 'review',
    'default/v1/products/featured/GET/200_{text-plain}.txt': 'featured',
    'default/v1/products/featured/POST/201_{text-plain}.txt': 'created',
    'default/v1/products/{productId}/POST/201_{text-plain}.txt': 'created by id',
    'default/a/{x}/c/GET/200_{text-plain}.txt': 'a/{x}/c',
    'default/a/b/{y}/GET/200_{text-plain}.txt': 'a/b/{y}',
    'default/{root}/GET/200_{text-plain}.txt': 'root template',
  });
  const get = (target: string, method = 'GET') => engine.resolve(request(method, target));

  it('binds the decoded segment and records the template in the trace', async () => {
    const response = await get('/v1/products/p%2D42%20x');
    expect(text(response)).toBe('product');
    expect(response.trace.route).toEqual({
      template: '/v1/products/{productId}',
      params: { productId: 'p-42 x' },
      considered: [],
    });
  });

  it('binds several parameters', async () => {
    const response = await get('/v1/products/p-1/reviews/r-9');
    expect(text(response)).toBe('review');
    expect(response.trace.route).toEqual({
      template: '/v1/products/{productId}/reviews/{reviewId}',
      params: { productId: 'p-1', reviewId: 'r-9' },
      considered: [],
    });
  });

  it('prefers a literal child over the template child', async () => {
    const response = await get('/v1/products/featured');
    expect(text(response)).toBe('featured');
    expect(response.trace.route).toEqual({ template: '/v1/products/featured', params: {}, considered: [] });
  });

  it('backtracks into the template when the literal branch has nothing deeper', async () => {
    const response = await get('/v1/products/featured/reviews');
    expect(text(response)).toBe('reviews');
    expect(response.trace.route?.params).toEqual({ productId: 'featured' });
    // The abandoned literal branch is part of the explanation.
    expect(response.trace.route?.considered).toEqual(['/v1/products/featured']);
  });

  it('lists nested abandoned branches in the order tried', async () => {
    // /a/b/{y} is tried first and dead-ends at /a/b/c; the literal /a/b is then abandoned for /a/{x}.
    const response = await get('/a/b/c/d');
    expect(response.status).toBe(404);
    expect(response.trace.route).toEqual({
      template: null,
      params: {},
      considered: ['/a', '/a/b', '/a/b/{y}', '/a/{x}', '/a/{x}/c', '/{root}'],
    });
    const nested = await get('/a/z/c');
    expect(nested.trace.route).toEqual({
      template: '/a/{x}/c',
      params: { x: 'z' },
      considered: [],
    });
  });

  // The tie table: literal at the earliest differing segment wins.
  it.each([
    ['/a/b/c', 'a/b/{y}'],
    ['/a/b/z', 'a/b/{y}'],
    ['/a/z/c', 'a/{x}/c'],
  ])('%s is answered by %s', async (target, expected) => {
    expect(text(await get(target))).toBe(expected);
  });

  it('treats the matched node as authoritative for methods', async () => {
    const response = await get('/v1/products/featured', 'DELETE');
    expect(response.status).toBe(405);
    expect(response.headers['allow']).toEqual(['GET, HEAD, OPTIONS, POST']);
    expect(response.trace.route?.template).toBe('/v1/products/featured');
    // POST exists at the literal node; the template's POST is never reached.
    expect(text(await get('/v1/products/featured', 'POST'))).toBe('created');
  });

  it('does not continue past a matched node that lacks the method', async () => {
    const lone = engineFor({
      'default/v1/products/featured/GET/200_{text-plain}.txt': 'featured',
      'default/v1/products/{productId}/POST/201_{text-plain}.txt': 'created',
    });
    const response = await lone.resolve(request('POST', '/v1/products/featured'));
    expect(response.status).toBe(405);
    expect(response.trace.outcome).toEqual({ kind: 'method-not-allowed', allowed: ['GET', 'HEAD', 'OPTIONS'] });
  });

  it('matches only non-empty segments', async () => {
    expect((await get('/v1/products/')).status).toBe(404);
  });

  it('never binds the reserved Atlas namespace to a root template', async () => {
    expect(text(await get('/anything'))).toBe('root template');
    const reserved = await get('/_janus');
    expect(reserved.status).toBe(404);
    expect(reserved.trace.route).toBeUndefined();
  });

  it('reports a miss with a null template and every abandoned prefix', async () => {
    const response = await get('/nowhere/at/all');
    expect(response.status).toBe(404);
    expect(response.trace.route).toEqual({ template: null, params: {}, considered: ['/{root}'] });
  });

  it('has no route in the trace when no template was considered', async () => {
    const lone = engineFor({ 'default/v1/GET/200_{text-plain}.txt': 'v1' });
    const response = await lone.resolve(request('GET', '/nowhere'));
    expect(response.status).toBe(404);
    expect(response.trace.route).toBeUndefined();
  });
});

describe('media-type negotiation', () => {
  const tree = {
    'default/p/GET/200_{application-json}.json': '{"id":1}',
    'default/p/GET/200_{application-yaml}.yaml': 'id: 1\n',
    'default/p/GET/200.headers.json': '{"X-Shared":"yes"}',
    'default/single/GET/200_{application-json}.json': '{}',
    'default/greeting/GET/200_{application-json}.json': '{"text":"Hi"}',
    'default/greeting/GET/200_[fr]_{application-json}.json': '{"text":"Bonjour"}',
    'default/greeting/GET/200_[fr]_{text-html}.html': '<p>Bonjour</p>',
    'default/empty/DELETE/204': '',
  };
  const engine = engineFor(tree);
  const get = (target: string, headers: HeaderMap = {}, method = 'GET') =>
    engine.resolve(request(method, target, headers));

  it('selects the file named by Accept', async () => {
    const yaml = await get('/p', { accept: ['application/yaml'] });
    expect(text(yaml)).toBe('id: 1\n');
    expect(yaml.headers).toMatchObject({
      'content-type': ['application/yaml'],
      vary: ['Accept'],
      'x-shared': ['yes'],
    });
    expect(yaml.trace.negotiation).toEqual({
      mediaType: {
        requested: 'application/yaml',
        available: ['application/json', 'application/yaml'],
        selected: 'application/yaml',
        droppedRanges: [],
      },
    });
  });

  it('serves the first by lexical order for */* or no Accept', async () => {
    expect(text(await get('/p'))).toBe('{"id":1}');
    expect((await get('/p')).trace.negotiation?.mediaType?.requested).toBeNull();
    expect(text(await get('/p', { accept: ['*/*'] }))).toBe('{"id":1}');
  });

  it('answers 406 with the JSON envelope naming the offered types, and Vary: Accept', async () => {
    const response = await get('/p', { accept: ['text/csv'] });
    expect(response).toMatchObject({
      status: 406,
      headers: { 'content-type': ['application/json'], vary: ['Accept'] },
      trace: {
        outcome: { kind: 'not-acceptable', axis: 'media-type', available: ['application/json', 'application/yaml'] },
        route: { template: '/p', params: {} },
      },
    });
    expect(envelope(response)).toEqual({
      error: {
        code: 'not-acceptable',
        message: 'No response for GET /p matches Accept; available: application/json, application/yaml',
      },
    });
    expect(fixtureHeaders(response)).toEqual([]);
  });

  it('varies on Accept even with a single representation', async () => {
    expect((await get('/single')).headers['vary']).toEqual(['Accept']);
    expect((await get('/single', { accept: ['text/csv'] })).status).toBe(406);
  });

  it('skips media-type negotiation for a bodyless group', async () => {
    const response = await get('/empty', { accept: ['text/csv'] }, 'DELETE');
    expect(response.status).toBe(204);
    expect(response.headers['vary']).toBeUndefined();
    expect(response.trace.negotiation).toBeUndefined();
    expect((await get('/empty', { accept: ['garbage'] }, 'DELETE')).status).toBe(204);
  });

  it('chooses the locale first, then the media type within it', async () => {
    const html = await get('/greeting', { 'accept-language': ['fr'], accept: ['text/html'] });
    expect(text(html)).toBe('<p>Bonjour</p>');
    expect(html.headers).toMatchObject({ 'content-language': ['fr'], vary: ['Accept, Accept-Language'] });
    expect(html.trace.negotiation).toEqual({
      language: { requested: 'fr', selected: 'fr' },
      mediaType: {
        requested: 'text/html',
        available: ['application/json', 'text/html'],
        selected: 'text/html',
        droppedRanges: [],
      },
    });
    // Locale never changes because of media type: the neutral group has no HTML.
    const neutral = await get('/greeting', { accept: ['text/html'] });
    expect(neutral.status).toBe(406);
    expect(neutral.headers['vary']).toEqual(['Accept, Accept-Language']);
    expect(neutral.trace.negotiation?.language).toEqual({ requested: null, selected: null });
  });

  it('negotiates HEAD exactly like GET', async () => {
    const headers = { accept: ['application/yaml'] };
    const got = await get('/p', headers);
    const head = await get('/p', headers, 'HEAD');
    expect(head.body).toBeNull();
    expect(head.headers).toEqual({ ...got.headers, 'content-length': [String(got.body?.length)] });
    expect((await get('/p', { accept: ['text/csv'] }, 'HEAD')).status).toBe(406);
  });

  describe('unusable Accept headers', () => {
    it('drops malformed ranges and warns once per dropped range', async () => {
      const response = await get('/p', { accept: ['application/yaml;q=2, application/json, text/;q=1'] });
      expect(text(response)).toBe('{"id":1}');
      expect(response.headers['x-mock-warning']).toEqual([
        '199 janus "ignored Accept range application/yaml;q=2"',
        '199 janus "ignored Accept range text/;q=1"',
      ]);
      // The trace names positions only: it never quotes request headers.
      expect(response.trace.negotiation?.mediaType?.droppedRanges).toEqual(['#1', '#3']);
    });

    it('onUnusableAccept 400 (default): answers invalid-request naming the header', async () => {
      const response = await get('/p', { accept: ['garbage'] });
      expect(response.status).toBe(400);
      expect(envelope(response)).toMatchObject({ error: { code: 'invalid-request' } });
      expect(JSON.stringify(envelope(response))).toContain('Accept');
      expect(fixtureHeaders(response)).toEqual([]);
    });

    it('onUnusableAccept any: treats it as */*', async () => {
      const lenient = engineFor(tree, { onUnusableAccept: 'any' });
      const response = await lenient.resolve(request('GET', '/p', { accept: ['garbage'] }));
      expect(text(response)).toBe('{"id":1}');
      expect(response.headers['x-mock-warning']).toEqual(['199 janus "ignored Accept range garbage"']);
    });

    it('treats an empty Accept as absent', async () => {
      expect((await get('/p', { accept: [''] })).status).toBe(200);
    });
  });

  describe('onUnacceptable', () => {
    it('ignore: serves the first by mediaTypePreference, then lexical order', async () => {
      const ignoring = engineFor(tree, { onUnacceptable: 'ignore' });
      expect(text(await ignoring.resolve(request('GET', '/p', { accept: ['text/csv'] })))).toBe('{"id":1}');
      const preferring = engineFor(tree, { onUnacceptable: 'ignore', mediaTypePreference: ['application/yaml'] });
      expect(text(await preferring.resolve(request('GET', '/p', { accept: ['text/csv'] })))).toBe('id: 1\n');
    });

    it('mediaTypePreference breaks ties when Accept does not', async () => {
      const preferring = engineFor(tree, { mediaTypePreference: ['application/yaml'] });
      expect(text(await preferring.resolve(request('GET', '/p')))).toBe('id: 1\n');
      expect(text(await preferring.resolve(request('GET', '/p', { accept: ['application/json'] })))).toBe('{"id":1}');
    });
  });
});

describe('request media types', () => {
  const tree = {
    'default/p/POST/accepts.yaml': 'accepts: [application/json, multipart/form-data]\n',
    'default/p/POST/201_{application-json}.json': '{"id":2}',
    'default/p/PATCH/accepts.yaml': 'accepts: [application/merge-patch+json]\n',
    'default/p/PATCH/200_{application-json}.json': '{}',
    'default/p/PUT/accepts.yaml': 'accepts: [application/json]\nallowMissingContentType: application/json\n',
    'default/p/PUT/200_{application-json}.json': '{}',
    'default/open/POST/201_{application-json}.json': '{}',
  };
  const engine = engineFor(tree);
  const send = (method: string, target: string, contentType: string | null, body?: string) =>
    engine.resolve(request(method, target, contentType === null ? {} : { 'content-type': [contentType] }, body));

  // One case per row of the table.
  it.each([
    ['absent body, anything, either', 'POST', '/p', 'text/xml', undefined, 201],
    ['empty body counts as absent', 'POST', '/p', 'text/xml', '', 201],
    ['present body, anything, no accepts.yaml', 'POST', '/open', 'text/xml', '<x/>', 201],
    ['present body, absent Content-Type, accepts.yaml', 'POST', '/p', null, '{}', 415],
    ['present body, absent Content-Type, allowMissingContentType', 'PUT', '/p', null, '{}', 200],
    ['present body, listed Content-Type', 'POST', '/p', 'application/json', '{}', 201],
    ['present body, unlisted Content-Type', 'POST', '/p', 'application/xml', '<p/>', 415],
  ])('%s', async (_name, method, target, contentType, body, status) => {
    expect((await send(method, target, contentType, body)).status).toBe(status);
  });

  it('compares type and subtype only, case-insensitively', async () => {
    expect((await send('POST', '/p', 'Application/JSON; charset=utf-8', '{}')).status).toBe(201);
    expect((await send('POST', '/p', 'multipart/form-data; boundary=x', '--x--')).status).toBe(201);
  });

  it('answers 415 with the envelope, the accepted list and Accept-Post', async () => {
    const response = await send('POST', '/p', 'application/xml', '<p/>');
    expect(response).toMatchObject({
      status: 415,
      headers: { 'content-type': ['application/json'], 'accept-post': ['application/json, multipart/form-data'] },
      trace: {
        outcome: { kind: 'unsupported-media-type', accepted: ['application/json', 'multipart/form-data'] },
        route: { template: '/p' },
      },
    });
    expect(envelope(response)).toEqual({
      error: {
        code: 'unsupported-media-type',
        message:
          "POST /p does not accept this request body's media type; accepted: application/json, multipart/form-data",
      },
    });
    expect(fixtureHeaders(response)).toEqual([]);
  });

  it('sets Accept-Patch for PATCH and neither header for other methods', async () => {
    const patch = await send('PATCH', '/p', 'application/json', '{}');
    expect(patch.status).toBe(415);
    expect(patch.headers['accept-patch']).toEqual(['application/merge-patch+json']);
    const put = await send('PUT', '/p', 'text/plain', 'x');
    expect(put.status).toBe(415);
    expect(put.headers['accept-post']).toBeUndefined();
    expect(put.headers['accept-patch']).toBeUndefined();
  });

  it('answers 400 for a malformed Content-Type with a body', async () => {
    for (const contentType of ['json', 'application/json; charset']) {
      const response = await send('POST', '/p', contentType, '{}');
      expect(response.status).toBe(400);
      expect(envelope(response)).toMatchObject({ error: { code: 'invalid-request' } });
    }
    const twice = await engine.resolve(
      request('POST', '/p', { 'content-type': ['application/json', 'application/json'] }, '{}'),
    );
    expect(twice.status).toBe(400);
  });

  it('checks the body before negotiating', async () => {
    const response = await engine.resolve(
      request('POST', '/p', { 'content-type': ['application/xml'], accept: ['text/csv'] }, '<p/>'),
    );
    expect(response.status).toBe(415);
  });
});

describe('diagnostic headers', () => {
  const tree = {
    'default/a/GET/200_{application-json}.json': '{"a":1}',
    'default/a/GET/200.headers.json':
      '{"Content-Type":"text/plain","Date":"Mon, 01 Jan 2001 00:00:00 GMT","Content-Length":"99","Set-Cookie":["x=1","y=2"]}',
    'default/b/GET/200_{application-json}.json': '{}',
  };
  const engine = engineFor(tree);

  it('names the served fixture in X-Mock-Identity, matching the trace and the Atlas ID', async () => {
    const response = await engine.resolve(request('GET', '/b'));
    const identity = response.headers['x-mock-identity'];
    expect(identity).toEqual([expect.stringMatching(/^fx_[0-9a-f]{16}$/) as unknown]);
    expect(response.trace.headers).toEqual({ identity: identity?.[0], dropped: [], contentTypeOverride: null });
    const endpoint = engine.atlas.inventory().items.find((item) => item.path === '/b');
    const detail = engine.atlas.endpoint(endpoint?.id ?? '', engine.atlas.health().snapshotVersion);
    expect(detail.kind === 'found' ? detail.value.fixtures[0]?.id : null).toBe(identity?.[0]);
  });

  it('sends a Content-Type override with X-Mock-Representation, and negotiates on the file name', async () => {
    const response = await engine.resolve(request('GET', '/a', { accept: ['application/json'] }));
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toEqual(['text/plain']);
    expect(response.headers['x-mock-representation']).toEqual(['application/json']);
    expect(response.trace.headers?.contentTypeOverride).toEqual({
      representation: 'application/json',
      wire: 'text/plain',
    });
    expect((await engine.resolve(request('GET', '/a', { accept: ['text/plain'] }))).status).toBe(406);
  });

  it('drops Janus-computed headers and replays repeated values', async () => {
    const response = await engine.resolve(request('GET', '/a'));
    expect(response.headers['date']).toBeUndefined();
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.headers['set-cookie']).toEqual(['x=1', 'y=2']);
    expect(response.trace.headers?.dropped).toEqual(['content-length', 'date']);
  });

  it('adds the same diagnostic headers to HEAD', async () => {
    const get = await engine.resolve(request('GET', '/a'));
    const head = await engine.resolve(request('HEAD', '/a'));
    expect(head.headers).toEqual({ ...get.headers, 'content-length': [String(get.body?.length)] });
  });

  it('adds none to Janus-generated errors', async () => {
    for (const target of ['/missing', '/a%zz']) {
      expect(fixtureHeaders(await engine.resolve(request('GET', target)))).toEqual([]);
    }
    expect(fixtureHeaders(await engine.resolve(request('POST', '/a')))).toEqual([]);
  });

  it('diagnostics.headers false removes every X-Mock-* header but keeps the trace', async () => {
    const quiet = engineFor(tree, { diagnosticHeaders: false });
    const response = await quiet.resolve(request('GET', '/a', { accept: ['bad;;, application/json'] }));
    expect(fixtureHeaders(response)).toEqual([]);
    expect(response.headers['content-type']).toEqual(['text/plain']);
    expect(response.trace.headers?.identity).toMatch(/^fx_[0-9a-f]{16}$/);
    expect(response.trace.headers?.identity).toBe(
      (await engine.resolve(request('GET', '/a'))).headers['x-mock-identity']?.[0],
    );
    expect(response.trace.negotiation?.mediaType?.droppedRanges).toEqual(['#1']);
  });
});

describe('trace privacy', () => {
  it('never contains request header or body values', async () => {
    const engine = engineFor({
      'default/p/{id}/POST/accepts.yaml': 'accepts: [application/json]\n',
      'default/p/{id}/POST/201_{application-json}.json': '{}',
      'default/p/{id}/POST/201_{text-plain}.txt': 'x',
    });
    const secret = 's3cr3t';
    const responses = await Promise.all([
      engine.resolve(
        request(
          'POST',
          `/p/42?token=${secret}`,
          {
            accept: [`text/plain;q=0.5, application/json;${secret}`],
            'accept-language': [`de-${secret}, ${secret}`],
            'content-type': [`application/json; charset=${secret}`],
            authorization: [secret],
          },
          `{"password":"${secret}"}`,
        ),
      ),
      engine.resolve(request('POST', '/p/42', { 'content-type': [`application/${secret}`] }, secret)),
    ]);
    for (const response of responses) {
      expect(response.trace.route?.params).toEqual({ id: '42' });
      expect(JSON.stringify(response.trace)).not.toContain(secret);
    }
  });
});
