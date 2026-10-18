import { METHODS } from 'node:http';

import {
  buildSnapshot,
  configDigest,
  snapshotOptions,
  sortStartupProblems,
  type BuildSnapshotOptions,
  type EffectiveConfig,
  type FixtureSnapshot,
  type StartupError,
  type StartupWarning,
} from '@janus/core';
import { readFixtureDirectory } from '@janus/fixtures-fs';
import type { RequestTree, Sandbox, ValidationContext } from '@janus/runner';

import type { CommonArgs } from './cli.js';
import { loadConfig, type ConfigOverride, type LocatedPath } from './config.js';
import { checkCaptures, checkExposure, type ProblemSource } from './recording.js';
import { checkRunner } from './runner-startup.js';

/**
 * What `buildSnapshot` needs here: the configuration's options, plus the
 * methods Node's HTTP parser accepts, so a method directory it never passes on
 * is the warning `unreceivable-method`.
 */
export function serverSnapshotOptions(config: EffectiveConfig): BuildSnapshotOptions {
  return { ...snapshotOptions(config), receivableMethods: METHODS };
}

/** Everything the startup validation pass learned. */
export interface StartupReport {
  readonly ok: boolean;
  /** Sorted. */
  readonly errors: readonly StartupError[];
  readonly warnings: readonly StartupWarning[];
  /** Human-readable remarks, e.g. why fixture validation was skipped. */
  readonly notes: readonly string[];
  readonly configFile: LocatedPath | null;
  readonly effective: EffectiveConfig;
  readonly fixturesRoot: LocatedPath | null;
  /** The captures directory when recording is configured, else null. */
  readonly captures: LocatedPath | null;
  readonly overrides: readonly ConfigOverride[];
  /** Set only when there are no errors. */
  readonly configDigest: string | null;
  readonly snapshot: FixtureSnapshot | null;
  /** `recording.captures`, resolved, whether or not recording is configured: the runner writes there too. */
  readonly capturesDirectory: LocatedPath;
  /** `runner.root`. */
  readonly requests: LocatedPath;
  /** The request snapshot; empty when it does not load. */
  readonly requestTree: RequestTree;
  /** How request files are validated: the grammar and the script compiler. */
  readonly requestContext: ValidationContext;
  readonly sandbox: Sandbox;
  /** PEM text of `runner.extraCaCerts`. */
  readonly extraCaCerts: readonly string[];
  /** Loopback, or `runner.allowNonLoopback`. */
  readonly runnerAvailable: boolean;
}

/**
 * The one validation path shared by `janus serve` and `janus validate`: read
 * and parse the configuration, then read and validate the fixture tree, and
 * collect every problem from both. Nothing here binds a port.
 */
export interface StartupOptions {
  /** `serve`: create the captures directory and check it can be written. `validate` never does. */
  readonly prepareCaptures?: boolean;
}

export async function validateStartup(
  args: CommonArgs,
  cwd: string,
  options: StartupOptions = {},
): Promise<StartupReport> {
  const loaded = await loadConfig(args, cwd);
  const errors: StartupError[] = [...loaded.errors];
  const warnings: StartupWarning[] = [...loaded.warnings];
  const notes: string[] = [];

  let snapshot: FixtureSnapshot | null = null;
  if (loaded.fixturesRoot === null) {
    notes.push(
      'fixture validation was skipped because fixtures.root could not be determined; fix the configuration or pass --data',
    );
  } else {
    const read = await readFixtureDirectory(loaded.fixturesRoot.absolute);
    if (!read.ok) {
      errors.push(...read.errors);
    } else {
      const built = buildSnapshot(read.files, serverSnapshotOptions(loaded.effective));
      warnings.push(...built.warnings);
      if (built.ok) snapshot = built.snapshot;
      else errors.push(...built.errors);
    }
  }

  const host = loaded.effective.settings.find((setting) => setting.key === 'server.host');
  if (host !== undefined && !isLoopback(loaded.effective.values.server.host)) {
    warnings.push({
      code: 'non-loopback-bind',
      source: host.source === 'cli' ? 'cli' : 'config',
      path: host.source === 'cli' ? '--host' : (loaded.file?.display ?? ''),
      ...(host.line === undefined ? {} : { line: host.line }),
      ...(host.column === undefined ? {} : { column: host.column }),
      message: 'Janus binds to a non-loopback address and has no authentication',
    });
  }

  // Only configured registrations need the captures directory and a loopback listener.
  const recording = loaded.effective.values.recording;
  let captures: LocatedPath | null = null;
  if (recording.endpoints.length > 0) {
    captures = loaded.captures;
    const capturesSetting = loaded.effective.settings.find((setting) => setting.key === 'recording.captures');
    const where = (source: 'cli' | 'config' | undefined, flag: string): ProblemSource =>
      source === 'cli' ? { source: 'cli', path: flag } : { source: 'config', path: loaded.file?.display ?? '' };
    errors.push(
      ...(await checkCaptures(
        captures,
        loaded.fixturesRoot,
        where(capturesSetting?.source === 'cli' ? 'cli' : 'config', '--captures'),
        options.prepareCaptures === true && errors.length === 0,
      )),
    );
    const exposure = checkExposure(
      loaded.effective.values.server.host,
      isLoopback(loaded.effective.values.server.host),
      recording.allowNonLoopback,
      where(host?.source === 'cli' ? 'cli' : 'config', '--host'),
    );
    errors.push(...exposure.errors);
    warnings.push(...exposure.warnings);
  }

  // The request tree, its location, CA files and exposure.
  const runner = await checkRunner(
    loaded,
    captures === null ? loaded.captures : null,
    isLoopback(loaded.effective.values.server.host),
    host?.source,
  );
  errors.push(...runner.errors);
  warnings.push(...runner.warnings);

  const ok = errors.length === 0;
  return {
    ok,
    errors: sortStartupProblems(errors),
    warnings: sortStartupProblems(warnings),
    notes,
    configFile: loaded.file,
    effective: loaded.effective,
    fixturesRoot: loaded.fixturesRoot,
    captures,
    overrides: loaded.overrides,
    configDigest: ok ? configDigest(loaded.effective) : null,
    snapshot: ok ? snapshot : null,
    capturesDirectory: loaded.captures,
    requests: loaded.requests,
    requestTree: runner.tree,
    requestContext: runner.context,
    sandbox: runner.sandbox,
    extraCaCerts: runner.extraCaCerts,
    runnerAvailable: runner.available,
  };
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}
