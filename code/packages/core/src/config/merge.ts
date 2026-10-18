import { toHex } from '../bytes.js';
import { CanonicalWriter, compareStrings } from '../canonical.js';
import { parseRfc3339 } from '../dynamic/time.js';
import { normalizeOriginEntry } from '../http/origin.js';
import { formatLatency, type LatencyProfile } from '../fixtures/latency.js';
import type { RecordingEndpoint } from '../recording/registrations.js';
import type { BuildSnapshotOptions } from '../types/index.js';
import type { ConfigLocations } from './parse.js';
import {
  CONFIG_DEFAULTS,
  type CompressionCoding,
  type ConfigFile,
  type ResolvedConfig,
  type SettingKey,
  type SettingValue,
} from './schema.js';

/** Values given as command-line flags. Only settings with a flag appear here. */
export interface ConfigOverrides {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly fixturesRoot?: string | undefined;
  /** `--seed`. */
  readonly seed?: number | undefined;
  /** `--now`, an RFC 3339 instant. */
  readonly now?: string | undefined;
  /** `--watch`: only ever true; absent leaves the file's value. */
  readonly watch?: boolean | undefined;
  /** `--no-ui`: only ever false; absent leaves the file's value. */
  readonly ui?: false | undefined;
  /** `--scenario`. */
  readonly scenario?: string | undefined;
  /** `--captures`. */
  readonly captures?: string | undefined;
  /** `--requests`. */
  readonly requests?: string | undefined;
}

export type SettingSource = 'default' | 'file' | 'cli';

/** One effective setting and where its value came from. */
export interface EffectiveSetting {
  readonly key: SettingKey;
  readonly value: SettingValue;
  readonly source: SettingSource;
  /** For `file`, where the value is written, when known. */
  readonly line?: number;
  readonly column?: number;
}

/** The configuration Janus actually runs with: defaults, then the file, then CLI flags. */
export interface EffectiveConfig {
  /** True when a configuration file was loaded (even an empty one). */
  readonly configFile: boolean;
  readonly values: ResolvedConfig;
  /** Every setting, sorted by key. */
  readonly settings: readonly EffectiveSetting[];
}

/** The engine's slice of the effective configuration. Core never sees host, port or paths. */
export interface EngineConfig {
  readonly strictTrailingSlash: boolean;
  readonly onUnknownMethod: 404 | 405;
  readonly mediaTypePreference: readonly string[];
  readonly onUnusableAccept: 400 | 'any';
  readonly onUnacceptable: 406 | 'ignore';
  /** False removes every `X-Mock-*` header Janus would add. */
  readonly diagnosticHeaders: boolean;
  /** `dynamic.now` in epoch milliseconds, or null for the injected wall clock. */
  readonly now: number | null;
  readonly clockMode: 'frozen' | 'offset';
  readonly timezone: string;
  /** Seed for generated values. Null renders with seed 0; the server always passes one. */
  readonly seed: number | null;
  readonly strictRefs: boolean;
  /** The scenario a request gets without a scenario header or pin. */
  readonly defaultScenario: string;
  /** `sessions.keyFrom`: `header.<name>` and `cookie.<name>` entries, in order. */
  readonly keyFrom: readonly string[];
  /** `sessions.idleTimeout`, in seconds. */
  readonly idleTimeout: number;
  /** `sessions.max`. */
  readonly maxSessions: number;
  readonly onNoFixture: 404 | 501;
  /** `header` lower-cased. */
  readonly idempotency: {
    readonly enabled: boolean;
    readonly header: string;
    readonly methods: readonly string[];
    readonly maxEntries: number;
  };
  /** The captures directory belongs to the server. */
  readonly recording: {
    readonly endpoints: readonly RecordingEndpoint[];
    readonly maxConcurrent: number;
    readonly timeoutMs: number;
    readonly maxResponseBytes: number;
  };
  /** `staged` or `auto`. */
  readonly promotionMode: 'staged' | 'auto';
  /** `server.autoOptions`. */
  readonly autoOptions: boolean;
  readonly faults: {
    readonly enabled: boolean;
    readonly timeoutMs: number;
    readonly maxHeldConnections: number;
    readonly latency: LatencyProfile | null;
  };
  readonly compression: {
    readonly enabled: boolean;
    readonly encodings: readonly CompressionCoding[];
    readonly minBytes: number;
  };
  /** `cors.fixtures`, origins normalized. */
  readonly fixtureCors: { readonly origins: readonly string[]; readonly credentials: boolean; readonly maxAge: number };
  /** `codecs.xml`. */
  readonly xml: boolean;
}

/** A setting as Atlas publishes it: no file positions, and never a path or bind detail. */
export interface PublicSetting {
  readonly key: SettingKey;
  readonly value: SettingValue;
  readonly source: SettingSource;
}

/**
 * Settings that describe where Janus runs rather than how it answers. They are
 * left out of the digest and never published over HTTP.
 */
export const PRIVATE_SETTINGS: ReadonlySet<SettingKey> = new Set(['fixtures.root', 'server.host', 'server.port']);

/**
 * Paths Atlas reports only as `"set"`, never by value, and which do not feed
 * the digest.
 */
export const PATH_SETTINGS: ReadonlySet<SettingKey> = new Set(['recording.captures']);

/**
 * Paths Atlas reports only as `"set"` that still feed the digest, like every
 * other runner setting.
 */
export const DIGESTED_PATH_SETTINGS: ReadonlySet<SettingKey> = new Set(['runner.root', 'runner.extraCaCerts']);

/** `recording.endpoints` as Atlas publishes it: one `METHOD path upstream` line per registration, in order. */
export function endpointLines(endpoints: readonly RecordingEndpoint[]): readonly string[] {
  return endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.upstream}`);
}

/**
 * Builds the effective configuration in one fixed order:
 * built-in defaults, then the file, then CLI flags. Every value records its source.
 */
export function mergeConfig(
  file: ConfigFile | undefined,
  overrides: ConfigOverrides,
  locations: ConfigLocations = {},
): EffectiveConfig {
  const fromFile: Readonly<Record<SettingKey, SettingValue | undefined>> = {
    'server.host': file?.server?.host,
    'server.port': file?.server?.port,
    'server.strictTrailingSlash': file?.server?.strictTrailingSlash,
    'server.autoOptions': file?.server?.autoOptions,
    'fixtures.root': file?.fixtures?.root,
    'fixtures.watch': file?.fixtures?.watch,
    onUnknownMethod: file?.onUnknownMethod,
    onNoFixture: file?.onNoFixture,
    'limits.maxUrlBytes': file?.limits?.maxUrlBytes,
    'limits.maxHeaderBytes': file?.limits?.maxHeaderBytes,
    'limits.maxBodyBytes': file?.limits?.maxBodyBytes,
    'limits.maxDecodedBodyBytes': file?.limits?.maxDecodedBodyBytes,
    'negotiation.mediaTypePreference': file?.negotiation?.mediaTypePreference,
    'negotiation.onUnusableAccept': file?.negotiation?.onUnusableAccept,
    'negotiation.onUnacceptable': file?.negotiation?.onUnacceptable,
    'diagnostics.headers': file?.diagnostics?.headers,
    'dynamic.now': file?.dynamic?.now,
    'dynamic.clockMode': file?.dynamic?.clockMode,
    'dynamic.timezone': file?.dynamic?.timezone,
    'dynamic.seed': file?.dynamic?.seed,
    'dynamic.strictRefs': file?.dynamic?.strictRefs,
    'dynamic.aliases': file?.dynamic?.aliases,
    'atlas.resolve': file?.atlas?.resolve,
    'ui.enabled': file?.ui?.enabled,
    'cors.origins': normalizeOrigins(file?.cors?.origins),
    'cors.maxAge': file?.cors?.maxAge,
    'cors.fixtures.origins': normalizeOrigins(file?.cors?.fixtures?.origins),
    'cors.fixtures.credentials': file?.cors?.fixtures?.credentials,
    'cors.fixtures.maxAge': file?.cors?.fixtures?.maxAge,
    'scenarios.default': file?.scenarios?.default,
    'sessions.keyFrom': file?.sessions?.keyFrom,
    'sessions.idleTimeout': file?.sessions?.idleTimeout,
    'sessions.max': file?.sessions?.max,
    'idempotency.enabled': file?.idempotency?.enabled,
    'idempotency.header': file?.idempotency?.header,
    'idempotency.methods': file?.idempotency?.methods,
    'idempotency.maxEntries': file?.idempotency?.maxEntries,
    'recording.endpoints':
      file?.recording?.endpoints === undefined ? undefined : endpointLines(file.recording.endpoints),
    'recording.captures': file?.recording?.captures,
    'recording.allowNonLoopback': file?.recording?.allowNonLoopback,
    'recording.maxConcurrent': file?.recording?.maxConcurrent,
    'recording.timeoutMs': file?.recording?.timeoutMs,
    'recording.maxResponseBytes': file?.recording?.maxResponseBytes,
    'promotion.mode': file?.promotion?.mode,
    'faults.enabled': file?.faults?.enabled,
    'faults.timeoutMs': file?.faults?.timeoutMs,
    'faults.maxHeldConnections': file?.faults?.maxHeldConnections,
    'faults.latency':
      file?.faults?.latency === undefined
        ? undefined
        : file.faults.latency === null
          ? null
          : formatLatency(file.faults.latency),
    'compression.enabled': file?.compression?.enabled,
    'compression.encodings': file?.compression?.encodings,
    'compression.minBytes': file?.compression?.minBytes,
    'codecs.xml': file?.codecs?.xml,
    'runner.root': file?.runner?.root,
    'runner.allowNonLoopback': file?.runner?.allowNonLoopback,
    'runner.maxActiveRuns': file?.runner?.maxActiveRuns,
    'runner.keepRuns': file?.runner?.keepRuns,
    'runner.scriptTimeoutMs': file?.runner?.scriptTimeoutMs,
    'runner.scriptMemoryBytes': file?.runner?.scriptMemoryBytes,
    'runner.maxImportBytes': file?.runner?.maxImportBytes,
    'runner.extraCaCerts': file?.runner?.extraCaCerts,
    'runner.skipTlsVerify': file?.runner?.skipTlsVerify,
  };
  const fromCli: Readonly<Partial<Record<SettingKey, SettingValue | undefined>>> = {
    'server.host': overrides.host,
    'server.port': overrides.port,
    'fixtures.root': overrides.fixturesRoot,
    'dynamic.seed': overrides.seed,
    'dynamic.now': overrides.now,
    'fixtures.watch': overrides.watch,
    'ui.enabled': overrides.ui,
    'scenarios.default': overrides.scenario,
    'recording.captures': overrides.captures,
    'runner.root': overrides.requests,
  };

  const settings: EffectiveSetting[] = [];
  const pick = <T extends SettingValue>(key: SettingKey, fallback: T): T => {
    const cli = fromCli[key];
    const filed = fromFile[key];
    let setting: EffectiveSetting;
    if (cli !== undefined) setting = { key, value: cli, source: 'cli' };
    else if (filed !== undefined) setting = { key, value: filed, source: 'file', ...locations[key] };
    else setting = { key, value: fallback, source: 'default' };
    settings.push(Object.freeze(setting));
    return setting.value as T;
  };

  const defaults = CONFIG_DEFAULTS;
  // Registrations have no flag: the setting records their text, `values` keeps the entries.
  pick<readonly string[]>('recording.endpoints', []);
  // The same for the server-wide latency profile: the setting is its text, `values` the profile.
  pick<string | null>('faults.latency', null);
  const values: ResolvedConfig = {
    server: {
      host: pick('server.host', defaults.server.host),
      port: pick('server.port', defaults.server.port),
      strictTrailingSlash: pick('server.strictTrailingSlash', defaults.server.strictTrailingSlash),
      autoOptions: pick('server.autoOptions', defaults.server.autoOptions),
    },
    fixtures: {
      root: pick('fixtures.root', defaults.fixtures.root),
      watch: pick('fixtures.watch', defaults.fixtures.watch),
    },
    onUnknownMethod: pick<404 | 405>('onUnknownMethod', defaults.onUnknownMethod),
    onNoFixture: pick<404 | 501>('onNoFixture', defaults.onNoFixture),
    limits: {
      maxUrlBytes: pick('limits.maxUrlBytes', defaults.limits.maxUrlBytes),
      maxHeaderBytes: pick('limits.maxHeaderBytes', defaults.limits.maxHeaderBytes),
      maxBodyBytes: pick('limits.maxBodyBytes', defaults.limits.maxBodyBytes),
      maxDecodedBodyBytes: pick('limits.maxDecodedBodyBytes', defaults.limits.maxDecodedBodyBytes),
    },
    negotiation: {
      mediaTypePreference: pick<readonly string[]>(
        'negotiation.mediaTypePreference',
        defaults.negotiation.mediaTypePreference,
      ),
      onUnusableAccept: pick<400 | 'any'>('negotiation.onUnusableAccept', defaults.negotiation.onUnusableAccept),
      onUnacceptable: pick<406 | 'ignore'>('negotiation.onUnacceptable', defaults.negotiation.onUnacceptable),
    },
    diagnostics: { headers: pick('diagnostics.headers', defaults.diagnostics.headers) },
    dynamic: {
      now: pick<string | null>('dynamic.now', defaults.dynamic.now),
      clockMode: pick<'frozen' | 'offset'>('dynamic.clockMode', defaults.dynamic.clockMode),
      timezone: pick('dynamic.timezone', defaults.dynamic.timezone),
      seed: pick<number | null>('dynamic.seed', defaults.dynamic.seed),
      strictRefs: pick('dynamic.strictRefs', defaults.dynamic.strictRefs),
      aliases: pick<Readonly<Record<string, string>>>('dynamic.aliases', defaults.dynamic.aliases),
    },
    atlas: { resolve: pick('atlas.resolve', defaults.atlas.resolve) },
    ui: { enabled: pick('ui.enabled', defaults.ui.enabled) },
    cors: {
      origins: pick<readonly string[]>('cors.origins', defaults.cors.origins),
      maxAge: pick('cors.maxAge', defaults.cors.maxAge),
      fixtures: {
        origins: pick<readonly string[]>('cors.fixtures.origins', defaults.cors.fixtures.origins),
        credentials: pick('cors.fixtures.credentials', defaults.cors.fixtures.credentials),
        maxAge: pick('cors.fixtures.maxAge', defaults.cors.fixtures.maxAge),
      },
    },
    scenarios: { default: pick('scenarios.default', defaults.scenarios.default) },
    sessions: {
      keyFrom: pick<readonly string[]>('sessions.keyFrom', defaults.sessions.keyFrom),
      idleTimeout: pick('sessions.idleTimeout', defaults.sessions.idleTimeout),
      max: pick('sessions.max', defaults.sessions.max),
    },
    idempotency: {
      enabled: pick('idempotency.enabled', defaults.idempotency.enabled),
      header: pick('idempotency.header', defaults.idempotency.header),
      methods: pick<readonly string[]>('idempotency.methods', defaults.idempotency.methods),
      maxEntries: pick('idempotency.maxEntries', defaults.idempotency.maxEntries),
    },
    recording: {
      endpoints: file?.recording?.endpoints ?? defaults.recording.endpoints,
      captures: pick('recording.captures', defaults.recording.captures),
      allowNonLoopback: pick('recording.allowNonLoopback', defaults.recording.allowNonLoopback),
      maxConcurrent: pick('recording.maxConcurrent', defaults.recording.maxConcurrent),
      timeoutMs: pick('recording.timeoutMs', defaults.recording.timeoutMs),
      maxResponseBytes: pick('recording.maxResponseBytes', defaults.recording.maxResponseBytes),
    },
    promotion: { mode: pick<'staged' | 'auto'>('promotion.mode', defaults.promotion.mode) },
    faults: {
      enabled: pick('faults.enabled', defaults.faults.enabled),
      timeoutMs: pick('faults.timeoutMs', defaults.faults.timeoutMs),
      maxHeldConnections: pick('faults.maxHeldConnections', defaults.faults.maxHeldConnections),
      latency: file?.faults?.latency ?? defaults.faults.latency,
    },
    compression: {
      enabled: pick('compression.enabled', defaults.compression.enabled),
      encodings: pick<readonly CompressionCoding[]>('compression.encodings', defaults.compression.encodings),
      minBytes: pick('compression.minBytes', defaults.compression.minBytes),
    },
    codecs: { xml: pick('codecs.xml', defaults.codecs.xml) },
    runner: {
      root: pick('runner.root', defaults.runner.root),
      allowNonLoopback: pick('runner.allowNonLoopback', defaults.runner.allowNonLoopback),
      maxActiveRuns: pick('runner.maxActiveRuns', defaults.runner.maxActiveRuns),
      keepRuns: pick('runner.keepRuns', defaults.runner.keepRuns),
      scriptTimeoutMs: pick('runner.scriptTimeoutMs', defaults.runner.scriptTimeoutMs),
      scriptMemoryBytes: pick('runner.scriptMemoryBytes', defaults.runner.scriptMemoryBytes),
      maxImportBytes: pick('runner.maxImportBytes', defaults.runner.maxImportBytes),
      extraCaCerts: pick<readonly string[]>('runner.extraCaCerts', defaults.runner.extraCaCerts),
      skipTlsVerify: pick('runner.skipTlsVerify', defaults.runner.skipTlsVerify),
    },
  };
  settings.sort((a, b) => compareStrings(a.key, b.key));
  return deepFreeze({ configFile: file !== undefined, values, settings });
}

/**
 * `cfg_` + 64 bits of a domain-tagged SHA-256 over the behaviour-affecting
 * settings. Sources, formatting and the private settings do not
 * count: two servers with one digest answer the same fixtures the same way.
 */
export function configDigest(config: EffectiveConfig): string {
  const writer = new CanonicalWriter().string('janus-config/1');
  const included = config.settings.filter(
    (setting) => !PRIVATE_SETTINGS.has(setting.key) && !PATH_SETTINGS.has(setting.key),
  );
  writer.number(included.length);
  for (const { key, value } of included) {
    writer.string(key);
    if (value === null) {
      writer.string('null');
    } else if (isList(value)) {
      writer.string('list').number(value.length);
      for (const item of value) writer.string(item);
    } else if (typeof value === 'object') {
      const names = Object.keys(value).sort(compareStrings);
      writer.string('map').number(names.length);
      for (const name of names) writer.string(name).string(value[name] ?? '');
    } else {
      writer.string(typeof value).string(String(value));
    }
  }
  return `cfg_${toHex(writer.digest()).slice(0, 16)}`;
}

export function engineConfig(config: EffectiveConfig): EngineConfig {
  return {
    strictTrailingSlash: config.values.server.strictTrailingSlash,
    onUnknownMethod: config.values.onUnknownMethod,
    mediaTypePreference: config.values.negotiation.mediaTypePreference,
    onUnusableAccept: config.values.negotiation.onUnusableAccept,
    onUnacceptable: config.values.negotiation.onUnacceptable,
    diagnosticHeaders: config.values.diagnostics.headers,
    now: config.values.dynamic.now === null ? null : parseRfc3339(config.values.dynamic.now),
    clockMode: config.values.dynamic.clockMode,
    timezone: config.values.dynamic.timezone,
    seed: config.values.dynamic.seed,
    strictRefs: config.values.dynamic.strictRefs,
    defaultScenario: config.values.scenarios.default,
    keyFrom: config.values.sessions.keyFrom,
    idleTimeout: config.values.sessions.idleTimeout,
    maxSessions: config.values.sessions.max,
    onNoFixture: config.values.onNoFixture,
    idempotency: {
      enabled: config.values.idempotency.enabled,
      header: config.values.idempotency.header.toLowerCase(),
      methods: config.values.idempotency.methods,
      maxEntries: config.values.idempotency.maxEntries,
    },
    recording: {
      endpoints: config.values.recording.endpoints,
      maxConcurrent: config.values.recording.maxConcurrent,
      timeoutMs: config.values.recording.timeoutMs,
      maxResponseBytes: config.values.recording.maxResponseBytes,
    },
    promotionMode: config.values.promotion.mode,
    autoOptions: config.values.server.autoOptions,
    faults: config.values.faults,
    compression: config.values.compression,
    fixtureCors: config.values.cors.fixtures,
    xml: config.values.codecs.xml,
  };
}

/** What `buildSnapshot` needs from the configuration: the custom aliases tokens may name. */
export function snapshotOptions(config: EffectiveConfig): BuildSnapshotOptions {
  return {
    aliases: config.values.dynamic.aliases,
    defaultScenario: config.values.scenarios.default,
    fixtureCors: config.values.cors.fixtures.origins.length > 0,
  };
}

/**
 * `cors.origins` as Janus uses it: each entry normalized, in
 * the order written, without repeats. Validation has already rejected the rest.
 */
function normalizeOrigins(origins: readonly string[] | undefined): readonly string[] | undefined {
  return origins === undefined ? undefined : [...new Set(origins.map(normalizeOriginEntry))];
}

export function isList(value: SettingValue): value is readonly string[] {
  return Array.isArray(value);
}

/** The settings Atlas may publish, sorted by key, without positions or private settings. */
export function publicSettings(config: EffectiveConfig): readonly PublicSetting[] {
  return Object.freeze(
    config.settings
      .filter((setting) => !PRIVATE_SETTINGS.has(setting.key))
      .map(({ key, value, source }) =>
        Object.freeze({ key, value: PATH_SETTINGS.has(key) || reportedAsSet(key, value) ? 'set' : value, source }),
      ),
  );
}

/** A runner path, or a non-empty list of them, is published as `"set"`. */
function reportedAsSet(key: SettingKey, value: SettingValue): boolean {
  return DIGESTED_PATH_SETTINGS.has(key) && !(isList(value) && value.length === 0);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
