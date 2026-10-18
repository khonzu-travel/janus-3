import { randomInt } from 'node:crypto';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isIP } from 'node:net';

import {
  createHoldCapacity,
  createHttpAdapter,
  type CorsSettings,
  type RequestLimits,
  type RequestRecord,
  type UiAssets,
} from '@janus/adapter-http';
import {
  buildSnapshot,
  createEngine,
  type ResolvedConfig,
  type AtlasDiagnostics,
  type BuildSnapshotOptions,
  type EngineConfig,
  type FixtureSnapshot,
  type StartupError,
  type StartupWarning,
} from '@janus/core';
import {
  readFixtureDirectory,
  watchFixtureDirectory,
  type FixtureWatcher,
  type WatchFixtureOptions,
} from '@janus/fixtures-fs';

import type { RequestTree, Sandbox, ValidationContext } from '@janus/runner';

import { CaptureStore, LazyCaptureStore } from './captures.js';
import { FsFixtureWriter } from './fixture-writer.js';
import { createReloader } from './reload.js';
import { RequestStore } from './requests.js';
import { createRunnerHost, type RunnerHost } from './runner-host.js';
import { createUpstream, type ClosableUpstream } from './upstream.js';

/** Default bound on graceful shutdown before remaining connections are terminated. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

/** Composition configuration, filled by `main` from the effective configuration. */
export interface ServeConfig {
  /** Absolute fixture root. */
  readonly dataRoot: string;
  readonly host: string;
  readonly port: number;
  /** A snapshot already built from `dataRoot` by the startup validation pass; read and built here when absent. */
  readonly snapshot?: FixtureSnapshot;
  /** Request limits; each defaults to the adapter's default. */
  readonly limits?: Partial<RequestLimits>;
  /** Each omitted setting takes its default. */
  readonly engine?: Partial<EngineConfig>;
  /** Custom aliases for the snapshot built here when `snapshot` is absent. */
  readonly snapshotOptions?: BuildSnapshotOptions;
  /**
   * Where `engine.seed` came from; `generated` when the server picked it.
   * Callers must not pair `generated` with a configured seed; contradictory provenance is not validated.
   */
  readonly seedSource?: 'config' | 'cli' | 'generated';
  readonly diagnostics?: AtlasDiagnostics;
  readonly shutdownTimeoutMs?: number;
  /** `fixtures.watch` / `--watch`: reload automatically when the fixture tree changes. */
  readonly watch?: boolean;
  /** `atlas.resolve`: mount `POST /_janus/resolve`. Defaults to true. */
  readonly resolve?: boolean;
  /** `cors.origins` and `cors.maxAge`. Defaults to no CORS. */
  readonly cors?: CorsSettings;
  /** The loaded UI, served at `/_janus/ui/`; null or absent serves none. */
  readonly ui?: UiAssets | null;
  /**
   * The absolute captures directory, already created. With
   * registrations in `engine.recording`, it enables recording; without it,
   * recorded requests are `501 recording-unavailable`.
   */
  readonly captures?: string;
  /** PEM text of `runner.extraCaCerts`, trusted by recording and the runner. */
  readonly extraCaCerts?: readonly string[];
  /** `runner.skipTlsVerify`: recording accepts any upstream certificate. The runner reads its own `values`. */
  readonly skipTlsVerify?: boolean;
  /** The request runner: absent leaves its routes unmounted. */
  readonly runner?: RunnerServeConfig;
  /** Tuning for the fixture watcher; tests shorten its timings or substitute its backend. */
  readonly watchOptions?: Pick<WatchFixtureOptions, 'quietMs' | 'maxWaitMs' | 'backend'>;
}

/** What the runner needs at startup. */
export interface RunnerServeConfig {
  /** Absolute `runner.root`. */
  readonly root: string;
  /** The request snapshot the startup pass validated. */
  readonly tree: RequestTree;
  readonly context: ValidationContext;
  readonly sandbox: Sandbox;
  /** Loopback, or `runner.allowNonLoopback`. */
  readonly available: boolean;
  /** The effective values: `runner`, `recording`, `limits`, `dynamic.timezone`. */
  readonly values: ResolvedConfig;
  /** Absolute `recording.captures`; created on the first runner capture. */
  readonly captures: string;
}

export interface ServeLogger {
  info(event: string, fields?: Readonly<Record<string, string | number>>): void;
  error(event: string, fields?: Readonly<Record<string, string | number>>): void;
  /** Prints a failed reload's problems. Optional. */
  problems?(errors: readonly StartupError[], warnings: readonly StartupWarning[]): void;
}

export interface RunningServer {
  /** Base URL that clients can use, e.g. "http://127.0.0.1:4010". */
  readonly url: string;
  /** The snapshot served at startup; reloads may have replaced it since. */
  readonly snapshot: FixtureSnapshot;
  /** Stops accepting connections and waits for active requests, up to the shutdown timeout. Idempotent. */
  close(): Promise<void>;
}

export type StartResult =
  | { readonly ok: true; readonly server: RunningServer }
  | { readonly ok: false; readonly errors: readonly StartupError[] };

/** A seed for runs that configure none: picked once, logged, and reported at /_janus/clock. */
export function generateSeed(): number {
  return randomInt(0, 2 ** 32);
}

/**
 * Starts Janus in a fixed order: read fixture bytes, build and
 * validate the snapshot (unless `main` already did), construct the adapter,
 * and only then bind the port. An invalid tree returns its errors and never
 * opens a socket.
 */
export async function startServer(config: ServeConfig, logger: ServeLogger): Promise<StartResult> {
  let snapshot = config.snapshot;
  if (snapshot === undefined) {
    const read = await readFixtureDirectory(config.dataRoot);
    if (!read.ok) return { ok: false, errors: read.errors };
    const built = buildSnapshot(read.files, config.snapshotOptions);
    if (!built.ok) return { ok: false, errors: built.errors };
    snapshot = built.snapshot;
  }

  // `startServer` is also a public composition root. Do not rely on the CLI
  // caller to fill a nullable seed: every server run must choose one once,
  // then use and report that same value for its lifetime.
  const configuredSeed = config.engine?.seed;
  const seed = configuredSeed ?? generateSeed();
  const seedSource =
    configuredSeed === null || configuredSeed === undefined ? 'generated' : (config.seedSource ?? 'config');
  logger.info('seed', { seed, source: seedSource });

  // The server owns the network and the captures directory; core decides what is sent and written.
  let upstream: ClosableUpstream | null = null;
  let captures: CaptureStore | null = null;
  const recording = config.engine?.recording;
  if (config.captures !== undefined && recording !== undefined && recording.endpoints.length > 0) {
    captures = await CaptureStore.open(config.captures, logger);
    upstream = createUpstream({
      timeoutMs: recording.timeoutMs,
      maxResponseBytes: recording.maxResponseBytes,
      ...(config.extraCaCerts === undefined ? {} : { extraCaCerts: config.extraCaCerts }),
      ...(config.skipTlsVerify === undefined ? {} : { skipTlsVerify: config.skipTlsVerify }),
      logger,
    });
  }

  // Auto promotion writes on every recording, so it needs a writable root before anything binds.
  if (captures !== null && config.engine?.promotionMode === 'auto') {
    const writable = await access(config.dataRoot, constants.W_OK).then(
      () => true,
      () => false,
    );
    if (!writable) {
      await upstream?.close();
      return {
        ok: false,
        errors: [
          {
            code: 'fixtures-not-writable',
            source: 'fixtures',
            path: '',
            message: 'promotion.mode is auto, but the fixture root is not writable',
          },
        ],
      };
    }
  }
  // The runner writes captures without recording.endpoints, through the same store when there is one.
  const runnerCaptures =
    config.runner === undefined ? null : new LazyCaptureStore(config.runner.captures, logger, captures);
  // The server owns the fixture writer and the reload; core plans every promotion.
  // Runner captures are promoted unchanged, so promotion reads them too.
  const promotable = captures ?? (config.runner?.available === true ? runnerCaptures : null);
  const fixtures = promotable === null ? null : await FsFixtureWriter.open(config.dataRoot);

  // The composition root owns the only wall clock and entropy source.
  // One held-connection limit, shared by core's decision and the adapter's hold.
  const transport = createHoldCapacity(config.engine?.faults?.maxHeldConnections ?? 128);
  const engine = createEngine({
    snapshot,
    transport,
    clock: () => Date.now(),
    randomBytes: (count) => crypto.getRandomValues(new Uint8Array(count)),
    seedSource,
    config: { ...config.engine, seed },
    ...(config.diagnostics === undefined ? {} : { diagnostics: config.diagnostics }),
    ...(upstream === null || captures === null ? {} : { recording: { upstream, captures } }),
    ...(fixtures === null || promotable === null
      ? {}
      : {
          runnerCaptures: config.runner?.available === true,
          promotion: {
            fixtures: {
              read: () => fixtures.read(),
              // Commits take turns with reloads, so no reload reads a half-written tree.
              apply: (plan, signal) => reloader.write(() => fixtures.apply(plan, signal)),
            },
            captures: promotable,
            reload: () => reloader.trigger('promotion'),
            ...(config.snapshotOptions === undefined ? {} : { buildOptions: config.snapshotOptions }),
          },
        }),
  });
  engine.promotions.subscribe((event) => {
    logger.info('promotion', {
      ...(event.capture === undefined ? {} : { capture: event.capture }),
      scenario: event.scenario,
      outcome: event.outcome,
      ...(event.mode === undefined ? {} : { mode: event.mode }),
      files: event.files.join(','),
      ...(event.code === undefined ? {} : { code: event.code }),
    });
  });

  // The runner reaches the network, Janus itself and the captures directory through the server.
  let runnerHost: RunnerHost | null = null;
  let requestStore: RequestStore | null = null;
  if (config.runner !== undefined && runnerCaptures !== null) {
    const runner = config.runner;
    requestStore = new RequestStore(
      runner.root,
      runner.context,
      { tree: runner.tree, errors: [], warnings: [] },
      logger,
    );
    runnerHost = createRunnerHost({
      store: requestStore,
      context: runner.context,
      sandbox: runner.sandbox,
      values: runner.values,
      extraCaCerts: config.extraCaCerts ?? [],
      captures: runnerCaptures,
      engine,
      available: runner.available,
      explain: config.resolve ?? true,
      logger,
    });
  }

  // Reloads rebuild the whole tree beside the active snapshot.
  // Warnings from the command line and configuration file survive a reload;
  // fixture warnings are replaced by the candidate's.
  const reloader = createReloader({
    engine,
    read: () => readFixtureDirectory(config.dataRoot),
    build: (files) => buildSnapshot(files, config.snapshotOptions),
    baseWarnings: (config.diagnostics?.warnings ?? []).filter((warning) => warning.source !== 'fixtures'),
    logger,
    ...(logger.problems === undefined ? {} : { printProblems: logger.problems.bind(logger) }),
  });
  const reloadOnWatch = (): void => {
    // The result is recorded and published by the reloader; nobody waits on it here.
    reloader.trigger('watch').catch(() => undefined);
  };

  let watcher: FixtureWatcher | null = null;
  let requestWatcher: FixtureWatcher | null = null;
  if (config.watch === true && requestStore !== null && (await isDirectory(requestStore.root))) {
    // The request tree is watched like the fixtures, and a problem keeps the previous snapshot.
    const store = requestStore;
    requestWatcher = watchFixtureDirectory(store.root, {
      label: 'requests root',
      onSettled: () => {
        store
          .reload()
          .then((load) => {
            if (load.errors.length > 0) logger.problems?.(load.errors, load.warnings);
          })
          .catch(() => undefined);
      },
      onError: (error) => {
        logger.error('requests-watch-error', { code: error.code, message: error.message });
      },
      ...config.watchOptions,
    });
  }
  if (config.watch === true) {
    watcher = watchFixtureDirectory(config.dataRoot, {
      onSettled: reloadOnWatch,
      onError: (error) => {
        logger.error('watch-error', { code: error.code, message: error.message });
        // A vanished root is reported as a failed reload, and watching stays off until restart.
        if (error.code === 'fixture-root-missing') reloadOnWatch();
      },
      ...config.watchOptions,
    });
  }

  // The watcher and upstream are already open: close them if the adapter cannot be built or cannot listen.
  let app: ReturnType<typeof createHttpAdapter>;
  try {
    app = createHttpAdapter({
      engine,
      host: config.host,
      resolve: config.resolve ?? true,
      ...(config.cors === undefined ? {} : { cors: config.cors }),
      ...(config.engine?.fixtureCors === undefined ? {} : { fixtureCors: config.engine.fixtureCors }),
      ui: config.ui ?? null,
      captures: runnerCaptures ?? captures,
      runner: runnerHost?.service ?? null,
      ...(runnerHost === null ? {} : { onResolved: runnerHost.onResolved }),
      reload: {
        trigger: () => reloader.trigger('request'),
        last: () => reloader.last(),
        watching: () => watcher?.isWatching() ?? false,
        subscribe: (listener) => reloader.subscribe(listener),
      },
      ...(config.limits === undefined ? {} : { limits: config.limits }),
      onRequestComplete: (record: RequestRecord) => {
        const recorded = record.recording;
        logger.info('request', {
          id: record.requestId,
          method: record.method,
          path: record.path,
          status: record.status,
          ms: record.durationMs,
          // The delay, the fault performed, and the codings.
          ...(record.transport === undefined
            ? {}
            : {
                latencyMs: record.transport.latencyMs,
                fault: formatFault(record.transport.fault),
                requestCodings: record.transport.requestCodings.join(',') || '-',
                responseCoding: record.transport.responseCoding ?? '-',
              }),
          // The upstream by origin only, and a failure by its kind.
          ...(recorded === undefined
            ? {}
            : {
                recording: `${recorded.scenario}/${recorded.exchange}`,
                outcome: recorded.outcome,
                upstream: recorded.upstream,
                upstreamMs: recorded.upstreamMs,
                ...(recorded.failure === undefined ? {} : { failure: recorded.failure }),
                ...(recorded.reason === undefined ? {} : { reason: recorded.reason }),
              }),
        });
      },
      onSessionWrite: (record) => {
        logger.info('session-write', {
          id: record.requestId,
          route: record.route,
          method: record.method,
          source: record.source ?? '-',
          session: record.id ?? '-',
          status: record.status,
          outcome: record.outcome,
        });
      },
      onInternalError: (requestId, error) => {
        logger.error('internal-error', {
          id: requestId,
          error: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });
    runnerHost?.attach(app);
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await watcher?.close();
    await requestWatcher?.close();
    await runnerHost?.close();
    await upstream?.close();
    throw error;
  }
  if (watcher !== null) {
    await watcher.ready;
    logger.info('watching', { active: watcher.isWatching() ? 'yes' : 'no' });
  }

  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  const url = `http://${isIP(config.host) === 6 ? `[${config.host}]` : config.host}:${String(port)}`;

  const timeoutMs = config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // Stop accepting reload triggers, close the watcher before
    // the HTTP server, and let the current reload finish within the deadline.
    closing ??= (async () => {
      const timer = setTimeout(() => {
        app.server.closeAllConnections();
      }, timeoutMs);
      try {
        // Queued reload callers get their 503 just before connections are cut.
        const draining = reloader.close(Math.max(0, timeoutMs - 250));
        await watcher?.close();
        await requestWatcher?.close();
        await runnerHost?.close();
        await Promise.all([draining, app.close()]);
        await upstream?.close();
      } finally {
        clearTimeout(timer);
      }
    })();
    return closing;
  };

  return { ok: true, server: { url, snapshot, close } };
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

/** A performed fault in the request log: `reset; rule=1; step=2`, or `-`. */
function formatFault(fault: NonNullable<RequestRecord['transport']>['fault']): string {
  if (fault === null) return '-';
  return `${fault.kind}; rule=${String(fault.rule)}${fault.step === undefined ? '' : `; step=${String(fault.step)}`}`;
}
