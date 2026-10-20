import type * as NodeCrypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestTokenGrammar } from '@janus/core';

import { launch } from './launch.js';
import { main, type CliEnvironment } from './main.js';
import { buildFromFiles, changedIds } from './requests.js';
import type { RunningServer } from './serve.js';

// Capture IDs are random; these tests number them 00000001, 00000002, … in claim order instead.
const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof NodeCrypto>();
  return {
    ...actual,
    randomBytes: (size: number) =>
      size === 4 ? Buffer.from((++ids.next).toString(16).padStart(8, '0'), 'hex') : actual.randomBytes(size),
  };
});

let root: string;
let server: RunningServer | null = null;

beforeEach(async () => {
  ids.next = 0;
  root = await mkdtemp(join(tmpdir(), 'janus-runner-'));
});

afterEach(async () => {
  await server?.close();
  server = null;
  await rm(root, { recursive: true, force: true });
});

async function write(tree: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, contents] of Object.entries(tree)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
}

const FIXTURES = {
  'data/default/v1/orders/POST/201.json': '{ "id": "o-1", "customer": "{{$body.$.customer}}" }',
  'data/default/v1/orders/{orderId}/GET/200.json': '{ "id": "{{$path.orderId}}" }',
};

const ORDERS = {
  'requests/orders/folder.yaml': 'name: Orders\nvars:\n  baseUrl: https://staging.example.com\n',
  'requests/orders/010-create.request.yaml':
    '# keep me\nname: Create\nmethod: POST\nurl: "{{baseUrl}}/v1/orders"\nbody:\n  type: json\n  text: \'{"customer":"Ada"}\'\nextract:\n  orderId: "{{$response.body.$.id}}"\n',
  'requests/orders/020-get.request.yaml':
    'name: Get\nmethod: GET\nurl: "{{baseUrl}}/v1/orders/:orderId"\npathParams:\n  orderId: "{{orderId}}"\nscripts:\n  after: |\n    pm.test("same order", () => pm.expect(pm.response.json().id).to.equal("o-1"));\n',
};

const silent = { info: () => undefined, error: () => undefined };

async function start(args: Record<string, unknown> = {}): Promise<string> {
  const result = await launch(
    { noConfig: true, data: 'data', port: 0, noUi: true, ...args },
    { cwd: root, logger: silent },
  );
  if (result.kind !== 'started') throw new Error(JSON.stringify(result));
  server = result.server;
  return result.server.url;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function waitForRun(base: string, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = await json(await fetch(`${base}/_janus/runs/${id}`));
    if (run['state'] === 'finished') return run;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('the run did not finish');
}

describe('runner routes', () => {
  it('lists the tree, runs a collection in mock mode and reports capabilities', async () => {
    await write({ ...FIXTURES, ...ORDERS });
    const base = await start();
    const health = await json(await fetch(`${base}/_janus/health`));
    expect((health['capabilities'] as Record<string, unknown>)['runner']).toEqual({ available: true, collections: 1 });
    const tree = await json(await fetch(`${base}/_janus/requests`));
    expect(tree['collections']).toEqual([
      {
        kind: 'collection',
        id: 'orders',
        name: 'Orders',
        children: [
          { kind: 'request', id: 'orders/010-create', name: 'Create', method: 'POST' },
          { kind: 'request', id: 'orders/020-get', name: 'Get', method: 'GET' },
        ],
      },
    ]);
    expect(tree['environments']).toEqual([]);
    const started = await fetch(`${base}/_janus/runs`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ target: { id: 'orders' }, mode: 'mock' }),
    });
    expect(started.status).toBe(202);
    const run = await waitForRun(base, String((await json(started))['id']));
    expect(run['outcome']).toBe('passed');
    expect(run['vars']).toEqual({ orderId: 'o-1' });
    const steps = run['steps'] as { janusRequestId?: string; tests: unknown[] }[];
    expect(steps[1]?.tests).toEqual([{ name: 'same order', passed: true }]);
    expect(steps[0]?.janusRequestId).toMatch(/.+/);
    const runs = await json(await fetch(`${base}/_janus/runs`));
    expect((runs['runs'] as unknown[]).length).toBe(1);
  });

  it('records to the upstream and writes a runner capture listed by source', async () => {
    const upstream = createServer((request, response) => {
      response.writeHead(201, { 'content-type': 'application/json', 'set-cookie': 'sid=1; Path=/' });
      response.end(JSON.stringify({ id: 'o-7', path: request.url, encoding: request.headers['accept-encoding'] }));
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    try {
      const address = upstream.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      await write({
        ...FIXTURES,
        'requests/shop/folder.yaml': `vars:\n  baseUrl: http://127.0.0.1:${String(port)}/api\nstripPrefix: /api\n`,
        'requests/shop/010-create.request.yaml':
          'name: Create\nmethod: POST\nurl: "{{baseUrl}}/v1/orders"\nbody:\n  type: json\n  text: "{}"\nheaders:\n  - name: X-Mock-Delay\n    value: "1"\n',
      });
      const base = await start();
      const started = await fetch(`${base}/_janus/runs`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ target: { id: 'shop' }, mode: 'record', scenario: 'default' }),
      });
      const run = await waitForRun(base, String((await json(started))['id']));
      expect(run['outcome']).toBe('passed');
      const [step] = run['steps'] as {
        capture: string;
        response: { body: { value: string } };
        request: { headers: { name: string }[] };
      }[];
      expect(step?.capture).toBe('default/00000001');
      expect(JSON.parse(step?.response.body.value ?? '')).toEqual({
        id: 'o-7',
        path: '/api/v1/orders',
        encoding: 'identity',
      });
      expect(step?.request.headers.map((header) => header.name.toLowerCase())).not.toContain('x-mock-delay');
      const meta = JSON.parse(await readFile(join(root, 'captures/default/00000001/201.meta.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(meta).toMatchObject({
        source: 'runner',
        registration: { method: 'POST', path: '/v1/orders', upstream: `http://127.0.0.1:${String(port)}/api` },
      });
      const list = await json(await fetch(`${base}/_janus/captures?source=runner`));
      expect(list['items']).toMatchObject([{ id: 'default/00000001', source: 'runner' }]);
      expect((await json(await fetch(`${base}/_janus/captures?source=recording`)))['items']).toEqual([]);
    } finally {
      await new Promise((done) => upstream.close(done));
    }
  });

  it('reports the decisions behind mock answers, and explains without serving', async () => {
    await write({ ...FIXTURES, ...ORDERS });
    const base = await start();
    const mock = await fetch(`${base}/_janus/runs`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ target: { id: 'orders/010-create' }, mode: 'mock' }),
    });
    const mocked = await waitForRun(base, String((await json(mock))['id']));
    const [served] = mocked['steps'] as { explanation?: Record<string, unknown> }[];
    expect(served?.explanation).toMatchObject({
      response: { status: 201 },
      fixture: { endpointId: expect.any(String) as unknown },
      notes: [],
    });
    expect((served?.explanation?.['trace'] as Record<string, unknown>)['outcome']).toMatchObject({ kind: 'matched' });

    const explain = await fetch(`${base}/_janus/runs`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        target: { id: 'orders/020-get' },
        mode: 'explain',
        vars: { orderId: 'o-5' },
        now: '2026-01-01T00:00:00Z',
      }),
    });
    expect(explain.status).toBe(202);
    const explained = await waitForRun(base, String((await json(explain))['id']));
    expect(explained['outcome']).toBe('passed');
    expect(explained['vars']).toEqual({ orderId: 'o-5' });
    const [step] = explained['steps'] as {
      tests: unknown[];
      response: { status: number; body: { value: string } };
      explanation: { notes: string[] };
    }[];
    expect(step?.tests).toEqual([]);
    expect(step?.response.status).toBe(200);
    expect(JSON.parse(step?.response.body.value ?? '')).toEqual({ id: 'o-5' });
    expect(step?.explanation.notes.length).toBeGreaterThan(0);

    const refused = await fetch(`${base}/_janus/runs`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ target: { id: 'orders' }, mode: 'mock', now: '2026-01-01T00:00:00Z' }),
    });
    expect(refused.status).toBe(400);
  });

  it('refuses explain mode when atlas.resolve is off', async () => {
    await write({ ...FIXTURES, ...ORDERS, 'janus.config.yaml': 'atlas:\n  resolve: false\n' });
    const base = await start({ noConfig: false });
    const refused = await fetch(`${base}/_janus/runs`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ target: { id: 'orders/020-get' }, mode: 'explain' }),
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await json(refused))).toContain('explain mode is off');
  });

  it('sends upstream without writing a capture', async () => {
    const upstream = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ path: request.url, scenario: request.headers['x-mock-scenario'] ?? null }));
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    try {
      const address = upstream.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      await write({
        ...FIXTURES,
        'requests/shop/folder.yaml': `vars:\n  baseUrl: http://127.0.0.1:${String(port)}\n`,
        'requests/shop/010-get.request.yaml':
          'name: Get\nmethod: GET\nurl: "{{baseUrl}}/v1/orders/o-1"\nheaders:\n  - name: X-Mock-Scenario\n    value: other\n',
      });
      const base = await start();
      const started = await fetch(`${base}/_janus/runs`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ target: { id: 'shop' }, mode: 'upstream' }),
      });
      const run = await waitForRun(base, String((await json(started))['id']));
      expect(run['outcome']).toBe('passed');
      const [step] = run['steps'] as {
        capture?: string;
        explanation?: unknown;
        response: { body: { value: string } };
      }[];
      expect(step?.capture).toBeUndefined();
      expect(step?.explanation).toBeUndefined();
      expect(JSON.parse(step?.response.body.value ?? '')).toEqual({ path: '/v1/orders/o-1', scenario: null });
      expect((await json(await fetch(`${base}/_janus/captures`)))['items']).toEqual([]);
    } finally {
      await new Promise((done) => upstream.close(done));
    }
  });

  it.each([
    ['nothing configured', '  keepRuns: 50\n', 'failed'],
    ['the certificate in extraCaCerts', '  extraCaCerts: [self-signed.pem]\n', 'passed'],
    ['skipTlsVerify', '  skipTlsVerify: true\n', 'passed'],
  ])('sends to a self-signed upstream with %s', async (_name, runner, outcome) => {
    // A self-signed certificate for 127.0.0.1, valid until 2126, used only by this test.
    const cert = `-----BEGIN CERTIFICATE-----
MIIBmjCCAUGgAwIBAgIUbVIOupriL24BP5H4f5qC5ujXtM0wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTAxNjA0NDkyMFoYDzIxMjYwOTIy
MDQ0OTIwWjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATdNM0Ah9WnUjyn4jhErPpvSwp6Y6hLwccITrRzM06ikaMmZwvahDWQ
Xx1TkK+7t2LyYmD6cPkZXesv8mvDV6E/o28wbTAdBgNVHQ4EFgQUBKAE3JEqtLza
7C87cUS43gbxCS4wHwYDVR0jBBgwFoAUBKAE3JEqtLza7C87cUS43gbxCS4wDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2NhbGhvc3QwCgYIKoZI
zj0EAwIDRwAwRAIgCKCjER8fxNCvKe5egP4dwwOqMdjcAb3M9nwY6DPBcNMCIDE/
A7i/wJzBmCO1QVjwh2BRk6hc+K0vpsC/PTLG3cFu
-----END CERTIFICATE-----`;
    const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgGiRNqz9+nKH9DPSL
40ZTK1XjA0N7y0G12WvgTaqohlahRANCAATdNM0Ah9WnUjyn4jhErPpvSwp6Y6hL
wccITrRzM06ikaMmZwvahDWQXx1TkK+7t2LyYmD6cPkZXesv8mvDV6E/
-----END PRIVATE KEY-----`;
    const upstream = createHttpsServer({ cert, key }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('secure');
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    try {
      const address = upstream.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      await write({
        ...FIXTURES,
        'self-signed.pem': cert,
        'janus.config.yaml': `fixtures:\n  root: ./data\nui:\n  enabled: false\nrunner:\n${runner}`,
        'requests/shop/folder.yaml': `vars:\n  baseUrl: https://127.0.0.1:${String(port)}\n`,
        'requests/shop/010-get.request.yaml': 'name: Get\nmethod: GET\nurl: "{{baseUrl}}/v1/orders/o-1"\n',
      });
      const result = await launch({ noConfig: false, port: 0 }, { cwd: root, logger: silent });
      if (result.kind !== 'started') throw new Error(JSON.stringify(result));
      server = result.server;
      const started = await fetch(`${server.url}/_janus/runs`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ target: { id: 'shop' }, mode: 'upstream' }),
      });
      const run = await waitForRun(server.url, String((await json(started))['id']));
      expect(run['outcome']).toBe(outcome);
    } finally {
      upstream.closeAllConnections();
      await new Promise((done) => upstream.close(done));
    }
  });

  it('sends the written Accept-Encoding upstream and decodes the compressed answer', async () => {
    const upstream = createServer((request, response) => {
      const body = JSON.stringify({ encoding: request.headers['accept-encoding'] ?? null });
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      response.end(gzipSync(body));
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    try {
      const address = upstream.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      await write({
        ...FIXTURES,
        'requests/shop/folder.yaml': `vars:\n  baseUrl: http://127.0.0.1:${String(port)}\n`,
        'requests/shop/010-get.request.yaml':
          'name: Get\nmethod: GET\nurl: "{{baseUrl}}/v1/orders/o-1"\nheaders:\n  - name: Accept-Encoding\n    value: gzip\nextract:\n  encoding: "{{$response.body.$.encoding}}"\n',
      });
      const base = await start();
      const started = await fetch(`${base}/_janus/runs`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ target: { id: 'shop' }, mode: 'upstream' }),
      });
      const run = await waitForRun(base, String((await json(started))['id']));
      expect(run['outcome']).toBe('passed');
      expect(run['vars']).toEqual({ encoding: 'gzip' });
      const [step] = run['steps'] as { response: { headers: { name: string }[]; body: { value: string } } }[];
      expect(JSON.parse(step?.response.body.value ?? '')).toEqual({ encoding: 'gzip' });
      expect(step?.response.headers.map((header) => header.name.toLowerCase())).not.toContain('content-encoding');
    } finally {
      await new Promise((done) => upstream.close(done));
    }
  });

  it('runs an unsaved request with the given variables and refuses an unknown scenario', async () => {
    await write({ ...FIXTURES, ...ORDERS });
    const base = await start();
    const request = {
      name: 'Get',
      method: 'GET',
      url: '{{baseUrl}}/v1/orders/:orderId',
      pathParams: { orderId: '{{orderId}}' },
    };
    const started = await fetch(`${base}/_janus/runs`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ target: { id: 'orders/030-draft', request }, mode: 'mock', vars: { orderId: 'o-9' } }),
    });
    const run = await waitForRun(base, String((await json(started))['id']));
    expect(run['outcome']).toBe('passed');
    const unknown = await fetch(`${base}/_janus/runs`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ target: { id: 'orders' }, mode: 'mock', scenario: 'nope' }),
    });
    expect(unknown.status).toBe(400);
    expect(await json(unknown)).toMatchObject({ error: { code: 'unknown-scenario' } });
  });

  it('writes requests with preconditions, keeping comments, and refuses stale or unconditional writes', async () => {
    await write({ ...FIXTURES, ...ORDERS });
    const base = await start();
    const url = `${base}/_janus/requests/orders/010-create`;
    const current = await json(await fetch(url));
    const digest = String(current['digest']);
    const document = { ...(current['document'] as Record<string, unknown>), name: 'Create order' };

    expect((await fetch(url, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(document) })).status).toBe(
      428,
    );
    const stale = await fetch(url, {
      method: 'PUT',
      headers: { ...JSON_HEADERS, 'if-match': 'sha256:00' },
      body: JSON.stringify(document),
    });
    expect(stale.status).toBe(412);
    expect(await json(stale)).toMatchObject({ error: { code: 'request-changed', current: { digest } } });

    const saved = await fetch(url, {
      method: 'PUT',
      headers: { ...JSON_HEADERS, 'if-match': digest },
      body: JSON.stringify(document),
    });
    expect(saved.status).toBe(200);
    const text = await readFile(join(root, 'requests/orders/010-create.request.yaml'), 'utf8');
    expect(text.startsWith('# keep me\nname: Create order\n')).toBe(true);
    expect((await json(await fetch(url)))['digest']).toBe((await json(saved))['digest']);

    const invalid = await fetch(`${base}/_janus/requests/orders/030-new`, {
      method: 'PUT',
      headers: { ...JSON_HEADERS, 'if-none-match': '*' },
      body: JSON.stringify({ name: 'New', method: 'GET', url: '{{$path.id}}' }),
    });
    expect(invalid.status).toBe(422);
    expect(await json(invalid)).toMatchObject({
      error: { code: 'request-invalid', problems: [{ code: 'request-invalid-template' }] },
    });

    const created = await fetch(`${base}/_janus/requests/orders/030-new`, {
      method: 'PUT',
      headers: { ...JSON_HEADERS, 'if-none-match': '*' },
      body: JSON.stringify({ name: 'New', method: 'GET', url: 'https://example.com/x' }),
    });
    expect(created.status).toBe(201);
    const again = await fetch(`${base}/_janus/requests/orders/030-new`, {
      method: 'PUT',
      headers: { ...JSON_HEADERS, 'if-none-match': '*' },
      body: JSON.stringify({ name: 'New', method: 'GET', url: 'https://example.com/x' }),
    });
    expect(again.status).toBe(412);
    const removed = await fetch(`${base}/_janus/requests/orders/030-new`, {
      method: 'DELETE',
      headers: { 'if-match': String((await json(created))['digest']) },
    });
    expect(removed.status).toBe(204);
    expect((await fetch(`${base}/_janus/requests/orders/030-new`)).status).toBe(404);
  });

  it('checks IDs and the Origin before any write', async () => {
    await write({ ...FIXTURES, ...ORDERS });
    const base = await start();
    expect([400, 404]).toContain((await fetch(`${base}/_janus/requests/orders/..%2Fsecret`)).status);
    expect((await fetch(`${base}/_janus/requests/Orders/A`)).status).toBe(404);
    const foreign = await fetch(`${base}/_janus/folders/other`, {
      method: 'PUT',
      headers: { ...JSON_HEADERS, 'if-none-match': '*', origin: 'https://evil.example' },
      body: '{}',
    });
    expect(foreign.status).toBe(403);
  });

  it('creates and removes folders', async () => {
    await write({ ...FIXTURES });
    const base = await start();
    const created = await fetch(`${base}/_janus/folders/shop`, {
      method: 'PUT',
      headers: { ...JSON_HEADERS, 'if-none-match': '*' },
      body: JSON.stringify({ name: 'Shop', cookies: false, environment: 'staging' }),
    });
    expect(created.status).toBe(201);
    const folderDigest = String((await json(created))['digest']);
    await write({ 'requests/shop/010-a.request.yaml': 'name: A\nmethod: GET\nurl: https://example.com\n' });
    await json(await fetch(`${base}/_janus/requests`));
    const notEmpty = await fetch(`${base}/_janus/folders/shop`, {
      method: 'DELETE',
      headers: { 'if-match': folderDigest },
    });
    expect(notEmpty.status).toBe(409);
    await rm(join(root, 'requests/shop/010-a.request.yaml'));
    const empty = await fetch(`${base}/_janus/folders/shop`, {
      method: 'DELETE',
      headers: { 'if-match': folderDigest },
    });
    expect(empty.status).toBe(204);
  });

  it('refuses environments as a collection and directly in one', async () => {
    await write({ ...FIXTURES, ...ORDERS });
    const base = await start();
    for (const id of ['environments', 'orders/environments']) {
      const refused = await fetch(`${base}/_janus/folders/${id}`, {
        method: 'PUT',
        headers: { ...JSON_HEADERS, 'if-none-match': '*' },
        body: JSON.stringify({ name: 'Environments' }),
      });
      expect(refused.status).toBe(422);
    }
    const nested = await fetch(`${base}/_janus/folders/orders/sub`, {
      method: 'PUT',
      headers: { ...JSON_HEADERS, 'if-none-match': '*' },
      body: JSON.stringify({ environment: 'staging' }),
    });
    expect(nested.status).toBe(422);
  });

  it('writes shared environments, lists them, and runs with one', async () => {
    await write({ ...FIXTURES, ...ORDERS, 'requests/shop/folder.yaml': 'name: Shop\n' });
    const base = await start();
    const environment = await fetch(`${base}/_janus/environments/staging`, {
      method: 'PUT',
      headers: { ...JSON_HEADERS, 'if-none-match': '*' },
      body: JSON.stringify({
        document: {
          name: 'Staging',
          vars: { baseUrl: 'https://env.example.com', host: 'a' },
          disabled: ['host'],
          default: true,
        },
        local: { vars: { token: 't' } },
      }),
    });
    expect(environment.status).toBe(201);
    const createdDocument = await json(environment);
    expect(Object.keys(createdDocument).sort()).toEqual(['apiVersion', 'digest', 'id']);
    expect(createdDocument['id']).toBe('staging');
    expect(await readFile(join(root, 'requests/environments/staging.local.yaml'), 'utf8')).toBe('vars:\n  token: t\n');
    const read = await json(await fetch(`${base}/_janus/environments/staging`));
    expect(read).toMatchObject({
      id: 'staging',
      digest: createdDocument['digest'],
      document: { name: 'Staging', disabled: ['host'], default: true },
      local: { vars: { token: 't' } },
    });
    expect(read).not.toHaveProperty('collection');
    expect((await fetch(`${base}/_janus/environments/shop/staging`)).status).toBe(404);
    expect((await fetch(`${base}/_janus/environments/Bad`)).status).toBe(404);
    const tree = await json(await fetch(`${base}/_janus/requests`));
    expect(tree['environments']).toEqual([{ id: 'staging', name: 'Staging', default: true }]);
    for (const collection of tree['collections'] as Record<string, unknown>[]) {
      expect(collection).not.toHaveProperty('environments');
    }
    // Every collection sees every environment, with the values a run would use.
    const request = await json(await fetch(`${base}/_janus/requests/orders/010-create`));
    expect(request['environments']).toEqual([
      { id: 'staging', name: 'Staging', vars: { baseUrl: 'https://env.example.com', token: 't' } },
    ]);
    const stale = await fetch(`${base}/_janus/environments/staging`, {
      method: 'PUT',
      headers: { ...JSON_HEADERS, 'if-match': 'sha256:0' },
      body: JSON.stringify({ document: {} }),
    });
    expect(stale.status).toBe(412);
    const started = await fetch(`${base}/_janus/runs`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ target: { id: 'orders' }, mode: 'mock', environment: 'staging' }),
    });
    const run = await waitForRun(base, String((await json(started))['id']));
    expect(run['environment']).toBe('staging');
    expect(run['outcome']).toBe('passed');
    const unknown = await fetch(`${base}/_janus/runs`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ target: { id: 'orders' }, mode: 'mock', environment: 'prod' }),
    });
    expect(unknown.status).toBe(400);
    expect(await json(unknown)).toMatchObject({ error: { code: 'unknown-environment' } });
    const removed = await fetch(`${base}/_janus/environments/staging`, {
      method: 'DELETE',
      headers: { 'if-match': String(read['digest']) },
    });
    expect(removed.status).toBe(204);
    expect((await json(await fetch(`${base}/_janus/requests`)))['environments']).toEqual([]);
  });

  it('reports environment changes as environments/<name>', () => {
    const tree = (files: Record<string, string>) =>
      buildFromFiles(
        {
          files: new Map(Object.entries(files).map(([path, text]) => [path, new TextEncoder().encode(text)])),
          directories: new Set(['environments', 'orders']),
        },
        { grammar: requestTokenGrammar({}) },
      ).tree;
    const before = tree({ 'environments/staging.yaml': 'vars: {}\n', 'orders/folder.yaml': 'name: O\n' });
    const after = tree({
      'environments/staging.yaml': 'vars:\n  a: b\n',
      'environments/dev.yaml': 'vars: {}\n',
      'orders/folder.yaml': 'name: O\n',
    });
    expect(changedIds(before, after)).toEqual(['environments/dev', 'environments/staging']);
  });

  it('previews and writes an import, refusing an existing collection without replace', async () => {
    await write({ ...FIXTURES });
    const base = await start();
    const collection = {
      info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'List products', request: { method: 'GET', url: 'https://api.example.com/v1/products' } }],
    };
    const environment = {
      name: 'Staging',
      _postman_variable_scope: 'environment',
      values: [
        { key: 'host', value: 'https://staging.example.com', enabled: true },
        { key: 'token', value: 's3cret', type: 'secret', enabled: true },
      ],
    };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
    const body = {
      files: [
        { name: 'shop.json', contentBase64: encode(collection) },
        { name: 'staging.postman_environment.json', contentBase64: encode(environment) },
      ],
    };
    const preview = await json(
      await fetch(`${base}/_janus/imports`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...body, preview: true }),
      }),
    );
    expect(preview).toMatchObject({
      preview: true,
      written: false,
      format: 'postman',
      collection: 'shop',
      exists: false,
      existingEnvironments: [],
    });
    expect(preview['files']).toEqual(
      expect.arrayContaining([
        { path: 'environments/staging.yaml', kind: 'environment' },
        { path: 'environments/staging.local.yaml', kind: 'environment' },
        { path: 'shop/010-list-products.request.yaml', kind: 'request' },
      ]),
    );
    const written = await fetch(`${base}/_janus/imports`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    expect(written.status).toBe(201);
    const tree = await json(await fetch(`${base}/_janus/requests`));
    expect(tree['collections']).toMatchObject([{ id: 'shop' }]);
    expect(tree['environments']).toEqual([{ id: 'staging', name: 'Staging' }]);
    expect(await readFile(join(root, 'requests/environments/staging.local.yaml'), 'utf8')).toContain('s3cret');
    const second = await json(
      await fetch(`${base}/_janus/imports`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...body, preview: true }),
      }),
    );
    expect(second).toMatchObject({ exists: true, existingEnvironments: ['staging'] });
    // An existing environment refuses the import as an existing collection does.
    const elsewhere = await fetch(`${base}/_janus/imports`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...body, into: 'other' }),
    });
    expect(elsewhere.status).toBe(409);
    expect(await json(elsewhere)).toMatchObject({ error: { code: 'import-destination-exists' } });
    const again = await fetch(`${base}/_janus/imports`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    expect(again.status).toBe(409);
    const replaced = await fetch(`${base}/_janus/imports`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...body, replace: true }),
    });
    expect(replaced.status).toBe(201);
    // Replacing an environment replaces both of its files.
    const withoutSecret = {
      files: [
        body.files[0],
        { name: 'staging.postman_environment.json', contentBase64: encode({ ...environment, values: [] }) },
      ],
      replace: true,
    };
    const replacedAgain = await fetch(`${base}/_janus/imports`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(withoutSecret),
    });
    expect(replacedAgain.status).toBe(201);
    await expect(readFile(join(root, 'requests/environments/staging.local.yaml'))).rejects.toThrow();
  });

  it('refuses to import into environments', async () => {
    await write({ ...FIXTURES });
    const base = await start();
    const har = { log: { version: '1.2', entries: [] } };
    const refused = await fetch(`${base}/_janus/imports`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        files: [{ name: 'a.har', contentBase64: Buffer.from(JSON.stringify(har)).toString('base64') }],
        into: 'environments',
      }),
    });
    expect(refused.status).toBe(400);
    expect(await json(refused)).toMatchObject({ error: { code: 'import-invalid' } });
  });

  it('is unavailable on a non-loopback listener unless allowed', async () => {
    await write({
      ...FIXTURES,
      ...ORDERS,
      'janus.config.yaml': 'fixtures:\n  root: ./data\nserver:\n  host: 0.0.0.0\n',
    });
    const result = await launch({ noConfig: false, port: 0, noUi: true }, { cwd: root, logger: silent });
    if (result.kind !== 'started') throw new Error(JSON.stringify(result));
    server = result.server;
    const base = result.server.url.replace('0.0.0.0', '127.0.0.1');
    const health = await json(await fetch(`${base}/_janus/health`));
    expect((health['capabilities'] as Record<string, unknown>)['runner']).toEqual({
      available: false,
      reason: 'non-loopback',
      collections: 1,
    });
    expect((await fetch(`${base}/_janus/requests`)).status).toBe(404);
  });

  it('reports request problems at startup', async () => {
    await write({
      ...FIXTURES,
      'requests/orders/010-bad.request.yaml': 'name: Bad\nmethod: GET\nurl: "{{"\nunknown: 1\n',
    });
    const result = await launch({ noConfig: true, data: 'data', port: 0, noUi: true }, { cwd: root, logger: silent });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.errors.map((error) => [error.code, error.source, error.path])).toContainEqual([
        'request-invalid',
        'requests',
        'orders/010-bad.request.yaml',
      ]);
    }
  });

  it('refuses a requests root that overlaps the fixtures', async () => {
    await write({ ...FIXTURES });
    const result = await launch(
      { noConfig: true, data: 'data', requests: 'data/requests', port: 0, noUi: true },
      { cwd: root, logger: silent },
    );
    expect(result.kind === 'invalid' && result.errors.map((error) => error.code)).toContain('requests-overlap');
  });
});

function cli() {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnvironment = {
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    onSignal: () => () => undefined,
  };
  return { env, stdout: () => out.join(''), stderr: () => err.join('') };
}

describe('janus run and janus import', () => {
  it('runs a collection in mock mode, prints each step and exits 0', async () => {
    await write({ ...FIXTURES, ...ORDERS });
    const io = cli();
    await expect(main(['run', 'orders', '--mock', '--no-config', '--data', 'data'], io.env)).resolves.toBe(0);
    expect(io.stdout()).toContain('✓ 010-create');
    expect(io.stdout()).toContain('2 steps passed, 1 test passed');
  });

  it('exits 1 when a step fails, 2 when the requests do not load, and needs a mode', async () => {
    await write({ ...FIXTURES, ...ORDERS });
    const io = cli();
    await expect(main(['run', 'orders/020-get', '--mock', '--no-config', '--data', 'data'], io.env)).resolves.toBe(1);
    expect(io.stdout()).toContain('unresolved-variable');
    await expect(main(['run', 'orders', '--no-config'], cli().env)).resolves.toBe(2);
    await expect(main(['run', 'orders', '--mock', '--upstream', '--no-config'], cli().env)).resolves.toBe(2);
    await write({ 'requests/orders/030-bad.request.yaml': 'nope: 1\n' });
    await expect(main(['run', 'orders', '--mock', '--no-config', '--data', 'data'], cli().env)).resolves.toBe(2);
  });

  it('runs with a shared environment, and refuses an unknown one', async () => {
    await write({
      ...FIXTURES,
      ...ORDERS,
      'requests/orders/folder.yaml': 'name: Orders\n',
      'requests/environments/staging.yaml': 'vars:\n  baseUrl: https://staging.example.com\n',
    });
    const io = cli();
    await expect(
      main(['run', 'orders', '--env', 'staging', '--mock', '--no-config', '--data', 'data'], io.env),
    ).resolves.toBe(0);
    const unknown = cli();
    await expect(
      main(['run', 'orders', '--env', 'prod', '--mock', '--no-config', '--data', 'data'], unknown.env),
    ).resolves.toBe(1);
    expect(unknown.stderr()).toContain('No environment "prod" exists');
  });

  it('writes a JUnit report with a case per step and per test', async () => {
    await write({ ...FIXTURES, ...ORDERS });
    const io = cli();
    await main(['run', 'orders', '--mock', '--no-config', '--data', 'data', '--reporter', 'junit'], io.env);
    expect(io.stdout()).toContain('<testsuite name="orders" tests="3" failures="0" skipped="0"');
  });

  it('imports a collection, previewing first', async () => {
    const collection = {
      info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'List', request: { method: 'GET', url: 'https://api.example.com/v1/products' } }],
    };
    await write({ 'shop.postman_collection.json': JSON.stringify(collection) });
    const preview = cli();
    await expect(
      main(['import', 'shop.postman_collection.json', '--no-config', '--preview'], preview.env),
    ).resolves.toBe(0);
    expect(preview.stdout()).toContain('Would import postman "Shop"');
    await expect(main(['import', 'shop.postman_collection.json', '--no-config'], cli().env)).resolves.toBe(0);
    expect(await readFile(join(root, 'requests/shop/010-list.request.yaml'), 'utf8')).toContain('name: List');
    await expect(main(['import', 'shop.postman_collection.json', '--no-config'], cli().env)).resolves.toBe(1);
  });
});
