import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildSnapshot, type StartupError } from '@janus/core';
import { readFixtureDirectory, type WatchBackendFactory } from '@janus/fixtures-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startServer, type RunningServer, type ServeConfig, type ServeLogger } from './serve.js';

// A watched server end to end: edits reach the running server,
// invalid edits never replace the served snapshot, and the event stream says so.

let root: string;
let server: RunningServer | undefined;
const log: { event: string; fields?: Readonly<Record<string, string | number>> }[] = [];
const printed: (readonly StartupError[])[] = [];

const logger: ServeLogger = {
  info: (event, fields) => log.push({ event, ...(fields === undefined ? {} : { fields }) }),
  error: (event, fields) => log.push({ event, ...(fields === undefined ? {} : { fields }) }),
  problems: (errors) => printed.push(errors),
};

const FILE = 'default/v1/products/GET/200_{application-json}.json';

async function write(path: string, text: string): Promise<void> {
  const absolute = join(root, ...path.split('/'));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text);
}

async function start(watch: boolean, extra: Partial<ServeConfig> = {}): Promise<RunningServer> {
  const read = await readFixtureDirectory(root);
  if (!read.ok) throw new Error('unreadable');
  const built = buildSnapshot(read.files);
  if (!built.ok) throw new Error('invalid');
  const result = await startServer(
    {
      dataRoot: root,
      host: '127.0.0.1',
      port: 0,
      snapshot: built.snapshot,
      watch,
      engine: {
        strictTrailingSlash: true,
        onUnknownMethod: 405,
        mediaTypePreference: [],
        onUnusableAccept: 400,
        onUnacceptable: 406,
        diagnosticHeaders: true,
        now: null,
        clockMode: 'frozen',
        timezone: 'UTC',
        seed: 1,
        strictRefs: false,
        defaultScenario: 'default',
        keyFrom: [],
        idleTimeout: 1800,
        maxSessions: 1000,
        onNoFixture: 404,
        idempotency: { enabled: true, header: 'idempotency-key', methods: ['POST', 'PATCH'], maxEntries: 1000 },
      },
      watchOptions: { quietMs: 50, maxWaitMs: 500 },
      shutdownTimeoutMs: 1000,
      ...extra,
    },
    logger,
  );
  if (!result.ok) throw new Error('did not start');
  server = result.server;
  return result.server;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'janus-serve-watch-'));
  await write(FILE, '{"v":1}');
  log.length = 0;
  printed.length = 0;
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

const body = async (url: string) => (await fetch(url)).text();
const json = async (url: string) => (await (await fetch(url)).json()) as Record<string, unknown>;

/** Reads an event stream into `text` until closed. */
async function events(url: string) {
  const state = { text: '' };
  const request = await new Promise<ClientRequest>((resolve, reject) => {
    const req = get(`${url}/_janus/events`, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        state.text += chunk;
      });
      response.on('error', () => undefined);
      resolve(req);
    });
    req.on('error', reject);
  });
  return {
    state,
    close: () => {
      request.destroy();
    },
  };
}

describe('janus serve --watch', () => {
  it('serves a saved edit without a restart, and keeps serving through an invalid one', async () => {
    const { url } = await start(true);
    const health = await json(`${url}/_janus/health`);
    expect(health['capabilities']).toEqual({
      resolve: true,
      reload: true,
      watch: true,
      events: true,
      ui: false,
      cors: { origins: 0, fixtures: 0 },
      scenarios: true,
      sessions: true,
      variants: true,
      sequences: true,
      pages: true,
      expectations: true,
      idempotency: true,
      recording: { available: false, endpoints: 0 },
      promotion: { available: false, mode: 'staged', pending: 0 },
      faults: { enabled: true, timeoutMs: 120000, maxHeldConnections: 128 },
      compression: { enabled: true, encodings: ['br', 'gzip', 'deflate'] },
      codecs: { xml: true },
      autoOptions: true,
      runner: { available: false, collections: 0 },
    });
    const stream = await events(url);
    await vi.waitFor(() => {
      expect(stream.state.text).toContain('event: state');
    });

    await write(FILE, '{"v":2}');
    await vi.waitFor(
      async () => {
        expect(await body(`${url}/v1/products`)).toBe('{"v":2}');
      },
      { timeout: 5000 },
    );
    await vi.waitFor(() => {
      expect(stream.state.text).toContain('event: snapshot');
    });

    await write(FILE, '{"v":');
    await vi.waitFor(
      () => {
        expect(stream.state.text).toContain('event: reload-failed');
      },
      { timeout: 5000 },
    );
    expect(await body(`${url}/v1/products`)).toBe('{"v":2}');
    const reload = await json(`${url}/_janus/reload`);
    expect(reload).toMatchObject({
      outcome: 'failed',
      triggers: ['watch'],
      errors: [
        {
          code: 'invalid-json',
          endpoint: { method: 'GET', path: '/v1/products' },
          file: '200_{application-json}.json',
        },
      ],
    });
    expect(JSON.stringify(reload)).not.toContain(root);
    expect((await json(`${url}/_janus/health`))['lastReload']).toMatchObject({ outcome: 'failed', errorCount: 1 });
    expect(printed.at(-1)?.map((error) => error.code)).toEqual(['invalid-json']);
    expect(log.map((entry) => entry.event)).toEqual(expect.arrayContaining(['reload-swapped', 'reload-failed']));
    stream.close();
  });

  it('reports a vanished root as a failed reload and stops watching until restart', async () => {
    const { url } = await start(true);
    await rm(root, { recursive: true, force: true });
    await vi.waitFor(
      async () => {
        expect((await json(`${url}/_janus/health`))['capabilities']).toMatchObject({ watch: false });
      },
      { timeout: 5000 },
    );
    await vi.waitFor(async () => {
      expect(await json(`${url}/_janus/reload`)).toMatchObject({
        outcome: 'failed',
        errors: [{ code: 'data-root-missing' }],
      });
    });
    expect(log).toContainEqual({
      event: 'watch-error',
      fields: { code: 'fixture-root-missing', message: expect.any(String) as string },
    });
    // Still serving the last good snapshot, and still ready.
    expect(await body(`${url}/v1/products`)).toBe('{"v":1}');
    expect((await json(`${url}/_janus/health`))['status']).toBe('ready');
  });

  it('closes the watcher when the HTTP adapter cannot be built', async () => {
    let open = false;
    const backend: WatchBackendFactory = (_root, handlers) => {
      open = true;
      handlers.onReady();
      return {
        close: () => {
          open = false;
          return Promise.resolve();
        },
      };
    };
    // Node refuses a fractional header limit when the adapter creates its server.
    await expect(
      start(true, { limits: { maxHeaderBytes: 1024.5 }, watchOptions: { quietMs: 50, maxWaitMs: 500, backend } }),
    ).rejects.toThrow();
    // The backend starts after an asynchronous check of the root; give it the chance.
    await new Promise((done) => setTimeout(done, 100));
    expect(open).toBe(false);
  });

  it('reloads on demand with watching off', async () => {
    const { url } = await start(false);
    expect((await json(`${url}/_janus/health`))['capabilities']).toEqual({
      resolve: true,
      reload: true,
      watch: false,
      events: true,
      ui: false,
      cors: { origins: 0, fixtures: 0 },
      scenarios: true,
      sessions: true,
      variants: true,
      sequences: true,
      pages: true,
      expectations: true,
      idempotency: true,
      recording: { available: false, endpoints: 0 },
      promotion: { available: false, mode: 'staged', pending: 0 },
      faults: { enabled: true, timeoutMs: 120000, maxHeldConnections: 128 },
      compression: { enabled: true, encodings: ['br', 'gzip', 'deflate'] },
      codecs: { xml: true },
      autoOptions: true,
      runner: { available: false, collections: 0 },
    });
    await write(FILE, '{"v":9}');
    await new Promise((done) => setTimeout(done, 200));
    expect(await body(`${url}/v1/products`)).toBe('{"v":1}');
    const response = await fetch(`${url}/_janus/reload`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'swapped', triggers: ['request'] });
    expect(await body(`${url}/v1/products`)).toBe('{"v":9}');

    await write(FILE, '{"v":');
    const failed = await fetch(`${url}/_janus/reload`, { method: 'POST' });
    expect(failed.status).toBe(422);
    expect(await body(`${url}/v1/products`)).toBe('{"v":9}');
  });

  it('shuts down promptly with an event stream open', async () => {
    const { url } = await start(true);
    const stream = await events(url);
    await vi.waitFor(() => {
      expect(stream.state.text).toContain('event: state');
    });
    const started = Date.now();
    await server?.close();
    server = undefined;
    expect(Date.now() - started).toBeLessThan(900);
    stream.close();
  });
});
