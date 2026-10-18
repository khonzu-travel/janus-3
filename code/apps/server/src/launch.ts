import { resolve } from 'node:path';

import { engineConfig, publicSettings, type SettingValue, type StartupError, type StartupWarning } from '@janus/core';

import { CaptureStore } from './captures.js';
import type { ServeArgs } from './cli.js';
import type { LocatedPath } from './config.js';
import { startServer, type RunningServer, type ServeLogger } from './serve.js';
import { serverSnapshotOptions, validateStartup } from './startup.js';
import { defaultUiRoot, loadUi, UI_ASSETS_MISSING } from './ui.js';

/** What `launch` needs from its host. */
export interface LaunchEnvironment {
  readonly cwd: string;
  /** Receives every log event the CLI would print. */
  readonly logger: ServeLogger;
  readonly shutdownTimeoutMs?: number;
  /** The built UI's directory; defaults to `@janus/ui/dist`. Null means there is no build. */
  readonly uiRoot?: string | null;
}

/** Where a launch found its files. */
export interface LaunchPaths {
  /** The working directory, absolute. */
  readonly cwd: string;
  /** Absolute, or null when no file was used. */
  readonly configFile: string | null;
  /** Absolute, or null when the configuration did not get that far. */
  readonly fixturesRoot: string | null;
  readonly captures: string | null;
}

export type LaunchResult =
  | {
      readonly kind: 'invalid';
      readonly errors: readonly StartupError[];
      readonly warnings: readonly StartupWarning[];
      readonly notes: readonly string[];
      readonly paths: LaunchPaths;
    }
  | {
      readonly kind: 'bind-failed';
      /** For example `EADDRINUSE` or `EACCES`. */
      readonly code: string;
      readonly host: string;
      readonly port: number;
      readonly paths: LaunchPaths;
    }
  | {
      readonly kind: 'started';
      readonly server: RunningServer;
      /** `<url>/_janus/ui/`, or null when the UI is disabled or not built. */
      readonly uiUrl: string | null;
      readonly warnings: readonly StartupWarning[];
      /** The lines `janus serve` prints after binding, such as the default scenario and recording. */
      readonly summary: readonly string[];
      readonly paths: LaunchPaths;
    };

/**
 * Points where `janus serve` prints between `launch`'s steps, so its output
 * keeps its order. Internal to the server package.
 */
export interface LaunchHooks {
  /** After validation: the fixture root as the user wrote it, for reports. */
  readonly validated?: (fixturesRoot: string | undefined) => void;
  /** The startup warnings, before the UI is reported and the port is bound. */
  readonly warnings?: (warnings: readonly StartupWarning[]) => void;
  /** After binding, before the `started` log line. */
  readonly bound?: (summary: readonly string[]) => void;
}

/** Runs serve's startup and starts the server. Prints nothing. */
export function launch(args: ServeArgs, env: LaunchEnvironment): Promise<LaunchResult> {
  return launchWith(args, env, {});
}

/** `launch`, with the hooks `janus serve` prints from. */
export async function launchWith(args: ServeArgs, env: LaunchEnvironment, hooks: LaunchHooks): Promise<LaunchResult> {
  const { logger } = env;
  const report = await validateStartup(args, env.cwd, { prepareCaptures: true });
  const root = report.fixturesRoot;
  hooks.validated?.(root?.display);
  const paths: LaunchPaths = {
    cwd: resolve(env.cwd),
    configFile: report.configFile?.absolute ?? null,
    fixturesRoot: root?.absolute ?? null,
    captures: report.captures?.absolute ?? null,
  };
  if (!report.ok || report.snapshot === null || report.configDigest === null || root === null) {
    return { kind: 'invalid', errors: report.errors, warnings: report.warnings, notes: report.notes, paths };
  }

  for (const override of report.overrides) {
    logger.info('config-override', {
      key: override.key,
      file: settingText(override.file),
      cli: settingText(override.cli),
    });
  }
  const { values } = report.effective;
  // Loaded after validation and before binding; a missing build never stops startup.
  const ui = values.ui.enabled ? await loadUi(env.uiRoot === undefined ? defaultUiRoot() : env.uiRoot) : null;
  const warnings = [
    ...report.warnings,
    ...(values.ui.enabled && ui === null ? [UI_ASSETS_MISSING] : []),
    // Interrupted exchanges are reported once, at startup.
    ...(report.captures === null ? [] : await incompleteCaptures(report.captures, values.recording.timeoutMs, logger)),
  ];
  hooks.warnings?.(warnings);
  if (ui !== null) logger.info('ui', { files: ui.files.size, bytes: ui.totalBytes });

  const engine = engineConfig(report.effective);
  const seedSetting = report.effective.settings.find((setting) => setting.key === 'dynamic.seed');
  const seedSource = seedSetting?.source === 'cli' ? 'cli' : 'config';
  let result;
  try {
    result = await startServer(
      {
        dataRoot: root.absolute,
        host: values.server.host,
        port: values.server.port,
        snapshot: report.snapshot,
        limits: values.limits,
        engine,
        seedSource,
        snapshotOptions: serverSnapshotOptions(report.effective),
        watch: values.fixtures.watch,
        resolve: values.atlas.resolve,
        cors: values.cors,
        ui,
        ...(report.captures === null ? {} : { captures: report.captures.absolute }),
        extraCaCerts: report.extraCaCerts,
        skipTlsVerify: values.runner.skipTlsVerify,
        runner: {
          root: report.requests.absolute,
          tree: report.requestTree,
          context: report.requestContext,
          sandbox: report.sandbox,
          available: report.runnerAvailable,
          values,
          captures: report.capturesDirectory.absolute,
        },
        diagnostics: {
          configDigest: report.configDigest,
          configFile: report.effective.configFile,
          settings: publicSettings(report.effective),
          warnings,
        },
        ...(env.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: env.shutdownTimeoutMs }),
      },
      logger,
    );
  } catch (error) {
    // Typically a bind failure such as EADDRINUSE or EACCES.
    const code = (error as { code?: unknown } | null)?.code;
    const reason = typeof code === 'string' ? code : error instanceof Error ? error.message : 'unknown';
    logger.error('startup-failed', { reason });
    return { kind: 'bind-failed', code: reason, host: values.server.host, port: values.server.port, paths };
  }

  if (!result.ok) {
    // The tree changed between validation and startup.
    return { kind: 'invalid', errors: result.errors, warnings: [], notes: [], paths };
  }

  const { server } = result;
  const summary = [`Janus listening on ${server.url} (data: ${root.absolute})`];
  if (ui !== null) summary.push(`Atlas UI: ${server.url}/_janus/ui/`);
  // Say when requests without a scenario get something other than `default`.
  const scenario = values.scenarios.default;
  if (scenario !== 'default') summary.push(`Default scenario: ${scenario}`);
  if (report.captures !== null) {
    const count = values.recording.endpoints.length;
    summary.push(
      `Recording: ${String(count)} ${count === 1 ? 'registration' : 'registrations'}, captures in ${report.captures.absolute}`,
    );
  }
  // Say where the request collections are, when there are any.
  const collections = report.requestTree.collections.length;
  if (collections > 0) {
    summary.push(
      `Requests: ${String(collections)} ${collections === 1 ? 'collection' : 'collections'} in ${report.requests.absolute}${report.runnerAvailable ? '' : ' (runner unavailable on a non-loopback address)'}`,
    );
  }
  hooks.bound?.(summary);
  logger.info('started', {
    url: server.url,
    snapshot: server.snapshot.version,
    config: report.configDigest,
    routes: server.snapshot.routeCount,
    fixtures: server.snapshot.fixtureCount,
  });
  return {
    kind: 'started',
    server,
    uiUrl: ui === null ? null : `${server.url}/_janus/ui/`,
    warnings,
    summary,
    paths,
  };
}

/** `capture-incomplete` warnings, naming the scenario and exchange only. */
async function incompleteCaptures(
  directory: LocatedPath,
  timeoutMs: number,
  logger: ServeLogger,
): Promise<StartupWarning[]> {
  let store: CaptureStore;
  try {
    store = await CaptureStore.open(directory.absolute, logger);
  } catch {
    return [];
  }
  return (await store.incomplete(timeoutMs)).map((reservation) => ({
    code: 'capture-incomplete' as const,
    source: 'config' as const,
    path: directory.display,
    message: `the recorded exchange ${reservation.scenario}/${reservation.exchange} has no log line, so it is ignored; its recording was interrupted`,
  }));
}

function settingText(value: SettingValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
