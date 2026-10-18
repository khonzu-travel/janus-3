import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSettler,
  watchFixtureDirectory,
  type FixtureWatchError,
  type FixtureWatcher,
  type WatchBackendFactory,
  type WatchBackendHandlers,
} from './watch.js';

// The fixture watcher.

describe('createSettler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports once after 150 ms without further changes', () => {
    const settled = vi.fn();
    const settler = createSettler(settled, 150, 2000);
    settler.poke();
    vi.advanceTimersByTime(100);
    settler.poke(); // e.g. an editor's rename after its write
    vi.advanceTimersByTime(100);
    settler.poke();
    vi.advanceTimersByTime(149);
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settled).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('reports a continuous burst 2 s after its first change', () => {
    const settled = vi.fn();
    const settler = createSettler(settled, 150, 2000);
    for (let elapsed = 0; elapsed < 1999; elapsed += 100) {
      settler.poke();
      vi.advanceTimersByTime(100);
    }
    expect(settled).toHaveBeenCalledTimes(1);
    // A new burst starts a new window.
    settler.poke();
    vi.advanceTimersByTime(150);
    expect(settled).toHaveBeenCalledTimes(2);
  });

  it('can be cancelled', () => {
    const settled = vi.fn();
    const settler = createSettler(settled, 150, 2000);
    settler.poke();
    settler.cancel();
    vi.advanceTimersByTime(5000);
    expect(settled).not.toHaveBeenCalled();
  });
});

let root: string;
let watcher: FixtureWatcher | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'janus-watch-'));
  await mkdir(join(root, 'default', 'v1', 'GET'), { recursive: true });
  await writeFile(join(root, 'default', 'v1', 'GET', '200_{text-plain}.txt'), 'one');
});

afterEach(async () => {
  await watcher?.close();
  watcher = undefined;
  await rm(root, { recursive: true, force: true });
});

function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  return vi.waitFor(
    () => {
      if (!condition()) throw new Error('not yet');
    },
    { timeout: timeoutMs, interval: 10 },
  );
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe('watchFixtureDirectory (filesystem)', () => {
  const start = async () => {
    const settled: number[] = [];
    const errors: FixtureWatchError[] = [];
    watcher = watchFixtureDirectory(root, {
      onSettled: () => settled.push(Date.now()),
      onError: (error) => errors.push(error),
      quietMs: 100,
      maxWaitMs: 1000,
    });
    await watcher.ready;
    expect(watcher.isWatching()).toBe(true);
    return { settled, errors };
  };

  it('reports one settle for a burst of changes anywhere in the tree', async () => {
    const { settled, errors } = await start();
    await writeFile(join(root, 'default', 'v1', 'GET', '200_{text-plain}.txt'), 'two');
    await mkdir(join(root, 'default', 'v2', 'GET'), { recursive: true });
    await writeFile(join(root, 'default', 'v2', 'GET', '204'), '');
    await until(() => settled.length > 0);
    await pause(300);
    expect(settled).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('treats an editor save-rename-delete sequence as one change', async () => {
    const { settled } = await start();
    const target = join(root, 'default', 'v1', 'GET', '200_{text-plain}.txt');
    const temporary = join(root, 'default', 'v1', 'GET', '200_{text-plain}.txt.tmp');
    await writeFile(temporary, 'saved');
    await rename(target, `${target}.bak`);
    await rename(temporary, target);
    await rm(`${target}.bak`);
    await until(() => settled.length > 0);
    await pause(300);
    expect(settled).toHaveLength(1);
  });

  it('ignores the editor and OS files fixture loading ignores', async () => {
    const { settled } = await start();
    const dir = join(root, 'default', 'v1', 'GET');
    for (const name of ['.DS_Store', 'Thumbs.db', '.200.txt.swp', '200_{text-plain}.txt~', '._200']) {
      await writeFile(join(dir, name), 'x');
    }
    await pause(400);
    expect(settled).toEqual([]);
  });

  it('stops for good when the root disappears, reporting fixture-root-missing once', async () => {
    const { settled, errors } = await start();
    await rm(root, { recursive: true, force: true });
    await until(() => errors.length > 0);
    await pause(300);
    expect(errors).toEqual([{ code: 'fixture-root-missing', message: expect.any(String) as string, retryable: false }]);
    expect(errors[0]?.message).not.toContain(root);
    expect(settled).toEqual([]);
    expect(watcher?.isWatching()).toBe(false);
    // Restoring the root does not resume watching, and nothing above it is watched.
    await mkdir(join(root, 'default'), { recursive: true });
    await writeFile(join(root, 'default', 'x'), '');
    await writeFile(join(dirname(root), `${root.split(/[\\/]/).pop() ?? ''}-sibling`), 'x');
    await pause(400);
    expect(settled).toEqual([]);
    expect(errors).toHaveLength(1);
    await rm(`${root}-sibling`, { force: true });
  });

  it('reports a missing root at start without watching', async () => {
    const errors: FixtureWatchError[] = [];
    watcher = watchFixtureDirectory(join(root, 'nope'), {
      onSettled: () => undefined,
      onError: (error) => errors.push(error),
    });
    await watcher.ready;
    expect(errors.map((error) => error.code)).toEqual(['fixture-root-missing']);
    expect(watcher.isWatching()).toBe(false);
  });

  it('closes idempotently and reports nothing afterwards', async () => {
    const { settled } = await start();
    await watcher?.close();
    await watcher?.close();
    await writeFile(join(root, 'default', 'v1', 'GET', '200_{text-plain}.txt'), 'three');
    await pause(300);
    expect(settled).toEqual([]);
    expect(watcher?.isWatching()).toBe(false);
  });
});

/** A backend the test drives by hand. */
function fakeBackend() {
  const instances: { handlers: WatchBackendHandlers; closed: boolean }[] = [];
  const factory: WatchBackendFactory = (_root, handlers) => {
    const instance = { handlers, closed: false };
    instances.push(instance);
    queueMicrotask(() => {
      handlers.onReady();
    });
    return {
      close: () => {
        instance.closed = true;
        return Promise.resolve();
      },
    };
  };
  return { factory, instances };
}

describe('watchFixtureDirectory (backend failures)', () => {
  it('retries with bounded backoff and reloads on recovery', async () => {
    const { factory, instances } = fakeBackend();
    const settled: string[] = [];
    const errors: FixtureWatchError[] = [];
    watcher = watchFixtureDirectory(root, {
      onSettled: () => settled.push('settled'),
      onError: (error) => errors.push(error),
      backend: factory,
      retryInitialMs: 20,
      retryMaxMs: 40,
    });
    await watcher.ready;
    expect(watcher.isWatching()).toBe(true);

    instances[0]?.handlers.onError(Object.assign(new Error(`EMFILE ${root}`), { code: 'EMFILE' }));
    await until(() => errors.length === 1);
    expect(errors[0]).toMatchObject({ code: 'watch-failed', retryable: true });
    expect(errors[0]?.message).not.toContain(root);
    expect(watcher.isWatching()).toBe(false);
    expect(instances[0]?.closed).toBe(true);

    await until(() => instances.length === 2 && watcher?.isWatching() === true);
    expect(settled).toEqual(['settled']);

    // Repeated failures back off, capped at retryMaxMs.
    instances[1]?.handlers.onError(new Error('x'));
    await until(() => instances.length === 3 && watcher?.isWatching() === true);
    expect(errors.map((error) => /retrying in (\d+) ms/.exec(error.message)?.[1])).toEqual(['20', '20']);
    expect(settled).toEqual(['settled', 'settled']);
  });

  it('caps the backoff while the backend keeps failing', async () => {
    const errors: FixtureWatchError[] = [];
    let created = 0;
    watcher = watchFixtureDirectory(root, {
      onSettled: () => undefined,
      onError: (error) => errors.push(error),
      backend: (_root, handlers) => {
        created++;
        queueMicrotask(() => {
          handlers.onError(new Error('down'));
        });
        return { close: () => Promise.resolve() };
      },
      retryInitialMs: 5,
      retryMaxMs: 20,
    });
    await until(() => errors.length >= 4);
    expect(errors.slice(0, 4).map((error) => /retrying in (\d+) ms/.exec(error.message)?.[1])).toEqual([
      '5',
      '10',
      '20',
      '20',
    ]);
    expect(created).toBeGreaterThanOrEqual(4);
  });

  it('treats a backend error after the root vanished as fixture-root-missing', async () => {
    const { factory, instances } = fakeBackend();
    const errors: FixtureWatchError[] = [];
    watcher = watchFixtureDirectory(root, {
      onSettled: () => undefined,
      onError: (error) => errors.push(error),
      backend: factory,
      retryInitialMs: 5,
    });
    await watcher.ready;
    await rm(root, { recursive: true, force: true });
    instances[0]?.handlers.onError(new Error('ENOENT'));
    await until(() => errors.length > 0);
    await pause(50);
    expect(errors.map((error) => error.code)).toEqual(['fixture-root-missing']);
    expect(instances).toHaveLength(1);
  });

  it('never lets a throwing listener escape', async () => {
    const { factory, instances } = fakeBackend();
    watcher = watchFixtureDirectory(root, {
      onSettled: () => {
        throw new Error('listener bug');
      },
      onError: () => undefined,
      backend: factory,
      quietMs: 5,
    });
    await watcher.ready;
    instances[0]?.handlers.onChange(join(root, 'default'), 'change');
    await pause(50);
    expect(watcher.isWatching()).toBe(true);
  });
});
