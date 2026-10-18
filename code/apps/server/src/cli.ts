import { parseArgs } from 'node:util';

import { CONFIG_DEFAULTS, isScenarioName, isValidHost, MAX_SEED, parseInstant, type StartupError } from '@janus/core';

export const DEFAULT_DATA = CONFIG_DEFAULTS.fixtures.root;
export const DEFAULT_HOST = CONFIG_DEFAULTS.server.host;
export const DEFAULT_PORT = CONFIG_DEFAULTS.server.port;
/** The only configuration file name Janus discovers. */
export const CONFIG_FILE_NAME = 'janus.config.yaml';

export const USAGE = `Usage: janus serve [--config <path> | --no-config] [--data <path>] [--host <address>] [--port <integer>]
                   [--seed <integer>] [--now <instant>] [--scenario <name>] [--captures <path>]
                   [--requests <path>] [--watch] [--no-ui]
       janus validate [--config <path> | --no-config] [--data <path>] [--seed <integer>] [--now <instant>]
                      [--scenario <name>] [--captures <path>] [--requests <path>] [--no-ui] [--strict]
                      [--require-reviewed] [--format text|json]
       janus run <id> (--mock | --upstream | --record) [--env <name>] [--scenario <name>] [--var <name>=<value>]...
                 [--reporter text|json|junit] [--config <path> | --no-config] [--data <path>]
                 [--requests <path>] [--captures <path>]
       janus import <file-or-folder>... [--into <collection>] [--replace] [--preview] [--include-static]
                    [--origin <origin>]... [--config <path> | --no-config] [--requests <path>]

Serve deterministic HTTP responses from a fixture directory.

Commands:
  serve               Validate the configuration and fixtures, then start the mock server
  validate            Validate the configuration, fixtures and request files without binding a port
  run                 Run a request, folder or collection from the request files (no port is bound)
  import              Convert a Postman, Bruno, Charles or HAR export into a request collection

Options:
  --config <path>     Configuration file (default: ./${CONFIG_FILE_NAME} when it exists)
  --no-config         Ignore any configuration file; use defaults and flags only
  --data <path>       Fixture root directory (default: ${DEFAULT_DATA}), relative to the working directory
  --host <address>    Address to bind (default: ${DEFAULT_HOST}, loopback only)
  --port <integer>    Port to bind, 0-65535; 0 picks a free port (default: ${String(DEFAULT_PORT)})
  --seed <integer>    Seed for generated dynamic values, 0-${String(MAX_SEED)} (default: picked at startup)
  --now <instant>     Instant dynamic values render against, RFC 3339 (default: the wall clock)
  --scenario <name>   Scenario served when a request names none (default: default)
  --captures <path>   Where recorded exchanges are written (default: ${CONFIG_DEFAULTS.recording.captures}), relative to the working directory
  --requests <path>   Request files for the runner (default: ${CONFIG_DEFAULTS.runner.root}), relative to the working directory
  --watch             serve: reload when fixture files change (default: off)
  --no-ui             Do not serve the Atlas UI at /_janus/ui/ (sets ui.enabled: false)
  --strict            validate: also fail on warnings
  --require-reviewed  validate: fail while any promoted file is pending review
  --format text|json  validate: report format (default: text)
  --mock, --upstream, --record
                      run: answer from the fixtures, send to the real URLs, or send and capture (one is required)
  --env <name>        run: the collection environment to use
  --var <name>=<value>  run: a starting run variable; repeatable
  --reporter <kind>   run: text, json or junit (default: text)
  --into <collection> import: the collection directory name (default: from the source)
  --replace           import: replace the collection when it exists
  --preview           import: report what would be written, write nothing
  --include-static    import: keep static assets from Charles and HAR sessions
  --origin <origin>   import: only this origin from Charles and HAR sessions; repeatable
  -h, --help          Show this help

Flags override the configuration file, which overrides the defaults.
`;

/** Options shared by `serve` and `validate`. Unset options are absent, so the file and defaults can apply. */
export interface CommonArgs {
  readonly config?: string;
  readonly noConfig: boolean;
  readonly data?: string;
  readonly host?: string;
  readonly port?: number;
  readonly seed?: number;
  readonly now?: string;
  /** `--scenario`: sets `scenarios.default`. */
  readonly scenario?: string;
  /** `--captures`: sets `recording.captures`. */
  readonly captures?: string;
  /** `--requests`: sets `runner.root`. */
  readonly requests?: string;
  /** `serve --watch`: only ever true; absent leaves `fixtures.watch` to the file. */
  readonly watch?: true;
  /** `--no-ui`: sets `ui.enabled: false` for both commands. */
  readonly noUi?: true;
}

export type ServeArgs = CommonArgs;

export interface ValidateArgs extends CommonArgs {
  readonly strict: boolean;
  /** Each promoted file pending review is the error `promotion-unreviewed`. */
  readonly requireReviewed: boolean;
  readonly format: 'text' | 'json';
}

/** `janus run`. */
export interface RunArgs extends CommonArgs {
  readonly target: string;
  readonly mode: 'mock' | 'upstream' | 'record';
  readonly environment?: string;
  readonly vars: Readonly<Record<string, string>>;
  readonly reporter: 'text' | 'json' | 'junit';
}

/** `janus import`. */
export interface ImportArgs extends CommonArgs {
  readonly sources: readonly string[];
  readonly into?: string;
  readonly replace: boolean;
  readonly preview: boolean;
  readonly includeStatic: boolean;
  readonly origins: readonly string[];
}

export type ParsedCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'run'; readonly args: RunArgs }
  | { readonly kind: 'import'; readonly args: ImportArgs }
  | { readonly kind: 'serve'; readonly args: ServeArgs }
  | { readonly kind: 'validate'; readonly args: ValidateArgs }
  | {
      readonly kind: 'usage-error';
      readonly message: string;
      /** Set when the usage error is also a startup error, e.g. `cli-conflict`. */
      readonly error?: StartupError;
      /** The requested `validate --format`, so a usage error can still be reported as JSON. */
      readonly format?: 'text' | 'json';
    };

/** Parses `janus` command-line arguments. Never throws. */
export function parseCommand(argv: readonly string[]): ParsedCommand {
  const [command, ...rest] = argv;
  if (command === undefined) return { kind: 'usage-error', message: 'missing command' };
  if (command === '--help' || command === '-h' || command === 'help') return { kind: 'help' };
  if (command === 'run') return parseRun(rest);
  if (command === 'import') return parseImport(rest);
  if (command !== 'serve' && command !== 'validate') {
    return { kind: 'usage-error', message: `unknown command "${command}"` };
  }
  const validate = command === 'validate';

  let values: {
    config?: string | undefined;
    'no-config'?: boolean | undefined;
    data?: string | undefined;
    host?: string | undefined;
    port?: string | undefined;
    seed?: string | undefined;
    now?: string | undefined;
    scenario?: string | undefined;
    captures?: string | undefined;
    requests?: string | undefined;
    strict?: boolean | undefined;
    'require-reviewed'?: boolean | undefined;
    format?: string | undefined;
    watch?: boolean | undefined;
    'no-ui'?: boolean | undefined;
    help?: boolean | undefined;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      strict: true,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        'no-config': { type: 'boolean' },
        data: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
        seed: { type: 'string' },
        now: { type: 'string' },
        scenario: { type: 'string' },
        captures: { type: 'string' },
        requests: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        strict: { type: 'boolean' },
        'require-reviewed': { type: 'boolean' },
        format: { type: 'string' },
        watch: { type: 'boolean' },
        'no-ui': { type: 'boolean' },
      },
    }));
  } catch (error) {
    return { kind: 'usage-error', message: error instanceof Error ? error.message : 'invalid arguments' };
  }
  if (values.help === true) return { kind: 'help' };
  if (!validate) {
    const only =
      values.strict !== undefined
        ? 'strict'
        : values['require-reviewed'] !== undefined
          ? 'require-reviewed'
          : values.format !== undefined
            ? 'format'
            : null;
    if (only !== null) return { kind: 'usage-error', message: `option --${only} applies only to validate` };
  }
  if (positionals.length > 0) return { kind: 'usage-error', message: `unexpected argument "${positionals[0] ?? ''}"` };

  for (const name of [
    'config',
    'data',
    'host',
    'port',
    'seed',
    'now',
    'scenario',
    'captures',
    'requests',
    'format',
  ] as const) {
    const value = values[name];
    if (value !== undefined && (value === '' || value.startsWith('-'))) {
      return { kind: 'usage-error', message: `option --${name} needs a value` };
    }
  }

  const requested = values.format ?? 'text';
  if (requested !== 'text' && requested !== 'json') {
    return { kind: 'usage-error', message: `invalid format "${requested}"; expected text or json` };
  }
  const format: 'text' | 'json' = requested;
  const withFormat = validate ? { format } : {};
  if (validate && values.watch !== undefined) {
    return { kind: 'usage-error', message: 'option --watch applies only to serve', format };
  }

  if (values.config !== undefined && values['no-config'] === true) {
    const message = '--config and --no-config cannot be combined';
    return {
      kind: 'usage-error',
      message,
      error: { code: 'cli-conflict', source: 'cli', path: '--no-config', token: '--no-config', message },
      ...withFormat,
    };
  }

  let port: number | undefined;
  if (values.port !== undefined) {
    const parsed = parsePort(values.port);
    if (parsed === null) {
      return {
        kind: 'usage-error',
        message: `invalid port "${values.port}"; expected an integer 0-65535`,
        ...withFormat,
      };
    }
    port = parsed;
  }
  let seed: number | undefined;
  if (values.seed !== undefined) {
    seed = /^\d{1,10}$/.test(values.seed) ? Number(values.seed) : Number.NaN;
    if (!(seed <= MAX_SEED)) {
      return {
        kind: 'usage-error',
        message: `invalid seed "${values.seed}"; expected an integer 0-${String(MAX_SEED)}`,
        ...withFormat,
      };
    }
  }
  if (values.now !== undefined && parseInstant(values.now) === null) {
    return {
      kind: 'usage-error',
      message: `invalid instant "${values.now}"; expected RFC 3339 with an offset, e.g. 2026-01-01T00:00:00Z`,
      ...withFormat,
    };
  }
  if (values.scenario !== undefined && !isScenarioName(values.scenario)) {
    return {
      kind: 'usage-error',
      message: `invalid scenario "${values.scenario}"; expected lowercase letters and digits in words joined by "-"`,
      ...withFormat,
    };
  }
  if (values.host !== undefined && !isValidHost(values.host)) {
    return {
      kind: 'usage-error',
      message: `invalid host "${values.host}"; expected a host name or IP address`,
      ...withFormat,
    };
  }

  const args: CommonArgs = {
    noConfig: values['no-config'] === true,
    ...(values.config === undefined ? {} : { config: values.config }),
    ...(values.data === undefined ? {} : { data: values.data }),
    ...(values.host === undefined ? {} : { host: values.host }),
    ...(port === undefined ? {} : { port }),
    ...(seed === undefined ? {} : { seed }),
    ...(values.now === undefined ? {} : { now: values.now }),
    ...(values.scenario === undefined ? {} : { scenario: values.scenario }),
    ...(values.captures === undefined ? {} : { captures: values.captures }),
    ...(values.requests === undefined ? {} : { requests: values.requests }),
    ...(values['no-ui'] === true ? { noUi: true as const } : {}),
  };
  if (!validate) return { kind: 'serve', args: values.watch === true ? { ...args, watch: true } : args };
  return {
    kind: 'validate',
    args: { ...args, strict: values.strict === true, requireReviewed: values['require-reviewed'] === true, format },
  };
}

function parsePort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port <= 65535 ? port : null;
}

type Usage = Extract<ParsedCommand, { kind: 'usage-error' }>;

/** The options `run` and `import` share with `serve`: the configuration and the directories. */
function commonPaths(values: {
  config?: string | undefined;
  'no-config'?: boolean | undefined;
  data?: string | undefined;
  requests?: string | undefined;
  captures?: string | undefined;
}): CommonArgs | Usage {
  for (const name of ['config', 'data', 'requests', 'captures'] as const) {
    const value = values[name];
    if (value !== undefined && (value === '' || value.startsWith('-'))) {
      return { kind: 'usage-error', message: `option --${name} needs a value` };
    }
  }
  if (values.config !== undefined && values['no-config'] === true) {
    const message = '--config and --no-config cannot be combined';
    return {
      kind: 'usage-error',
      message,
      error: { code: 'cli-conflict', source: 'cli', path: '--no-config', token: '--no-config', message },
    };
  }
  return {
    noConfig: values['no-config'] === true,
    // Run and import never serve the UI.
    noUi: true,
    ...(values.config === undefined ? {} : { config: values.config }),
    ...(values.data === undefined ? {} : { data: values.data }),
    ...(values.requests === undefined ? {} : { requests: values.requests }),
    ...(values.captures === undefined ? {} : { captures: values.captures }),
  };
}

/** `janus run <id> (--mock | --upstream | --record) …`. */
function parseRun(argv: readonly string[]): ParsedCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        'no-config': { type: 'boolean' },
        data: { type: 'string' },
        requests: { type: 'string' },
        captures: { type: 'string' },
        env: { type: 'string' },
        record: { type: 'boolean' },
        mock: { type: 'boolean' },
        upstream: { type: 'boolean' },
        scenario: { type: 'string' },
        var: { type: 'string', multiple: true },
        reporter: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    return { kind: 'usage-error', message: error instanceof Error ? error.message : 'invalid arguments' };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help' };
  const [target, ...extra] = positionals;
  if (target === undefined)
    return { kind: 'usage-error', message: 'run needs the ID of a request, folder or collection' };
  if (extra.length > 0) return { kind: 'usage-error', message: `unexpected argument "${extra[0] ?? ''}"` };
  const modes = (['mock', 'upstream', 'record'] as const).filter((mode) => values[mode] === true);
  const [mode] = modes;
  if (mode === undefined || modes.length > 1) {
    return { kind: 'usage-error', message: 'run needs exactly one of --mock, --upstream or --record' };
  }
  const reporter = values.reporter ?? 'text';
  if (reporter !== 'text' && reporter !== 'json' && reporter !== 'junit') {
    return { kind: 'usage-error', message: `invalid reporter "${reporter}"; expected text, json or junit` };
  }
  if (values.scenario !== undefined && !isScenarioName(values.scenario)) {
    return { kind: 'usage-error', message: `invalid scenario "${values.scenario}"` };
  }
  const vars: Record<string, string> = {};
  for (const entry of values.var ?? []) {
    const equals = entry.indexOf('=');
    if (equals <= 0) return { kind: 'usage-error', message: `invalid --var "${entry}"; expected <name>=<value>` };
    vars[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  const common = commonPaths(values);
  if ('kind' in common) return common;
  return {
    kind: 'run',
    args: {
      ...common,
      target,
      mode,
      ...(values.env === undefined ? {} : { environment: values.env }),
      ...(values.scenario === undefined ? {} : { scenario: values.scenario }),
      vars,
      reporter,
    },
  };
}

/** `janus import <file-or-folder>… …`. */
function parseImport(argv: readonly string[]): ParsedCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        'no-config': { type: 'boolean' },
        requests: { type: 'string' },
        into: { type: 'string' },
        replace: { type: 'boolean' },
        preview: { type: 'boolean' },
        'include-static': { type: 'boolean' },
        origin: { type: 'string', multiple: true },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    return { kind: 'usage-error', message: error instanceof Error ? error.message : 'invalid arguments' };
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help' };
  if (positionals.length === 0) return { kind: 'usage-error', message: 'import needs a file or folder to import' };
  const common = commonPaths(values);
  if ('kind' in common) return common;
  return {
    kind: 'import',
    args: {
      ...common,
      sources: positionals,
      ...(values.into === undefined ? {} : { into: values.into }),
      replace: values.replace === true,
      preview: values.preview === true,
      includeStatic: values['include-static'] === true,
      origins: values.origin ?? [],
    },
  };
}
