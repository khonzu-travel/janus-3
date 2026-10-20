import { describe, expect, it } from 'vitest';

import {
  captureFileKind,
  capturedEntry,
  parseCaptureCursor,
  parseCaptureId,
  parseCaptureLogLine,
  projectCaptureDetail,
  projectCaptureList,
  type CaptureListQuery,
} from '../atlas/captures.js';
import { utf8Encode } from '../bytes.js';
import { parseConfig } from '../config/parse.js';
import type { EngineConfig } from '../config/merge.js';
import { createEngine } from '../create-engine.js';
import { buildSnapshot } from '../fixtures/build.js';
import { parseFileName } from '../fixtures/filename.js';
import { parseHeaderSidecar } from '../fixtures/sidecar.js';
import { parseRecordHeader } from '../http/record.js';
import type { FixtureSnapshot, HeaderMap, RequestDescription } from '../types/index.js';
import { captureDigest, planCapture } from './capture.js';
import { forwardedHeaderNames, planRelayedHeaders, planUpstreamRequest } from './forward.js';
import {
  formatCaptureLogLine,
  type CaptureFailureEntry,
  type CapturePlan,
  type CaptureReservation,
  type HeaderLine,
  type RecordingPorts,
  type UpstreamRequest,
  type UpstreamResponse,
} from './ports.js';
import { compileRegistrations, matchRegistration, type Registration, type RecordingEndpoint } from './registrations.js';

// Recording.

const text = (bytes: Uint8Array | null | undefined): string | null =>
  bytes === null || bytes === undefined ? null : new TextDecoder().decode(bytes);

const STAGING = 'https://staging.api.example.test';
const ENDPOINTS: readonly RecordingEndpoint[] = [
  { method: 'GET', path: '/v1/products/{productId}', upstream: STAGING },
  { method: 'POST', path: '/v1/carts/{cartId}/items', upstream: `${STAGING}/shop/` },
  { method: 'POST', path: '/v1/payments', upstream: STAGING },
];

function registrations(endpoints: readonly RecordingEndpoint[] = ENDPOINTS): readonly Registration[] {
  const compiled = compileRegistrations(endpoints);
  expect(compiled.problems).toEqual([]);
  return compiled.registrations;
}

function registration(index: number): Registration {
  const found = registrations()[index];
  if (found === undefined) throw new Error('no registration');
  return found;
}

function snapshot(tree: Readonly<Record<string, string>>): FixtureSnapshot {
  const built = buildSnapshot(new Map(Object.entries(tree).map(([path, body]) => [path, utf8Encode(body)])));
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return built.snapshot;
}

const TREE = {
  'default/v1/products/{productId}/GET/200.json': '{"from":"fixture"}',
  'default/v1/products/{productId}/GET/200.second.json': '{"from":"second"}',
  'default/v1/products/{productId}/GET/sequence.yaml': 'steps: [200, 200.second]\n',
  'default/v1/payments/POST/201.json': '{"id":"pay_1"}',
  'payment-declined/flow.yaml': 'description: Declined\n',
};

describe('X-Mock-Record', () => {
  it.each([
    [{}, { kind: 'absent' }],
    [{ 'x-mock-record': [] }, { kind: 'absent' }],
    [{ 'x-mock-record': ['false'] }, { kind: 'record', record: false }],
    [{ 'x-mock-record': ['true'] }, { kind: 'record', record: true }],
    [{ 'x-mock-record': [' TRUE\t'] }, { kind: 'record', record: true }],
    [{ 'x-mock-record': ['False'] }, { kind: 'record', record: false }],
  ] as [HeaderMap, unknown][])('reads %j', (headers, expected) => {
    expect(parseRecordHeader(headers)).toEqual(expected);
  });

  it.each([[['yes']], [['1']], [['']], [['true', 'true']], [['true, false']]])('rejects %j', (values) => {
    expect(parseRecordHeader({ 'x-mock-record': values })).toMatchObject({ kind: 'invalid' });
  });
});

describe('registrations', () => {
  const problems = (endpoints: readonly RecordingEndpoint[]) =>
    compileRegistrations(endpoints).problems.map((problem) => [problem.code, problem.index]);

  it('accepts templates and upstreams with and without a base path', () => {
    const [products, carts, payments] = registrations();
    expect(products?.origin).toBe(STAGING);
    expect(products?.basePath).toBe('');
    expect(carts?.basePath).toBe('/shop');
    expect(payments?.segments).toEqual([
      { kind: 'literal', value: 'v1' },
      { kind: 'literal', value: 'payments' },
    ]);
    expect(registrations([{ method: 'GET', path: '/', upstream: 'http://127.0.0.1:9000' }])[0]?.segments).toEqual([]);
  });

  it.each([
    'v1/a',
    '/v1/',
    '/v1//a',
    '/v1/{id',
    '/v1/a{id}',
    '/v1/{1d}',
    '/v1/{id}/{id}',
    '/v1/./a',
    '/v1/../a',
    '/_janus',
    '/_janus/health',
  ])('rejects the template %s', (path) => {
    expect(problems([{ method: 'GET', path, upstream: STAGING }])).toEqual([['recording-invalid-endpoint', 0]]);
  });

  it.each([
    'staging.example.test',
    '/relative',
    'ftp://staging.example.test',
    'https://user:secret@staging.example.test',
    'https://user@staging.example.test',
    'https://staging.example.test/?a=1',
    'https://staging.example.test/?',
    'https://staging.example.test/#top',
    'file:///etc/passwd',
  ])('rejects the upstream %s', (upstream) => {
    expect(problems([{ method: 'GET', path: '/a', upstream }])).toEqual([['recording-invalid-endpoint', 0]]);
  });

  it('reports overlapping registrations, naming both', () => {
    const overlap = compileRegistrations([
      { method: 'GET', path: '/v1/products/{productId}', upstream: STAGING },
      { method: 'GET', path: '/v1/{kind}/p-1', upstream: STAGING },
      { method: 'POST', path: '/v1/products/p-1', upstream: STAGING },
      { method: 'GET', path: '/v1/products', upstream: STAGING },
      { method: 'GET', path: '/v2/products/{id}', upstream: STAGING },
    ]).problems;
    expect(overlap).toEqual([
      {
        code: 'recording-overlap',
        index: 1,
        message: expect.stringContaining('GET /v1/{kind}/p-1 and GET /v1/products/{productId}') as unknown,
      },
    ]);
  });

  it('matches by method, length, literals and non-empty parameters; never HEAD', () => {
    const all = registrations();
    expect(matchRegistration(all, 'GET', ['v1', 'products', 'p 1'])?.params).toEqual({ productId: 'p 1' });
    expect(matchRegistration(all, 'GET', ['v1', 'products'])).toBeNull();
    expect(matchRegistration(all, 'GET', ['v1', 'products', ''])).toBeNull();
    expect(matchRegistration(all, 'POST', ['v1', 'products', 'p-1'])).toBeNull();
    expect(matchRegistration(all, 'HEAD', ['v1', 'products', 'p-1'])).toBeNull();
    expect(matchRegistration(all, 'POST', ['v1', 'payments'])?.registration.index).toBe(2);
  });

  it('reports problems from the configuration file at the offending entry', () => {
    const parsed = parseConfig({
      sourceName: 'janus.config.yaml',
      text: [
        'recording:',
        '  endpoints:',
        '    - { method: GET, path: "/a/{id}", upstream: "https://x.test" }',
        '    - { method: GET, path: "/a/b", upstream: "https://x.test" }',
        '    - { method: GET, path: "/_janus/x", upstream: "https://x.test" }',
        '',
      ].join('\n'),
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((error) => [error.code, error.line, error.key])).toEqual([
      ['recording-overlap', 4, 'recording.endpoints'],
      ['recording-invalid-endpoint', 5, 'recording.endpoints'],
    ]);
  });

  it('reports more than 256 registrations as an invalid value', () => {
    const lines = Array.from(
      { length: 257 },
      (_, index) => `    - { method: GET, path: /r${String(index)}, upstream: "https://x.test" }`,
    );
    const parsed = parseConfig({ sourceName: 'c.yaml', text: ['recording:', '  endpoints:', ...lines, ''].join('\n') });
    expect(parsed.ok ? [] : parsed.errors.map((error) => error.code)).toEqual(['config-invalid-value']);
  });
});

describe('the upstream request', () => {
  const headers: HeaderMap = {
    host: ['127.0.0.1:4010'],
    authorization: ['Bearer test-token'],
    cookie: ['session=abc', 'theme=dark'],
    'x-cart': ['c-1'],
    connection: ['keep-alive, X-Secret-Hop'],
    'keep-alive': ['timeout=5'],
    'x-secret-hop': ['1'],
    te: ['trailers'],
    'transfer-encoding': ['chunked'],
    upgrade: ['h2c'],
    'proxy-authorization': ['Basic eA=='],
    'content-length': ['12'],
    expect: ['100-continue'],
    forwarded: ['for=1.2.3.4'],
    via: ['1.1 evil'],
    'x-forwarded-for': ['1.2.3.4'],
    'x-forwarded-host': ['evil.test'],
    'x-mock-record': ['true'],
    'x-mock-scenario': ['payment-declined'],
    'accept-encoding': ['gzip, br'],
    'content-type': ['application/json'],
  };

  it('joins the upstream, its base path, the canonical path and the raw query', () => {
    expect(planUpstreamRequest(registration(0), 'GET', ['v1', 'products', 'p 1/x'], '/x?a=1&b=%20', {}, null).url).toBe(
      `${STAGING}/v1/products/p%201%2Fx?a=1&b=%20`,
    );
    expect(
      planUpstreamRequest(registration(1), 'POST', ['v1', 'carts', 'c1', 'items'], '/v1/carts/c1/items', {}, null).url,
    ).toBe(`${STAGING}/shop/v1/carts/c1/items`);
  });

  it('never lets caller text change the authority or base path', () => {
    // Normalised segments never hold "/" or dot-segments; everything else is encoded into the path.
    for (const segments of [['@evil.test'], ['http:'], ['%2F..%2F'], ['?x=1#y'], ['\\evil.test']]) {
      const url = new URL(planUpstreamRequest(registration(1), 'POST', segments, '/', {}, null).url);
      expect(url.origin).toBe(STAGING);
      expect(url.pathname.startsWith('/shop/')).toBe(true);
    }
  });

  it('removes hop-by-hop, Janus, proxy and encoding headers and forwards the rest as sent', () => {
    const body = utf8Encode('{"a":1}');
    const plan = planUpstreamRequest(registration(2), 'POST', ['v1', 'payments'], '/v1/payments', headers, body);
    expect(plan.method).toBe('POST');
    expect(plan.body).toBe(body);
    expect(plan.headers).toEqual([
      ['authorization', 'Bearer test-token'],
      ['cookie', 'session=abc'],
      ['cookie', 'theme=dark'],
      ['x-cart', 'c-1'],
      ['content-type', 'application/json'],
      ['accept-encoding', 'identity'],
    ]);
    expect(forwardedHeaderNames(headers)).toEqual([
      'authorization',
      'cookie',
      'x-cart',
      'content-type',
      'accept-encoding',
    ]);
  });
});

describe('the upstream request in received order (review D3)', () => {
  it('forwards the received lines in their order, names as written, without the removed ones', () => {
    const received: HeaderLine[] = [
      ['Host', '127.0.0.1:4010'],
      ['X-A', '1'],
      ['x-mock-record', 'true'],
      ['x-b', '2'],
      ['x-a', '3'],
    ];
    const headers: HeaderMap = { host: ['127.0.0.1:4010'], 'x-a': ['1', '3'], 'x-mock-record': ['true'], 'x-b': ['2'] };
    const plan = planUpstreamRequest(registration(0), 'GET', ['v1'], '/v1', headers, null, received);
    expect(plan.headers).toEqual([
      ['X-A', '1'],
      ['x-b', '2'],
      ['x-a', '3'],
      ['accept-encoding', 'identity'],
    ]);
  });
});

describe('the relayed response', () => {
  const upstream: HeaderLine[] = [
    ['Content-Type', 'application/json'],
    ['Content-Length', '74'],
    ['Date', 'Sat, 03 Oct 2026 14:20:55 GMT'],
    ['Connection', 'close, X-Hop'],
    ['X-Hop', '1'],
    ['Keep-Alive', 'timeout=5'],
    ['Transfer-Encoding', 'chunked'],
    ['X-Mock-Identity', 'fx_spoofed'],
    ['Set-Cookie', 'sid=1; Path=/'],
    ['Set-Cookie', 'b=2'],
    ['Set-Cookie2', 'old=1'],
    ['Clear-Site-Data', '"cookies"'],
    ['Strict-Transport-Security', 'max-age=1'],
    ['Alt-Svc', 'h3=":443"'],
    ['Report-To', '{}'],
    ['Reporting-Endpoints', 'a="https://r.test"'],
    ['NEL', '{}'],
    ['Timing-Allow-Origin', '*'],
    ['Access-Control-Allow-Origin', '*'],
    ['Access-Control-Allow-Credentials', 'true'],
    ['WWW-Authenticate', 'Bearer error="invalid_token"'],
    ['Authentication-Info', 'nextnonce="x"'],
    ['Location', 'https://elsewhere.test/a'],
    ['Content-Encoding', 'gzip'],
    ['ETag', '"v1"'],
    // Review D1: set by the adapter on every response.
    ['X-Janus-Request-Id', 'upstream-id'],
  ];

  it('keeps the upstream headers apart from transport, Janus and origin-bound ones', () => {
    expect(planRelayedHeaders(upstream, { scenario: 'payment-declined', recorded: 'payment-declined/000001' })).toEqual(
      {
        'content-type': ['application/json'],
        'www-authenticate': ['Bearer error="invalid_token"'],
        'authentication-info': ['nextnonce="x"'],
        location: ['https://elsewhere.test/a'],
        'content-encoding': ['gzip'],
        etag: ['"v1"'],
        'x-mock-scenario': ['payment-declined'],
        'x-mock-recorded': ['payment-declined/000001'],
      },
    );
  });

  it('adds no diagnostic header with diagnostics.headers: false', () => {
    const relayed = planRelayedHeaders(upstream, null);
    expect(Object.keys(relayed).filter((name) => name.startsWith('x-mock-'))).toEqual([]);
  });
});

describe('capture plans', () => {
  const reservation: CaptureReservation = { scenario: 'payment-declined', exchange: '000001' };
  const T0 = Date.UTC(2026, 9, 3, 14, 20, 55, 36);
  const plan = (
    status: number,
    headers: HeaderLine[],
    body: Uint8Array | string,
    request: Partial<{ headers: HeaderMap; body: Uint8Array | null; target: string }> = {},
  ): CapturePlan =>
    planCapture({
      reservation,
      registration: registration(2),
      request: {
        method: 'POST',
        target: request.target ?? '/v1/payments?attempt=1',
        params: {},
        headers: request.headers ?? {},
        body: request.body ?? null,
      },
      response: { status, headers, body: typeof body === 'string' ? utf8Encode(body) : body },
      startedAt: T0,
      finishedAt: T0 + 84,
    });
  const file = (captured: CapturePlan, name: string) => captured.files.find((entry) => entry.name === name)?.bytes;
  const names = (captured: CapturePlan) => captured.files.map((entry) => entry.name);
  const responseName = (status: number, headers: HeaderLine[], body = 'x') =>
    names(plan(status, headers, body)).find(
      (name) => name !== 'request.json' && !name.includes('.meta.') && !name.includes('.headers.'),
    );
  const meta = (captured: CapturePlan) =>
    JSON.parse(text(file(captured, `${String(captured.log.status)}.meta.json`)) ?? '') as Record<string, unknown>;

  it.each([
    [204, [['Content-Type', 'application/json']], '204'],
    [304, [], '304'],
    [200, [['Content-Type', 'application/json']], '200.json'],
    [200, [['Content-Type', 'application/json; charset=utf-8']], '200.json'],
    [200, [['Content-Type', 'application/yaml']], '200.yaml'],
    [200, [['Content-Type', 'image/jpeg']], '200.jpg'],
    [402, [['Content-Type', 'application/problem+json']], '402_{application-problem+json}.json'],
    [200, [['Content-Type', 'application/atom+xml']], '200_{application-atom+xml}.xml'],
    [200, [['Content-Type', 'text/xml']], '200_{text-xml}.xml'],
    [200, [['Content-Type', 'font/woff2']], '200_{font-woff2}.bin'],
    [200, [['Content-Type', 'x-custom/thing']], '200.bin'],
    [200, [], '200.bin'],
    [200, [['Content-Type', 'not a type']], '200.bin'],
    [
      200,
      [
        ['Content-Type', 'text/plain'],
        ['Content-Type', 'text/html'],
      ],
      '200.bin',
    ],
    [
      200,
      [
        ['Content-Type', 'application/json'],
        ['Content-Language', 'de-CH'],
      ],
      '200_[de-CH].json',
    ],
    [
      200,
      [
        ['Content-Type', 'application/problem+json'],
        ['Content-Language', 'fr'],
      ],
      '200_[fr]_{application-problem+json}.json',
    ],
    [
      200,
      [
        ['Content-Type', 'application/json'],
        ['Content-Language', 'de, en'],
      ],
      '200.json',
    ],
    [
      200,
      [
        ['Content-Type', 'application/json'],
        ['Content-Language', 'not_a_tag!'],
      ],
      '200.json',
    ],
  ] as [number, HeaderLine[], string][])('names status %i with %j as %s', (status, headers, expected) => {
    const name = responseName(status, headers);
    expect(name).toBe(expected);
    const parsed = parseFileName(name ?? '');
    expect(parsed.kind).toBe('response');
  });

  it('writes the request, response, sidecar and provenance exactly as exchanged', () => {
    const requestBody = utf8Encode('{"card":{"number":"4000000000000002"}}');
    const responseBody = '{"error":"card_declined","card":"4000000000000002"}';
    const captured = plan(
      402,
      [
        ['Content-Type', 'application/json'],
        ['Content-Length', String(responseBody.length)],
        ['Date', 'Sat, 03 Oct 2026 14:20:55 GMT'],
        ['Connection', 'close'],
        ['Set-Cookie', 'sid=s3cr3t; Path=/'],
        ['Set-Cookie', 'b=2'],
        ['X-Mock-Identity', 'fx_1'],
        ['Request-Id', 'req_9'],
      ],
      responseBody,
      {
        body: requestBody,
        headers: {
          'content-type': ['application/json'],
          authorization: ['Bearer test-token'],
          cookie: ['session=abc'],
          'x-mock-record': ['true'],
          'x-mock-scenario': ['payment-declined'],
        },
      },
    );
    expect(names(captured)).toEqual(['request.json', '402.json', '402.headers.json', '402.meta.json']);
    expect(text(file(captured, '402.json'))).toBe(responseBody);
    expect(JSON.parse(text(file(captured, '402.json')) ?? '')).toEqual(JSON.parse(responseBody));
    expect(JSON.parse(text(file(captured, 'request.json')) ?? '')).toEqual({
      method: 'POST',
      target: '/v1/payments?attempt=1',
      registration: { method: 'POST', path: '/v1/payments' },
      params: {},
      headers: {
        'content-type': ['application/json'],
        authorization: ['Bearer test-token'],
        cookie: ['session=abc'],
        'x-mock-record': ['true'],
        'x-mock-scenario': ['payment-declined'],
      },
      body: { encoding: 'utf8', data: '{"card":{"number":"4000000000000002"}}' },
    });
    const sidecar = file(captured, '402.headers.json') ?? new Uint8Array();
    expect(JSON.parse(text(sidecar) ?? '')).toEqual({
      'set-cookie': ['sid=s3cr3t; Path=/', 'b=2'],
      'request-id': 'req_9',
    });
    expect(parseHeaderSidecar(sidecar).problems).toEqual([]);
    expect(meta(captured)).toEqual({
      format: 'janus.capture.v1',
      source: 'recording',
      scenario: 'payment-declined',
      exchange: '000001',
      capturedAt: '2026-10-03T14:20:55.120Z',
      durationMs: 84,
      registration: { method: 'POST', path: '/v1/payments', upstream: STAGING },
      response: {
        status: 402,
        file: '402.json',
        byteLength: responseBody.length,
        upstreamByteLength: responseBody.length,
        digest: captureDigest(utf8Encode(responseBody)),
      },
      removedHeaders: ['connection', 'content-length', 'content-type', 'date', 'x-mock-identity'],
      notes: [],
    });
    expect(captured.log).toEqual({
      exchange: '000001',
      at: '2026-10-03T14:20:55.120Z',
      method: 'POST',
      target: '/v1/payments?attempt=1',
      registration: '/v1/payments',
      outcome: 'captured',
      status: 402,
      durationMs: 84,
    });
    expect(formatCaptureLogLine(captured.log)).toBe(
      '{"exchange":"000001","at":"2026-10-03T14:20:55.120Z","method":"POST","target":"/v1/payments?attempt=1","registration":"/v1/payments","outcome":"captured","status":402,"durationMs":84}\n',
    );
  });

  it('keeps every byte of a binary body and stores a non-UTF-8 request body as base64', () => {
    const bytes = new Uint8Array([0, 0xff, 0xfe, 0x80, 10]);
    const captured = plan(200, [['Content-Type', 'image/png']], bytes, { body: new Uint8Array([0xc3, 0x28]) });
    expect(file(captured, '200.png')).toEqual(bytes);
    expect((JSON.parse(text(file(captured, 'request.json')) ?? '') as { body: unknown }).body).toEqual({
      encoding: 'base64',
      data: 'wyg=',
    });
  });

  it('keeps Content-Type parameters and an unnamed type in the sidecar', () => {
    const withCharset = plan(200, [['Content-Type', 'application/json; charset=utf-8']], '{}');
    expect(text(file(withCharset, '200.headers.json'))).toContain('application/json; charset=utf-8');
    const custom = plan(200, [['Content-Type', 'x-custom/thing']], 'raw');
    expect(JSON.parse(text(file(custom, '200.headers.json')) ?? '')).toEqual({ 'content-type': 'x-custom/thing' });
    const localized = plan(
      200,
      [
        ['Content-Type', 'application/json'],
        ['Content-Language', 'de-CH'],
      ],
      '{}',
    );
    expect(names(localized)).not.toContain('200.headers.json');
    expect(meta(localized)['removedHeaders']).toEqual(['content-language', 'content-type']);
  });

  it('stores an encoded body empty and notes it', () => {
    const captured = plan(
      200,
      [
        ['Content-Type', 'application/json'],
        ['Content-Encoding', 'gzip'],
      ],
      new Uint8Array([31, 139, 8]),
    );
    expect(file(captured, '200.json')).toEqual(new Uint8Array());
    expect(meta(captured)).toMatchObject({
      response: { byteLength: 0, upstreamByteLength: 3 },
      removedHeaders: ['content-encoding', 'content-type'],
      notes: [{ code: 'body-encoded' }],
    });
    const identity = plan(
      200,
      [
        ['Content-Type', 'application/json'],
        ['Content-Encoding', 'identity'],
      ],
      '{}',
    );
    expect(meta(identity)['notes']).toEqual([]);
  });

  it('discards a body sent with a bodyless status, and its Content-Type', () => {
    const captured = plan(
      204,
      [
        ['Content-Type', 'application/json'],
        ['ETag', '"x"'],
      ],
      'oops',
    );
    expect(names(captured)).toEqual(['request.json', '204', '204.headers.json', '204.meta.json']);
    expect(file(captured, '204')).toEqual(new Uint8Array());
    expect(meta(captured)).toMatchObject({ notes: [{ code: 'bodyless-status-body-discarded' }] });
    expect(names(plan(304, [], ''))).toEqual(['request.json', '304', '304.meta.json']);
  });

  it('notes an invalid Content-Type and leaves it out of the sidecar', () => {
    const captured = plan(200, [['Content-Type', 'nonsense']], 'x');
    expect(names(captured)).toEqual(['request.json', '200.bin', '200.meta.json']);
    expect(meta(captured)).toMatchObject({
      removedHeaders: ['content-type'],
      notes: [{ code: 'invalid-content-type' }],
    });
  });

  it('builds file names only from the status, media type and language, never from request data', () => {
    const captured = plan(200, [['Content-Type', 'application/json']], '{}', { target: '/../../etc/passwd?x=/..' });
    for (const name of names(captured)) expect(name).toMatch(/^(request\.json|200\.json|200\.meta\.json)$/);
  });
});

describe('recording in the engine', () => {
  interface Calls {
    claims: string[];
    sends: UpstreamRequest[];
    writes: CapturePlan[];
    fails: CaptureFailureEntry[];
  }

  function fakePorts(
    respond: (request: UpstreamRequest) => Promise<UpstreamResponse> | UpstreamResponse,
    options: { claim?: 'fail'; write?: 'fail' } = {},
  ): { ports: RecordingPorts; calls: Calls } {
    const calls: Calls = { claims: [], sends: [], writes: [], fails: [] };
    let next = 0;
    return {
      calls,
      ports: {
        upstream: {
          send: async (request) => {
            calls.sends.push(request);
            return respond(request);
          },
        },
        captures: {
          claim: (scenario) => {
            calls.claims.push(scenario);
            if (options.claim === 'fail') return Promise.reject(new Error('EACCES'));
            next++;
            return Promise.resolve({ scenario, exchange: String(next).padStart(6, '0') });
          },
          write: (_reservation, captured) => {
            calls.writes.push(captured);
            return Promise.resolve(options.write === 'fail' ? { ok: false } : { ok: true });
          },
          fail: (_reservation, entry) => {
            calls.fails.push(entry);
            return Promise.resolve();
          },
        },
      },
    };
  }

  const ok: UpstreamResponse = {
    kind: 'response',
    status: 402,
    headers: [
      ['Content-Type', 'application/json'],
      ['Set-Cookie', 'sid=1'],
    ],
    body: utf8Encode('{"declined":true}'),
  };

  function engine(ports: RecordingPorts | undefined, config: Partial<EngineConfig> = {}) {
    return createEngine({
      snapshot: snapshot(TREE),
      clock: () => Date.UTC(2026, 9, 3),
      randomBytes: (count) => new Uint8Array(count).fill(7),
      config: {
        recording: { endpoints: ENDPOINTS, maxConcurrent: 4, timeoutMs: 30000, maxResponseBytes: 1024 },
        ...config,
      },
      ...(ports === undefined ? {} : { recording: ports }),
    });
  }

  const recordPayment = (headers: HeaderMap = {}): RequestDescription => ({
    method: 'POST',
    target: '/v1/payments?attempt=1',
    headers: { 'x-mock-record': ['true'], 'x-mock-scenario': ['payment-declined'], ...headers },
    body: utf8Encode('{"amount":1}'),
  });
  const errorCode = (body: Uint8Array | null) =>
    (JSON.parse(text(body) ?? '{}') as { error?: { code?: string } }).error?.code;

  it('forwards a registered request and relays the upstream response with diagnostics', async () => {
    const { ports, calls } = fakePorts(() => ok);
    const response = await engine(ports).resolve(recordPayment({ authorization: ['Bearer t'] }));
    expect(response.status).toBe(402);
    expect(text(response.body)).toBe('{"declined":true}');
    expect(response.headers).toEqual({
      'content-type': ['application/json'],
      'x-mock-scenario': ['payment-declined'],
      'x-mock-recorded': ['payment-declined/000001'],
    });
    expect(calls.claims).toEqual(['payment-declined']);
    expect(calls.sends[0]).toMatchObject({ url: `${STAGING}/v1/payments?attempt=1`, method: 'POST' });
    expect(calls.sends[0]?.headers).toContainEqual(['authorization', 'Bearer t']);
    expect(calls.writes[0]?.log).toMatchObject({ exchange: '000001', outcome: 'captured', status: 402 });
    expect(response.trace.recording).toEqual({
      scenario: 'payment-declined',
      exchange: '000001',
      outcome: 'captured',
      upstreamMs: 0,
      upstream: STAGING,
    });
    expect(response.trace.outcome).toEqual({
      kind: 'recorded',
      registration: { method: 'POST', path: '/v1/payments' },
      status: 402,
    });
  });

  it('forwards whether or not a fixture exists, and only with X-Mock-Record: true', async () => {
    const { ports, calls } = fakePorts(() => ok);
    const janus = engine(ports);
    const plain = await janus.resolve({ method: 'GET', target: '/v1/products/p-1', headers: {} });
    expect(text(plain.body)).toBe('{"from":"fixture"}');
    const off = await janus.resolve({
      method: 'GET',
      target: '/v1/products/p-1',
      headers: { 'x-mock-record': ['false'] },
    });
    expect(off.status).toBe(200);
    expect(calls.sends).toHaveLength(0);
    const cart = await janus.resolve({
      method: 'POST',
      target: '/v1/carts/c1/items',
      headers: { 'x-mock-record': ['true'] },
    });
    expect(cart.status).toBe(402);
    expect(calls.sends[0]?.url).toBe(`${STAGING}/shop/v1/carts/c1/items`);
  });

  it('refuses unregistered requests and HEAD before calling any port', async () => {
    const { ports, calls } = fakePorts(() => ok);
    const janus = engine(ports);
    for (const request of [
      { method: 'GET', target: '/v1/orders', headers: { 'x-mock-record': ['true'] } },
      { method: 'HEAD', target: '/v1/products/p-1', headers: { 'x-mock-record': ['true'] } },
      { method: 'DELETE', target: '/v1/payments', headers: { 'x-mock-record': ['true'] } },
    ]) {
      const response = await janus.resolve(request);
      expect(response.status).toBe(403);
      expect(response.trace.outcome).toEqual({ kind: 'recording-not-allowed' });
    }
    const invalid = await janus.resolve({
      method: 'GET',
      target: '/v1/products/p-1',
      headers: { 'x-mock-record': ['yes'] },
    });
    expect(invalid.status).toBe(400);
    const unknown = await janus.resolve(recordPayment({ 'x-mock-scenario': ['nope'] }));
    expect(unknown.status).toBe(400);
    expect(calls).toEqual({ claims: [], sends: [], writes: [], fails: [] });
  });

  it('is 403 with recording disabled and 501 without ports', async () => {
    const disabled = await createEngine({ snapshot: snapshot(TREE) }).resolve(recordPayment());
    expect(disabled.status).toBe(403);
    const unavailable = await engine(undefined).resolve(recordPayment());
    expect([unavailable.status, errorCode(unavailable.body)]).toEqual([501, 'recording-unavailable']);
    expect(unavailable.headers['x-mock-scenario']).toEqual(['payment-declined']);
  });

  it('never sends when no exchange can be claimed', async () => {
    const { ports, calls } = fakePorts(() => ok, { claim: 'fail' });
    const response = await engine(ports).resolve(recordPayment());
    expect([response.status, errorCode(response.body)]).toEqual([500, 'recording-capture-failed']);
    expect(calls.sends).toHaveLength(0);
  });

  it.each([
    ['connect', 502, 'recording-upstream-failed', 'upstream-failed'],
    ['timeout', 504, 'recording-upstream-timeout', 'upstream-timeout'],
    ['too-large', 502, 'recording-response-too-large', 'response-too-large'],
  ] as const)('maps an upstream %s failure to %i and logs it', async (failure, status, code, outcome) => {
    const { ports, calls } = fakePorts(() => ({ kind: 'failure', failure }));
    const response = await engine(ports).resolve(recordPayment({ authorization: ['Bearer secret'] }));
    expect([response.status, errorCode(response.body)]).toEqual([status, code]);
    expect(text(response.body)).not.toContain('secret');
    expect(text(response.body)).not.toContain('attempt');
    expect(calls.writes).toHaveLength(0);
    expect(calls.fails).toEqual([expect.objectContaining({ exchange: '000001', outcome }) as unknown]);
    expect(response.trace.recording).toMatchObject({ outcome, failure });
  });

  it('names a connect failure by its reason in the error, the log line and the trace', async () => {
    const { ports, calls } = fakePorts(() => ({ kind: 'failure', failure: 'connect', reason: 'certificate' }));
    const response = await engine(ports).resolve(recordPayment());
    expect(JSON.parse(text(response.body) ?? '')).toMatchObject({
      error: {
        code: 'recording-upstream-failed',
        message:
          "The upstream could not be reached: the upstream's TLS certificate was not trusted; nothing was received from it",
        reason: 'certificate',
      },
    });
    expect(calls.fails).toEqual([
      expect.objectContaining({ outcome: 'upstream-failed', reason: 'certificate' }) as unknown,
    ]);
    expect(response.trace.recording).toMatchObject({ failure: 'connect', reason: 'certificate' });
  });

  it('reports a connect failure without a reason as unknown', async () => {
    const { ports, calls } = fakePorts(() => ({ kind: 'failure', failure: 'connect' }));
    const response = await engine(ports).resolve(recordPayment());
    expect(JSON.parse(text(response.body) ?? '')).toMatchObject({ error: { reason: 'unknown' } });
    expect(calls.fails).toEqual([expect.objectContaining({ reason: 'unknown' }) as unknown]);
  });

  it('relays the response with X-Mock-Recorded: failed when the capture cannot be written', async () => {
    const { ports } = fakePorts(() => ok, { write: 'fail' });
    const response = await engine(ports).resolve(recordPayment());
    expect(response.status).toBe(402);
    expect(response.headers['x-mock-recorded']).toEqual(['failed']);
    expect(response.trace.recording?.outcome).toBe('capture-failed');
  });

  it('sends no X-Mock-* header with diagnostics.headers: false', async () => {
    const { ports } = fakePorts(() => ok);
    const response = await engine(ports, { diagnosticHeaders: false }).resolve(recordPayment());
    expect(Object.keys(response.headers)).toEqual(['content-type']);
  });

  it('bounds concurrent recordings and releases the slot on every outcome', async () => {
    const pending: ((response: UpstreamResponse) => void)[] = [];
    const { ports, calls } = fakePorts(
      () =>
        new Promise<UpstreamResponse>((resolve) => {
          pending.push(resolve);
        }),
    );
    const janus = createEngine({
      snapshot: snapshot(TREE),
      config: { recording: { endpoints: ENDPOINTS, maxConcurrent: 2, timeoutMs: 30000, maxResponseBytes: 1024 } },
      recording: ports,
    });
    const first = janus.resolve(recordPayment());
    const second = janus.resolve(recordPayment());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const busy = await janus.resolve(recordPayment());
    expect([busy.status, errorCode(busy.body)]).toEqual([503, 'recording-busy']);
    expect(calls.claims).toHaveLength(2);
    pending[0]?.(ok);
    pending[1]?.({ kind: 'failure', failure: 'timeout' });
    expect((await first).status).toBe(402);
    expect((await second).status).toBe(504);
    const third = janus.resolve(recordPayment());
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending[2]?.(ok);
    expect((await third).status).toBe(402);
  });

  it('leaves sequence positions and replay records alone', async () => {
    const { ports } = fakePorts(() => ok);
    const janus = engine(ports);
    const session = { 'x-mock-session': ['s1'] };
    expect(janus.sessions.write('POST', session, null).ok).toBe(true);
    const get = { method: 'GET', target: '/v1/products/p-1', headers: session };
    const recorded = await janus.resolve({ ...get, headers: { ...session, 'x-mock-record': ['true'] } });
    expect(recorded.status).toBe(402);
    expect(text((await janus.resolve(get)).body)).toBe('{"from":"fixture"}');
    expect(text((await janus.resolve(get)).body)).toBe('{"from":"second"}');
  });

  it('explains a recorded request without calling a port', async () => {
    const { ports, calls } = fakePorts(() => ok);
    const janus = engine(ports);
    const explained = await janus.atlas.explain(
      recordPayment({ authorization: ['Bearer t'], 'x-forwarded-for': ['1.1.1.1'] }),
    );
    expect(explained.response).toBeNull();
    expect(explained.trace.outcome).toEqual({
      kind: 'would-record',
      registration: { method: 'POST', path: '/v1/payments' },
      upstream: `${STAGING}/v1/payments?attempt=1`,
      forwardedHeaders: ['authorization', 'accept-encoding'],
    });
    expect(explained.notes).toContain('nothing was sent: a simulation never contacts the upstream or writes a capture');
    const refused = await janus.atlas.explain({
      method: 'GET',
      target: '/nope',
      headers: { 'x-mock-record': ['true'] },
    });
    expect(refused.response?.status).toBe(403);
    expect(refused.trace.outcome).toEqual({ kind: 'recording-not-allowed' });
    expect(calls).toEqual({ claims: [], sends: [], writes: [], fails: [] });
  });

  it('describes the registrations and availability', () => {
    expect(engine(undefined).atlas.recording()).toEqual({
      available: false,
      endpoints: ENDPOINTS,
      timeoutMs: 30000,
      maxResponseBytes: 1024,
      maxConcurrent: 4,
    });
    expect(engine(fakePorts(() => ok).ports).atlas.recording().available).toBe(true);
  });

  it('refuses to create an engine with invalid registrations', () => {
    expect(() =>
      createEngine({
        snapshot: snapshot(TREE),
        config: {
          recording: {
            endpoints: [{ method: 'GET', path: 'nope', upstream: STAGING }],
            maxConcurrent: 1,
            timeoutMs: 1000,
            maxResponseBytes: 1,
          },
        },
      }),
    ).toThrow(/recording\.endpoints/);
  });
});

describe('capture projections', () => {
  const line = (exchange: string, at: string, outcome: string, status?: number) =>
    JSON.stringify({
      exchange,
      at,
      method: 'POST',
      target: '/v1/payments',
      registration: '/v1/payments',
      outcome,
      ...(status === undefined ? {} : { status }),
      durationMs: 5,
    });
  const logs = [
    {
      scenario: 'payment-declined',
      lines: [
        line('000001', '2026-10-03T14:00:01.000Z', 'captured', 402),
        line('000002', '2026-10-03T14:00:03.000Z', 'upstream-timeout'),
        '{not json',
      ],
    },
    { scenario: 'default', lines: [line('000001', '2026-10-03T14:00:02.000Z', 'captured', 200), ''] },
    { scenario: 'Bad Name', lines: [line('000001', '2026-10-03T15:00:00.000Z', 'captured', 200)] },
  ];

  it('lists newest first with links only for captured exchanges, then unreadable lines', () => {
    const list = projectCaptureList(logs, { limit: 100 });
    expect(list.next).toBeNull();
    expect(list.items).toEqual([
      expect.objectContaining({ id: 'payment-declined/000002', outcome: 'upstream-timeout' }) as unknown,
      expect.objectContaining({ id: 'default/000001', detailHref: 'captures/default/000001', status: 200 }) as unknown,
      expect.objectContaining({
        id: 'payment-declined/000001',
        detailHref: 'captures/payment-declined/000001',
      }) as unknown,
      { outcome: 'unreadable', scenario: 'payment-declined', line: 3 },
    ]);
    expect(list.items[0]).not.toHaveProperty('detailHref');
  });

  it('lists a line whose durationMs is not a non-negative integer as unreadable (review D4)', () => {
    const base = JSON.parse(line('000001', '2026-10-03T14:00:01.000Z', 'captured', 200)) as Record<string, unknown>;
    for (const durationMs of [1.5, -1, Number.MAX_SAFE_INTEGER + 1, '5']) {
      expect(parseCaptureLogLine(JSON.stringify({ ...base, durationMs }))).toBeNull();
    }
    expect(parseCaptureLogLine(JSON.stringify({ ...base, durationMs: 0 }))).toMatchObject({ durationMs: 0 });
  });

  it('filters by scenario and outcome and pages with before', () => {
    expect(projectCaptureList(logs, { limit: 100, scenario: 'default' }).items).toHaveLength(1);
    expect(projectCaptureList(logs, { limit: 100, outcome: 'captured' }).items).toHaveLength(2);
    expect(projectCaptureList(logs, { limit: 100, outcome: 'unreadable' }).items).toEqual([
      { outcome: 'unreadable', scenario: 'payment-declined', line: 3 },
    ]);
    const first = projectCaptureList(logs, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.next).toBe('default/000001');
    const before = parseCaptureId(first.next ?? '');
    expect(before).toEqual({ scenario: 'default', exchange: '000001' });
    const second = projectCaptureList(logs, { limit: 2, ...(before === null ? {} : { before }) });
    expect(second.items.map((item) => ('id' in item ? item.id : item.outcome))).toEqual([
      'payment-declined/000001',
      'unreadable',
    ]);
    expect(second.next).toBeNull();
    expect(parseCaptureId('../000001')).toBeNull();
    expect(parseCaptureId('default/1')).toBeNull();
  });

  it('pages unreadable lines with the rest, by a cursor of their own (review D5)', () => {
    const broken = [
      { scenario: 'default', lines: [line('000001', '2026-10-03T14:00:02.000Z', 'captured', 200), '{', '{'] },
      { scenario: 'b', lines: ['{'] },
    ];
    const pages: unknown[][] = [];
    let before: CaptureListQuery['before'];
    for (;;) {
      const page = projectCaptureList(broken, { limit: 1, ...(before === undefined ? {} : { before }) });
      pages.push(page.items.map((item) => ('id' in item ? item.id : `${item.scenario}:${String(item.line)}`)));
      if (page.next === null) break;
      const parsed = parseCaptureCursor(page.next);
      if (parsed === null) throw new Error(page.next);
      before = parsed;
    }
    expect(pages).toEqual([['default/000001'], ['b:1'], ['default:2'], ['default:3']]);
    expect(projectCaptureList(broken, { limit: 2, outcome: 'unreadable' })).toEqual({
      items: [
        { outcome: 'unreadable', scenario: 'b', line: 1 },
        { outcome: 'unreadable', scenario: 'default', line: 2 },
      ],
      next: 'default/line-2',
    });
    // A line cursor is not a capture ID: promotions and details never take one.
    expect(parseCaptureId('default/line-2')).toBeNull();
    expect(parseCaptureCursor('default/line-0')).toBeNull();
    expect(parseCaptureCursor('default/000001')).toEqual({ scenario: 'default', exchange: '000001' });
  });

  it('shows a capture from its files, marking unreadable and modified parts', () => {
    const captured = planCapture({
      reservation: { scenario: 'payment-declined', exchange: '000001' },
      registration: registration(2),
      request: {
        method: 'POST',
        target: '/v1/payments',
        params: {},
        headers: { authorization: ['Bearer t'], 'content-type': ['application/json'] },
        body: utf8Encode('{"a":1}'),
      },
      response: {
        status: 402,
        headers: [
          ['Content-Type', 'application/json'],
          ['Set-Cookie', 'sid=1'],
        ],
        body: utf8Encode('{"b":2}'),
      },
      startedAt: 0,
      finishedAt: 5,
    });
    const files = new Map<string, Uint8Array | null>(captured.files.map((entry) => [entry.name, entry.bytes]));
    const log = { scenario: 'payment-declined', lines: [formatCaptureLogLine(captured.log).trim()] };
    const entry = capturedEntry(log, '000001');
    expect(entry).not.toBeNull();
    if (entry === null) return;
    const detail = projectCaptureDetail('payment-declined', entry, files);
    expect(detail.id).toBe('payment-declined/000001');
    expect(detail.request).toMatchObject({
      state: 'available',
      method: 'POST',
      headers: [
        { name: 'authorization', value: 'Bearer t' },
        { name: 'content-type', value: 'application/json' },
      ],
      body: { state: 'available', encoding: 'utf8', value: '{"a":1}' },
    });
    expect(detail.response).toMatchObject({
      state: 'available',
      status: 402,
      fileName: '402.json',
      headers: [{ name: 'set-cookie', value: 'sid=1' }],
      body: { value: '{"b":2}' },
      modified: false,
    });
    expect(detail.provenance).toMatchObject({ state: 'available', format: 'janus.capture.v1' });

    const edited = new Map(files).set('402.json', utf8Encode('{"b":3}'));
    expect(projectCaptureDetail('payment-declined', entry, edited).response).toMatchObject({ modified: true });
    // A text response is shown whole, past the 64 KiB a fixture preview stops at.
    const large = `{"b":"${'x'.repeat(70 * 1024)}"}`;
    expect(
      projectCaptureDetail('payment-declined', entry, new Map(files).set('402.json', utf8Encode(large))).response,
    ).toMatchObject({ body: { encoding: 'utf8', value: large, truncated: false } });
    const request = JSON.stringify({
      ...JSON.parse(new TextDecoder().decode(files.get('request.json') ?? new Uint8Array())),
      body: { encoding: 'utf8', data: large },
    });
    expect(
      projectCaptureDetail('payment-declined', entry, new Map(files).set('request.json', utf8Encode(request))).request,
    ).toMatchObject({ body: { encoding: 'utf8', value: large, truncated: false } });
    const broken = new Map(files).set('request.json', utf8Encode('{')).set('402.meta.json', null);
    broken.delete('402.json');
    const partial = projectCaptureDetail('payment-declined', entry, broken);
    expect([partial.request.state, partial.response.state, partial.provenance.state]).toEqual([
      'unreadable',
      'unreadable',
      'unreadable',
    ]);
  });

  it('classifies only the allowlisted names of an exchange', () => {
    expect(captureFileKind('request.json', 402)).toBe('request');
    expect(captureFileKind('402.json', 402)).toBe('response');
    expect(captureFileKind('402.headers.json', 402)).toBe('headers');
    expect(captureFileKind('402.meta.json', 402)).toBe('meta');
    expect(captureFileKind('200.json', 402)).toBeNull();
    expect(captureFileKind('../402.json', 402)).toBeNull();
    expect(captureFileKind('notes.txt', 402)).toBeNull();
    expect(captureFileKind('402.empty.json', 402)).toBeNull();
  });
});
