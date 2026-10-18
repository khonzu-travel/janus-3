import {
  buildSnapshot,
  createEngine,
  type AtlasSnapshotEvent,
  type FixtureFiles,
  type StartupWarning,
} from '@janus/core';
import type { ReadFixturesResult } from '@janus/fixtures-fs';
import { describe, expect, it, vi } from 'vitest';

import { createReloader, ReloadUnavailableError, type ReloaderOptions } from './reload.js';
import type { ServeLogger } from './serve.js';

// Reload orchestration.

const files = (tree: Readonly<Record<string, string>>): FixtureFiles =>
  new Map(Object.entries(tree).map(([path, text]) => [path, new TextEncoder().encode(text)]));

const GOOD = { 'default/v1/GET/200_{application-json}.json': '{"v":1}' };
const NEXT = { 'default/v1/GET/200_{application-json}.json': '{"v":2}' };
const BROKEN = { 'default/v1/GET/200_{application-json}.json': '{"v":' };
const WARNED = {
  'default/v1/GET/200_{application-json}.json': '{"v":3}',
  'default/v1/GET/200.headers.json': '{"Content-Type":"application/json"}',
};

const CONFIG_WARNING: StartupWarning = {
  code: 'non-loopback-bind',
  source: 'config',
  path: 'janus.config.yaml',
  message: 'Janus binds to a non-loopback address and has no authentication',
};

function setup(overrides: Partial<ReloaderOptions> = {}) {
  const initial = buildSnapshot(files(GOOD));
  if (!initial.ok) throw new Error('invalid');
  const engine = createEngine({
    snapshot: initial.snapshot,
    diagnostics: { configDigest: 'cfg_0000000000000000', configFile: false, settings: [], warnings: [CONFIG_WARNING] },
  });
  let tree: Readonly<Record<string, string>> | null = GOOD;
  /** Pending reads, released by the test. */
  const gates: (() => void)[] = [];
  let gated = false;
  const log: string[] = [];
  const logger: ServeLogger = {
    info: (event) => log.push(event),
    error: (event) => log.push(event),
  };
  const read = vi.fn(async (): Promise<ReadFixturesResult> => {
    if (gated) await new Promise<void>((done) => gates.push(done));
    if (tree === null) {
      return {
        ok: false,
        root: '/r',
        errors: [{ code: 'data-root-missing', source: 'fixtures', path: '', message: 'the data root does not exist' }],
      };
    }
    return { ok: true, root: '/r', files: files(tree) };
  });
  const printed: number[] = [];
  const reloader = createReloader({
    engine,
    read,
    build: (input) => buildSnapshot(input),
    baseWarnings: [CONFIG_WARNING],
    logger,
    printProblems: (errors) => printed.push(errors.length),
    now: () => Date.UTC(2026, 8, 29, 10, 14, 3),
    ...overrides,
  });
  const events: AtlasSnapshotEvent[] = [];
  reloader.subscribe((event) => events.push(event));
  return {
    engine,
    reloader,
    read,
    log,
    events,
    printed,
    initial: initial.snapshot,
    setTree: (next: Readonly<Record<string, string>> | null) => {
      tree = next;
    },
    gate: (on: boolean) => {
      gated = on;
    },
    release: async () => {
      await vi.waitFor(() => {
        if (gates.length === 0) throw new Error('no read waiting');
      });
      gates.shift()?.();
    },
  };
}

describe('createReloader', () => {
  it('swaps a valid, changed tree and publishes the new version', async () => {
    const { reloader, engine, events, log, initial, setTree } = setup();
    setTree(NEXT);
    const result = await reloader.trigger('request');
    expect(result).toMatchObject({
      outcome: 'swapped',
      triggers: ['request'],
      finishedAt: '2026-09-29T10:14:03Z',
      activeSnapshotVersion: engine.snapshot().version,
      candidateSnapshotVersion: engine.snapshot().version,
      errors: [],
      warnings: [],
    });
    expect(engine.snapshot().version).not.toBe(initial.version);
    expect(events).toEqual([
      { type: 'snapshot', snapshotVersion: engine.snapshot().version, previousVersion: initial.version },
    ]);
    expect(log).toEqual(['reload-started', 'reload-swapped']);
    expect(reloader.last()).toBe(result);
  });

  it('records unchanged without replacing the snapshot object, announcing only the new state', async () => {
    const { reloader, engine, events, log } = setup();
    const before = engine.snapshot();
    const result = await reloader.trigger('watch');
    expect(result).toMatchObject({
      outcome: 'unchanged',
      triggers: ['watch'],
      candidateSnapshotVersion: before.version,
    });
    expect(engine.snapshot()).toBe(before);
    expect(events).toEqual([
      {
        type: 'state',
        snapshotVersion: before.version,
        lastReload: { outcome: 'unchanged', errorCount: 0, finishedAt: '2026-09-29T10:14:03Z' },
      },
    ]);
    expect(log).toEqual(['reload-started', 'reload-unchanged']);
  });

  it('keeps serving on an invalid tree, reporting located errors and publishing reload-failed', async () => {
    const { reloader, engine, events, log, printed, initial, setTree } = setup();
    setTree(BROKEN);
    const result = await reloader.trigger('request');
    expect(result.outcome).toBe('failed');
    expect(result.candidateSnapshotVersion).toBeNull();
    expect(result.activeSnapshotVersion).toBe(initial.version);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'invalid-json',
        endpoint: { method: 'GET', path: '/v1' },
        file: '200_{application-json}.json',
      }),
    ]);
    expect(engine.snapshot()).toBe(initial);
    expect(events).toEqual([{ type: 'reload-failed', errorCount: 1, finishedAt: '2026-09-29T10:14:03Z' }]);
    expect(log).toEqual(['reload-started', 'reload-failed']);
    expect(printed).toEqual([1]);
  });

  it('reports a missing root as a failed reload', async () => {
    const { reloader, setTree } = setup();
    setTree(null);
    expect(await reloader.trigger('watch')).toMatchObject({
      outcome: 'failed',
      errors: [{ code: 'data-root-missing', endpoint: { method: null, path: '/' }, file: null }],
    });
  });

  it('replaces fixture warnings with the candidate’s and keeps configuration warnings', async () => {
    const { reloader, engine, setTree } = setup();
    setTree(WARNED);
    const swapped = await reloader.trigger('request');
    expect(swapped.warnings.map((warning) => warning.code)).toEqual(['redundant-content-type']);
    expect(engine.atlas.health().warnings.map((warning) => warning.code)).toEqual([
      'non-loopback-bind',
      'redundant-content-type',
    ]);
    // Unchanged still refreshes them, and a later clean tree clears the fixture warning.
    await reloader.trigger('request');
    expect(engine.atlas.health().warnings).toHaveLength(2);
    setTree(NEXT);
    await reloader.trigger('request');
    expect(engine.atlas.health().warnings.map((warning) => warning.code)).toEqual(['non-loopback-bind']);
    // A failed reload leaves them as they were.
    setTree({ ...WARNED, 'default/v1/GET/oops': '' });
    await reloader.trigger('request');
    expect(engine.atlas.health().warnings.map((warning) => warning.code)).toEqual(['non-loopback-bind']);
  });

  it('runs one reload at a time and coalesces triggers that arrive meanwhile into one follow-up', async () => {
    const { reloader, read, gate, release, setTree } = setup();
    gate(true);
    setTree(NEXT);
    const first = reloader.trigger('watch');
    await vi.waitFor(() => {
      expect(read).toHaveBeenCalledTimes(1);
    });
    const second = reloader.trigger('request');
    const third = reloader.trigger('watch');
    const fourth = reloader.trigger('request');
    await release();
    expect((await first).triggers).toEqual(['watch']);
    await release();
    const [a, b, c] = await Promise.all([second, third, fourth]);
    // Every caller that joined the follow-up gets its result, which names both kinds in a stable order.
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.triggers).toEqual(['watch', 'request']);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('makes a caller that arrives mid-reload wait for the follow-up, which sees its change', async () => {
    const { reloader, read, gate, release, setTree, engine } = setup();
    gate(true);
    const running = reloader.trigger('watch');
    await vi.waitFor(() => {
      expect(read).toHaveBeenCalledTimes(1);
    });
    setTree(NEXT);
    const waiting = reloader.trigger('request');
    await release(); // the first read may have seen the old tree
    await running;
    await release();
    const result = await waiting;
    expect(result.activeSnapshotVersion).toBe(engine.snapshot().version);
    expect(result.triggers).toEqual(['request']);
  });

  it('subscribes and reads the state in one step', async () => {
    const { reloader, setTree, engine } = setup();
    setTree(BROKEN);
    await reloader.trigger('request');
    const seen: AtlasSnapshotEvent[] = [];
    const subscription = reloader.subscribe((event) => seen.push(event));
    expect(subscription.state).toEqual({
      snapshotVersion: engine.snapshot().version,
      lastReload: { outcome: 'failed', errorCount: 1, finishedAt: '2026-09-29T10:14:03Z' },
    });
    setTree(NEXT);
    await reloader.trigger('request');
    subscription.unsubscribe();
    setTree(GOOD);
    await reloader.trigger('request');
    expect(seen.map((event) => event.type)).toEqual(['snapshot']);
  });

  it('refuses triggers after shutdown starts', async () => {
    const { reloader } = setup();
    await reloader.close(100);
    await expect(reloader.trigger('request')).rejects.toBeInstanceOf(ReloadUnavailableError);
  });

  it('lets the current reload finish within the deadline on shutdown', async () => {
    const { reloader, gate, release, setTree, events } = setup();
    gate(true);
    setTree(NEXT);
    const running = reloader.trigger('request');
    const closing = reloader.close(2000);
    await release();
    await closing;
    expect((await running).outcome).toBe('swapped');
    // Subscribers are dropped once shutdown completes.
    expect(events).toHaveLength(1);
  });

  it('rejects waiting callers with 503 when the deadline passes, and swaps or publishes nothing after', async () => {
    const { reloader, gate, release, setTree, events, engine, initial } = setup();
    gate(true);
    setTree(NEXT);
    const running = reloader.trigger('request');
    const queued = reloader.trigger('request');
    const rejections = Promise.allSettled([running, queued]);
    await reloader.close(20);
    const settled = await rejections;
    expect(settled.map((entry) => entry.status)).toEqual(['rejected', 'rejected']);
    for (const entry of settled) {
      if (entry.status === 'rejected') expect((entry.reason as { code?: string }).code).toBe('service-unavailable');
    }
    await release();
    await new Promise((done) => setTimeout(done, 20));
    expect(engine.snapshot()).toBe(initial);
    expect(events).toEqual([]);
  });
});

it('drains a fixture write and its reload before completing shutdown', async () => {
  const { reloader, setTree, events } = setup();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writing = reloader.write(async () => {
    await gate;
    setTree(NEXT);
    return { outcome: 'written' };
  });
  const closing = reloader.close(2000);
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  expect(await writing).toMatchObject({ outcome: 'written', reload: { outcome: 'swapped', triggers: ['promotion'] } });
  await closing;
  expect(events).toHaveLength(1);
  await expect(reloader.write(() => Promise.resolve({ outcome: 'written' }))).rejects.toBeInstanceOf(
    ReloadUnavailableError,
  );
});

it('does not reload a write that restored the tree after failing', async () => {
  const { reloader, read, events } = setup();
  expect(await reloader.write(() => Promise.resolve({ outcome: 'failed', files: [], restored: true }))).toEqual({
    outcome: 'failed',
    files: [],
    restored: true,
  });
  expect(read).not.toHaveBeenCalled();
  expect(events).toEqual([]);
  await reloader.close(100);
});

it('reloads a tree the writer could not restore under the same lock', async () => {
  const { reloader, setTree, engine } = setup();
  const result = await reloader.write(() => {
    setTree(NEXT);
    return Promise.resolve({ outcome: 'failed', files: ['default/v1/GET/200.json'], restored: false });
  });
  expect(result).toMatchObject({
    outcome: 'failed',
    restored: false,
    reload: {
      outcome: 'swapped',
      triggers: ['promotion'],
      activeSnapshotVersion: engine.snapshot().version,
    },
  });
});
