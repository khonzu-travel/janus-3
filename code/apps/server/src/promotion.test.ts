import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildSnapshot, fileDigest, type EngineConfig, type RecordingEndpoint, type WriteFile } from '@janus/core';
import { readFixtureDirectory } from '@janus/fixtures-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsFixtureWriter } from './fixture-writer.js';
import { main, type CliEnvironment } from './main.js';
import { startServer, type RunningServer, type ServeLogger } from './serve.js';

const writeHooks = vi.hoisted(() => ({
  beforeHeaders: null as (() => Promise<void>) | null,
  beforeMetadata: null as (() => Promise<void>) | null,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>();
  return {
    ...actual,
    link: async (source: string, target: string) => {
      if (target.endsWith('.headers.json')) await writeHooks.beforeHeaders?.();
      return actual.link(source, target);
    },
    rename: async (source: string, target: string) => {
      if (target.endsWith('.meta.json')) await writeHooks.beforeMetadata?.();
      return actual.rename(source, target);
    },
  };
});

// Promotion through the server.

let root: string;
let closers: (() => Promise<void>)[] = [];
const logs: string[] = [];
/** How long a test waits for the watcher to settle and reload. */
const WATCH_WAIT = { timeout: 5000, interval: 50 };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'janus-promotion-'));
  closers = [];
  logs.length = 0;
});

afterEach(async () => {
  writeHooks.beforeHeaders = null;
  writeHooks.beforeMetadata = null;
  for (const close of closers.reverse()) await close();
  await rm(root, { recursive: true, force: true });
});

const logger: ServeLogger = {
  info: (event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
  error: (event, fields) => logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
};

const CARD = '4000000000000002';

/** The fake upstream of the journey: a declined payment and a product. */
async function fakeUpstream(): Promise<{ url: string; payment: { id: string } }> {
  const payment = { id: 'pay_8f2e91c0' };
  const server = createServer((request, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
      if (request.method === 'POST') {
        response.writeHead(402, {
          'content-type': 'application/json',
          location: `/v1/payments/${payment.id}`,
        });
        response.end(JSON.stringify({ id: payment.id, status: 'declined', card: CARD }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'p-8812', name: 'Upstream lamp' }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  closers.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  );
  return { url: `http://127.0.0.1:${String(port)}`, payment };
}

async function writeTree(base: string, tree: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, contents] of Object.entries(tree)) {
    const absolute = join(base, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
}

const TREE = {
  'default/v1/products/{productId}/GET/200.json': '{"id":"p-1","name":"Hand-written lamp"}\n',
  'default/v1/payments/POST/201.json': '{"status":"paid"}\n',
  'payment-declined/flow.yaml':
    'description: Declined\nids:\n  paymentId: pay_declined_1\n  productId: p-declined\noverrides:\n  - /v1/payments/POST\n',
};

const data = (): string => join(root, 'data');
const capturesDir = (): string => join(root, 'captures');

async function janus(
  endpoints: readonly RecordingEndpoint[],
  options: { watch?: boolean; mode?: 'staged' | 'auto'; tree?: Readonly<Record<string, string>> } = {},
): Promise<RunningServer> {
  if (options.tree !== undefined) await writeTree(data(), options.tree);
  await mkdir(capturesDir(), { recursive: true });
  const read = await readFixtureDirectory(data());
  if (!read.ok) throw new Error(JSON.stringify(read.errors));
  const built = buildSnapshot(read.files);
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  const engine: Partial<EngineConfig> = {
    seed: 1,
    recording: { endpoints, timeoutMs: 5000, maxResponseBytes: 1024 * 1024, maxConcurrent: 16 },
    promotionMode: options.mode ?? 'staged',
  };
  const result = await startServer(
    {
      dataRoot: data(),
      host: '127.0.0.1',
      port: 0,
      snapshot: built.snapshot,
      engine,
      captures: capturesDir(),
      shutdownTimeoutMs: 1000,
      ...(options.watch === undefined ? {} : { watch: options.watch }),
    },
    logger,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  closers.push(() => result.server.close());
  return result.server;
}

function endpoints(upstream: string): RecordingEndpoint[] {
  return [
    { method: 'GET', path: '/v1/products/{productId}', upstream },
    { method: 'POST', path: '/v1/payments', upstream },
  ];
}

/** The members these tests read from Atlas documents; each document has only some of them. */
interface Doc {
  readonly outcome: string;
  readonly files: readonly {
    readonly file: string;
    readonly role: string;
    readonly preview: { readonly value: string };
  }[];
  readonly rewrites: readonly unknown[];
  readonly error: {
    readonly code: string;
    readonly conflicts: readonly { readonly file: string; readonly kind: string; readonly reason: string }[];
  };
  readonly items: readonly {
    readonly scenario: string;
    readonly file: string;
    readonly path: string;
    readonly detailHref: string;
  }[];
  readonly fixtures: readonly { readonly digest: string }[];
  readonly promotedTo: readonly unknown[];
  readonly pending: number;
  readonly capabilities: {
    readonly promotion: { readonly available: boolean; readonly mode: string; readonly pending: number };
  };
}

async function post(server: RunningServer, path: string, body: unknown): Promise<{ status: number; body: Doc }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Doc };
}

async function get(server: RunningServer, path: string): Promise<Doc> {
  return (await (await fetch(`${server.url}${path}`)).json()) as Doc;
}

async function recordPayment(server: RunningServer): Promise<Response> {
  return fetch(`${server.url}/v1/payments`, {
    method: 'POST',
    headers: { 'x-mock-record': 'true', 'x-mock-scenario': 'payment-declined', 'content-type': 'application/json' },
    body: JSON.stringify({ card: CARD }),
  });
}

function environment(): { env: CliEnvironment; out: () => string } {
  const out: string[] = [];
  return {
    env: {
      cwd: root,
      stdout: (text) => out.push(text),
      stderr: (text) => out.push(text),
      onSignal: () => () => undefined,
      uiRoot: null,
    },
    out: () => out.join(''),
  };
}

describe('the acceptance journey', () => {
  it('records, promotes with rewritten IDs, protects hand-written files, skips edits in auto mode, and requires review', async () => {
    const upstream = await fakeUpstream();
    let server = await janus(endpoints(upstream.url), { tree: TREE });

    // 2. Record a product and a declined payment.
    const product = await fetch(`${server.url}/v1/products/p-8812`, {
      headers: { 'x-mock-record': 'true', 'x-mock-scenario': 'payment-declined' },
    });
    expect(product.headers.get('x-mock-recorded')).toBe('payment-declined/000001');
    const payment = await recordPayment(server);
    expect(payment.status).toBe(402);
    expect(payment.headers.get('x-mock-recorded')).toBe('payment-declined/000002');
    expect(payment.headers.get('x-mock-promoted')).toBeNull();

    // 3. A dry run shows the exact rewrites in the body and Location; then promote.
    const request = { capture: 'payment-declined/000002', ids: { paymentId: upstream.payment.id } };
    const planned = await post(server, '/_janus/promotions', { ...request, dryRun: true });
    expect(planned.status).toBe(200);
    expect(planned.body).toMatchObject({ outcome: 'planned', applicable: true, conflicts: [] });
    const response = planned.body.files.find((file) => file.role === 'response');
    expect(response?.file).toBe('/v1/payments/POST/402.json');
    expect(response?.preview.value).toContain('{{$scenario.ids.paymentId}}');
    expect(response?.preview.value).toContain(CARD);
    expect(planned.body.rewrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'paymentId', tier: 'exact', pointer: '/id' }),
        expect.objectContaining({ id: 'paymentId', tier: 'exact', header: 'location' }),
      ]),
    );
    expect(await readdir(join(data(), 'payment-declined'))).toEqual(['flow.yaml']);

    const promoted = await post(server, '/_janus/promotions', request);
    expect(promoted.status).toBe(201);
    expect(promoted.body).toMatchObject({
      outcome: 'promoted',
      reload: { outcome: 'swapped', triggers: ['promotion'] },
    });
    expect(logs.some((line) => line.startsWith('promotion ') && line.includes('"outcome":"promoted"'))).toBe(true);

    // 4. The promoted 402 serves the scenario's ID; default still answers 201.
    const declined = await fetch(`${server.url}/v1/payments`, {
      method: 'POST',
      headers: { 'x-mock-scenario': 'payment-declined', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(declined.status).toBe(402);
    expect(declined.headers.get('location')).toBe('/v1/payments/pay_declined_1');
    expect(await declined.json()).toEqual({ id: 'pay_declined_1', status: 'declined', card: CARD });
    const paid = await fetch(`${server.url}/v1/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(paid.status).toBe(201);

    // The capture links to the files promoted from it.
    const capture = await get(server, '/_janus/captures/payment-declined/000002');
    expect(capture.promotedTo).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scenario: 'payment-declined', file: '/v1/payments/POST/402.json' }),
      ]),
    );

    // 5. Promoting the product into default meets the hand-written file.
    const conflict = await post(server, '/_janus/promotions', {
      capture: 'payment-declined/000001',
      scenario: 'default',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('promotion-conflict');
    expect(conflict.body.error.conflicts).toEqual([
      expect.objectContaining({
        file: '/v1/products/{productId}/GET/200.json',
        kind: 'hand-written',
        reason: 'hand-written',
      }),
    ]);
    const inventory = await get(server, '/_janus/endpoints?scenario=default');
    const productItem = inventory.items.find((item) => item.path === '/v1/products/{productId}');
    const detail = await get(server, `/_janus/${productItem?.detailHref ?? ''}`);
    const digest = detail.fixtures[0]?.digest;
    const replaced = await post(server, '/_janus/promotions', {
      capture: 'payment-declined/000001',
      scenario: 'default',
      replace: [{ file: '/v1/products/{productId}/GET/200.json', digest }],
    });
    expect(replaced.status).toBe(201);
    expect(
      JSON.parse(await readFile(join(data(), 'default/v1/products/{productId}/GET/200.json'), 'utf8')),
    ).toMatchObject({ name: 'Upstream lamp' });

    // 6. Hand-edit the promoted 402 and record again in auto mode: skipped, edit kept.
    const promotedFile = join(data(), 'payment-declined/v1/payments/POST/402.json');
    const edited = '{"id":"{{$scenario.ids.paymentId}}","status":"declined","edited":true}\n';
    await writeFile(promotedFile, edited);
    await server.close();
    server = await janus(endpoints(upstream.url), { mode: 'auto' });
    const again = await recordPayment(server);
    expect(again.status).toBe(402);
    expect(again.headers.get('x-mock-promoted')).toBe('skipped');
    expect(await readFile(promotedFile, 'utf8')).toBe(edited);
    expect(logs.some((line) => line.includes('"outcome":"skipped"') && line.includes('promotion-conflict'))).toBe(true);
    await server.close();

    // 7. The review check fails naming the pending files, then passes once they are reviewed.
    const failing = environment();
    expect(await main(['validate', '--no-config', '--data', 'data', '--require-reviewed'], failing.env)).toBe(1);
    expect(failing.out()).toContain('promotion-unreviewed');
    expect(failing.out()).toContain('/v1/payments/POST/402.json');
    expect(await main(['validate', '--no-config', '--data', 'data'], environment().env)).toBe(0);

    server = await janus(endpoints(upstream.url));
    const pending = await get(server, '/_janus/promotions?review=pending');
    expect(pending.pending).toBe(pending.items.length);
    expect(pending.items.length).toBeGreaterThanOrEqual(2);
    const byScenario = new Map<string, { file: string }[]>();
    for (const item of pending.items) {
      byScenario.set(item.scenario, [...(byScenario.get(item.scenario) ?? []), item]);
    }
    for (const [scenario, items] of byScenario) {
      const files = await Promise.all(
        items.map(async (item) => ({
          file: item.file,
          digest: fileDigest(await readFile(join(data(), scenario, ...item.file.slice(1).split('/')))),
        })),
      );
      const reviewed = await post(server, '/_janus/promotions/review', { scenario, files });
      expect(reviewed.status).toBe(200);
    }
    expect((await get(server, '/_janus/promotions?review=pending')).items).toEqual([]);
    const passing = environment();
    expect(await main(['validate', '--no-config', '--data', 'data', '--require-reviewed'], passing.env)).toBe(0);
  });
});

describe('promotion through the server', () => {
  it('serialises concurrent promotions of one target: one create and one 409 exists', async () => {
    const upstream = await fakeUpstream();
    const server = await janus(endpoints(upstream.url), { tree: TREE });
    await recordPayment(server);
    const results = await Promise.all([
      post(server, '/_janus/promotions', { capture: 'payment-declined/000001' }),
      post(server, '/_janus/promotions', { capture: 'payment-declined/000001' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)?.body.error.conflicts[0]).toMatchObject({
      kind: 'promoted',
      reason: 'exists',
    });
  });

  it('auto-promotes a capture, refreshes its own promoted file, and marks it pending', async () => {
    const upstream = await fakeUpstream();
    const server = await janus(endpoints(upstream.url), { tree: TREE, mode: 'auto' });
    const first = await recordPayment(server);
    expect(first.headers.get('x-mock-promoted')).toBe('promoted');
    upstream.payment.id = 'pay_second';
    const second = await recordPayment(server);
    expect(second.headers.get('x-mock-promoted')).toBe('promoted');
    const meta = JSON.parse(
      await readFile(join(data(), 'payment-declined/v1/payments/POST/402.meta.json'), 'utf8'),
    ) as { files: Record<string, { capture: string; review: string }> };
    expect(meta.files['402.json']).toMatchObject({ capture: 'payment-declined/000002', review: 'pending' });
    const health = await get(server, '/_janus/health');
    expect(health.capabilities.promotion).toMatchObject({ available: true, mode: 'auto' });
    expect(health.capabilities.promotion.pending).toBeGreaterThan(0);
  });

  it('refuses unknown captures, unknown scenarios and bad bodies', async () => {
    const upstream = await fakeUpstream();
    const server = await janus(endpoints(upstream.url), { tree: TREE });
    expect((await post(server, '/_janus/promotions', { capture: 'payment-declined/000009' })).status).toBe(404);
    expect((await post(server, '/_janus/promotions', { capture: 'nope' })).status).toBe(404);
    expect((await post(server, '/_janus/promotions', { capture: 'payment-declined/000001', extra: 1 })).status).toBe(
      400,
    );
    await recordPayment(server);
    const unknown = await post(server, '/_janus/promotions', { capture: 'payment-declined/000001', scenario: 'ghost' });
    expect(unknown).toMatchObject({ status: 400, body: { error: { code: 'unknown-scenario' } } });
    const unknownId = await post(server, '/_janus/promotions', {
      capture: 'payment-declined/000001',
      ids: { orderId: 'x-1234' },
    });
    expect(unknownId).toMatchObject({ status: 422, body: { error: { code: 'promotion-unknown-id' } } });
    const text = await fetch(`${server.url}/_janus/promotions`, { method: 'POST', body: 'x' });
    expect(text.status).toBe(415);
  });

  it('is unavailable without recording', async () => {
    await writeTree(data(), TREE);
    const read = await readFixtureDirectory(data());
    if (!read.ok) throw new Error('unreadable');
    const built = buildSnapshot(read.files);
    if (!built.ok) throw new Error('invalid');
    const result = await startServer(
      { dataRoot: data(), host: '127.0.0.1', port: 0, snapshot: built.snapshot, engine: { seed: 1 } },
      logger,
    );
    if (!result.ok) throw new Error('not started');
    closers.push(() => result.server.close());
    const answer = await post(result.server, '/_janus/promotions', { capture: 'default/000001' });
    expect(answer).toMatchObject({ status: 501, body: { error: { code: 'promotion-unavailable' } } });
    expect((await get(result.server, '/_janus/health')).capabilities.promotion).toEqual({
      available: false,
      mode: 'staged',
      pending: 0,
    });
  });
});

describe('creating a scenario', () => {
  it('writes flow.yaml, reloads in the write lock and answers once the scenario is served', async () => {
    const upstream = await fakeUpstream();
    const server = await janus(endpoints(upstream.url), { tree: TREE });
    const created = await post(server, '/_janus/scenarios', { name: 'sold-out' });
    expect(created).toMatchObject({
      status: 201,
      body: { apiVersion: 'atlas.v1', name: 'sold-out', extends: 'default', reload: { outcome: 'swapped' } },
    });
    expect(await readFile(join(data(), 'sold-out', 'flow.yaml'), 'utf8')).toBe('extends: default\n');
    expect(logs.find((line) => line.startsWith('reload-started '))).toBe('reload-started {"triggers":"promotion"}');
    const scenarios = (await get(server, '/_janus/scenarios')) as unknown as { items: { name: string }[] };
    expect(scenarios.items.map((item) => item.name)).toContain('sold-out');
    const child = await post(server, '/_janus/scenarios', { name: 'sold-out-en', extends: 'sold-out' });
    expect(child).toMatchObject({ status: 201, body: { extends: 'sold-out' } });
    const served = await fetch(`${server.url}/v1/payments`, {
      method: 'POST',
      headers: { 'x-mock-scenario': 'sold-out-en', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(served.status).toBe(201);
  });

  it('refuses bad requests, existing scenarios, unknown parents and foreign origins', async () => {
    const upstream = await fakeUpstream();
    const server = await janus(endpoints(upstream.url), { tree: TREE });
    const code = async (body: unknown) => {
      const answer = await post(server, '/_janus/scenarios', body);
      return [answer.status, answer.body.error.code];
    };
    expect(await code({ extends: 'default' })).toEqual([400, 'atlas-invalid-request']);
    expect(await code({ name: 'a', unknown: 1 })).toEqual([400, 'atlas-invalid-request']);
    expect(await code({ name: 'Not/Valid' })).toEqual([422, 'scenario-invalid-name']);
    expect(await code({ name: 'payment-declined' })).toEqual([409, 'scenario-exists']);
    expect(await code({ name: 'fresh', extends: 'ghost' })).toEqual([422, 'unknown-scenario']);
    // A directory that is not (yet) a scenario is not taken over.
    await mkdir(join(data(), 'stray'), { recursive: true });
    await writeFile(join(data(), 'stray', 'notes.txt'), 'x');
    expect(await code({ name: 'stray' })).toEqual([409, 'scenario-exists']);
    const invalidJson = await fetch(`${server.url}/_janus/scenarios`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(invalidJson.status).toBe(400);
    const text = await fetch(`${server.url}/_janus/scenarios`, { method: 'POST', body: 'x' });
    expect(text.status).toBe(415);
    const foreign = await fetch(`${server.url}/_janus/scenarios`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'evil' }),
    });
    expect(foreign.status).toBe(403);
    expect((await fetch(`${server.url}/_janus/scenarios`, { method: 'PUT' })).status).toBe(405);
    expect(await readdir(data())).toEqual(['default', 'payment-declined', 'stray']);
  });

  it('is unavailable without recording, as promotion is', async () => {
    await writeTree(data(), TREE);
    const read = await readFixtureDirectory(data());
    if (!read.ok) throw new Error('unreadable');
    const built = buildSnapshot(read.files);
    if (!built.ok) throw new Error('invalid');
    const result = await startServer(
      { dataRoot: data(), host: '127.0.0.1', port: 0, snapshot: built.snapshot, engine: { seed: 1 } },
      logger,
    );
    if (!result.ok) throw new Error('not started');
    closers.push(() => result.server.close());
    const answer = await post(result.server, '/_janus/scenarios', { name: 'sold-out' });
    expect(answer).toMatchObject({ status: 501, body: { error: { code: 'promotion-unavailable' } } });
  });
});

describe('the fixture writer', () => {
  const file = (path: string, text: string, precondition: WriteFile['precondition']): WriteFile => ({
    path: path.split('/'),
    bytes: new TextEncoder().encode(text),
    precondition,
  });

  it('creates directories and files, and leaves no temporary file behind', async () => {
    await mkdir(data());
    const writer = await FsFixtureWriter.open(data());
    const result = await writer.apply(
      {
        files: [
          file('s/v1/a/GET/200.json', '{}', { kind: 'absent' }),
          file('s/v1/a/GET/200.meta.json', 'm', { kind: 'absent' }),
        ],
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ outcome: 'written' });
    expect((await readdir(join(data(), 's/v1/a/GET'))).sort()).toEqual(['200.json', '200.meta.json']);
  });

  it('refuses an existing file under absent and a changed file under digest, writing nothing', async () => {
    await writeTree(data(), { 's/a/GET/200.json': 'old', 's/a/GET/201.json': 'x' });
    const writer = await FsFixtureWriter.open(data());
    const signal = new AbortController().signal;
    expect(await writer.apply({ files: [file('s/a/GET/200.json', 'new', { kind: 'absent' })] }, signal)).toEqual({
      outcome: 'conflict',
      files: ['s/a/GET/200.json'],
    });
    const stale = { kind: 'digest' as const, digest: fileDigest(new TextEncoder().encode('older')) };
    expect(
      await writer.apply(
        { files: [file('s/a/GET/202.json', 'n', { kind: 'absent' }), file('s/a/GET/200.json', 'new', stale)] },
        signal,
      ),
    ).toEqual({ outcome: 'conflict', files: ['s/a/GET/200.json'] });
    expect((await readdir(join(data(), 's/a/GET'))).sort()).toEqual(['200.json', '201.json']);
    expect(await readFile(join(data(), 's/a/GET/200.json'), 'utf8')).toBe('old');
    const current = { kind: 'digest' as const, digest: fileDigest(new TextEncoder().encode('old')) };
    expect(await writer.apply({ files: [file('s/a/GET/200.json', 'new', current)] }, signal)).toEqual({
      outcome: 'written',
    });
    expect(await readFile(join(data(), 's/a/GET/200.json'), 'utf8')).toBe('new');
    expect((await readdir(join(data(), 's/a/GET'))).sort()).toEqual(['200.json', '201.json']);
  });

  it('refuses a symbolic link on the way to a target', async () => {
    await mkdir(join(root, 'outside'), { recursive: true });
    await mkdir(join(data(), 's'), { recursive: true });
    await symlink(join(root, 'outside'), join(data(), 's', 'v1'));
    const writer = await FsFixtureWriter.open(data());
    const result = await writer.apply(
      { files: [file('s/v1/a/GET/200.json', '{}', { kind: 'absent' })] },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ outcome: 'failed', restored: true });
    expect(await readdir(join(root, 'outside'))).toEqual([]);
  });

  it('refuses path components that are not plain names', async () => {
    await mkdir(data());
    const writer = await FsFixtureWriter.open(data());
    for (const path of [
      ['s', '..', 'x.json'],
      ['s', '', 'x.json'],
      ['s', 'a/b', 'x.json'],
    ]) {
      const result = await writer.apply(
        { files: [{ path, bytes: new Uint8Array(), precondition: { kind: 'absent' } }] },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ outcome: 'failed' });
    }
    expect(await readdir(data())).toEqual([]);
  });
});

describe('promotion and reload coordination', () => {
  it('swaps a watched promotion in its own reload; the watcher only finds it unchanged', async () => {
    const upstream = await fakeUpstream();
    const server = await janus(endpoints(upstream.url), { tree: TREE, watch: true });
    await recordPayment(server);
    expect((await post(server, '/_janus/promotions', { capture: 'payment-declined/000001' })).status).toBe(201);
    expect(logs.find((line) => line.startsWith('reload-started '))).toBe('reload-started {"triggers":"promotion"}');
    await vi.waitFor(() => {
      expect(logs).toContain('reload-started {"triggers":"watch"}');
    }, WATCH_WAIT);
    await vi.waitFor(() => {
      expect(logs.filter((line) => /^reload-(swapped|unchanged|failed) /.test(line))).toHaveLength(
        logs.filter((line) => line.startsWith('reload-started ')).length,
      );
    }, WATCH_WAIT);
    expect(logs.filter((line) => line.startsWith('reload-swapped '))).toHaveLength(1);
  });

  it('holds watch and manual reloads until every promotion file is committed', async () => {
    const upstream = await fakeUpstream();
    const server = await janus(endpoints(upstream.url), { tree: TREE, watch: true });
    await recordPayment(server);
    let markEntered = (): void => undefined;
    let releaseCommit = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    writeHooks.beforeHeaders = async () => {
      markEntered();
      await release;
    };
    const promotion = post(server, '/_janus/promotions', { capture: 'payment-declined/000001' });
    await entered;
    const request = fetch(`${server.url}/_janus/reload`, { method: 'POST' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(logs.filter((line) => line.startsWith('reload-started '))).toEqual([]);
    } finally {
      releaseCommit();
    }
    expect((await promotion).status).toBe(201);
    expect((await request).status).toBe(200);
    // The watcher may add its own reloads afterwards; the first two are the promotion's and the request's.
    expect(logs.filter((line) => line.startsWith('reload-started ')).slice(0, 2)).toEqual([
      'reload-started {"triggers":"promotion"}',
      'reload-started {"triggers":"request"}',
    ]);
    expect((await get(server, '/_janus/promotions?review=pending')).items).toHaveLength(2);
  });
});

it('rolls back a review when the response changes during the metadata rename', async () => {
  const responsePath = 'default/a/GET/200.json';
  const metaPath = 'default/a/GET/200.meta.json';
  await writeTree(data(), { [responsePath]: 'old', [metaPath]: 'pending' });
  const writer = await FsFixtureWriter.open(data());
  writeHooks.beforeMetadata = async () => {
    writeHooks.beforeMetadata = null;
    await writeFile(join(data(), responsePath), 'unseen edit');
  };
  const result = await writer.apply(
    {
      files: [
        {
          path: metaPath.split('/'),
          bytes: new TextEncoder().encode('reviewed'),
          precondition: {
            kind: 'digest',
            digest: fileDigest(new TextEncoder().encode('pending')),
          },
        },
      ],
      checks: [{ path: responsePath.split('/'), digest: fileDigest(new TextEncoder().encode('old')) }],
    },
    new AbortController().signal,
  );
  expect(result).toEqual({ outcome: 'conflict', files: [responsePath] });
  expect(await readFile(join(data(), metaPath), 'utf8')).toBe('pending');
  expect(await readFile(join(data(), responsePath), 'utf8')).toBe('unseen edit');
});

it('serves an edit made while a watched review is rolled back', async () => {
  const upstream = await fakeUpstream();
  const server = await janus(endpoints(upstream.url), { tree: TREE, watch: true });
  await recordPayment(server);
  await post(server, '/_janus/promotions', { capture: 'payment-declined/000001' });
  const response = join(data(), 'payment-declined/v1/payments/POST/402.json');
  const digest = fileDigest(await readFile(response));
  writeHooks.beforeMetadata = async () => {
    writeHooks.beforeMetadata = null;
    await writeFile(response, '{"edited":true}');
  };
  const reviewed = await post(server, '/_janus/promotions/review', {
    scenario: 'payment-declined',
    files: [{ file: '/v1/payments/POST/402.json', digest }],
  });
  expect(reviewed.status).toBe(409);
  // The watcher, which keeps running through the write, picks the edit up.
  await vi.waitFor(async () => {
    const served = await fetch(`${server.url}/v1/payments`, {
      method: 'POST',
      headers: { 'x-mock-scenario': 'payment-declined' },
    });
    expect(await served.json()).toEqual({ edited: true });
  }, WATCH_WAIT);
  expect((await get(server, '/_janus/promotions?review=pending')).items).toEqual(
    expect.arrayContaining([expect.objectContaining({ file: '/v1/payments/POST/402.json', modified: true })]),
  );
});
