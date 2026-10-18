import { beforeAll, describe, expect, it } from 'vitest';

import type { RequestBody } from '../model.js';
import { createSandbox, type Sandbox } from './index.js';
import type {
  ScriptInput,
  ScriptOutcome,
  ScriptPhase,
  ScriptRequest,
  ScriptResponse,
  ScriptVariables,
} from './types.js';

type Scope = 'request' | 'folder' | 'collection' | 'environment';

/** Variables over fixed scopes plus a run map. */
function fakeVariables(scopes: Partial<Record<Scope, Record<string, unknown>>> = {}): {
  variables: ScriptVariables;
  run: Map<string, unknown>;
} {
  const run = new Map<string, unknown>();
  const order: Scope[] = ['request', 'folder', 'collection', 'environment'];
  const get = (name: string): unknown => {
    if (run.has(name)) return run.get(name);
    for (const scope of order) {
      const values = scopes[scope];
      if (values !== undefined && Object.hasOwn(values, name)) return values[name];
    }
    return undefined;
  };
  const variables: ScriptVariables = {
    get,
    set: (name, value) => run.set(name, value),
    unset: (name) => run.delete(name),
    has: (name) => get(name) !== undefined,
    scope: (scope, name) => scopes[scope]?.[name],
    interpolate: (text) =>
      text.replace(/\{\{([^}]+)\}\}/g, (whole, name: string) => {
        const value = get(name.trim());
        return value === undefined ? whole : typeof value === 'string' ? value : JSON.stringify(value);
      }),
    environmentName: 'staging',
  };
  return { variables, run };
}

function fakeRequest(overrides: Partial<ScriptRequest> = {}): ScriptRequest {
  return {
    method: 'POST',
    url: '{{base}}/carts?page=1#top',
    headers: [
      { name: 'Accept', value: 'application/json' },
      { name: 'X-Trace', value: 't-1' },
    ],
    body: { type: 'json', text: '{"sku":"A-1","qty":2}' },
    ...overrides,
  };
}

const RESPONSE: ScriptResponse = {
  status: 201,
  statusText: 'Created',
  headers: [
    ['Content-Type', 'application/json'],
    ['Set-Cookie', 'a=1'],
    ['Set-Cookie', 'b=2'],
  ],
  text: '{"id":"c-91","data":{"items":[{"id":"i-1","qty":2}]},"ok":true}',
  timeMs: 84,
};

interface RunOptions {
  phase?: ScriptPhase;
  request?: ScriptRequest;
  response?: ScriptResponse;
  variables?: ScriptVariables;
  timeoutMs?: number;
  memoryBytes?: number;
}

let sandbox: Sandbox;

beforeAll(async () => {
  sandbox = await createSandbox();
});

async function run(source: string, options: RunOptions = {}): Promise<ScriptOutcome & { input: ScriptInput }> {
  const phase = options.phase ?? 'after';
  const input: ScriptInput = {
    source,
    phase,
    request: options.request ?? fakeRequest(),
    ...(phase === 'after' ? { response: options.response ?? RESPONSE } : {}),
    variables: options.variables ?? fakeVariables().variables,
    info: { requestName: 'Create cart', requestId: 'checkout/010-create-cart' },
    limits: { timeoutMs: options.timeoutMs ?? 2000, memoryBytes: options.memoryBytes ?? 32 * 1024 * 1024 },
  };
  return { ...(await sandbox.run(input)), input };
}

/** Runs a script and returns the values it logged with {@link out}; `undefined` inside arrays reads as null. */
async function values(source: string, options: RunOptions = {}): Promise<unknown[]> {
  const outcome = await run(source, options);
  expect(outcome.failure).toBeNull();
  return outcome.console.map((line) => (line.text === 'undefined' ? undefined : (JSON.parse(line.text) as unknown)));
}

const out = (expression: string): string => `console.log(JSON.stringify(${expression}));`;

describe('pm variables', () => {
  it.each(['pm.variables', 'pm.environment', 'pm.collectionVariables'])('%s reads, writes and renders', async (api) => {
    const { variables, run: runVars } = fakeVariables({ environment: { base: 'https://x', token: 'env' } });
    const results = await values(
      [
        out(`${api}.get('token')`),
        out(`${api}.has('token')`),
        out(`${api}.has('nope')`),
        `${api}.set('token', 'run');`,
        `${api}.set('count', { n: 1, f: function () {} });`,
        out(`${api}.get('token')`),
        out(`${api}.replaceIn('{{base}}/{{token}}/{{missing}}')`),
        `${api}.unset('token');`,
        out(`${api}.get('token')`),
      ].join('\n'),
      { variables },
    );
    expect(results).toEqual(['env', true, false, 'run', 'https://x/run/{{missing}}', 'env']);
    expect(runVars.get('count')).toEqual({ n: 1 });
  });

  it('exposes the environment name', async () => {
    expect(await values(out('pm.environment.name'))).toEqual(['staging']);
  });
});

describe('pm.request', () => {
  it('reads the method, URL, headers and body', async () => {
    const results = await values(
      [
        out('pm.request.method'),
        out('pm.request.url.toString()'),
        out('`${pm.request.url}`'),
        out('pm.request.url.getQueryString()'),
        out('pm.request.headers.get("accept")'),
        out('pm.request.headers.get("missing")'),
        out('pm.request.headers.has("x-trace")'),
        out('pm.request.headers.toObject()'),
        out('pm.request.body.mode'),
        out('pm.request.body.raw'),
        out('String(pm.request.body)'),
      ].join('\n'),
    );
    expect(results).toEqual([
      'POST',
      '{{base}}/carts?page=1#top',
      '{{base}}/carts?page=1#top',
      'page=1',
      'application/json',
      undefined,
      true,
      { Accept: 'application/json', 'X-Trace': 't-1' },
      'raw',
      '{"sku":"A-1","qty":2}',
      '{"sku":"A-1","qty":2}',
    ]);
  });

  it.each<[RequestBody | undefined, unknown]>([
    [
      { type: 'text', text: 'hi' },
      { mode: 'raw', raw: 'hi' },
    ],
    [
      { type: 'xml', text: '<a/>' },
      { mode: 'raw', raw: '<a/>' },
    ],
    [
      { type: 'form', fields: [{ name: 'a', value: '1' }] },
      { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1' }] },
    ],
    [
      { type: 'multipart', parts: [{ name: 'f', file: 'x.png' }] },
      { mode: 'formdata', formdata: [{ key: 'f', type: 'file', src: 'x.png' }] },
    ],
    [
      { type: 'file', file: 'b.bin' },
      { mode: 'file', file: { src: 'b.bin' } },
    ],
    [
      { type: 'graphql', query: '{ a }' },
      { mode: 'graphql', graphql: { query: '{ a }' } },
    ],
    [undefined, {}],
  ])('maps a %j body to its Postman mode', async (body, expected) => {
    const [view] = await values(out('pm.request.body'), { request: fakeRequest({ body }) });
    expect(view).toMatchObject(expected as object);
  });

  it('changes the request in a before script', async () => {
    const request = fakeRequest();
    const outcome = await run(
      [
        'pm.request.method = "put";',
        'pm.request.url.query.add({ key: "q", value: "{{term}}" });',
        'pm.request.url.query.add("flag");',
        'pm.request.url.query.remove("page");',
        'pm.request.headers.add({ key: "X-One", value: "1" });',
        'pm.request.headers.add("X-Two: 2");',
        'pm.request.headers.upsert({ key: "accept", value: "text/plain" });',
        'pm.request.headers.remove("x-trace");',
        'pm.request.body.update(\'{"sku":"B-2"}\');',
      ].join('\n'),
      { phase: 'before', request },
    );
    expect(outcome.failure).toBeNull();
    expect(request).toEqual({
      method: 'PUT',
      url: '{{base}}/carts?q={{term}}&flag#top',
      headers: [
        { name: 'accept', value: 'text/plain' },
        { name: 'X-One', value: '1' },
        { name: 'X-Two', value: '2' },
      ],
      body: { type: 'json', text: '{"sku":"B-2"}' },
    });
  });

  it('keeps a raw body type and creates a body when there is none', async () => {
    const xml = fakeRequest({ body: { type: 'xml', text: '<a/>' } });
    await run('pm.request.body.update("<b/>")', { phase: 'before', request: xml });
    expect(xml.body).toEqual({ type: 'xml', text: '<b/>' });
    const none = fakeRequest({ body: undefined });
    await run('pm.request.body.update("plain")', { phase: 'before', request: none });
    expect(none.body).toEqual({ type: 'text', text: 'plain' });
    const form = fakeRequest({ body: undefined });
    await run('pm.request.body.update({ mode: "urlencoded", urlencoded: [{ key: "a", value: 1 }] })', {
      phase: 'before',
      request: form,
    });
    expect(form.body).toEqual({ type: 'form', fields: [{ name: 'a', value: '1' }] });
    const url = fakeRequest();
    await run('pm.request.url = "https://example.test/x"', { phase: 'before', request: url });
    expect(url.url).toBe('https://example.test/x');
  });

  it.each([
    'pm.request.method = "GET"',
    'pm.request.url = "x"',
    'pm.request.url.query.add("a=1")',
    'pm.request.url.query.remove("page")',
    'pm.request.headers.add({ key: "a", value: "b" })',
    'pm.request.headers.upsert({ key: "a", value: "b" })',
    'pm.request.headers.remove("accept")',
    'pm.request.body.update("x")',
    'req.setUrl("x")',
    'req.setMethod("GET")',
    'req.setHeader("a", "b")',
    'req.setHeaders({})',
    'req.deleteHeader("accept")',
    'req.setBody({})',
  ])('refuses %s in an after script', async (change) => {
    const request = fakeRequest();
    const before = structuredClone(request);
    const outcome = await run(`\n${change};`, { request });
    expect(outcome.failure).toEqual({
      code: 'script-error',
      message: 'the request cannot be changed in an after script: it has already been sent',
      line: 2,
    });
    expect(request).toEqual(before);
  });

  it('refuses a method that is not an HTTP token or is refused', async () => {
    expect((await run('pm.request.method = "no way"', { phase: 'before' })).failure?.message).toMatch(
      /not an HTTP method/,
    );
    expect((await run('req.setMethod("connect")', { phase: 'before' })).failure?.message).toMatch(/cannot use CONNECT/);
  });
});

describe('pm.response', () => {
  it('reads the response', async () => {
    const results = await values(
      [
        out('pm.response.code'),
        out('pm.response.status'),
        out('pm.response.responseTime'),
        out('pm.response.headers.get("content-type")'),
        out('pm.response.headers.get("missing")'),
        out('pm.response.text()'),
        out('pm.response.json().data.items[0].id'),
      ].join('\n'),
    );
    expect(results).toEqual([201, 'Created', 84, 'application/json', undefined, RESPONSE.text, 'i-1']);
  });

  it('runs the response assertions as tests', async () => {
    const outcome = await run(
      [
        'pm.test("status", () => pm.response.to.have.status(201));',
        'pm.test("reason", () => pm.response.to.have.status("Created"));',
        'pm.test("wrong status", () => pm.response.to.have.status(200));',
        'pm.test("header", () => pm.response.to.have.header("content-type"));',
        'pm.test("header value", () => pm.response.to.have.header("Content-Type", "application/json"));',
        'pm.test("missing header", () => pm.response.to.have.header("X-Nope"));',
        'pm.test("json", () => pm.response.to.have.jsonBody());',
        'pm.test("json path", () => pm.response.to.have.jsonBody("data.items[0].id"));',
        'pm.test("json value", () => pm.response.to.have.jsonBody("data.items[0]", { id: "i-1", qty: 2 }));',
        'pm.test("json wrong value", () => pm.response.to.have.jsonBody("id", "c-1"));',
        'pm.test("json missing", () => pm.response.to.have.jsonBody("data.nope"));',
        'pm.test("ok", () => pm.response.to.be.ok);',
        'pm.test("assertion error", () => { try { pm.response.to.have.status(500) } catch (e) { pm.expect(e.name).to.equal("AssertionError") } });',
      ].join('\n'),
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.tests).toEqual([
      { name: 'status', passed: true },
      { name: 'reason', passed: true },
      { name: 'wrong status', passed: false, message: 'expected response to have status code 200 but got 201' },
      { name: 'header', passed: true },
      { name: 'header value', passed: true },
      { name: 'missing header', passed: false, message: 'expected response to have header X-Nope' },
      { name: 'json', passed: true },
      { name: 'json path', passed: true },
      { name: 'json value', passed: true },
      {
        name: 'json wrong value',
        passed: false,
        message: "response body JSON at id: expected 'c-91' to deeply equal 'c-1'",
      },
      { name: 'json missing', passed: false, message: 'expected response body JSON to have path data.nope' },
      { name: 'ok', passed: true },
      { name: 'assertion error', passed: true },
    ]);
  });

  it('fails to.be.ok and to.have.jsonBody on a non-JSON error response', async () => {
    const outcome = await run(
      'pm.test("ok", () => pm.response.to.be.ok); pm.test("json", () => pm.response.to.have.jsonBody());',
      {
        response: { ...RESPONSE, status: 404, statusText: 'Not Found', text: 'nope' },
      },
    );
    expect(outcome.tests).toEqual([
      { name: 'ok', passed: false, message: 'expected response code to be 2XX but found 404' },
      { name: 'json', passed: false, message: 'expected response body to be valid JSON' },
    ]);
  });

  it('is not available in a before script', async () => {
    const outcome = await run('\n\npm.response.code', { phase: 'before' });
    expect(outcome.failure).toEqual({
      code: 'script-error',
      message: 'pm.response is not available in a before script',
      line: 3,
    });
    expect(await values(out('[typeof res, typeof responseBody, typeof responseCode]'), { phase: 'before' })).toEqual([
      ['undefined', 'undefined', 'undefined'],
    ]);
  });
});

describe('pm.test, pm.expect, pm.info and the older globals', () => {
  it('records tests with chai assertion messages', async () => {
    const outcome = await run(
      [
        'pm.test("passes", function () { pm.expect(pm.response.code).to.equal(201); });',
        'pm.test("fails", function () { pm.expect(1).to.equal(2); });',
        'pm.test("throws", function () { null.x; });',
        'pm.test("expect global", () => expect([1, 2]).to.have.lengthOf(2));',
        'pm.test("no function");',
      ].join('\n'),
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.tests).toEqual([
      { name: 'passes', passed: true },
      { name: 'fails', passed: false, message: 'expected 1 to equal 2' },
      { name: 'throws', passed: false, message: "cannot read property 'x' of null" },
      { name: 'expect global', passed: true },
      { name: 'no function', passed: false, message: 'the test has no function' },
    ]);
  });

  it('fails the script on an assertion outside a test', async () => {
    const outcome = await run('pm.test("first", () => {});\npm.expect(1).to.equal(2);');
    expect(outcome.failure).toEqual({
      code: 'script-error',
      message: 'AssertionError: expected 1 to equal 2',
      line: 2,
    });
    expect(outcome.tests).toEqual([{ name: 'first', passed: true }]);
  });

  it('awaits a test that returns a promise', async () => {
    const outcome = await run(
      [
        'pm.test("async pass", async () => { await null; pm.expect(1).to.equal(1); });',
        'pm.test("async fail", () => Promise.resolve().then(() => { throw new Error("late"); }));',
        'pm.test("never settles", () => new Promise(() => {}));',
        'test("bruno async", async () => { await Promise.resolve(); expect(res.status).to.equal(201); });',
      ].join('\n'),
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.tests).toEqual([
      { name: 'async pass', passed: true },
      { name: 'async fail', passed: false, message: 'late' },
      { name: 'never settles', passed: false, message: 'the test did not finish' },
      { name: 'bruno async', passed: true },
    ]);
  });

  it('times out a test whose promise keeps the script busy', async () => {
    const outcome = await run(
      'pm.test("spin", () => { const spin = () => Promise.resolve().then(spin); return spin(); });',
      {
        timeoutMs: 200,
      },
    );
    expect(outcome.failure?.code).toBe('script-timeout');
    expect(outcome.tests).toEqual([{ name: 'spin', passed: false, message: 'the test did not finish' }]);
  });

  it('exposes pm.info', async () => {
    expect(await values(out('[pm.info.requestName, pm.info.requestId, pm.info.eventName]'))).toEqual([
      ['Create cart', 'checkout/010-create-cart', 'test'],
    ]);
  });

  it('supports tests[...] and the older response globals', async () => {
    const { variables, run: runVars } = fakeVariables({ environment: { host: 'h' } });
    const outcome = await run(
      [
        'tests["status is 201"] = responseCode.code === 201;',
        'tests["fails"] = false;',
        'tests["fails"] = 1;',
        out('[responseCode, responseHeaders["Content-Type"], JSON.parse(responseBody).id, responseTime]'),
        'postman.setEnvironmentVariable("cart", "c-91");',
        out('[postman.getEnvironmentVariable("cart"), postman.getEnvironmentVariable("host")]'),
      ].join('\n'),
      { variables },
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.tests).toEqual([
      { name: 'status is 201', passed: true },
      { name: 'fails', passed: true },
    ]);
    expect(outcome.console.map((line) => JSON.parse(line.text) as unknown)).toEqual([
      [{ code: 201, name: 'Created', detail: 'Created' }, 'application/json', 'c-91', 84],
      ['c-91', 'h'],
    ]);
    expect(runVars.get('cart')).toBe('c-91');
  });
});

describe('the Bruno API', () => {
  it('reads and writes variables', async () => {
    const { variables, run: runVars } = fakeVariables({
      request: { r: 'request' },
      folder: { f: 'folder' },
      collection: { c: 'collection' },
      environment: { e: 'environment', base: 'https://x' },
    });
    const results = await values(
      [
        out('[bru.getVar("r"), bru.getVar("e"), bru.hasVar("e"), bru.hasVar("nope")]'),
        out('[bru.getRequestVar("r"), bru.getFolderVar("f"), bru.getCollectionVar("c"), bru.getEnvVar("e")]'),
        out('[bru.getRequestVar("e"), bru.getEnvName()]'),
        'bru.setVar("token", "t-1"); bru.setEnvVar("e", "changed");',
        out('[bru.getVar("token"), bru.getVar("e")]'),
        'bru.deleteVar("token");',
        out('bru.getVar("token")'),
        out('bru.interpolate("{{base}}/{{e}}")'),
        out('bru.interpolate({ url: "{{base}}" })'),
      ].join('\n'),
      { variables },
    );
    expect(results).toEqual([
      ['request', 'environment', true, false],
      ['request', 'folder', 'collection', 'environment'],
      [null, 'staging'],
      ['t-1', 'changed'],
      undefined,
      'https://x/changed',
      { url: 'https://x' },
    ]);
    expect(runVars.get('e')).toBe('changed');
  });

  it('reads the request', async () => {
    const results = await values(
      [
        out('[req.getUrl(), req.getMethod(), req.getHeader("accept"), req.getHeaders()]'),
        out('[req.url, req.method, req.body]'),
        out('req.getBody()'),
      ].join('\n'),
    );
    expect(results).toEqual([
      ['{{base}}/carts?page=1#top', 'POST', 'application/json', { Accept: 'application/json', 'X-Trace': 't-1' }],
      ['{{base}}/carts?page=1#top', 'POST', { sku: 'A-1', qty: 2 }],
      { sku: 'A-1', qty: 2 },
    ]);
    const [text] = await values(out('req.getBody()'), { request: fakeRequest({ body: { type: 'text', text: 'hi' } }) });
    expect(text).toBe('hi');
  });

  it('changes the request in a before script', async () => {
    const request = fakeRequest();
    const outcome = await run(
      [
        'req.setUrl("{{base}}/v2");',
        'req.setMethod("patch");',
        'req.setHeader("X-Trace", "t-2");',
        'req.setHeader("X-New", "n");',
        'req.setBody({ sku: "C-3" });',
      ].join('\n'),
      { phase: 'before', request },
    );
    expect(outcome.failure).toBeNull();
    expect(request).toEqual({
      method: 'PATCH',
      url: '{{base}}/v2',
      headers: [
        { name: 'Accept', value: 'application/json' },
        { name: 'X-Trace', value: 't-2' },
        { name: 'X-New', value: 'n' },
      ],
      body: { type: 'json', text: '{"sku":"C-3"}' },
    });
    const replaced = fakeRequest();
    await run('req.setHeaders({ "X-Only": "1" }); req.setBody("text body");', { phase: 'before', request: replaced });
    expect(replaced.headers).toEqual([{ name: 'X-Only', value: '1' }]);
    expect(replaced.body).toEqual({ type: 'json', text: 'text body' });
  });

  it('reads the response', async () => {
    const results = await values(
      [
        out('[res.status, res.getStatus(), res.responseTime, res.getResponseTime()]'),
        out('[res.headers["content-type"], res.getHeader("Content-Type"), res.getHeaders()["set-cookie"]]'),
        out('[res.body.id, res.getBody().ok]'),
        out('[res("data.items[0].id"), res("data.items.0.qty"), res("data.nope"), res("id")]'),
      ].join('\n'),
    );
    expect(results).toEqual([
      [201, 201, 84, 84],
      ['application/json', 'application/json', 'a=1, b=2'],
      ['c-91', true],
      ['i-1', 2, null, 'c-91'],
    ]);
    const [body] = await values(out('[res.body, res("a")]'), { response: { ...RESPONSE, text: 'plain' } });
    expect(body).toEqual(['plain', null]);
  });

  it('runs test() with expect', async () => {
    const outcome = await run('test("status", function () { expect(res.getStatus()).to.equal(200); });');
    expect(outcome.tests).toEqual([{ name: 'status', passed: false, message: 'expected 201 to equal 200' }]);
  });
});

describe('unsupported calls', () => {
  it.each([
    ['pm.sendRequest("https://x", () => {})', 'pm.sendRequest'],
    ['bru.sendRequest({})', 'bru.sendRequest'],
    ['bru.runRequest("x")', 'bru.runRequest'],
    ['postman.setNextRequest("x")', 'postman.setNextRequest'],
    ['pm.execution.setNextRequest("x")', 'pm.execution.setNextRequest'],
    ['bru.setNextRequest("x")', 'bru.setNextRequest'],
    ['pm.visualizer.set("<b></b>")', 'pm.visualizer'],
    ['const v = pm.visualizer', 'pm.visualizer'],
    ['pm.cookies.jar()', 'pm.cookies.jar'],
    ['require("lodash")', 'require'],
  ])('%s fails the step, even when caught', async (call, name) => {
    for (const source of [`\n${call};`, `\ntry { ${call}; } catch (e) {}`]) {
      const outcome = await run(source);
      expect(outcome.failure).toEqual({
        code: 'script-unsupported',
        message: `${name} is not supported in Janus scripts`,
        line: 2,
      });
    }
  });

  it('fails a dynamic import, even when caught', async () => {
    const outcome = await run('import("node:fs").then(() => {}, () => {});');
    expect(outcome.failure).toEqual({
      code: 'script-unsupported',
      message: 'import() is not supported in Janus scripts',
    });
  });

  it('wins over a later error and inside a test', async () => {
    const outcome = await run('pm.test("t", () => pm.sendRequest("x"));\nthrow new Error("later");');
    expect(outcome.failure?.code).toBe('script-unsupported');
    expect(outcome.tests).toEqual([
      { name: 't', passed: false, message: 'pm.sendRequest is not supported in Janus scripts' },
    ]);
  });
});

describe('containment and limits', () => {
  it('has no require, timers, fetch, process or host access', async () => {
    const [result] = await values(
      out(
        '[typeof process, typeof setTimeout, typeof setInterval, typeof fetch, typeof XMLHttpRequest, typeof std, typeof os, typeof Buffer, typeof globalThis.constructor.constructor("return this")().process, typeof hostCall, typeof loadChai]',
      ),
    );
    expect(result).toEqual(Array.from({ length: 11 }, () => 'undefined'));
  });

  it('runs each script in a fresh context', async () => {
    expect(
      (await run('globalThis.leak = 1; var declared = 2; Object.prototype.polluted = 3; pm.extra = 4;')).failure,
    ).toBeNull();
    expect(await values(out('[typeof leak, typeof declared, ({}).polluted, pm.extra]'))).toEqual([
      ['undefined', 'undefined', null, null],
    ]);
  });

  it('stops a script that runs too long', async () => {
    const started = Date.now();
    const outcome = await run('while (true) {}', { timeoutMs: 100 });
    expect(outcome.failure).toEqual({ code: 'script-timeout', message: 'the script ran longer than 100 ms' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await run('try { while (true) {} } catch (e) {}', { timeoutMs: 50 })).failure?.code).toBe('script-timeout');
  });

  it('stops a script that uses too much memory', async () => {
    const huge = await run('const a = []; while (true) a.push({ n: a.length });', { memoryBytes: 4 * 1024 * 1024 });
    expect(huge.failure).toEqual({ code: 'script-memory', message: 'the script used more than 4194304 bytes' });
    const array = await run('new Array(1e9).fill(0)', { memoryBytes: 4 * 1024 * 1024 });
    expect(array.failure?.code).toBe('script-memory');
    const inTest = await run('pm.test("big", () => { const a = []; while (true) a.push({}); });', {
      memoryBytes: 4 * 1024 * 1024,
    });
    expect(inTest.failure?.code).toBe('script-memory');
    expect(inTest.tests).toEqual([{ name: 'big', passed: false, message: 'the test did not finish' }]);
  });

  it('reports a thrown error with its script line', async () => {
    expect((await run('const a = 1;\n\nthrow new Error("boom");')).failure).toEqual({
      code: 'script-error',
      message: 'boom',
      line: 3,
    });
    expect((await run('\nnull.x')).failure).toEqual({
      code: 'script-error',
      message: "TypeError: cannot read property 'x' of null",
      line: 2,
    });
    expect((await run('function f() {\n  throw new RangeError("deep");\n}\nf();')).failure).toEqual({
      code: 'script-error',
      message: 'RangeError: deep',
      line: 2,
    });
    expect((await run('throw "plain"')).failure).toEqual({ code: 'script-error', message: 'plain' });
    expect((await run('\n\nlet x = ;')).failure).toMatchObject({ code: 'script-error', line: 3 });
  });

  it('reports runaway recursion and recovers from a native stack overflow', async () => {
    expect((await run('function r() { return r(); }\nr();')).failure).toMatchObject({
      code: 'script-error',
      message: 'InternalError: stack overflow',
    });
    // Compiling deeply nested code at run time exhausts the host's native stack before QuickJS notices.
    for (const source of [
      'Function("x = " + "[".repeat(5000) + "]".repeat(5000));',
      'let o = []; for (let i = 0; i < 100000; i++) o = [o]; JSON.stringify(o);',
    ]) {
      const { failure } = await run(source);
      expect(failure?.code).toBe('script-error');
      expect(failure?.message).toMatch(/stack overflow/);
      expect(await values(out('1 + 1'))).toEqual([2]);
    }
  });

  it('keeps at most 1 000 console lines of 4 KiB', async () => {
    const outcome = await run(
      [
        'console.info("info", 1, { a: [1] }, undefined, null, new Error("e"));',
        'console.warn("warn"); console.error("error");',
        'console.log("é".repeat(5000));',
        'for (let i = 0; i < 2000; i++) console.log(i);',
      ].join('\n'),
    );
    expect(outcome.failure).toBeNull();
    expect(outcome.console).toHaveLength(1000);
    expect(outcome.console.slice(0, 3)).toEqual([
      { level: 'info', text: 'info 1 {"a":[1]} undefined null Error: e' },
      { level: 'warn', text: 'warn' },
      { level: 'error', text: 'error' },
    ]);
    expect(outcome.console[3]?.text).toBe('é'.repeat(2048));
    expect(outcome.console[999]).toEqual({ level: 'log', text: '995' });
  });

  it('gives every context chai', async () => {
    const outcome = await run(
      'pm.test("deep", () => { expect({ a: [1, { b: 2 }] }).to.deep.equal({ a: [1, { b: 3 }] }); });\npm.test("ok", () => pm.expect("abc").to.include("b"));',
    );
    expect(outcome.tests).toEqual([
      {
        name: 'deep',
        passed: false,
        message: 'expected { a: [ 1, { b: 2 } ] } to deeply equal { a: [ 1, { b: 3 } ] }',
      },
      { name: 'ok', passed: true },
    ]);
  });
});

describe('check', () => {
  it('accepts a script without running it', () => {
    expect(sandbox.check('while (true) {}')).toBeNull();
    expect(sandbox.check('pm.test("x", () => pm.expect(1).to.equal(1));')).toBeNull();
  });

  it('reports a syntax error with its line and column', () => {
    expect(sandbox.check('const a = 1;\n\n  let b = ;')).toEqual({
      message: "SyntaxError: unexpected token in expression: ';'",
      line: 3,
      column: 11,
    });
    expect(sandbox.check('import x from "y";')?.line).toBe(1);
  });

  it('reports deep nesting as a problem instead of failing', () => {
    expect(sandbox.check(`x = ${'['.repeat(5000)}${']'.repeat(5000)};`)).toMatchObject({ line: 1 });
    expect(sandbox.check('1 + 1')).toBeNull();
  });
});
