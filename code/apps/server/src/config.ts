import { lstat, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  mergeConfig,
  parseConfig,
  type ConfigFile,
  type EffectiveConfig,
  type SettingKey,
  type SettingValue,
  type StartupError,
  type StartupWarning,
} from '@janus/core';

import { CONFIG_FILE_NAME, type CommonArgs } from './cli.js';

/** Near-miss names that are never loaded but are worth a warning when `janus.config.yaml` is absent. */
const SIMILAR_FILE_NAMES = [
  'janus.config.yml',
  'janus.config.json',
  'janus.yaml',
  'janus.yml',
  '.janusrc',
  '.janusrc.yaml',
  '.janusrc.yml',
];

/** A path as the user wrote it (for reports) and where it points (for I/O). */
export interface LocatedPath {
  readonly display: string;
  readonly absolute: string;
}

/** A CLI flag that replaced a value the configuration file set. */
export interface ConfigOverride {
  readonly key: SettingKey;
  readonly file: SettingValue;
  readonly cli: SettingValue;
}

export interface LoadedConfig {
  /** The configuration file that was read, if any. */
  readonly file: LocatedPath | null;
  /** Built from the valid part of the file when it has errors, so the fixture root can still be found. */
  readonly effective: EffectiveConfig;
  /** Null when `fixtures.root` is invalid and not overridden, so the tree cannot be located. */
  readonly fixturesRoot: LocatedPath | null;
  /** `recording.captures`, resolved like `fixtures.root`. */
  readonly captures: LocatedPath;
  /** `runner.root`, resolved like `recording.captures`. */
  readonly requests: LocatedPath;
  /** `runner.extraCaCerts`, each against the configuration file's directory. */
  readonly extraCaCerts: readonly LocatedPath[];
  readonly errors: readonly StartupError[];
  readonly warnings: readonly StartupWarning[];
  readonly overrides: readonly ConfigOverride[];
}

/**
 * Discovers, reads and parses the configuration file, then merges it with the
 * command line. Core does the parsing; this only does file I/O
 * and resolves relative paths: the file's against its own directory, flags'
 * against the working directory.
 */
export async function loadConfig(args: CommonArgs, cwd: string): Promise<LoadedConfig> {
  const errors: StartupError[] = [];
  const warnings: StartupWarning[] = [];

  let file: LocatedPath | null = null;
  if (args.config !== undefined) {
    const absolute = resolve(cwd, args.config);
    file = { display: displayConfigPath(args.config, absolute, cwd), absolute };
  } else if (!args.noConfig) {
    const absolute = join(cwd, CONFIG_FILE_NAME);
    // Discovery is based on the directory entry existing, not on it already
    // being a regular file. A directory, a dangling symlink, an unreadable
    // entry, or any other non-file at the canonical name must be diagnosed
    // rather than silently treated as though no configuration was present.
    if (await exists(absolute)) {
      file = { display: CONFIG_FILE_NAME, absolute };
    } else {
      for (const name of SIMILAR_FILE_NAMES) {
        if (!(await isFile(join(cwd, name)))) continue;
        warnings.push({
          code: 'config-similar-file-ignored',
          source: 'config',
          path: name,
          message: `"${name}" was not loaded; Janus only reads ${CONFIG_FILE_NAME} (or the file named with --config)`,
        });
      }
    }
  }

  let parsedFile: ConfigFile | undefined;
  let rootUnknown = false;
  let locations = {};
  if (file !== null) {
    const text = await readText(file, errors);
    if (text === null) {
      rootUnknown = true;
    } else {
      const parsed = parseConfig({ text, sourceName: file.display });
      locations = parsed.locations;
      if (parsed.ok) {
        parsedFile = parsed.config;
        warnings.push(...parsed.warnings);
      } else {
        parsedFile = parsed.partial;
        errors.push(...parsed.errors);
        // A problem that may hide the intended fixture root: the root itself, its section, or the document.
        rootUnknown = parsed.errors.some(
          (error) => error.key === undefined || error.key === 'fixtures' || error.key === 'fixtures.root',
        );
      }
    }
  }

  const effective = mergeConfig(
    parsedFile,
    {
      host: args.host,
      port: args.port,
      fixturesRoot: args.data,
      seed: args.seed,
      now: args.now,
      scenario: args.scenario,
      captures: args.captures,
      requests: args.requests,
      watch: args.watch,
      ui: args.noUi === true ? false : undefined,
    },
    locations,
  );

  const overrides: ConfigOverride[] = [];
  const fileValues = mergeConfig(parsedFile, {}).settings;
  for (const setting of effective.settings) {
    const fromFile = fileValues.find((entry) => entry.key === setting.key);
    if (
      setting.source === 'cli' &&
      fromFile?.source === 'file' &&
      JSON.stringify(fromFile.value) !== JSON.stringify(setting.value)
    ) {
      overrides.push({ key: setting.key, file: fromFile.value, cli: setting.value });
    }
  }

  let fixturesRoot: LocatedPath | null;
  if (args.data !== undefined) {
    fixturesRoot = { display: displayRoot(args.data), absolute: resolve(cwd, args.data) };
  } else if (parsedFile?.fixtures?.root !== undefined && file !== null) {
    const root = parsedFile.fixtures.root;
    fixturesRoot = { display: displayRoot(root), absolute: resolve(dirname(file.absolute), root) };
  } else if (rootUnknown) {
    fixturesRoot = null;
  } else {
    const root = effective.values.fixtures.root;
    fixturesRoot = { display: displayRoot(root), absolute: resolve(cwd, root) };
  }

  // A value from the file is relative to its directory, like fixtures.root; otherwise the working directory.
  const capturesPath = args.captures ?? effective.values.recording.captures;
  const capturesBase =
    args.captures === undefined && parsedFile?.recording?.captures !== undefined && file !== null
      ? dirname(file.absolute)
      : cwd;
  const captures: LocatedPath = { display: displayRoot(capturesPath), absolute: resolve(capturesBase, capturesPath) };

  // Runner.root as recording.captures; extraCaCerts against the file's directory.
  const requestsPath = args.requests ?? effective.values.runner.root;
  const requestsBase =
    args.requests === undefined && parsedFile?.runner?.root !== undefined && file !== null
      ? dirname(file.absolute)
      : cwd;
  const requests: LocatedPath = { display: displayRoot(requestsPath), absolute: resolve(requestsBase, requestsPath) };
  const caBase = file === null ? cwd : dirname(file.absolute);
  const extraCaCerts = effective.values.runner.extraCaCerts.map((path) => ({
    display: path,
    absolute: resolve(caBase, path),
  }));

  return { file, effective, fixturesRoot, captures, requests, extraCaCerts, errors, warnings, overrides };
}

/** True when a directory entry exists at `path`, even a symlink whose target is missing. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readText(file: LocatedPath, errors: StartupError[]): Promise<string | null> {
  const fail = (code: 'config-not-found' | 'config-unreadable', message: string): null => {
    errors.push({ code, source: 'config', path: file.display, message });
    return null;
  };
  // Check the type before opening: reading a FIFO or device would block
  // startup indefinitely instead of reporting the problem.
  try {
    const info = await stat(file.absolute);
    if (info.isDirectory()) return fail('config-unreadable', 'the configuration path is a directory, not a file');
    if (!info.isFile()) return fail('config-unreadable', 'the configuration path is not a regular file');
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return fail('config-not-found', 'the configuration file does not exist');
    return fail('config-unreadable', 'the configuration file cannot be read');
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(file.absolute);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return fail('config-not-found', 'the configuration file does not exist');
    if (code === 'EISDIR') return fail('config-unreadable', 'the configuration path is a directory, not a file');
    return fail('config-unreadable', 'the configuration file cannot be read');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('config-unreadable', 'the configuration file is not valid UTF-8');
  }
}

/** Relative to the working directory when the file is inside it; otherwise as given. */
function displayConfigPath(given: string, absolute: string, cwd: string): string {
  const fromCwd = relative(cwd, absolute);
  if (fromCwd !== '' && !fromCwd.startsWith('..') && !isAbsolute(fromCwd)) return fromCwd.split('\\').join('/');
  return given;
}

/** A fixture root as given, without a leading "./" or trailing "/" ("./data/" → "data"). */
function displayRoot(given: string): string {
  const trimmed = given.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return trimmed === '' ? (given.startsWith('/') ? '/' : '.') : trimmed;
}
