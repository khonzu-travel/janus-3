import {
  formatInstant,
  reloadProblem,
  reloadSummary,
  sortStartupProblems,
  type AtlasReloadResult,
  type AtlasReloadTrigger,
  type AtlasSnapshotEvent,
  type AtlasSnapshotState,
  type BuildSnapshotResult,
  type Engine,
  type FixtureFiles,
  type StartupError,
  type StartupWarning,
  type WriteResult,
} from '@janus/core';
import type { ReadFixturesResult } from '@janus/fixtures-fs';

import type { ServeLogger } from './serve.js';

/**
 * A reload could not be performed for this caller because the server is
 * shutting down. The HTTP adapter answers it with `503 service-unavailable`.
 */
export class ReloadUnavailableError extends Error {
  readonly code = 'service-unavailable';
  constructor() {
    super('Janus is shutting down');
    this.name = 'ReloadUnavailableError';
  }
}

export interface ReloaderOptions {
  readonly engine: Engine;
  /** Reads the whole fixture tree. */
  readonly read: () => Promise<ReadFixturesResult>;
  readonly build: (files: FixtureFiles) => BuildSnapshotResult;
  /** Startup warnings that do not come from the fixture tree; reloads keep them. */
  readonly baseWarnings: readonly StartupWarning[];
  readonly logger: ServeLogger;
  /** Prints a failed reload's problems. */
  readonly printProblems?: (errors: readonly StartupError[], warnings: readonly StartupWarning[]) => void;
  /** The wall clock for `finishedAt`. */
  readonly now?: () => number;
}

export interface Reloader {
  /** Requests a reload and settles with the result of the reload that includes this trigger. */
  trigger(kind: AtlasReloadTrigger): Promise<AtlasReloadResult>;
  /** Holds off every other reload until a fixture write and its promotion reload finish. */
  write(apply: () => Promise<WriteResult>): Promise<WriteResult>;
  /** The most recent result, or null before the first reload. */
  last(): AtlasReloadResult | null;
  /** Reads the state and subscribes in one synchronous step, so no change can fall between them. */
  subscribe(listener: (event: AtlasSnapshotEvent) => void): { readonly state: AtlasSnapshotState; unsubscribe(): void };
  /**
   * Shuts down: refuses new triggers at once, lets accepted
   * work finish for up to `timeoutMs`, then rejects remaining callers with
   * `ReloadUnavailableError`. Nothing is swapped or published afterwards.
   */
  close(timeoutMs: number): Promise<void>;
}

interface Waiter {
  readonly resolve: (result: AtlasReloadResult) => void;
  readonly reject: (error: Error) => void;
}

interface Batch {
  readonly triggers: Set<AtlasReloadTrigger>;
  readonly waiters: Waiter[];
}

const TRIGGER_ORDER: readonly AtlasReloadTrigger[] = ['watch', 'request', 'promotion'];

/**
 * Orchestrates reloads: read, build and validate a complete
 * candidate beside the active snapshot, and swap only a valid one. Reloads run
 * one at a time; triggers that arrive meanwhile join a single follow-up, and
 * every caller waits for the reload that includes its trigger.
 */
export function createReloader(options: ReloaderOptions): Reloader {
  const { engine, logger } = options;
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<(event: AtlasSnapshotEvent) => void>();
  let lastResult: AtlasReloadResult | null = null;
  let running: Batch | null = null;
  let queued: Batch | null = null;
  let stopped = false;
  /** Set when shutdown's deadline passed: in-flight work may finish but must not swap or publish. */
  let abandoned = false;
  let idle: (() => void)[] = [];
  let operations = 0;
  let operationQueue: Promise<unknown> = Promise.resolve();
  const finishIdle = (): void => {
    if (running !== null || operations > 0) return;
    const done = idle;
    idle = [];
    for (const resolve of done) resolve();
  };
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    operations++;
    const next = operationQueue.then(async () => {
      if (abandoned) throw new ReloadUnavailableError();
      return operation();
    });
    operationQueue = next.catch(() => undefined);
    return next.finally(() => {
      operations--;
      finishIdle();
    });
  };

  const publish = (event: AtlasSnapshotEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // One broken subscriber must not stop the others.
      }
    }
  };

  /** The previous version is known only to the swap, so it travels beside the result. */
  let swappedFrom = '';
  const perform = async (batch: Batch): Promise<AtlasReloadResult> => {
    const triggers = TRIGGER_ORDER.filter((kind) => batch.triggers.has(kind));
    logger.info('reload-started', { triggers: triggers.join(',') });
    const result = (
      outcome: AtlasReloadResult['outcome'],
      candidate: string | null,
      errors: readonly StartupError[],
      warnings: readonly StartupWarning[],
    ): AtlasReloadResult => ({
      outcome,
      triggers,
      finishedAt: formatInstant(now()),
      activeSnapshotVersion: engine.snapshot().version,
      candidateSnapshotVersion: candidate,
      errors: sortStartupProblems(errors).map(reloadProblem),
      warnings: sortStartupProblems(warnings).map(reloadProblem),
    });
    const failed = (errors: readonly StartupError[], warnings: readonly StartupWarning[]): AtlasReloadResult => {
      logger.error('reload-failed', { errors: errors.length });
      options.printProblems?.(sortStartupProblems(errors), sortStartupProblems(warnings));
      return result('failed', null, errors, warnings);
    };

    const read = await options.read();
    if (!read.ok) return failed(read.errors, []);
    const built = options.build(read.files);
    if (!built.ok) return failed(built.errors, built.warnings);
    if (abandoned) throw new ReloadUnavailableError();
    const warnings = sortStartupProblems([...options.baseWarnings, ...built.warnings]);
    const previous = engine.replaceSnapshot(built.snapshot, { warnings });
    if (previous === built.snapshot.version) {
      logger.info('reload-unchanged', { snapshot: previous });
      return result('unchanged', built.snapshot.version, [], built.warnings);
    }
    logger.info('reload-swapped', { snapshot: built.snapshot.version, previous });
    swappedFrom = previous;
    return result('swapped', built.snapshot.version, [], built.warnings);
  };

  const record = (result: AtlasReloadResult): void => {
    if (abandoned) return;
    lastResult = result;
    if (result.outcome === 'swapped') {
      publish({ type: 'snapshot', snapshotVersion: result.activeSnapshotVersion, previousVersion: swappedFrom });
    } else if (result.outcome === 'failed') {
      publish({ type: 'reload-failed', errorCount: result.errors.length, finishedAt: result.finishedAt });
    } else {
      publish({ type: 'state', snapshotVersion: result.activeSnapshotVersion, lastReload: reloadSummary(result) });
    }
  };

  const run = async (batch: Batch): Promise<void> => {
    let outcome: { ok: true; result: AtlasReloadResult } | { ok: false; error: Error };
    try {
      const result = await exclusive(async () => {
        const result = await perform(batch);
        record(result);
        return result;
      });
      outcome = { ok: true, result };
    } catch (error) {
      if (!(error instanceof ReloadUnavailableError)) {
        logger.error('reload-error', { message: error instanceof Error ? error.message : String(error) });
      }
      outcome = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
    if (abandoned) {
      for (const waiter of batch.waiters) waiter.reject(new ReloadUnavailableError());
    } else if (outcome.ok) {
      const { result } = outcome;
      for (const waiter of batch.waiters) waiter.resolve(result);
    } else {
      for (const waiter of batch.waiters) waiter.reject(outcome.error);
    }

    running = queued;
    queued = null;
    if (running !== null) {
      void run(running);
    } else {
      finishIdle();
    }
  };

  /** Detaches every caller still waiting, so the abandoned run settles nobody twice. */
  const takeWaiters = (): Waiter[] => {
    const waiting = [...(running?.waiters ?? []), ...(queued?.waiters ?? [])];
    if (running !== null) running.waiters.length = 0;
    queued = null;
    return waiting;
  };

  return {
    write: (apply) => {
      if (stopped) return Promise.reject(new ReloadUnavailableError());
      return exclusive(async () => {
        const result = await apply();
        if (result.outcome !== 'written' && !(result.outcome === 'failed' && !result.restored)) return result;
        const reload = await perform({ triggers: new Set(['promotion']), waiters: [] });
        record(reload);
        return { ...result, reload };
      });
    },
    trigger: (kind) => {
      if (stopped) return Promise.reject(new ReloadUnavailableError());
      return new Promise<AtlasReloadResult>((resolve, reject) => {
        const waiter = { resolve, reject };
        if (running === null) {
          running = { triggers: new Set([kind]), waiters: [waiter] };
          void run(running);
        } else {
          queued ??= { triggers: new Set(), waiters: [] };
          queued.triggers.add(kind);
          queued.waiters.push(waiter);
        }
      });
    },
    last: () => lastResult,
    subscribe: (listener) => {
      listeners.add(listener);
      return {
        state: {
          snapshotVersion: engine.snapshot().version,
          lastReload: lastResult === null ? null : reloadSummary(lastResult),
        },
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
    close: async (timeoutMs) => {
      stopped = true;
      if (running === null && operations === 0) {
        listeners.clear();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = new Promise<boolean>((resolve) => {
        idle.push(() => {
          resolve(true);
        });
      });
      const expired = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
      });
      const inTime = await Promise.race([finished, expired]);
      clearTimeout(timer);
      if (!inTime) {
        abandoned = true;
        for (const waiter of takeWaiters()) waiter.reject(new ReloadUnavailableError());
      }
      listeners.clear();
    },
  };
}
