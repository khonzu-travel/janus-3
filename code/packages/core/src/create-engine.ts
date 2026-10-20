import { createAtlas, explainResponse, type AtlasDiagnostics, type AtlasProjection } from './atlas/index.js';
import type { Atlas } from './atlas/types.js';
import { configDigest, mergeConfig, publicSettings, type EngineConfig } from './config/merge.js';
import type { ConfigFile } from './config/schema.js';
import { createEngineClock } from './dynamic/clock.js';
import { rfc3339 } from './dynamic/time.js';
import { snapshotData, type SnapshotData } from './fixtures/snapshot.js';
import { resolveSessionKey } from './http/session.js';
import {
  DEFAULT_ENGINE_CONFIG,
  resolveWithEffects,
  type DynamicRuntime,
  type Resolution,
  type ResolveMode,
  type SessionReader,
} from './resolve/resolve.js';
import { record, type Recorder } from './recording/record.js';
import type { CaptureReservation, RecordingPorts } from './recording/ports.js';
import { registrationsOf } from './recording/registrations.js';
import { RecordingSlots } from './recording/slots.js';
import { createPromoter, type EnginePromotions, type PromotionPorts } from './promotion/promoter.js';
import { promotionBodyLimit } from './promotion/request.js';
import { describeSession, resetSequences, stillCurrent, writeSession, type SessionContext } from './sessions/api.js';
import { SESSION_CLOCK_OVERRUN, sessionInstant, SessionStore } from './sessions/store.js';
import type {
  Engine,
  FixtureSnapshot,
  ReplaceSnapshotOptions,
  RequestDescription,
  ResolveOptions,
  ResponseDescription,
  TransportCapacity,
} from './types/index.js';

export interface CreateEngineOptions {
  /** A validated snapshot from `buildSnapshot`, served until `replaceSnapshot` swaps in another. */
  readonly snapshot: FixtureSnapshot;
  /** How requests resolve. Each omitted setting takes its default. */
  readonly config?: Partial<EngineConfig>;
  /**
   * What Atlas reports about the configuration: the digest, the published
   * settings and startup warnings. Defaults to a description of `config` with
   * no file and no warnings.
   */
  readonly diagnostics?: AtlasDiagnostics;
  /**
   * The wall clock, in epoch milliseconds. Core never reads time
   * itself: without it, dynamic fixtures render only against `nowMs`,
   * `X-Mock-Now` or `dynamic.now`, and otherwise fail with `render-failed`.
   */
  readonly clock?: () => number;
  /** The entropy source for `:unique` tokens only. Without it, such tokens fail with `render-failed`. */
  readonly randomBytes?: (count: number) => Uint8Array;
  /** Where `config.seed` came from, for `GET /_janus/clock`. Defaults to `config`. */
  readonly seedSource?: 'config' | 'cli' | 'generated';
  /**
   * The upstream and capture sink recording uses. Without them
   * a request that would be recorded is `501 recording-unavailable`.
   */
  readonly recording?: RecordingPorts;
  /**
   * The fixture writer, capture reader and reload promotion uses. Without them, or without registrations, promotion is
   * `501 promotion-unavailable`.
   */
  readonly promotion?: PromotionPorts;
  /**
   * The request runner writes captures, so promotion is
   * available without recording registrations.
   */
  readonly runnerCaptures?: boolean;
  /**
   * The adapter's held-connection limit. Without it, a `timeout`
   * fault is never refused for capacity.
   */
  readonly transport?: TransportCapacity;
}

/** Everything one snapshot needs to serve and explain: replaced as a whole, never in parts. */
interface ActiveState {
  readonly summary: FixtureSnapshot;
  readonly data: SnapshotData;
  readonly atlas: AtlasProjection;
}

/**
 * Creates an engine over an immutable fixture snapshot. Resolution never
 * touches I/O or shared mutable state. The only mutable thing is which
 * snapshot is active: each request, Atlas read and `explain`
 * call reads it once at its start and finishes on it, so none sees a mix.
 */
export function createEngine(options: CreateEngineOptions): Engine {
  const config: EngineConfig = Object.freeze({ ...DEFAULT_ENGINE_CONFIG, ...options.config });
  // Fails now, not on the first recorded request, for registrations that were never validated.
  const registrations = registrationsOf(config.recording.endpoints);
  const seedSource = options.seedSource ?? 'config';
  const runtime: DynamicRuntime = Object.freeze({
    clock: createEngineClock({ now: config.now, clockMode: config.clockMode }, options.clock),
    randomBytes: options.randomBytes,
  });
  const dynamic = { config, runtime, seedSource };
  let diagnostics = options.diagnostics ?? describeEngineConfig(config, seedSource);
  const activate = (summary: FixtureSnapshot): ActiveState => {
    const data = snapshotData(summary);
    return Object.freeze({ summary, data, atlas: createAtlas(summary, data, diagnostics, dynamic) });
  };
  let active = activate(options.snapshot);
  // Sessions belong to the engine, not to a snapshot: a reload keeps them.
  const now = options.clock ?? (() => 0);
  const store = new SessionStore({
    idleTimeoutMs: config.idleTimeout * 1000,
    max: config.maxSessions,
    now,
    randomBytes: options.randomBytes,
  });
  /** Real requests expire what they find; simulations only look. */
  const serving: SessionReader = Object.freeze({
    read: (id: string) => store.get(id),
    now,
    position: (id: string, key: string) => store.position(id, key),
    replay: (id: string, key: string) => store.replay(id, key),
  });
  const simulating: SessionReader = Object.freeze({
    read: (id: string) => store.peek(id),
    now,
    position: (id: string, key: string) => store.position(id, key),
    replay: (id: string, key: string) => store.replay(id, key),
  });
  const promoter = createPromoter({
    ports: options.promotion,
    recording: registrations.length > 0 || options.runnerCaptures === true,
    mode: config.promotionMode,
    snapshot: () => active.data,
    items: () => active.atlas.promotions().items,
    clock: options.clock ?? (() => 0),
    defaultScenario: () => config.defaultScenario,
    bodyLimit: promotionBodyLimit(config.recording.maxResponseBytes),
  });
  const recorder: Recorder = {
    ports: options.recording,
    config,
    clock: options.clock ?? (() => 0),
    slots: new RecordingSlots(config.recording.maxConcurrent),
    // Promote each successful capture before its response is relayed.
    ...(config.promotionMode === 'auto' && promoter.available
      ? { promote: (reservation: CaptureReservation) => promoter.auto(reservation) }
      : {}),
  };
  const sessionContext = (): SessionContext => ({ store, snapshot: active.data, config, now });

  const settle = <T>(signal: AbortSignal | undefined, run: () => T): Promise<T> => {
    try {
      signal?.throwIfAborted();
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('resolve failed', { cause: error }));
    }
  };
  const resolveOn = (
    state: ActiveState,
    request: RequestDescription,
    reader: SessionReader,
    mode: ResolveMode,
  ): Resolution => resolveWithEffects(state.data, request, config, runtime, reader, mode, options.transport);

  const atlas: Atlas = Object.freeze({
    health: () => active.atlas.health(),
    config: () => active.atlas.config(),
    inventory: ((scenario?: string) =>
      scenario === undefined ? active.atlas.inventory() : active.atlas.inventory(scenario)) as Atlas['inventory'],
    scenarios: () => active.atlas.scenarios(),
    endpoint: (id: string, at: string) => active.atlas.endpoint(id, at),
    fixture: (id: string, at: string) => active.atlas.fixture(id, at),
    renderedFixture: (...args: Parameters<Atlas['renderedFixture']>) => active.atlas.renderedFixture(...args),
    clock: (headers: Parameters<Atlas['clock']>[0]) => {
      const key = resolveSessionKey(headers, config.keyFrom);
      if (!key.ok) return { kind: 'bad-input' as const, message: key.reason };
      const id = key.key.id;
      const clock = id === null ? null : (store.get(id)?.clock ?? null);
      const shown = clock === null ? null : sessionInstant(clock, now());
      if (shown?.overrun === true) return { kind: 'bad-input' as const, message: SESSION_CLOCK_OVERRUN };
      return active.atlas.clock(headers, {
        id,
        clock: clock === null || shown === null ? null : { instant: shown.instant, mode: clock.mode },
      });
    },
    recording: () =>
      Object.freeze({
        available: options.recording !== undefined,
        endpoints: Object.freeze(
          registrations.map((registration) =>
            Object.freeze({
              method: registration.endpoint.method,
              path: registration.endpoint.path,
              upstream: registration.endpoint.upstream,
            }),
          ),
        ),
        timeoutMs: config.recording.timeoutMs,
        maxResponseBytes: config.recording.maxResponseBytes,
        maxConcurrent: config.recording.maxConcurrent,
      }),
    promotions: () => active.atlas.promotions(),
    promotedTo: (capture: string) => active.atlas.promotedTo(capture),
    promotion: () =>
      Object.freeze({
        available: promoter.available,
        mode: config.promotionMode,
        pending: active.data.provenance.filter((record) => record.entry.review === 'pending').length,
      }),
    explain: (request: RequestDescription, resolveOptions?: ResolveOptions) => {
      // Held for the whole call: a swap during it does not change the answer.
      const state = active;
      return settle(resolveOptions?.signal, () =>
        explainResponse(resolveOn(state, request, simulating, 'simulate').response, state.atlas, request),
      );
    },
    explainServed: (request: RequestDescription, response: ResponseDescription) => ({
      ...explainResponse(response, active.atlas, request),
      notes: [],
    }),
  });

  const engine: Engine = {
    atlas,
    resolve: async (request, resolveOptions) => {
      const state = active;
      const signal = resolveOptions?.signal;
      let forward: Resolution['forward'];
      const resolved = await settle(signal, (): ResponseDescription => {
        const resolution = resolveOn(state, request, serving, 'serve');
        const { response, effects } = resolution;
        forward = resolution.forward;
        // The session changes a served request makes, after it resolved.
        for (const effect of effects) {
          if (effect.kind === 'advance') store.setPosition(effect.session, effect.key, effect.position);
          else store.storeReplay(effect.session, effect.key, effect.record, effect.max);
        }
        const id = response.trace.session?.id;
        if (id !== undefined && id !== null) store.touch(id);
        return response;
      });
      // A recorded request leaves every sequence and replay record alone.
      return forward === undefined ? resolved : record(recorder, forward, signal ?? NEVER_ABORTED);
    },
    sessions: Object.freeze({
      describe: (headers: Parameters<Engine['sessions']['describe']>[0]) => describeSession(sessionContext(), headers),
      write: (...args: Parameters<Engine['sessions']['write']>) => writeSession(sessionContext(), ...args),
      resetSequences: (headers: Parameters<Engine['sessions']['resetSequences']>[0], endpoint: string | null) =>
        resetSequences(sessionContext(), headers, endpoint),
      touch: (headers: Parameters<Engine['sessions']['touch']>[0]) => {
        const key = resolveSessionKey(headers, config.keyFrom);
        if (key.ok && key.key.id !== null) store.touch(key.key.id);
      },
    }),
    promotions: Object.freeze({
      bodyLimit: promoter.bodyLimit,
      promote: (...args: Parameters<EnginePromotions['promote']>) => promoter.promote(...args),
      review: (...args: Parameters<EnginePromotions['review']>) => promoter.review(...args),
      createScenario: (...args: Parameters<EnginePromotions['createScenario']>) => promoter.createScenario(...args),
      subscribe: (...args: Parameters<EnginePromotions['subscribe']>) => promoter.subscribe(...args),
    }),
    planDelay: (request) => resolveOn(active, request, simulating, 'plan').response.transport?.delayMs ?? 0,
    checkHead: (request) => {
      const resolution = resolveOn(active, request, simulating, 'head');
      return resolution.headPassed === true ? null : resolution.response;
    },
    recordingSlots: recorder.slots,
    snapshot: () => active.summary,
    replaceSnapshot: (snapshot: FixtureSnapshot, replaceOptions?: ReplaceSnapshotOptions) => {
      // Validate before touching anything, so a foreign snapshot cannot leave a half-applied state.
      snapshotData(snapshot);
      const previous = active;
      if (replaceOptions?.warnings !== undefined) {
        diagnostics = { ...diagnostics, warnings: replaceOptions.warnings };
      }
      // An unchanged version keeps the snapshot object; only the warnings Atlas reports are refreshed.
      const next = snapshot.version === previous.summary.version ? previous.summary : snapshot;
      active = activate(next);
      store.retainPositions((position) => stillCurrent(active.data, position));
      return previous.summary.version;
    },
  };
  return Object.freeze(engine);
}

/** For requests the transport never cancels. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

function describeEngineConfig(
  runtimeConfig: EngineConfig,
  seedSource: NonNullable<CreateEngineOptions['seedSource']>,
): AtlasDiagnostics {
  // A generated seed affects rendered bytes for this run, but it is runtime
  // state rather than configuration. Atlas reports it through /clock and it
  // must not leak into /config or the configuration digest.
  const config: EngineConfig = seedSource === 'generated' ? { ...runtimeConfig, seed: null } : runtimeConfig;
  const d = DEFAULT_ENGINE_CONFIG;
  const differs = <K extends keyof EngineConfig>(key: K): EngineConfig[K] | undefined =>
    JSON.stringify(config[key]) === JSON.stringify(d[key]) ? undefined : config[key];
  const file: ConfigFile = {
    server: {
      ...defined('strictTrailingSlash', differs('strictTrailingSlash')),
      ...defined('autoOptions', differs('autoOptions')),
    },
    ...defined('onUnknownMethod', differs('onUnknownMethod')),
    ...defined('onNoFixture', differs('onNoFixture')),
    negotiation: {
      ...defined('mediaTypePreference', differs('mediaTypePreference')),
      ...defined('onUnusableAccept', differs('onUnusableAccept')),
      ...defined('onUnacceptable', differs('onUnacceptable')),
    },
    diagnostics: { ...defined('headers', differs('diagnosticHeaders')) },
    dynamic: {
      ...defined('now', config.now === null ? undefined : rfc3339(config.now)),
      ...defined('clockMode', differs('clockMode')),
      ...defined('timezone', differs('timezone')),
      ...defined('seed', differs('seed')),
      ...defined('strictRefs', differs('strictRefs')),
    },
    scenarios: { ...defined('default', differs('defaultScenario')) },
    sessions: {
      ...defined('keyFrom', differs('keyFrom')),
      ...defined('idleTimeout', differs('idleTimeout')),
      ...defined('max', differs('maxSessions')),
    },
    idempotency: idempotencyFile(config, d),
    recording: recordingFile(config, d),
    promotion: { ...defined('mode', differs('promotionMode')) },
    faults: sectionFile(config.faults, d.faults),
    compression: sectionFile(config.compression, d.compression),
    cors: { fixtures: sectionFile(config.fixtureCors, d.fixtureCors) },
    codecs: { ...defined('xml', differs('xml')) },
  };
  const same = Object.keys(d).every((key) => differs(key as keyof EngineConfig) === undefined);
  const effective = mergeConfig(same ? undefined : file, {});
  return {
    configDigest: configDigest(effective),
    configFile: false,
    settings: publicSettings(effective),
    warnings: [],
  };
}

/** The idempotency settings that differ from the defaults, as a configuration file writes them. */
function idempotencyFile(config: EngineConfig, d: EngineConfig): NonNullable<ConfigFile['idempotency']> {
  const { enabled, header, methods, maxEntries } = config.idempotency;
  const base = d.idempotency;
  return {
    ...defined('enabled', enabled === base.enabled ? undefined : enabled),
    ...defined('header', header === base.header ? undefined : header),
    ...defined('methods', JSON.stringify(methods) === JSON.stringify(base.methods) ? undefined : methods),
    ...defined('maxEntries', maxEntries === base.maxEntries ? undefined : maxEntries),
  };
}

/** The recording settings that differ from the defaults, as a configuration file writes them. */
function recordingFile(config: EngineConfig, d: EngineConfig): NonNullable<ConfigFile['recording']> {
  const { endpoints, maxConcurrent, timeoutMs, maxResponseBytes } = config.recording;
  const base = d.recording;
  return {
    ...defined('endpoints', endpoints.length === 0 ? undefined : endpoints),
    ...defined('maxConcurrent', maxConcurrent === base.maxConcurrent ? undefined : maxConcurrent),
    ...defined('timeoutMs', timeoutMs === base.timeoutMs ? undefined : timeoutMs),
    ...defined('maxResponseBytes', maxResponseBytes === base.maxResponseBytes ? undefined : maxResponseBytes),
  };
}

/** The members of a settings section that differ from the defaults, as a configuration file writes them. */
function sectionFile<T extends object>(value: T, base: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (JSON.stringify(value[key]) !== JSON.stringify(base[key])) out[key] = value[key];
  }
  return out;
}

function defined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
