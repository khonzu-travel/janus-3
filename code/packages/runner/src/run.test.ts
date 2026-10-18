import { describe, expect, it, vi } from 'vitest';

import {
  requestTokenGrammar,
  type AtlasExplanation,
  type CapturePlan,
  type CaptureReservation,
  type CaptureSink,
  type CaptureFailureEntry,
} from '@janus/core';

import {
  createRunner,
  type ExplainRequest,
  type MockRequest,
  type RunnerPorts,
  type RunnerSettings,
  type SendResponse,
  type ScriptHost,
} from './run.js';
import type { SendRequest } from './render.js';
import { buildRequestTree, type RequestTree } from './tree.js';
import type { ScriptInput, ScriptOutcome } from './sandbox/types.js';

const grammar = requestTokenGrammar({});
const encoder = new TextEncoder();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tree(files: Record<string, string>, directories: string[]): RequestTree {
  const result = buildRequestTree(
    {
      files: new Map(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)])),
      directories: new Set(directories),
    },
    { grammar },
  );
  expect(result.errors).toEqual([]);
  return result.tree;
}

const SETTINGS: RunnerSettings = {
  grammar,
  timezone: 'UTC',
  scriptTimeoutMs: 1000,
  scriptMemoryBytes: 32 * 1024 * 1024,
  maxActiveRuns: 2,
  keepRuns: 50,
  recordingTimeoutMs: 1000,
  basePath: '',
  scenarios: { names: ['default', 's', 'cart', 'other'], default: 'default' },
};

interface Harness {
  ports: RunnerPorts;
  sent: SendRequest[];
  /** Whether each send asked for a compressed answer to be decoded. */
  decoded: boolean[];
  mocked: MockRequest[];
  explained: ExplainRequest[];
  plans: { reservation: CaptureReservation; plan: CapturePlan }[];
  failures: CaptureFailureEntry[];
  events: unknown[];
}

function harness(answer: (request: SendRequest) => SendResponse | Promise<SendResponse>): Harness {
  const sent: SendRequest[] = [];
  const decoded: boolean[] = [];
  const mocked: MockRequest[] = [];
  const explained: ExplainRequest[] = [];
  const plans: Harness['plans'] = [];
  const failures: CaptureFailureEntry[] = [];
  const events: unknown[] = [];
  let exchange = 0;
  let slots = 0;
  const captures: CaptureSink = {
    claim: (scenario) => Promise.resolve({ scenario, exchange: String(++exchange).padStart(6, '0') }),
    write: (reservation, plan) => {
      plans.push({ reservation, plan });
      return Promise.resolve({ ok: true });
    },
    fail: (_reservation, entry) => {
      failures.push(entry);
      return Promise.resolve();
    },
  };
  const ports: RunnerPorts = {
    send: (request, _signal, options) => {
      sent.push(request);
      decoded.push(options?.decode === true);
      return Promise.resolve(answer(request));
    },
    mock: (request) => {
      mocked.push(request);
      return Promise.resolve(answer(request.request));
    },
    explain: (request) => {
      explained.push(request);
      return Promise.resolve(EXPLANATION);
    },
    captures,
    now: () => Date.UTC(2026, 9, 10, 12),
    progress: (event) => events.push(event),
    readFile: () => Promise.resolve(null),
    randomBytes: (count) => new Uint8Array(count).fill(7),
    slots: {
      acquire: () => Promise.resolve(slots++ < 4),
      release: () => {
        slots--;
      },
    },
  };
  return { ports, sent, decoded, mocked, explained, plans, failures, events };
}

const EXPLANATION = {
  snapshotVersion: 'v1',
  response: {
    status: 200,
    headers: [{ name: 'content-type', value: 'application/json' }],
    body: { encoding: 'utf8', data: '{}', truncated: false, size: 2 },
  },
  trace: { outcome: { kind: 'matched' } },
  fixture: null,
  shadowed: [],
  notes: [],
} as unknown as AtlasExplanation;

const noScripts: ScriptHost = {
  run: () => Promise.resolve({ failure: null, tests: [], console: [] }),
};

const json = (status: number, value: unknown, headers: [string, string][] = []): SendResponse => ({
  kind: 'response',
  status,
  headers: [['Content-Type', 'application/json'], ...headers],
  body: encoder.encode(JSON.stringify(value)),
  timeMs: 12,
});

const CHECKOUT = tree(
  {
    'checkout/folder.yaml': 'name: Checkout\nstripPrefix: /v1\nvars:\n  baseUrl: https://staging.example.com/v1\n',
    'checkout/010-create-cart.request.yaml':
      'name: Create cart\nmethod: POST\nurl: "{{baseUrl}}/carts"\nbody:\n  type: json\n  text: \'{"currency":"EUR"}\'\nextract:\n  cartId: "{{$response.body.$.id}}"\n',
    'checkout/020-add-item.request.yaml':
      'name: Add item\nmethod: POST\nurl: "{{baseUrl}}/carts/:cartId/items"\npathParams:\n  cartId: "{{cartId}}"\nbody:\n  type: json\n  text: \'{"sku":"{{sku}}","qty":{{qty}}}\'\nvars:\n  sku: SKU-1\n  qty: "2"\n',
    'checkout/030-get-cart.request.yaml':
      'name: Get cart\nmethod: GET\nurl: "{{baseUrl}}/carts/:cartId"\npathParams:\n  cartId: "{{cartId}}"\n',
  },
  ['checkout'],
);

describe('runs', () => {
  it.each(['record', 'mock'] as const)('extracts the headers actually sent in %s mode', async (mode) => {
    const requests = tree(
      {
        'api/010-a.request.yaml': `name: A
method: GET
url: https://example.com/a
headers:
  - name: Host
    value: other.example.com
  - name: Accept-Encoding
    value: gzip
  - name: X-Mock-Scenario
    value: other
extract:
  host:
    value: '{{$request.header.host}}'
    default: absent
  encoding: '{{$request.header.accept-encoding}}'
  scenario:
    value: '{{$request.header.x-mock-scenario}}'
    default: absent
`,
      },
      ['api'],
    );
    const h = harness(() => json(200, {}));
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      { target: { kind: 'node', id: 'api' }, environment: null, mode, scenario: 's', vars: {} },
      requests,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(run.outcome).toBe('passed');
    expect(run.vars).toEqual({
      host: 'absent',
      encoding: mode === 'record' ? 'identity' : 'gzip',
      // The request's own X-Mock-Scenario wins over the run's; record mode files under it and strips it.
      scenario: mode === 'record' ? 'absent' : 'other',
    });
    if (mode === 'record') expect(h.plans[0]?.reservation.scenario).toBe('other');
    expect(run.steps[0]?.scenarioFrom).toBe('request');
  });

  it('fails extract when its variable templates are unresolved', async () => {
    const requests = tree(
      {
        'api/010-a.request.yaml': `name: A
method: GET
url: https://example.com/a
extract:
  value: '{{missing}}-{{$response.status}}-{{alsoMissing}}'
`,
        'api/020-b.request.yaml': 'name: B\nmethod: GET\nurl: https://example.com/b\n',
      },
      ['api'],
    );
    const h = harness(() => json(200, {}));
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      { target: { kind: 'node', id: 'api' }, environment: null, mode: 'mock', scenario: 's', vars: {} },
      requests,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(run.outcome).toBe('failed');
    expect(run.steps[0]?.failure).toMatchObject({ code: 'unresolved-variable' });
    expect(run.steps[0]?.failure?.message).toContain('missing');
    expect(run.steps[0]?.failure?.message).toContain('alsoMissing');
    expect(run.vars).toEqual({});
    expect(run.steps[1]?.outcome).toBe('not-run');
    expect(h.mocked).toHaveLength(1);
  });

  it.each(['record', 'mock'] as const)('does not send in %s mode when cancelled during a body read', async (mode) => {
    const requests = tree(
      {
        'api/010-a.request.yaml':
          'name: A\nmethod: POST\nurl: https://example.com/a\nbody:\n  type: file\n  file: body.txt\n',
      },
      ['api'],
    );
    const h = harness(() => json(200, {}));
    const body = deferred<Uint8Array>();
    const reading = deferred<undefined>();
    h.ports.readFile = () => {
      reading.resolve(undefined);
      return body.promise;
    };
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      { target: { kind: 'node', id: 'api' }, environment: null, mode, scenario: 's', vars: {} },
      requests,
    );
    if (!started.ok) throw new Error(started.message);
    await reading.promise;
    expect(runner.cancel(started.id)).toBe(true);
    body.resolve(encoder.encode('body'));
    const run = await started.done;
    expect(run.outcome).toBe('cancelled');
    expect(run.steps[0]?.outcome).toBe('not-run');
    expect(h.sent).toEqual([]);
    expect(h.mocked).toEqual([]);
    expect(h.plans).toEqual([]);
  });

  it('does not send when cancelled while claiming a capture and releases the recording slot', async () => {
    const h = harness(() => json(200, {}));
    const claim = deferred<CaptureReservation>();
    const claiming = deferred<undefined>();
    h.ports.captures.claim = () => {
      claiming.resolve(undefined);
      return claim.promise;
    };
    const release = vi.spyOn(h.ports.slots, 'release');
    const fail = vi.spyOn(h.ports.captures, 'fail');
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      { target: { kind: 'node', id: 'checkout' }, environment: null, mode: 'record', scenario: 's', vars: {} },
      CHECKOUT,
    );
    if (!started.ok) throw new Error(started.message);
    await claiming.promise;
    runner.cancel(started.id);
    claim.resolve({ scenario: 's', exchange: '000001' });
    const run = await started.done;
    expect(run.outcome).toBe('cancelled');
    expect(run.steps.every((step) => step.outcome === 'not-run')).toBe(true);
    expect(h.sent).toEqual([]);
    expect(release).toHaveBeenCalledOnce();
    // The claimed exchange is logged, so it is not left as an incomplete capture.
    expect(fail).toHaveBeenCalledWith(
      { scenario: 's', exchange: '000001' },
      expect.objectContaining({ exchange: '000001', outcome: 'upstream-failed', source: 'runner' }),
    );
  });

  it('runs a collection in name order, carrying extracted values and writing runner captures', async () => {
    const h = harness((request) =>
      request.method === 'POST' && request.url.endsWith('/carts') ? json(201, { id: 'c-91' }) : json(200, { ok: true }),
    );
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      { target: { kind: 'node', id: 'checkout' }, environment: null, mode: 'record', scenario: 'cart', vars: {} },
      CHECKOUT,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(run.outcome).toBe('passed');
    expect(run.steps.map((step) => [step.requestId, step.outcome, step.capture])).toEqual([
      ['checkout/010-create-cart', 'passed', 'cart/000001'],
      ['checkout/020-add-item', 'passed', 'cart/000002'],
      ['checkout/030-get-cart', 'passed', 'cart/000003'],
    ]);
    expect(h.sent.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST https://staging.example.com/v1/carts',
      'POST https://staging.example.com/v1/carts/c-91/items',
      'GET https://staging.example.com/v1/carts/c-91',
    ]);
    expect(new TextDecoder().decode(h.sent[1]?.body ?? new Uint8Array())).toBe('{"sku":"SKU-1","qty":2}');
    expect(h.sent[0]?.headers).toContainEqual(['Accept-Encoding', 'identity']);
    // Record mode keeps the bytes as received, so the capture is what the upstream sent.
    expect(h.decoded).toEqual([false, false, false]);
    expect(run.vars).toEqual({ cartId: 'c-91' });
    expect(run.steps[0]?.variables).toEqual({ cartId: 'c-91' });

    const meta = h.plans[1]?.plan.files.find((file) => file.name === '201.meta.json');
    expect(meta).toBeUndefined();
    const added = h.plans[1]?.plan;
    const metaFile = added?.files.find((file) => file.name.endsWith('.meta.json'));
    const parsed = JSON.parse(new TextDecoder().decode(metaFile?.bytes)) as {
      source: string;
      registration: { path: string; upstream: string };
    };
    expect(parsed.source).toBe('runner');
    expect(parsed.registration).toMatchObject({
      path: '/carts/{cartId}/items',
      upstream: 'https://staging.example.com/v1',
    });
    expect(added?.log).toMatchObject({ source: 'runner', run: started.id, request: 'checkout/020-add-item' });
    const requestFile = added?.files.find((file) => file.name === 'request.json');
    expect(JSON.parse(new TextDecoder().decode(requestFile?.bytes))).toMatchObject({
      source: 'runner',
      url: 'https://staging.example.com/v1/carts/c-91/items',
      run: { id: started.id, step: 2, request: 'checkout/020-add-item' },
      params: { cartId: 'c-91' },
    });
    expect(h.events.at(-1)).toEqual({ id: started.id, state: 'finished', outcome: 'passed' });
  });

  it('stops at the first failure and reports later steps as not-run', async () => {
    const h = harness(() => json(201, { other: 1 }));
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      { target: { kind: 'node', id: 'checkout' }, environment: null, mode: 'mock', scenario: 'cart', vars: {} },
      CHECKOUT,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(run.outcome).toBe('failed');
    expect(run.steps.map((step) => step.outcome)).toEqual(['failed', 'not-run', 'not-run']);
    expect(run.steps[0]?.failure).toEqual({
      code: 'extract-missing',
      message: 'No value for cartId ({{$response.body.$.id}})',
    });
  });

  it('sends mock-mode requests to Janus with the scenario and stripped prefix', async () => {
    const h = harness(() => json(201, { id: 'c-1' }));
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      {
        target: { kind: 'node', id: 'checkout/030-get-cart' },
        environment: null,
        mode: 'mock',
        scenario: 'cart',
        vars: { cartId: 'c 1' },
      },
      CHECKOUT,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(run.outcome).toBe('passed');
    expect(h.mocked[0]?.target).toBe('/carts/c%201');
    expect(h.mocked[0]?.request.headers).toContainEqual(['x-mock-scenario', 'cart']);
    expect(run.steps[0]?.scenarioFrom).toBe('run');
    expect(h.plans).toEqual([]);
  });

  it('adds no X-Mock-Scenario to mock sends when the run names no scenario', async () => {
    const h = harness(() => json(200, { id: 'c-1' }));
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      {
        target: { kind: 'node', id: 'checkout/030-get-cart' },
        environment: null,
        mode: 'mock',
        scenario: null,
        vars: { cartId: 'c1' },
      },
      CHECKOUT,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(run.outcome).toBe('passed');
    expect(run.scenario).toBeNull();
    expect(run.steps[0]?.scenarioFrom).toBeUndefined();
    expect(h.mocked[0]?.request.headers.some(([name]) => name.toLowerCase() === 'x-mock-scenario')).toBe(false);
  });

  it('records into scenarios.default when neither the request nor the run names one', async () => {
    const h = harness(() => json(200, { id: 'c-1' }));
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      {
        target: { kind: 'node', id: 'checkout/030-get-cart' },
        environment: null,
        mode: 'record',
        scenario: null,
        vars: { cartId: 'c1' },
      },
      CHECKOUT,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(run.steps[0]?.capture).toBe('default/000001');
  });

  it('fails a record step whose X-Mock-Scenario names no known scenario', async () => {
    const h = harness(() => json(200, {}));
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      {
        target: {
          kind: 'request',
          id: 'checkout/030-get-cart',
          document: {
            name: 'Get cart',
            method: 'GET',
            url: 'https://staging.example.com/v1/carts/c1',
            headers: [{ name: 'X-Mock-Scenario', value: 'nope' }],
          },
        },
        environment: null,
        mode: 'record',
        scenario: 'cart',
        vars: {},
      },
      CHECKOUT,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(run.steps[0]?.failure?.code).toBe('unknown-scenario');
    expect(h.sent).toEqual([]);
  });

  it('names every undefined variable before sending', async () => {
    const h = harness(() => json(200, {}));
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      {
        target: { kind: 'node', id: 'checkout/030-get-cart' },
        environment: null,
        mode: 'record',
        scenario: 'cart',
        vars: {},
      },
      CHECKOUT,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(run.steps[0]?.failure?.code).toBe('unresolved-variable');
    expect(run.steps[0]?.failure?.message).toContain('"cartId"');
    expect(h.sent).toEqual([]);
  });

  it('maps send failures and logs them in the scenario log', async () => {
    const h = harness(() => ({ kind: 'failure', failure: 'timeout' }));
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      {
        target: { kind: 'node', id: 'checkout/010-create-cart' },
        environment: null,
        mode: 'record',
        scenario: 'cart',
        vars: {},
      },
      CHECKOUT,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(run.steps[0]?.failure?.code).toBe('send-timeout');
    expect(h.failures[0]).toMatchObject({
      outcome: 'upstream-timeout',
      source: 'runner',
      request: 'checkout/010-create-cart',
    });
  });

  it.each(['record', 'upstream'] as const)('names a %s connect failure by its reason', async (mode) => {
    const h = harness(() => ({ kind: 'failure', failure: 'connect', reason: 'refused' }));
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      { target: { kind: 'node', id: 'checkout/010-create-cart' }, environment: null, mode, scenario: 'cart', vars: {} },
      CHECKOUT,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(run.steps[0]?.failure).toEqual({
      code: 'send-failed',
      message: 'The request could not be sent: the connection was refused',
    });
    if (mode === 'record') expect(h.failures[0]).toMatchObject({ outcome: 'upstream-failed', reason: 'refused' });
  });

  it('runs scripts in order and fails on a failed test after every after script ran', async () => {
    const order: string[] = [];
    const scripts: ScriptHost = {
      run: (input: ScriptInput): Promise<ScriptOutcome> => {
        order.push(`${input.phase}:${input.source}`);
        if (input.source === 'set') input.variables.set('fromScript', 5);
        if (input.source === 'edit') input.request.headers.push({ name: 'X-Edited', value: '{{fromScript}}' });
        const tests =
          input.source === 'test' ? [{ name: 'is ok', passed: false, message: 'expected 1 to equal 2' }] : [];
        return Promise.resolve({ failure: null, tests, console: [] });
      },
    };
    const scripted = tree(
      {
        'api/folder.yaml': 'scripts:\n  before: set\n  after: collection-after\n',
        'api/inner/folder.yaml': 'scripts:\n  before: edit\n  after: folder-after\n',
        'api/inner/010-a.request.yaml':
          'name: A\nmethod: GET\nurl: https://example.com/a\nscripts:\n  before: request-before\n  after: test\n',
      },
      ['api', 'api/inner'],
    );
    const h = harness(() => json(200, {}));
    const runner = createRunner(h.ports, () => SETTINGS, scripts);
    const started = runner.start(
      { target: { kind: 'node', id: 'api' }, environment: null, mode: 'mock', scenario: 'default', vars: {} },
      scripted,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(order).toEqual([
      'before:set',
      'before:edit',
      'before:request-before',
      'after:test',
      'after:folder-after',
      'after:collection-after',
    ]);
    expect(h.mocked[0]?.request.headers).toContainEqual(['X-Edited', '5']);
    expect(run.steps[0]?.failure).toEqual({ code: 'test-failed', message: 'Test failed: is ok' });
    expect(run.steps[0]?.variables).toEqual({ fromScript: 5 });
  });

  it('refuses a run past maxActiveRuns and cancels one in progress', async () => {
    let release: (value: SendResponse) => void = () => undefined;
    const h = harness(() => new Promise<SendResponse>((resolve) => (release = resolve)));
    const runner = createRunner(h.ports, () => ({ ...SETTINGS, maxActiveRuns: 1 }), noScripts);
    const spec = {
      target: { kind: 'node', id: 'checkout' },
      environment: null,
      mode: 'mock',
      scenario: 'cart',
      vars: {},
    } as const;
    const first = runner.start(spec, CHECKOUT);
    if (!first.ok) throw new Error(first.message);
    expect(runner.start(spec, CHECKOUT)).toMatchObject({ ok: false, code: 'runner-busy' });
    await vi.waitFor(() => {
      expect(h.mocked).toHaveLength(1);
    });
    expect(runner.cancel(first.id)).toBe(true);
    release(json(201, { id: 'x' }));
    const run = await first.done;
    expect(run.outcome).toBe('cancelled');
    expect(run.steps.map((step) => step.outcome)).toEqual(['not-run', 'not-run', 'not-run']);
    expect(runner.list()[0]?.id).toBe(first.id);
  });

  it('uses a shared environment, local values first, and refuses an unknown one', async () => {
    const withEnv = tree(
      {
        'environments/staging.yaml': 'name: Staging\nvars:\n  host: https://a.example.com\n  token: shared\n',
        'environments/staging.local.yaml': 'vars:\n  token: mine\n',
        'api/010-a.request.yaml':
          'name: A\nmethod: GET\nurl: "{{host}}/a"\nheaders:\n  - name: Authorization\n    value: Bearer {{token}}\n',
      },
      ['api', 'environments'],
    );
    const h = harness(() => json(200, {}));
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      { target: { kind: 'node', id: 'api' }, environment: 'staging', mode: 'record', scenario: 's', vars: {} },
      withEnv,
    );
    if (!started.ok) throw new Error(started.message);
    await started.done;
    expect(h.sent[0]?.url).toBe('https://a.example.com/a');
    expect(h.sent[0]?.headers).toContainEqual(['Authorization', 'Bearer mine']);
    expect(
      runner.start(
        { target: { kind: 'node', id: 'api' }, environment: 'prod', mode: 'record', scenario: 's', vars: {} },
        withEnv,
      ),
    ).toMatchObject({
      ok: false,
      code: 'unknown-environment',
    });
  });

  it('leaves out disabled environment variables, falling back to the folder’s', async () => {
    const withEnv = tree(
      {
        'environments/staging.yaml':
          'vars:\n  host: https://env.example.com\n  token: shared\ndisabled: [host, token, nowhere]\n',
        'environments/staging.local.yaml': 'vars:\n  token: mine\n',
        'api/folder.yaml': 'vars:\n  host: https://folder.example.com\n',
        'api/010-a.request.yaml': 'name: A\nmethod: GET\nurl: "{{host}}/a"\n',
        'api/020-b.request.yaml': 'name: B\nmethod: GET\nurl: "{{host}}/{{token}}"\n',
      },
      ['api', 'environments'],
    );
    const h = harness(() => json(200, {}));
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      { target: { kind: 'node', id: 'api' }, environment: 'staging', mode: 'record', scenario: 's', vars: {} },
      withEnv,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(h.sent[0]?.url).toBe('https://folder.example.com/a');
    // A disabled name is disabled in the `.local.yaml` too.
    expect(run.steps[1]?.outcome).toBe('failed');
    expect(run.steps[1]?.failure?.code).toBe('unresolved-variable');
  });

  it('keeps cookies between steps unless the collection turns them off', async () => {
    const files = (cookies: string) => ({
      'api/folder.yaml': cookies,
      'api/010-login.request.yaml': 'name: Login\nmethod: POST\nurl: https://example.com/login\n',
      'api/020-me.request.yaml': 'name: Me\nmethod: GET\nurl: https://example.com/me\n',
    });
    for (const [setting, expected] of [
      ['name: Api\n', true],
      ['cookies: false\n', false],
    ] as const) {
      const h = harness(() => json(200, {}, [['Set-Cookie', 'sid=abc; Path=/']]));
      const runner = createRunner(h.ports, () => SETTINGS, noScripts);
      const started = runner.start(
        { target: { kind: 'node', id: 'api' }, environment: null, mode: 'mock', scenario: 's', vars: {} },
        tree(files(setting), ['api']),
      );
      if (!started.ok) throw new Error(started.message);
      await started.done;
      expect(h.mocked[1]?.request.headers.some(([name, value]) => name === 'Cookie' && value === 'sid=abc')).toBe(
        expected,
      );
    }
  });
});

describe('upstream and explain modes', () => {
  const requests = tree(
    {
      'api/010-a.request.yaml': `name: A
method: GET
url: https://example.com/v1/a
headers:
  - name: X-Mock-Scenario
    value: other
  - name: Accept-Encoding
    value: gzip, br
extract:
  status: '{{$response.status}}'
scripts:
  after: test('ok', () => {})
`,
    },
    ['api'],
  );

  it('sends upstream without a capture, keeping Accept-Encoding and decoding the answer', async () => {
    const h = harness(() => json(201, {}));
    const scripts = vi.fn(() => Promise.resolve({ failure: null, tests: [], console: [] }));
    const runner = createRunner(h.ports, () => SETTINGS, { run: scripts });
    const started = runner.start(
      { target: { kind: 'node', id: 'api' }, environment: null, mode: 'upstream', scenario: 's', vars: {} },
      requests,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(run.outcome).toBe('passed');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.headers.some(([name]) => name.toLowerCase() === 'x-mock-scenario')).toBe(false);
    expect(h.sent[0]?.headers).toContainEqual(['Accept-Encoding', 'gzip, br']);
    expect(h.sent[0]?.headers.filter(([name]) => name.toLowerCase() === 'accept-encoding')).toHaveLength(1);
    expect(h.decoded).toEqual([true]);
    expect(h.mocked).toEqual([]);
    expect(h.plans).toEqual([]);
    expect(run.steps[0]?.capture).toBeUndefined();
    expect(run.vars).toEqual({ status: 201 });
    expect(scripts).toHaveBeenCalledTimes(1);
  });

  it('explains without sending, extracting or testing', async () => {
    const h = harness(() => json(200, {}));
    const scripts = vi.fn(() => Promise.resolve({ failure: null, tests: [], console: [] }));
    const runner = createRunner(h.ports, () => SETTINGS, { run: scripts });
    const started = runner.start(
      {
        target: { kind: 'node', id: 'api' },
        environment: null,
        mode: 'explain',
        scenario: 's',
        vars: {},
        nowMs: 1000,
      },
      requests,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(run.outcome).toBe('passed');
    expect(h.sent).toEqual([]);
    expect(h.mocked).toEqual([]);
    expect(h.explained).toHaveLength(1);
    expect(h.explained[0]).toMatchObject({ target: '/v1/a', nowMs: 1000 });
    expect(h.explained[0]?.request.headers).toContainEqual(['X-Mock-Scenario', 'other']);
    expect(run.steps[0]?.explanation).toBe(EXPLANATION);
    expect(run.steps[0]?.response?.status).toBe(200);
    expect(run.vars).toEqual({});
    expect(scripts).not.toHaveBeenCalled();
  });

  it('reports the decisions a mock-mode answer carries', async () => {
    const h = harness(() => ({ ...json(200, {}), explanation: EXPLANATION }));
    const runner = createRunner(h.ports, () => SETTINGS, noScripts);
    const started = runner.start(
      { target: { kind: 'node', id: 'api' }, environment: null, mode: 'mock', scenario: 's', vars: {} },
      requests,
    );
    if (!started.ok) throw new Error(started.message);
    const run = await started.done;
    expect(run.steps[0]?.explanation).toBe(EXPLANATION);
  });
});
