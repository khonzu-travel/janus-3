import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { isIgnoredFileName } from '@janus/core';
import { watch } from 'chokidar';

/** Quiet period after the last change before a burst counts as settled. */
export const SETTLE_QUIET_MS = 150;
/** A continuous burst settles this long after its first change, even if changes keep coming. */
export const SETTLE_MAX_WAIT_MS = 2000;
/** Bounds of the exponential backoff between attempts to restart a failed watcher. */
export const RETRY_INITIAL_MS = 500;
export const RETRY_MAX_MS = 30_000;

export type FixtureWatchErrorCode =
  /** The fixture root disappeared. Watching stops for good; it is never restarted or moved to a parent. */
  | 'fixture-root-missing'
  /** The watcher backend failed. Watching is retried with bounded backoff; recovery reports a settle. */
  | 'watch-failed';

export interface FixtureWatchError {
  readonly code: FixtureWatchErrorCode;
  /** Safe to print: never contains the root's path. */
  readonly message: string;
  readonly retryable: boolean;
}

export interface FixtureWatcher {
  /** Settles once the first watch is established, or once watching has stopped for good. */
  readonly ready: Promise<void>;
  /** True while changes are being observed: false before ready, while retrying, and after the root went missing. */
  isWatching(): boolean;
  /** Stops watching and cancels pending reports. Idempotent. */
  close(): Promise<void>;
}

export interface WatchFixtureOptions {
  /** Something under the root changed and the changes settled. It reports that, not what. */
  readonly onSettled: () => void;
  /** The asynchronous error channel; nothing is ever thrown into the caller's stack later. */
  readonly onError: (error: FixtureWatchError) => void;
  readonly quietMs?: number;
  readonly maxWaitMs?: number;
  readonly retryInitialMs?: number;
  readonly retryMaxMs?: number;
  /** The file-watching backend; chokidar by default. Tests substitute one they can fail on demand. */
  readonly backend?: WatchBackendFactory;
  /** What the root is called in messages: "fixture root" by default, "requests root" for the runner. */
  readonly label?: string;
}

/** What the watcher needs from a file-watching library. */
export interface WatchBackendHandlers {
  /** Any add, change or removal under the root, with the absolute path it concerns. */
  onChange(path: string, kind: string): void;
  onReady(): void;
  onError(error: unknown): void;
}

export interface WatchBackend {
  close(): Promise<void>;
}

export type WatchBackendFactory = (root: string, handlers: WatchBackendHandlers) => WatchBackend;

/** Chokidar 5 over the whole tree, skipping the editor and OS files fixture loading ignores. */
export const chokidarBackend: WatchBackendFactory = (root, handlers) => {
  const watcher = watch(root, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (path: string) => path !== root && isIgnoredFileName(basename(path)),
  });
  watcher.on('all', (kind, path) => {
    handlers.onChange(path, kind);
  });
  watcher.on('ready', () => {
    handlers.onReady();
  });
  watcher.on('error', (error) => {
    handlers.onError(error);
  });
  return { close: () => watcher.close() };
};

/**
 * Coalesces a burst of changes into one report: `quietMs`
 * with no further change, or `maxWaitMs` after the burst's first change,
 * whichever comes first. An editor's save-rename-delete is one report.
 */
export function createSettler(onSettled: () => void, quietMs: number, maxWaitMs: number) {
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const fire = (): void => {
    cancel();
    onSettled();
  };
  const cancel = (): void => {
    clearTimeout(quiet);
    clearTimeout(deadline);
    quiet = undefined;
    deadline = undefined;
  };
  return {
    poke(): void {
      clearTimeout(quiet);
      quiet = setTimeout(fire, quietMs);
      deadline ??= setTimeout(fire, maxWaitMs);
    },
    cancel,
  };
}

/**
 * Watches a fixture root recursively and reports when changes have settled.
 * The caller always re-reads the whole tree, so a missed or reordered event can
 * never produce a partial snapshot.
 */
export function watchFixtureDirectory(root: string, options: WatchFixtureOptions): FixtureWatcher {
  const absolute = resolve(root);
  const label = options.label ?? 'fixture root';
  const backendFactory = options.backend ?? chokidarBackend;
  const retryInitialMs = options.retryInitialMs ?? RETRY_INITIAL_MS;
  const retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
  const report = <A extends unknown[]>(callback: (...args: A) => void, ...args: A): void => {
    try {
      callback(...args);
    } catch {
      // A failing listener must not break the watcher or escape into a timer's stack.
    }
  };

  let closed = false;
  let watching = false;
  let backend: WatchBackend | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((done) => {
    markReady = done;
  });

  const stopBackend = (): void => {
    watching = false;
    const current = backend;
    backend = undefined;
    current?.close().catch(() => undefined);
  };

  const rootMissing = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(retry);
    settler.cancel();
    stopBackend();
    markReady();
    report(options.onError, {
      code: 'fixture-root-missing',
      message: `the ${label} no longer exists; restart Janus to watch it again`,
      retryable: false,
    });
  };

  /** Runs `then` when the root is still a directory; otherwise stops for good. */
  const withRoot = (then: () => void): void => {
    stat(absolute).then(
      (info) => {
        if (closed) return;
        if (info.isDirectory()) then();
        else rootMissing();
      },
      () => {
        rootMissing();
      },
    );
  };

  const settler = createSettler(
    () => {
      withRoot(() => {
        report(options.onSettled);
      });
    },
    options.quietMs ?? SETTLE_QUIET_MS,
    options.maxWaitMs ?? SETTLE_MAX_WAIT_MS,
  );

  const start = (): void => {
    if (closed) return;
    const recovering = attempts > 0;
    try {
      backend = backendFactory(absolute, {
        onChange: (path, kind) => {
          if (closed) return;
          if (path === absolute && kind === 'unlinkDir') withRoot(() => undefined);
          else settler.poke();
        },
        onReady: () => {
          if (closed) return;
          watching = true;
          attempts = 0;
          markReady();
          // Changes made while the watch was down were missed: reload everything.
          if (recovering) report(options.onSettled);
        },
        onError: (error) => {
          failed(error);
        },
      });
    } catch (error) {
      failed(error);
    }
  };

  const failed = (error: unknown): void => {
    if (closed) return;
    stopBackend();
    withRoot(() => {
      if (retry !== undefined) return;
      const delay = Math.min(retryMaxMs, retryInitialMs * 2 ** attempts);
      attempts++;
      report(options.onError, {
        code: 'watch-failed',
        message: `watching the ${label} failed (${errorCode(error)}); retrying in ${String(delay)} ms`,
        retryable: true,
      });
      retry = setTimeout(() => {
        retry = undefined;
        start();
      }, delay);
    });
  };

  withRoot(start);

  return {
    ready,
    isWatching: () => watching && !closed,
    close: async () => {
      if (closed && backend === undefined) return;
      closed = true;
      clearTimeout(retry);
      settler.cancel();
      markReady();
      const current = backend;
      backend = undefined;
      watching = false;
      await current?.close();
    },
  };
}

/** A short, path-free description of a backend error. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}
