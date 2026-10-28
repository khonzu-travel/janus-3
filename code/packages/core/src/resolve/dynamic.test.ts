import { afterEach, describe, expect, it, vi } from 'vitest';

import { utf8Encode } from '../bytes.js';
import type { EngineConfig } from '../config/merge.js';
import { createEngine, type CreateEngineOptions } from '../create-engine.js';
import { buildSnapshot } from '../fixtures/build.js';
import type { Engine, HeaderMap, RequestDescription, ResponseDescription } from '../types/index.js';

// Rendering, the clock and determinism.

type Tree = Readonly<Record<string, string | Uint8Array>>;

function engineFor(
  tree: Tree,
  options: Omit<CreateEngineOptions, 'snapshot'> & { aliases?: Record<string, string> } = {},
): Engine {
  const files = new Map(
    Object.entries(tree).map(([path, value]) => [path, typeof value === 'string' ? utf8Encode(value) : value]),
  );
  const result = buildSnapshot(files, { aliases: options.aliases ?? {} });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return createEngine({ ...options, snapshot: result.snapshot });
}

const NOW = '2026-01-01T00:00:00Z';
const NOW_MS = Date.UTC(2026, 0, 1);

const get = (target: string, headers: HeaderMap = {}, extra: Partial<RequestDescription> = {}): RequestDescription => ({
  method: 'GET',
  target,
  headers: { 'x-mock-now': [NOW], ...headers },
  ...extra,
});

const text = (response: ResponseDescription): string => new TextDecoder().decode(response.body ?? new Uint8Array());
const json = (response: ResponseDescription): unknown => JSON.parse(text(response));

const PRODUCT = JSON.stringify(
  {
    id: '{{$path.productId}}',
    name: '{{$faker.commerce.productName}}',
    restockDate: '{{$today+14d}}',
    updatedAt: '{{$now}}',
  },
  null,
  2,
);

describe('the scope example', () => {
  const engine = engineFor(
    { 'default/v1/products/{productId}/GET/200_{application-json}.json': PRODUCT },
    { config: { seed: 42 } },
  );

  it('renders the clock, the request and a generated value', async () => {
    const response = await engine.resolve(get('/v1/products/p-42'));
    expect(response.status).toBe(200);
    expect(json(response)).toEqual({
      id: 'p-42',
      name: expect.any(String) as unknown,
      restockDate: '2026-01-15',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    // Compact JSON in source key order.
    expect(text(response)).toMatch(
      /^\{"id":"p-42","name":"[^"]+","restockDate":"2026-01-15","updatedAt":"2026-01-01T00:00:00Z"\}$/,
    );
  });

  it('gives the same bytes for the same request, and other values for another parameter', async () => {
    const first = text(await engine.resolve(get('/v1/products/p-42')));
    expect(text(await engine.resolve(get('/v1/products/p-42')))).toBe(first);
    const other = json(await engine.resolve(get('/v1/products/p-43'))) as { name: string };
    expect(other.name).not.toBe((JSON.parse(first) as { name: string }).name);
  });

  it('shifts dates with another X-Mock-Now', async () => {
    const response = await engine.resolve(get('/v1/products/p-42', { 'x-mock-now': ['2026-03-01T12:00:00+02:00'] }));
    expect(json(response)).toMatchObject({ restockDate: '2026-03-15', updatedAt: '2026-03-01T10:00:00Z' });
  });

  it('records the render in the trace, without request values', async () => {
    const response = await engine.resolve(get('/v1/products/p-42', { authorization: ['Bearer secret'] }));
    expect(response.trace.render).toEqual({
      instant: NOW,
      clockSource: 'request-header',
      tokens: 4,
      nondeterministic: false,
    });
    expect(JSON.stringify(response.trace)).not.toContain('secret');
  });
});

describe('whole-value typing', () => {
  const engine = engineFor({
    'default/t/GET/200_{application-json}.json': JSON.stringify({
      qty: '{{$randomInt(1,5)}}',
      active: '{{$randomBool}}',
      date: '{{$today}}',
      ts: '{{$now:unix}}',
      label: 'Order {{$uuid}} on {{$today}}',
      name: '{{$body.$.customer.name}}',
      items: '{{$body.$.items}}',
      pick: '{{$randomFrom(1, "two", null)}}',
      missing: '{{$query.none}}',
      embeddedMissing: 'q={{$query.none}}!',
      nested: [{ deep: '{{$method}}' }],
      '{{$uuid}}': 'keys are never evaluated',
      escaped: '{{$$now}} is literal',
    }),
  });

  it('replaces a lone token with its natural type, and interpolates otherwise', async () => {
    const body = JSON.stringify({ customer: { name: { first: 'Ada' } }, items: [1, 2] });
    const response = await engine.resolve(
      get('/t', { 'content-type': ['application/json'] }, { method: 'POST', body: utf8Encode(body) }),
    );
    // POST is not defined; use GET with a body instead.
    expect(response.status).toBe(405);
    const result = json(
      await engine.resolve(get('/t', { 'content-type': ['application/json'] }, { body: utf8Encode(body) })),
    ) as Record<string, unknown>;
    expect(typeof result['qty']).toBe('number');
    expect([1, 2, 3, 4, 5]).toContain(result['qty']);
    expect(typeof result['active']).toBe('boolean');
    expect(result['date']).toBe('2026-01-01');
    expect(result['ts']).toBe(NOW_MS / 1000);
    expect(result['label']).toMatch(
      /^Order [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} on 2026-01-01$/,
    );
    expect(result['name']).toEqual({ first: 'Ada' });
    expect(result['items']).toEqual([1, 2]);
    expect([1, 'two', null]).toContain(result['pick']);
    expect(result['missing']).toBeNull();
    expect(result['embeddedMissing']).toBe('q=!');
    expect(result['nested']).toEqual([{ deep: 'GET' }]);
    expect(result['{{$uuid}}']).toBe('keys are never evaluated');
    expect(result['escaped']).toBe('{{$now}} is literal');
  });
});

describe('request values', () => {
  const tree: Tree = {
    'default/r/{id}/GET/200_{text-plain}.txt':
      'path={{$path.id}} query={{$query.q}} header={{$header.X-Trace}} method={{$method}} body={{$body.$.a}}',
    'default/r/{id}/POST/200_{text-plain}.txt': 'body={{$body.$.a}}',
  };
  const engine = engineFor(tree);

  it('reads the first query value, the first header value case-insensitively, and the method', async () => {
    const response = await engine.resolve(get('/r/7?q=1&q=2', { 'x-trace': ['abc', 'def'] }));
    expect(text(response)).toBe('path=7 query=1 header=abc method=GET body=');
  });

  it('reads the first JSON match from a JSON body, and treats other bodies as missing', async () => {
    const post = (contentType: string | null, body: string | null) =>
      engine.resolve({
        method: 'POST',
        target: '/r/1',
        headers: { 'x-mock-now': [NOW], ...(contentType === null ? {} : { 'content-type': [contentType] }) },
        ...(body === null ? {} : { body: utf8Encode(body) }),
      });
    expect(text(await post('application/json', '{"a":"x"}'))).toBe('body=x');
    expect(text(await post('application/vnd.acme+json; charset=utf-8', '{"a":[1]}'))).toBe('body=[1]');
    expect(text(await post('text/plain', '{"a":"x"}'))).toBe('body=');
    expect(text(await post(null, null))).toBe('body=');
    expect(text(await post('application/json', '{"b":1}'))).toBe('body=');
  });

  it('answers 400 invalid-request for a malformed JSON body a token reads', async () => {
    const response = await engine.resolve({
      method: 'POST',
      target: '/r/1',
      headers: { 'content-type': ['application/json'], 'x-mock-now': [NOW] },
      body: utf8Encode('{"a":'),
      requestId: 'r1',
    });
    expect(response.status).toBe(400);
    expect(json(response)).toEqual({
      error: {
        code: 'invalid-request',
        message: 'Invalid request: the request body is not valid JSON',
        requestId: 'r1',
      },
    });
  });

  it('never parses the body when the fixture does not read it', async () => {
    const plain = engineFor({ 'default/x/POST/200_{text-plain}.txt': '{{$method}}' });
    const response = await plain.resolve({
      method: 'POST',
      target: '/x',
      headers: { 'content-type': ['application/json'], 'x-mock-now': [NOW] },
      body: utf8Encode('{'),
    });
    expect(text(response)).toBe('POST');
  });

  it('fails with 500 render-failed under strictRefs, naming the token and fixture but no request value', async () => {
    const strict = engineFor(tree, { config: { strictRefs: true } });
    const response = await strict.resolve(get('/r/7?other=secret', {}, { requestId: 'r2' }));
    expect(response.status).toBe(500);
    const envelope = json(response) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe('render-failed');
    expect(envelope.error.message).toMatch(/^Fixture fx_[0-9a-f]{16} could not be rendered at \{\{\$query\.q\}\}: /);
    expect(envelope.error.message).not.toContain('secret');
    expect(response.trace.outcome).toEqual({
      kind: 'render-failed',
      fixture: { path: 'default/r/{id}/GET/200_{text-plain}.txt' },
      token: 'query.q',
      reason: 'the request has no value for it and dynamic.strictRefs is true',
    });
    expect(response.headers['x-mock-identity']).toBeUndefined();
  });
});

describe('header sidecars', () => {
  const engine = engineFor({
    'default/h/GET/200_{text-plain}.txt': 'ok',
    'default/h/GET/200.headers.json': JSON.stringify({
      'X-Request-Id': '{{$header.X-Request-Id}}',
      'Set-Cookie': ['a={{$uuid}}', 'b={{$uuid}}', 'static'],
      Expires: '{{$tomorrow:http}}',
    }),
    'default/bad/GET/200_{text-plain}.txt': 'ok',
    'default/bad/GET/200.headers.json': '{"X-Echo":"{{$header.x-in}}"}',
  });

  it('renders replayed header values as strings', async () => {
    const response = await engine.resolve(get('/h', { 'x-request-id': ['abc'] }));
    expect(response.headers['x-request-id']).toEqual(['abc']);
    expect(response.headers['expires']).toEqual(['Fri, 02 Jan 2026 00:00:00 GMT']);
    const [a, b, c] = response.headers['set-cookie'] ?? [];
    expect(a).toMatch(/^a=[0-9a-f-]{36}$/);
    expect(b?.slice(2)).not.toBe(a?.slice(2));
    expect(c).toBe('static');
    expect(text(response)).toBe('ok');
  });

  it('renders non-ASCII text, reading a received value as the UTF-8 it carries', async () => {
    const unicode = engineFor({
      'default/u/GET/200_{text-plain}.txt': 'ok',
      'default/u/GET/200.headers.json': '{"X-Echo":"\u20ac {{$header.x-in}}"}',
    });
    // Node hands over one character per received byte: these are the UTF-8 bytes of "café".
    const response = await unicode.resolve(get('/u', { 'x-in': ['caf\u00c3\u00a9'] }));
    expect(response.status).toBe(200);
    expect(response.headers['x-echo']).toEqual(['\u20ac caf\u00e9']);
  });

  it('fails with render-failed rather than writing CR, LF or NUL into a header', async () => {
    for (const value of ['a\r\nX-Injected: 1', 'a\nb', 'a\u0000b']) {
      const response = await engine.resolve(get('/bad', { 'x-in': [value] }));
      expect(response.status).toBe(500);
      expect(response.trace.outcome).toMatchObject({
        kind: 'render-failed',
        token: 'header.x-in',
        reason: 'the rendered "x-echo" header value contains CR, LF, NUL or another control character',
      });
      expect(JSON.stringify(response.trace.outcome)).not.toContain(value);
      expect(response.headers['x-echo']).toBeUndefined();
    }
  });
});

describe('determinism', () => {
  const tree: Tree = {
    'default/d/{id}/GET/200_{application-json}.json': JSON.stringify({
      a: '{{$uuid}}',
      b: '{{$uuid}}',
      pair: '{{$uuid}}{{$uuid}}',
      n: '{{$randomInt(0,1000000000)}}',
      f: '{{$faker.person.fullName}}',
      u: '{{$ulid}}',
    }),
    'default/d/{id}/POST/200_{application-json}.json': '{"a":"{{$uuid}}"}',
  };
  const engine = engineFor(tree, { config: { seed: 1 } });
  const body = async (request: RequestDescription): Promise<Record<string, string>> =>
    json(await engine.resolve(request)) as Record<string, string>;

  it('gives the same bytes across 1 000 concurrent renders in shuffled order', async () => {
    const targets = Array.from({ length: 1000 }, (_, i) => `/d/${String(i % 10)}?page=${String(i % 3)}`);
    const expected = new Map<string, string>();
    for (const target of new Set(targets)) expected.set(target, text(await engine.resolve(get(target))));
    const shuffled = [...targets].sort((x, y) => ((x.length * 7919 + y.charCodeAt(3)) % 3) - 1);
    const responses = await Promise.all(shuffled.map((target) => engine.resolve(get(target))));
    responses.forEach((response, i) => {
      expect(text(response)).toBe(expected.get(shuffled[i] ?? ''));
    });
  });

  it('distinguishes repeated identical tokens, in separate strings and within one', async () => {
    const result = await body(get('/d/1'));
    expect(result['a']).not.toBe(result['b']);
    expect(result['pair']?.slice(0, 36)).not.toBe(result['pair']?.slice(36));
    // The ULID's time part is the render instant.
    expect(result['u']).toMatch(/^01KDVDNA00[0-9A-HJKMNP-TV-Z]{16}$/);
  });

  it('changes every value when any key component changes', async () => {
    const base = await body(get('/d/1'));
    const variants: Promise<Record<string, string>>[] = [
      body(get('/d/2')),
      body(get('/d/1?x=1')),
      body(get('/d/1', { 'x-mock-now': ['2026-01-01T00:00:01Z'] })),
      json(await engineFor(tree, { config: { seed: 2 } }).resolve(get('/d/1'))) as Promise<Record<string, string>>,
    ];
    for (const variant of await Promise.all(variants)) {
      for (const key of ['a', 'n', 'f']) expect(variant[key], key).not.toEqual(base[key]);
    }
    const posted = (payload: string, contentType = 'application/json') =>
      engine.resolve({
        method: 'POST',
        target: '/d/1',
        headers: { 'content-type': [contentType], 'x-mock-now': [NOW] },
        body: utf8Encode(payload),
      });
    const one = text(await posted('{"x":1,"y":[1,2]}'));
    expect(text(await posted('{ "y": [1, 2], "x": 1 }'))).toBe(one); // canonical JSON
    expect(text(await posted('{"x":2,"y":[1,2]}'))).not.toBe(one);
    expect(text(await posted('{"x":1,"y":[1,2]}', 'text/plain'))).not.toBe(one);
  });

  it('treats an empty body as no body, whatever its Content-Type', async () => {
    const post = (extra: Partial<RequestDescription>) =>
      engine.resolve({ method: 'POST', target: '/d/1', headers: { 'x-mock-now': [NOW] }, ...extra });
    const none = text(await post({}));
    expect(text(await post({ body: new Uint8Array() }))).toBe(none);
    expect(
      text(
        await post({ headers: { 'content-type': ['application/json'], 'x-mock-now': [NOW] }, body: new Uint8Array() }),
      ),
    ).toBe(none);
  });

  it('hashes a JSON body nested past the depth cap as bytes instead of failing (review X3)', async () => {
    const deep = (depth: number) => utf8Encode(`${'['.repeat(depth)}${']'.repeat(depth)}`);
    const post = (bytes: Uint8Array) =>
      engine.resolve({
        method: 'POST',
        target: '/d/1',
        headers: { 'content-type': ['application/json'], 'x-mock-now': [NOW] },
        body: bytes,
      });
    const response = await post(deep(100_000));
    expect(response.status).toBe(200);
    expect(text(await post(deep(100_000)))).toBe(text(response));
    expect(text(await post(deep(100_001)))).not.toBe(text(response));
    expect((await post(deep(1000))).status).toBe(200);
  });

  it('refuses to read a request body nested past the depth cap (review X3)', async () => {
    const tree = { 'default/e/POST/200_{application-json}.json': '{"echo":"{{$body.$}}"}' };
    const response = await engineFor(tree).resolve({
      method: 'POST',
      target: '/e',
      headers: { 'content-type': ['application/json'], 'x-mock-now': [NOW] },
      body: utf8Encode(`${'['.repeat(100_000)}${']'.repeat(100_000)}`),
    });
    expect(response.status).toBe(400);
    expect(text(response)).toContain('nests deeper than 1000 levels');
  });

  it('ignores request headers, and query order', async () => {
    const base = text(await engine.resolve(get('/d/1?a=1&b=2')));
    expect(text(await engine.resolve(get('/d/1?b=2&a=1', { 'x-other': ['1'] })))).toBe(base);
  });

  describe('with ambient time and entropy stubbed to throw', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('never reads Math.random, Date.now or the platform CSPRNG', async () => {
      const first = text(await engine.resolve(get('/d/5')));
      vi.spyOn(Math, 'random').mockImplementation(() => {
        throw new Error('Math.random');
      });
      vi.spyOn(Date, 'now').mockImplementation(() => {
        throw new Error('Date.now');
      });
      vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
        throw new Error('getRandomValues');
      });
      const fresh = engineFor(tree, { config: { seed: 1 } });
      expect(text(await fresh.resolve(get('/d/5')))).toBe(first);
      expect(text(await engine.resolve(get('/d/5')))).toBe(first);
    });
  });
});

describe(':unique and X-Mock-Nondeterministic', () => {
  const tree: Tree = {
    'default/u/GET/200_{text-plain}.txt': '{{$uuid:unique}}',
    'default/g/GET/200_{text-plain}.txt': '{{$uuid}}',
    'default/c/GET/200_{text-plain}.txt': '{{$today}}',
    'default/q/GET/200_{text-plain}.txt': '{{$query.a}}',
  };
  let counter = 0;
  const randomBytes = (count: number): Uint8Array => new Uint8Array(count).fill(++counter);
  let wall = Date.UTC(2030, 0, 1);
  const clock = (): number => wall;

  it('draws :unique from the injected entropy source and marks the response', async () => {
    const engine = engineFor(tree, { randomBytes });
    const a = await engine.resolve(get('/u'));
    const b = await engine.resolve(get('/u'));
    expect(text(a)).not.toBe(text(b));
    expect(a.headers['x-mock-nondeterministic']).toEqual(['true']);
    expect(a.trace.render?.nondeterministic).toBe(true);
    expect((await engine.resolve(get('/g'))).headers['x-mock-nondeterministic']).toBeUndefined();
  });

  it('fails :unique without an entropy source', async () => {
    const response = await engineFor(tree).resolve(get('/u'));
    expect(response.status).toBe(500);
    expect(response.trace.outcome).toMatchObject({ kind: 'render-failed', token: 'uuid:unique' });
  });

  it('marks clock and generator tokens under a live or offset clock, but not request tokens', async () => {
    const live = engineFor(tree, { clock });
    const noHeader = { method: 'GET', headers: {} };
    for (const target of ['/g', '/c']) {
      const response = await live.resolve({ ...noHeader, target });
      expect(response.headers['x-mock-nondeterministic'], target).toEqual(['true']);
      expect(response.trace.render?.clockSource).toBe('wall-clock');
    }
    expect((await live.resolve({ ...noHeader, target: '/q' })).headers['x-mock-nondeterministic']).toBeUndefined();
    const offset = engineFor(tree, { clock, config: { now: NOW_MS, clockMode: 'offset' } });
    expect((await offset.resolve({ ...noHeader, target: '/c' })).headers['x-mock-nondeterministic']).toEqual(['true']);
    const frozen = engineFor(tree, { clock, config: { now: NOW_MS } });
    expect((await frozen.resolve({ ...noHeader, target: '/c' })).headers['x-mock-nondeterministic']).toBeUndefined();
    // A frozen request header wins over the live clock.
    expect((await live.resolve(get('/g'))).headers['x-mock-nondeterministic']).toBeUndefined();
  });

  it('suppresses the header with diagnostics.headers false, but keeps the trace', async () => {
    const engine = engineFor(tree, { randomBytes, config: { diagnosticHeaders: false } });
    const response = await engine.resolve(get('/u'));
    expect(response.headers['x-mock-nondeterministic']).toBeUndefined();
    expect(response.trace.render?.nondeterministic).toBe(true);
  });

  it('advances an offset clock with the wall clock from engine creation', async () => {
    wall = Date.UTC(2030, 0, 1);
    const engine = engineFor(
      { 'default/n/GET/200_{text-plain}.txt': '{{$now}}' },
      { clock, config: { now: NOW_MS, clockMode: 'offset' } },
    );
    expect(text(await engine.resolve({ method: 'GET', target: '/n', headers: {} }))).toBe(NOW);
    wall += 90_000;
    expect(text(await engine.resolve({ method: 'GET', target: '/n', headers: {} }))).toBe('2026-01-01T00:01:30Z');
  });
});

describe('the clock', () => {
  const tree: Tree = { 'default/n/GET/200_{text-plain}.txt': '{{$now:unixMillis}}' };
  const clock = (): number => Date.UTC(2030, 5, 1);
  const config: Partial<EngineConfig> = { now: Date.UTC(2028, 0, 1) };

  it.each([
    [
      'caller nowMs',
      { nowMs: Date.UTC(2027, 0, 1), headers: { 'x-mock-now': ['2029-01-01T00:00:00Z'] } },
      Date.UTC(2027, 0, 1),
      'caller',
    ],
    ['X-Mock-Now', { headers: { 'x-mock-now': ['2029-01-01T00:00:00Z'] } }, Date.UTC(2029, 0, 1), 'request-header'],
    ['dynamic.now', { headers: {} }, Date.UTC(2028, 0, 1), 'server-default'],
  ] as const)('prefers %s', async (_name, request, expected, source) => {
    const response = await engineFor(tree, { clock, config }).resolve({ method: 'GET', target: '/n', ...request });
    expect(text(response)).toBe(String(expected));
    expect(response.trace.render?.clockSource).toBe(source);
  });

  it('falls back to the injected wall clock', async () => {
    const response = await engineFor(tree, { clock }).resolve({ method: 'GET', target: '/n', headers: {} });
    expect(text(response)).toBe(String(Date.UTC(2030, 5, 1)));
    expect(response.trace.render?.clockSource).toBe('wall-clock');
  });

  it('fails with render-failed when no clock was injected and none was requested', async () => {
    const response = await engineFor(tree).resolve({ method: 'GET', target: '/n', headers: {} });
    expect(response.status).toBe(500);
    expect(response.trace.outcome).toMatchObject({
      kind: 'render-failed',
      reason: 'no clock was provided to the engine and no instant was requested',
    });
  });

  it.each([
    [['2026-01-01']],
    [['2026-01-01T00:00:00']],
    [['tomorrow']],
    [['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z']],
    [['2026-01-01T00:00:00Z, 2026-01-02T00:00:00Z']],
  ])('answers 400 invalid-request for X-Mock-Now %j', async (values) => {
    const response = await engineFor(tree, { clock }).resolve({
      method: 'GET',
      target: '/n',
      headers: { 'x-mock-now': values },
    });
    expect(response.status).toBe(400);
    expect(response.trace.outcome.kind).toBe('invalid-request');
    expect(text(response)).toContain('X-Mock-Now');
  });

  it.each([1.5, Number.NaN, Infinity, 8.64e15 + 1])('answers 400 for nowMs %s', async (nowMs) => {
    const response = await engineFor(tree).resolve({ method: 'GET', target: '/n', headers: {}, nowMs });
    expect(response.status).toBe(400);
    expect(text(response)).toContain('nowMs');
  });

  it('ignores X-Mock-Now for fixtures without tokens', async () => {
    const engine = engineFor({ 'default/s/GET/200_{text-plain}.txt': 'static' });
    const response = await engine.resolve({ method: 'GET', target: '/s', headers: { 'x-mock-now': ['bad'] } });
    expect(text(response)).toBe('static');
    expect(response.trace.render).toBeUndefined();
  });
});

describe('HEAD', () => {
  const engine = engineFor({
    'default/h/GET/200_{application-json}.json': '{"id":"{{$uuid}}","n":"{{$randomInt(1,1000000)}}","m":"{{$method}}"}',
    'default/h/GET/200.headers.json': '{"ETag":"\\"{{$uuid}}\\""}',
    'default/s/GET/200_{text-plain}.txt': '{{$header.x-strict}}',
  });

  it('renders exactly as GET, then drops the body', async () => {
    const got = await engine.resolve(get('/h'));
    const head = await engine.resolve({ ...get('/h'), method: 'HEAD' });
    expect(head.body).toBeNull();
    expect(head.headers).toEqual({ ...got.headers, 'content-length': [String(got.body?.length)] });
    expect(head.trace.render).toEqual(got.trace.render);
  });

  it('fails exactly as GET', async () => {
    const strict = engineFor(
      { 'default/s/GET/200_{text-plain}.txt': '{{$header.x-strict}}' },
      { config: { strictRefs: true } },
    );
    const got = await strict.resolve(get('/s'));
    const head = await strict.resolve({ ...get('/s'), method: 'HEAD' });
    expect(head.status).toBe(got.status);
    expect(head.status).toBe(500);
    expect(head.body).toBeNull();
    expect(head.trace.outcome).toEqual(got.trace.outcome);
  });
});

describe('token-free fixtures', () => {
  it('are replayed byte for byte, with no render trace', async () => {
    const raw = '{\n  "b": 1.0,\n  "a": "\\u00e9",\n  "1": [ ]\n}\n';
    const engine = engineFor({
      'default/j/GET/200_{application-json}.json': raw,
      'default/t/GET/200_{text-plain}.txt': 'x {{ y }}',
    });
    const response = await engine.resolve(get('/j'));
    expect(text(response)).toBe(raw);
    expect(response.trace.render).toBeUndefined();
    expect(text(await engine.resolve(get('/t')))).toBe('x {{ y }}');
  });

  it('never evaluates binary bodies', async () => {
    const engine = engineFor({ 'default/b/GET/200_{application-octet-stream}.bin': '{{$now}} {{$bogus}}' });
    expect(text(await engine.resolve(get('/b')))).toBe('{{$now}} {{$bogus}}');
  });

  it('keep source key order and number spelling when re-serialised with tokens', async () => {
    const engine = engineFor({
      'default/j/GET/200_{application-json}.json': '{ "b": 1.0, "2": 1e2, "a": "{{$today}}" }',
    });
    expect(text(await engine.resolve(get('/j')))).toBe('{"b":1.0,"2":1e2,"a":"2026-01-01"}');
  });
});

describe('custom aliases', () => {
  it('render like their expansion', async () => {
    const engine = engineFor(
      { 'default/a/GET/200_{text-plain}.txt': '{{$trialEnd}} {{$graceEnd:unix}}' },
      { aliases: { trialEnd: 'today+30d', graceEnd: 'trialEnd+7d' } },
    );
    expect(text(await engine.resolve(get('/a')))).toBe(`2026-01-31 ${String(Date.UTC(2026, 1, 7) / 1000)}`);
  });

  it('render in the configured timezone', async () => {
    const engine = engineFor(
      { 'default/z/GET/200_{text-plain}.txt': '{{$today}}' },
      { config: { timezone: 'Pacific/Kiritimati' } },
    );
    expect(text(await engine.resolve(get('/z')))).toBe('2026-01-01');
    const west = engineFor(
      { 'default/z/GET/200_{text-plain}.txt': '{{$today}}' },
      { config: { timezone: 'America/Los_Angeles' } },
    );
    expect(text(await west.resolve(get('/z')))).toBe('2025-12-31');
  });
});

describe('date(…) and num(…)', () => {
  const post = (target: string, body: unknown, headers: HeaderMap = {}): RequestDescription => ({
    method: 'POST',
    target,
    headers: { 'content-type': ['application/json'], 'x-mock-now': [NOW], ...headers },
    body: utf8Encode(JSON.stringify(body)),
  });
  const tree = {
    'default/subs/POST/201.json': JSON.stringify({
      startDate: '{{$body.$.startDate}}',
      expirationDate: '{{$date(body.$.startDate)+30d}}',
      endOfMonth: '{{$date(body.$.startDate)+1mo:"dd/MM/yyyy"}}',
      startsAt: '{{$date(body.$.startsAt)+2h}}',
      startsAtTokyo: '{{$date(body.$.startsAt)@Asia/Tokyo}}',
      total: '{{$num(body.$.price)*2+1}}',
      label: 'x{{$num(body.$.qty)+0.2}}',
    }),
    'default/subs/POST/201.headers.json': JSON.stringify({ 'X-Next-Page': '{{$num(header.X-Page)+1}}' }),
  };
  const engine = engineFor(tree);

  it('add to a date, a date-time in its own offset or a zone, and a number', async () => {
    const response = await engine.resolve(
      post(
        '/subs',
        { startDate: '2026-01-31', startsAt: '2026-01-31T23:30:00+01:00', price: 9.99, qty: '0.1' },
        { 'x-page': ['4'] },
      ),
    );
    expect(response.status).toBe(201);
    expect(json(response)).toEqual({
      startDate: '2026-01-31',
      expirationDate: '2026-03-02',
      endOfMonth: '28/02/2026',
      startsAt: '2026-02-01T01:30:00+01:00',
      startsAtTokyo: '2026-02-01T07:30:00+09:00',
      total: 20.98,
      label: 'x0.3',
    });
    expect(response.headers['x-next-page']).toEqual(['5']);
  });

  it('treat a value that is not a date or a number as missing, or render-failed under strictRefs', async () => {
    const body = { startDate: 'soon', startsAt: '2026-01-31T23:30:00', price: 'cheap', qty: true };
    expect(json(await engine.resolve(post('/subs', body)))).toEqual({
      startDate: 'soon',
      expirationDate: null,
      endOfMonth: null,
      startsAt: null,
      startsAtTokyo: null,
      total: null,
      label: 'x',
    });
    const strict = engineFor(tree, { config: { strictRefs: true } });
    const response = await strict.resolve(post('/subs', body, { 'x-page': ['1'] }));
    expect(response.status).toBe(500);
    expect(response.trace.outcome).toMatchObject({
      kind: 'render-failed',
      token: 'date(body.$.startDate)+30d',
      reason: 'the request value is not an RFC 3339 date or date-time and dynamic.strictRefs is true',
    });
  });

  it('fails with render-failed for a result that is not finite', async () => {
    const big = engineFor({ 'default/n/POST/200.json': '{"n":"{{$num(body.$.n)*10}}"}' });
    const response = await big.resolve(post('/n', { n: 1e308 }));
    expect(response.status).toBe(500);
    expect(response.trace.outcome).toMatchObject({
      kind: 'render-failed',
      reason: 'the result is not a finite number',
    });
  });
});
