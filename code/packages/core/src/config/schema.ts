import * as z from 'zod';

import { isValidTimeZone, parseRfc3339 } from '../dynamic/time.js';
import { isScenarioName } from '../fixtures/flow.js';
import { HOP_BY_HOP_HEADERS, isFieldName } from '../http/headers.js';
import { ANY_ORIGIN, isValidOriginEntry } from '../http/origin.js';
import { isKeyFromEntry } from '../http/session.js';
import { MAX_LATENCY_MS, type LatencyProfile } from '../fixtures/latency.js';
import { MAX_REGISTRATIONS, RECORDABLE_METHODS, type RecordingEndpoint } from '../recording/registrations.js';

/**
 * The configuration file schema. Every object is strict, so an
 * unknown key is an error rather than a silently ignored typo. Every setting is
 * optional here; defaults are applied by `mergeConfig`, which records where each
 * effective value came from.
 */

/** A host name (RFC 1123), an IPv4 address, or an unbracketed IPv6 address. */
const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*)$/;

/** True for a value `server.host` and `--host` accept. */
export function isValidHost(host: string): boolean {
  return host.length <= 253 && HOST.test(host);
}

export interface ResolvedConfig {
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly strictTrailingSlash: boolean;
    readonly autoOptions: boolean;
  };
  readonly fixtures: { readonly root: string; readonly watch: boolean };
  readonly onUnknownMethod: 404 | 405;
  readonly onNoFixture: 404 | 501;
  readonly limits: {
    readonly maxUrlBytes: number;
    readonly maxHeaderBytes: number;
    readonly maxBodyBytes: number;
    readonly maxDecodedBodyBytes: number;
  };
  readonly negotiation: {
    readonly mediaTypePreference: readonly string[];
    readonly onUnusableAccept: 400 | 'any';
    readonly onUnacceptable: 406 | 'ignore';
  };
  readonly diagnostics: { readonly headers: boolean };
  readonly dynamic: {
    /** RFC 3339 instant, or null for the wall clock. */
    readonly now: string | null;
    readonly clockMode: 'frozen' | 'offset';
    readonly timezone: string;
    /** 0 to 2^32 − 1, or null for a seed generated at startup. */
    readonly seed: number | null;
    readonly strictRefs: boolean;
    readonly aliases: Readonly<Record<string, string>>;
  };
  readonly atlas: { readonly resolve: boolean };
  readonly ui: { readonly enabled: boolean };
  /** Normalized origins, or `["*"]`. */
  readonly cors: {
    readonly origins: readonly string[];
    readonly maxAge: number;
    readonly fixtures: { readonly origins: readonly string[]; readonly credentials: boolean; readonly maxAge: number };
  };
  readonly scenarios: { readonly default: string };
  readonly sessions: {
    readonly keyFrom: readonly string[];
    /** Seconds. */
    readonly idleTimeout: number;
    readonly max: number;
  };
  readonly idempotency: {
    readonly enabled: boolean;
    readonly header: string;
    readonly methods: readonly string[];
    readonly maxEntries: number;
  };
  readonly recording: {
    readonly endpoints: readonly RecordingEndpoint[];
    /** Relative to the configuration file's directory. */
    readonly captures: string;
    readonly allowNonLoopback: boolean;
    readonly maxConcurrent: number;
    readonly timeoutMs: number;
    readonly maxResponseBytes: number;
  };
  readonly promotion: { readonly mode: 'staged' | 'auto' };
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
  readonly codecs: { readonly xml: boolean };
  readonly runner: {
    /** Relative to the configuration file's directory. */
    readonly root: string;
    readonly allowNonLoopback: boolean;
    readonly maxActiveRuns: number;
    readonly keepRuns: number;
    readonly scriptTimeoutMs: number;
    readonly scriptMemoryBytes: number;
    readonly maxImportBytes: number;
    /** PEM files, relative to the configuration file's directory. */
    readonly extraCaCerts: readonly string[];
    readonly skipTlsVerify: boolean;
  };
}

/** The response content codings Janus can apply. */
export type CompressionCoding = 'br' | 'gzip' | 'deflate';
export const COMPRESSION_CODINGS: readonly CompressionCoding[] = Object.freeze(['br', 'gzip', 'deflate']);

/** Built-in defaults. */
export const CONFIG_DEFAULTS: ResolvedConfig = Object.freeze({
  server: Object.freeze({ host: '127.0.0.1', port: 4010, strictTrailingSlash: true, autoOptions: true }),
  fixtures: Object.freeze({ root: './data', watch: false }),
  onUnknownMethod: 405 as const,
  onNoFixture: 404 as const,
  limits: Object.freeze({
    maxUrlBytes: 8192,
    maxHeaderBytes: 16384,
    maxBodyBytes: 1024 * 1024,
    maxDecodedBodyBytes: 4 * 1024 * 1024,
  }),
  negotiation: Object.freeze({
    mediaTypePreference: Object.freeze([]),
    onUnusableAccept: 400 as const,
    onUnacceptable: 406 as const,
  }),
  diagnostics: Object.freeze({ headers: true }),
  dynamic: Object.freeze({
    now: null,
    clockMode: 'frozen' as const,
    timezone: 'UTC',
    seed: null,
    strictRefs: false,
    aliases: Object.freeze({}),
  }),
  atlas: Object.freeze({ resolve: true }),
  ui: Object.freeze({ enabled: true }),
  cors: Object.freeze({
    origins: Object.freeze([]),
    maxAge: 600,
    fixtures: Object.freeze({ origins: Object.freeze([]), credentials: false, maxAge: 600 }),
  }),
  scenarios: Object.freeze({ default: 'default' }),
  sessions: Object.freeze({ keyFrom: Object.freeze([]), idleTimeout: 1800, max: 1000 }),
  idempotency: Object.freeze({
    enabled: true,
    header: 'Idempotency-Key',
    methods: Object.freeze(['POST', 'PATCH']),
    maxEntries: 1000,
  }),
  recording: Object.freeze({
    endpoints: Object.freeze([]),
    captures: './captures',
    allowNonLoopback: false,
    maxConcurrent: 4,
    timeoutMs: 30000,
    maxResponseBytes: 10485760,
  }),
  promotion: Object.freeze({ mode: 'staged' as const }),
  faults: Object.freeze({ enabled: true, timeoutMs: 120000, maxHeldConnections: 128, latency: null }),
  compression: Object.freeze({ enabled: true, encodings: COMPRESSION_CODINGS, minBytes: 1024 }),
  codecs: Object.freeze({ xml: true }),
  runner: Object.freeze({
    root: './requests',
    allowNonLoopback: false,
    maxActiveRuns: 2,
    keepRuns: 50,
    scriptTimeoutMs: 1000,
    scriptMemoryBytes: 32 * 1024 * 1024,
    maxImportBytes: 50 * 1024 * 1024,
    extraCaCerts: Object.freeze([]),
    skipTlsVerify: false,
  }),
});

export type SettingKey =
  | 'server.host'
  | 'server.port'
  | 'server.strictTrailingSlash'
  | 'server.autoOptions'
  | 'fixtures.root'
  | 'fixtures.watch'
  | 'onUnknownMethod'
  | 'onNoFixture'
  | 'limits.maxUrlBytes'
  | 'limits.maxHeaderBytes'
  | 'limits.maxBodyBytes'
  | 'limits.maxDecodedBodyBytes'
  | 'negotiation.mediaTypePreference'
  | 'negotiation.onUnusableAccept'
  | 'negotiation.onUnacceptable'
  | 'diagnostics.headers'
  | 'dynamic.now'
  | 'dynamic.clockMode'
  | 'dynamic.timezone'
  | 'dynamic.seed'
  | 'dynamic.strictRefs'
  | 'dynamic.aliases'
  | 'atlas.resolve'
  | 'ui.enabled'
  | 'cors.origins'
  | 'cors.maxAge'
  | 'cors.fixtures.origins'
  | 'cors.fixtures.credentials'
  | 'cors.fixtures.maxAge'
  | 'scenarios.default'
  | 'sessions.keyFrom'
  | 'sessions.idleTimeout'
  | 'sessions.max'
  | 'idempotency.enabled'
  | 'idempotency.header'
  | 'idempotency.methods'
  | 'idempotency.maxEntries'
  | 'recording.endpoints'
  | 'recording.captures'
  | 'recording.allowNonLoopback'
  | 'recording.maxConcurrent'
  | 'recording.timeoutMs'
  | 'recording.maxResponseBytes'
  | 'promotion.mode'
  | 'faults.enabled'
  | 'faults.timeoutMs'
  | 'faults.maxHeldConnections'
  | 'faults.latency'
  | 'compression.enabled'
  | 'compression.encodings'
  | 'compression.minBytes'
  | 'codecs.xml'
  | 'runner.root'
  | 'runner.allowNonLoopback'
  | 'runner.maxActiveRuns'
  | 'runner.keepRuns'
  | 'runner.scriptTimeoutMs'
  | 'runner.scriptMemoryBytes'
  | 'runner.maxImportBytes'
  | 'runner.extraCaCerts'
  | 'runner.skipTlsVerify';

export type SettingValue = string | number | boolean | null | readonly string[] | Readonly<Record<string, string>>;

/** The largest `dynamic.seed`: seeds are unsigned 32-bit integers. */
export const MAX_SEED = 0xffff_ffff;

/** A bare `type/subtype` media type: tokens on both sides, no wildcard, no parameters. */
const MEDIA_TYPE = /^[!#$%&'+\-.^_`|~0-9A-Za-z]+\/[!#$%&'+\-.^_`|~0-9A-Za-z]+$/;

interface SettingSpec {
  /** `recording.endpoints` and `faults.latency` validate structures; Atlas publishes them as `SettingValue` text. */
  readonly schema: z.ZodType<SettingValue | readonly RecordingEndpoint[] | LatencyProfile>;
  /** What a valid value looks like, for "expected …, got …" messages. */
  readonly expected: string;
  /** Integers must be written as YAML integers, not floats such as `4010.0`. */
  readonly integer?: boolean;
}

const integer = (min: number, max?: number) => {
  const base = z.int().min(min);
  return max === undefined ? base : base.max(max);
};

/** Every setting, in documentation order. Keys are dotted paths into the file. */
export const SETTINGS: Readonly<Record<SettingKey, SettingSpec>> = {
  'server.host': {
    schema: z.string().regex(HOST).max(253).meta({
      description: 'Address to bind. A non-loopback address is reported as a warning: Janus has no authentication.',
      default: CONFIG_DEFAULTS.server.host,
    }),
    expected: 'a host name or IP address',
  },
  'server.port': {
    schema: integer(0, 65535).meta({ description: 'Port to bind; 0 picks a free port.', default: 4010 }),
    expected: 'an integer from 0 to 65535',
    integer: true,
  },
  'server.strictTrailingSlash': {
    schema: z.boolean().meta({
      description: 'true: "/a/" never matches "/a". false: exactly one trailing "/" is dropped before matching.',
      default: true,
    }),
    expected: 'true or false',
  },
  'server.autoOptions': {
    schema: z.boolean().meta({
      description:
        'true: an OPTIONS request to a fixture path without an OPTIONS directory gets 204 with Allow. false: it gets 405.',
      default: true,
    }),
    expected: 'true or false',
  },
  'fixtures.root': {
    schema: z.string().min(1).meta({
      description: "Fixture root directory, relative to this file's directory.",
      default: CONFIG_DEFAULTS.fixtures.root,
    }),
    expected: 'a non-empty path',
  },
  'fixtures.watch': {
    schema: z.boolean().meta({
      description:
        'true: watch the fixture root and reload the snapshot when files change. An invalid edit never replaces the served snapshot.',
      default: false,
    }),
    expected: 'true or false',
  },
  onUnknownMethod: {
    schema: z.literal([405, 404]).meta({
      description:
        'When the path exists but the method does not: 405 with Allow, or 404 route-not-found without disclosing methods.',
      default: 405,
    }),
    expected: '404 or 405',
    integer: true,
  },
  onNoFixture: {
    schema: z.literal([404, 501]).meta({
      description:
        'When no route matches in the selected scenario: 404 route-not-found, or 501 not-mocked, which cannot be mistaken for an application 404.',
      default: 404,
    }),
    expected: '404 or 501',
    integer: true,
  },
  'limits.maxUrlBytes': {
    schema: integer(256).meta({
      description: 'Longest request target, in bytes; longer is 414 url-too-long.',
      default: CONFIG_DEFAULTS.limits.maxUrlBytes,
    }),
    expected: 'an integer of at least 256',
    integer: true,
  },
  'limits.maxHeaderBytes': {
    schema: integer(1024).meta({
      description: 'Largest total request header size, in bytes; larger is 431 headers-too-large.',
      default: CONFIG_DEFAULTS.limits.maxHeaderBytes,
    }),
    expected: 'an integer of at least 1024',
    integer: true,
  },
  'limits.maxBodyBytes': {
    schema: integer(0).meta({
      description: 'Largest request body, in bytes; larger is 413 request-too-large.',
      default: CONFIG_DEFAULTS.limits.maxBodyBytes,
    }),
    expected: 'a non-negative integer',
    integer: true,
  },
  'limits.maxDecodedBodyBytes': {
    schema: integer(0).meta({
      description:
        'Largest request body after removing its Content-Encoding, in bytes; larger is 413 decoded-body-too-large. At least limits.maxBodyBytes.',
      default: CONFIG_DEFAULTS.limits.maxDecodedBodyBytes,
    }),
    expected: 'a non-negative integer, at least limits.maxBodyBytes',
    integer: true,
  },
  'negotiation.mediaTypePreference': {
    schema: z
      .array(z.string().regex(MEDIA_TYPE))
      .refine((list) => new Set(list.map((entry) => entry.toLowerCase())).size === list.length, {
        message: 'duplicate media type',
      })
      .meta({
        description:
          'Media types to prefer, first first, when Accept ranks several representations equally. Unlisted types follow in lexical order.',
        default: [],
      }),
    expected: 'a list of distinct media types such as application/json (no wildcards or parameters)',
  },
  'negotiation.onUnusableAccept': {
    schema: z.literal([400, 'any']).meta({
      description: 'An Accept header with no usable media range: 400 invalid-request, or any to treat it as */*.',
      default: 400,
    }),
    expected: '400 or any',
    integer: true,
  },
  'negotiation.onUnacceptable': {
    schema: z.literal([406, 'ignore']).meta({
      description:
        'No representation matches Accept: 406 not-acceptable, or ignore to serve the first by mediaTypePreference, then lexical order.',
      default: 406,
    }),
    expected: '406 or ignore',
    integer: true,
  },
  'diagnostics.headers': {
    schema: z.boolean().meta({
      description: 'false removes every X-Mock-* diagnostic header Janus adds. The trace is unaffected.',
      default: true,
    }),
    expected: 'true or false',
  },
  'dynamic.now': {
    schema: z
      .string()
      .refine((value) => parseRfc3339(value) !== null)
      .nullable()
      .meta({
        description:
          'The instant dynamic values render against, as RFC 3339 with an offset (2026-01-01T00:00:00Z); null uses the wall clock.',
        default: null,
      }),
    expected: 'an RFC 3339 instant with an offset, such as 2026-01-01T00:00:00Z, or null',
  },
  'dynamic.clockMode': {
    schema: z.enum(['frozen', 'offset']).meta({
      description:
        'frozen: dynamic.now never moves. offset: it starts at dynamic.now and advances with the wall clock.',
      default: 'frozen',
    }),
    expected: 'frozen or offset',
  },
  'dynamic.timezone': {
    schema: z
      .string()
      .refine((value) => isValidTimeZone(value))
      .meta({
        description: 'IANA time zone for dates such as {{$today}}; never the host zone.',
        default: 'UTC',
      }),
    expected: 'an IANA time zone such as UTC or Europe/Paris',
  },
  'dynamic.seed': {
    schema: z.int().min(0).max(MAX_SEED).nullable().meta({
      description: 'Seed for generated values; null picks one at startup and reports it at /_janus/clock.',
      default: null,
    }),
    expected: `an integer from 0 to ${String(MAX_SEED)}, or null`,
    integer: true,
  },
  'dynamic.strictRefs': {
    schema: z.boolean().meta({
      description:
        'true: a request value a token needs but the request lacks is 500 render-failed instead of null or "".',
      default: false,
    }),
    expected: 'true or false',
  },
  'dynamic.aliases': {
    schema: z.record(z.string(), z.string()).meta({
      description: 'Custom clock aliases, name: <base><offsets>, e.g. trialEnd: today+30d.',
      default: {},
    }),
    expected: 'a mapping of alias names to clock expressions such as today+30d',
  },
  'atlas.resolve': {
    schema: z.boolean().meta({
      description: 'false disables POST /_janus/resolve, the resolution explorer: it then answers 404.',
      default: true,
    }),
    expected: 'true or false',
  },
  'ui.enabled': {
    schema: z.boolean().meta({
      description: 'false stops serving the Atlas UI at /_janus/ui/; --no-ui does the same.',
      default: true,
    }),
    expected: 'true or false',
  },
  'cors.origins': {
    schema: z
      .array(z.string().refine(isValidOriginEntry))
      .refine((list) => !list.includes(ANY_ORIGIN) || list.length === 1, { message: '"*" must be the only entry' })
      .meta({
        description:
          'Origins whose pages may call the Atlas API across origins, such as http://localhost:5173; ["*"] allows any. Empty disables CORS.',
        default: [],
      }),
    expected:
      'a list of origins such as http://localhost:5173 (http or https, a host and an optional port), or ["*"] alone',
  },
  'cors.maxAge': {
    schema: integer(0, 86400).meta({
      description: 'How long browsers may cache a preflight, in seconds.',
      default: 600,
    }),
    expected: 'an integer from 0 to 86400',
    integer: true,
  },
  'cors.fixtures.origins': {
    schema: z
      .array(z.string().refine(isValidOriginEntry))
      .refine((list) => !list.includes(ANY_ORIGIN) || list.length === 1, { message: '"*" must be the only entry' })
      .meta({
        description:
          'Origins whose pages may call the fixture routes across origins; ["*"] allows any. Empty disables fixture CORS. Never applies to the Atlas.',
        default: [],
      }),
    expected:
      'a list of origins such as http://localhost:5173 (http or https, a host and an optional port), or ["*"] alone',
  },
  'cors.fixtures.credentials': {
    schema: z.boolean().meta({
      description: 'true lets pages send cookies to the fixture routes and read the answers. Not with ["*"].',
      default: false,
    }),
    expected: 'true or false',
  },
  'cors.fixtures.maxAge': {
    schema: integer(0, 86400).meta({
      description: 'How long browsers may cache a fixture preflight, in seconds.',
      default: 600,
    }),
    expected: 'an integer from 0 to 86400',
    integer: true,
  },
  'scenarios.default': {
    schema: z.string().refine(isScenarioName).meta({
      description:
        'The scenario a request gets without X-Mock-Scenario or a session pin; it must be a scenario directory. --scenario does the same.',
      default: 'default',
    }),
    expected: 'a scenario name: lowercase letters and digits in words joined by "-"',
  },
  'sessions.keyFrom': {
    schema: z
      .array(z.string().refine(isKeyFromEntry))
      .max(8)
      .refine((list) => new Set(list.map((entry) => keyFromIdentity(entry))).size === list.length, {
        message: 'duplicate entry',
      })
      .meta({
        description:
          'Where a session key comes from when X-Mock-Session is absent: header.<name> or cookie.<name> entries, the first present one hashed into the session ID.',
        default: [],
      }),
    expected: 'a list of at most 8 distinct header.<name> or cookie.<name> entries',
  },
  'sessions.idleTimeout': {
    schema: integer(60, 86400).meta({
      description: 'Seconds after its last request that a session expires.',
      default: 1800,
    }),
    expected: 'an integer from 60 to 86400',
    integer: true,
  },
  'sessions.max': {
    schema: integer(1, 100000).meta({
      description: 'Sessions that may exist at once; creating one more is 503 session-limit.',
      default: 1000,
    }),
    expected: 'an integer from 1 to 100000',
    integer: true,
  },
  'idempotency.enabled': {
    schema: z.boolean().meta({
      description:
        'false resolves every retried request again instead of replaying the response a session got for its Idempotency-Key.',
      default: true,
    }),
    expected: 'true or false',
  },
  'idempotency.header': {
    schema: z.string().refine(isIdempotencyHeader).meta({
      description:
        'The request header carrying the idempotency key. Not X-Mock-*, a hop-by-hop header or Content-Type.',
      default: 'Idempotency-Key',
    }),
    expected: 'a header field name other than X-Mock-*, a hop-by-hop header or Content-Type',
  },
  'idempotency.methods': {
    schema: z
      .array(z.enum(['POST', 'PATCH', 'PUT', 'DELETE']))
      .refine((list) => new Set(list).size === list.length, { message: 'duplicate method' })
      .meta({ description: 'The methods whose retries are replayed.', default: ['POST', 'PATCH'] }),
    expected: 'a list of distinct methods from POST, PATCH, PUT and DELETE',
  },
  'idempotency.maxEntries': {
    schema: integer(1, 100000).meta({
      description: "Stored responses one session may hold; storing one more drops that session's oldest.",
      default: 1000,
    }),
    expected: 'an integer from 1 to 100000',
    integer: true,
  },
  'recording.endpoints': {
    schema: z
      .array(
        z.strictObject({
          method: z.enum(RECORDABLE_METHODS),
          path: z.string().min(1),
          upstream: z.string().min(1),
        }),
      )
      .max(MAX_REGISTRATIONS)
      .meta({
        description:
          'The requests X-Mock-Record: true may forward: each a method, a path template such as /v1/products/{productId}, and the http or https upstream it is sent to. Empty disables recording.',
        default: [],
      }),
    expected: `a list of at most ${String(MAX_REGISTRATIONS)} entries, each with method (GET, POST, PUT, PATCH, DELETE or OPTIONS), path and upstream`,
  },
  'recording.captures': {
    schema: z.string().min(1).meta({
      description:
        "Where recorded exchanges are written, relative to this file's directory. Never inside fixtures.root; never served.",
      default: CONFIG_DEFAULTS.recording.captures,
    }),
    expected: 'a non-empty path',
  },
  'recording.allowNonLoopback': {
    schema: z.boolean().meta({
      description:
        'true allows recording on a non-loopback listener: any client that can reach the port can then call every registered upstream.',
      default: false,
    }),
    expected: 'true or false',
  },
  'recording.maxConcurrent': {
    schema: integer(1, 64).meta({
      description: 'Recordings that may be in progress at once; one more is 503 recording-busy.',
      default: CONFIG_DEFAULTS.recording.maxConcurrent,
    }),
    expected: 'an integer from 1 to 64',
    integer: true,
  },
  'recording.timeoutMs': {
    schema: integer(1000, 600000).meta({
      description: 'Milliseconds an upstream has to send its whole response; longer is 504 recording-upstream-timeout.',
      default: CONFIG_DEFAULTS.recording.timeoutMs,
    }),
    expected: 'an integer from 1000 to 600000',
    integer: true,
  },
  'recording.maxResponseBytes': {
    schema: integer(0, 1073741824).meta({
      description: 'Largest upstream response body, in bytes; larger is 502 recording-response-too-large.',
      default: CONFIG_DEFAULTS.recording.maxResponseBytes,
    }),
    expected: 'an integer from 0 to 1073741824',
    integer: true,
  },
  'promotion.mode': {
    schema: z.enum(['staged', 'auto']).meta({
      description:
        'staged keeps captures until someone promotes one; auto promotes each successful capture into its scenario as soon as it is written, pending review.',
      default: CONFIG_DEFAULTS.promotion.mode,
    }),
    expected: 'staged or auto',
  },
  'faults.enabled': {
    schema: z.boolean().meta({
      description:
        'false turns off every fault and every delay at once; fault.yaml and latency are still loaded and described.',
      default: true,
    }),
    expected: 'true or false',
  },
  'faults.timeoutMs': {
    schema: integer(1000, 3600000).meta({
      description: 'How long a timeout fault holds a connection before Janus closes it, in milliseconds.',
      default: CONFIG_DEFAULTS.faults.timeoutMs,
    }),
    expected: 'an integer from 1000 to 3600000',
    integer: true,
  },
  'faults.maxHeldConnections': {
    schema: integer(1, 10000).meta({
      description: 'Connections timeout faults may hold at once; one more gets 503 fault-capacity-exceeded.',
      default: CONFIG_DEFAULTS.faults.maxHeldConnections,
    }),
    expected: 'an integer from 1 to 10000',
    integer: true,
  },
  'faults.latency': {
    schema: latencyProfileSchema().nullable().meta({
      description:
        'The server-wide delay before the first byte: { ms: N } or { min: A, max: B } in milliseconds, or null for none.',
      default: null,
    }),
    expected: `{ ms: N } or { min: A, max: B } with integers from 0 to ${String(MAX_LATENCY_MS)} and min ≤ max, or null`,
  },
  'compression.enabled': {
    schema: z.boolean().meta({
      description: 'false sends every fixture body uncompressed, whatever Accept-Encoding asks for.',
      default: true,
    }),
    expected: 'true or false',
  },
  'compression.encodings': {
    schema: z
      .array(z.enum(COMPRESSION_CODINGS))
      .min(1)
      .refine((list) => new Set(list).size === list.length, { message: 'duplicate coding' })
      .meta({
        description: 'The codings Janus may use, preferred first when Accept-Encoding ranks them equally.',
        default: [...COMPRESSION_CODINGS],
      }),
    expected: 'a non-empty list of distinct codings from br, gzip and deflate',
  },
  'compression.minBytes': {
    schema: integer(0, 1073741824).meta({
      description: 'Smallest JSON or text body Janus compresses, in bytes.',
      default: CONFIG_DEFAULTS.compression.minBytes,
    }),
    expected: 'an integer from 0 to 1073741824',
    integer: true,
  },
  'codecs.xml': {
    schema: z.boolean().meta({
      description:
        'true: body.<JSONPath> references read XML request bodies as a document. false: an XML body is a missing value.',
      default: true,
    }),
    expected: 'true or false',
  },
  'runner.root': {
    schema: z.string().min(1).meta({
      description:
        "Where saved requests, collections and environments live, relative to this file's directory. Never inside fixtures.root or recording.captures.",
      default: CONFIG_DEFAULTS.runner.root,
    }),
    expected: 'a non-empty path',
  },
  'runner.allowNonLoopback': {
    schema: z.boolean().meta({
      description:
        'true makes the request runner available on a non-loopback listener: any client that can reach the port can then make Janus send requests anywhere it can reach.',
      default: false,
    }),
    expected: 'true or false',
  },
  'runner.maxActiveRuns': {
    schema: integer(1, 16).meta({
      description: 'Runs that may be in progress at once; one more is 503 runner-busy.',
      default: CONFIG_DEFAULTS.runner.maxActiveRuns,
    }),
    expected: 'an integer from 1 to 16',
    integer: true,
  },
  'runner.keepRuns': {
    schema: integer(1, 1000).meta({
      description: 'Finished runs kept in memory for the Atlas and the UI.',
      default: CONFIG_DEFAULTS.runner.keepRuns,
    }),
    expected: 'an integer from 1 to 1000',
    integer: true,
  },
  'runner.scriptTimeoutMs': {
    schema: integer(50, 60000).meta({
      description:
        'Milliseconds one pre-request or post-response script may run; longer fails the step script-timeout.',
      default: CONFIG_DEFAULTS.runner.scriptTimeoutMs,
    }),
    expected: 'an integer from 50 to 60000',
    integer: true,
  },
  'runner.scriptMemoryBytes': {
    schema: integer(1024 * 1024, 512 * 1024 * 1024).meta({
      description: 'Largest heap one script may use, in bytes; more fails the step script-memory.',
      default: CONFIG_DEFAULTS.runner.scriptMemoryBytes,
    }),
    expected: 'an integer from 1048576 to 536870912',
    integer: true,
  },
  'runner.maxImportBytes': {
    schema: integer(1024 * 1024, 1024 * 1024 * 1024).meta({
      description: 'Largest import, in bytes, across all its files; a zip may expand to four times this.',
      default: CONFIG_DEFAULTS.runner.maxImportBytes,
    }),
    expected: 'an integer from 1048576 to 1073741824',
    integer: true,
  },
  'runner.extraCaCerts': {
    schema: z.array(z.string().min(1)).max(64).meta({
      description:
        "PEM files of certificate authorities (or self-signed certificates) trusted for runner and recording requests besides the platform's, relative to this file's directory.",
      default: [],
    }),
    expected: 'a list of at most 64 paths',
  },
  'runner.skipTlsVerify': {
    schema: z.boolean().meta({
      description:
        'Accept any certificate from the upstream for runner and recording requests, unverified. Only for dev, test or staging backends; Janus warns tls-verification-off.',
      default: CONFIG_DEFAULTS.runner.skipTlsVerify,
    }),
    expected: 'true or false',
  },
};

/** `{ ms: N }` or `{ min: A, max: B }`. */
function latencyProfileSchema() {
  const bound = z.int().min(0).max(MAX_LATENCY_MS);
  return z.union([
    z.strictObject({ ms: bound }),
    z.strictObject({ min: bound, max: bound }).refine((range) => range.min <= range.max, {
      message: 'min is greater than max',
    }),
  ]);
}

/** A header name `idempotency.header` may take. */
function isIdempotencyHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    isFieldName(name) && !lower.startsWith('x-mock-') && !HOP_BY_HOP_HEADERS.has(lower) && lower !== 'content-type'
  );
}

/** Header names compare case-insensitively; cookie names do not. */
function keyFromIdentity(entry: string): string {
  return entry.startsWith('header.') ? entry.toLowerCase() : entry;
}

export const SETTING_KEYS = Object.freeze(Object.keys(SETTINGS) as SettingKey[]);

/** Sections (mappings) of the file, with their expected-value text. */
export const SECTIONS: Readonly<Record<string, string>> = {
  server: 'a mapping of server settings',
  fixtures: 'a mapping of fixture settings',
  limits: 'a mapping of request limits',
  negotiation: 'a mapping of negotiation settings',
  diagnostics: 'a mapping of diagnostic settings',
  dynamic: 'a mapping of dynamic-value settings',
  atlas: 'a mapping of Atlas settings',
  ui: 'a mapping of UI settings',
  cors: 'a mapping of CORS settings',
  scenarios: 'a mapping of scenario settings',
  sessions: 'a mapping of session settings',
  idempotency: 'a mapping of idempotency replay settings',
  recording: 'a mapping of recording settings',
  promotion: 'a mapping of promotion settings',
  faults: 'a mapping of fault settings',
  compression: 'a mapping of response compression settings',
  codecs: 'a mapping of request body codec settings',
  runner: 'a mapping of request runner settings',
  'cors.fixtures': 'a mapping of fixture CORS settings',
};

const setting = (key: SettingKey) => SETTINGS[key].schema.optional();

export const configFileSchema = z
  .strictObject({
    $schema: z.string().optional().meta({ description: 'JSON Schema reference for editors; ignored by Janus.' }),
    server: z
      .strictObject({
        host: setting('server.host'),
        port: setting('server.port'),
        strictTrailingSlash: setting('server.strictTrailingSlash'),
        autoOptions: setting('server.autoOptions'),
      })
      .optional(),
    fixtures: z.strictObject({ root: setting('fixtures.root'), watch: setting('fixtures.watch') }).optional(),
    onUnknownMethod: setting('onUnknownMethod'),
    onNoFixture: setting('onNoFixture'),
    limits: z
      .strictObject({
        maxUrlBytes: setting('limits.maxUrlBytes'),
        maxHeaderBytes: setting('limits.maxHeaderBytes'),
        maxBodyBytes: setting('limits.maxBodyBytes'),
        maxDecodedBodyBytes: setting('limits.maxDecodedBodyBytes'),
      })
      .optional(),
    negotiation: z
      .strictObject({
        mediaTypePreference: setting('negotiation.mediaTypePreference'),
        onUnusableAccept: setting('negotiation.onUnusableAccept'),
        onUnacceptable: setting('negotiation.onUnacceptable'),
      })
      .optional(),
    diagnostics: z.strictObject({ headers: setting('diagnostics.headers') }).optional(),
    dynamic: z
      .strictObject({
        now: setting('dynamic.now'),
        clockMode: setting('dynamic.clockMode'),
        timezone: setting('dynamic.timezone'),
        seed: setting('dynamic.seed'),
        strictRefs: setting('dynamic.strictRefs'),
        aliases: setting('dynamic.aliases'),
      })
      .optional(),
    atlas: z.strictObject({ resolve: setting('atlas.resolve') }).optional(),
    ui: z.strictObject({ enabled: setting('ui.enabled') }).optional(),
    cors: z
      .strictObject({
        origins: setting('cors.origins'),
        maxAge: setting('cors.maxAge'),
        fixtures: z
          .strictObject({
            origins: setting('cors.fixtures.origins'),
            credentials: setting('cors.fixtures.credentials'),
            maxAge: setting('cors.fixtures.maxAge'),
          })
          .optional(),
      })
      .optional(),
    scenarios: z.strictObject({ default: setting('scenarios.default') }).optional(),
    sessions: z
      .strictObject({
        keyFrom: setting('sessions.keyFrom'),
        idleTimeout: setting('sessions.idleTimeout'),
        max: setting('sessions.max'),
      })
      .optional(),
    idempotency: z
      .strictObject({
        enabled: setting('idempotency.enabled'),
        header: setting('idempotency.header'),
        methods: setting('idempotency.methods'),
        maxEntries: setting('idempotency.maxEntries'),
      })
      .optional(),
    recording: z
      .strictObject({
        endpoints: setting('recording.endpoints'),
        captures: setting('recording.captures'),
        allowNonLoopback: setting('recording.allowNonLoopback'),
        maxConcurrent: setting('recording.maxConcurrent'),
        timeoutMs: setting('recording.timeoutMs'),
        maxResponseBytes: setting('recording.maxResponseBytes'),
      })
      .optional(),
    promotion: z.strictObject({ mode: setting('promotion.mode') }).optional(),
    faults: z
      .strictObject({
        enabled: setting('faults.enabled'),
        timeoutMs: setting('faults.timeoutMs'),
        maxHeldConnections: setting('faults.maxHeldConnections'),
        latency: setting('faults.latency'),
      })
      .optional(),
    compression: z
      .strictObject({
        enabled: setting('compression.enabled'),
        encodings: setting('compression.encodings'),
        minBytes: setting('compression.minBytes'),
      })
      .optional(),
    codecs: z.strictObject({ xml: setting('codecs.xml') }).optional(),
    runner: z
      .strictObject({
        root: setting('runner.root'),
        allowNonLoopback: setting('runner.allowNonLoopback'),
        maxActiveRuns: setting('runner.maxActiveRuns'),
        keepRuns: setting('runner.keepRuns'),
        scriptTimeoutMs: setting('runner.scriptTimeoutMs'),
        scriptMemoryBytes: setting('runner.scriptMemoryBytes'),
        maxImportBytes: setting('runner.maxImportBytes'),
        extraCaCerts: setting('runner.extraCaCerts'),
        skipTlsVerify: setting('runner.skipTlsVerify'),
      })
      .optional(),
  })
  .meta({ title: 'Janus configuration', description: 'Settings for the Janus mock server (janus.config.yaml).' });

/** A validated configuration file: only what the file says, before defaults and CLI flags. */
export interface ConfigFile {
  readonly $schema?: string;
  readonly server?: {
    readonly host?: string;
    readonly port?: number;
    readonly strictTrailingSlash?: boolean;
    readonly autoOptions?: boolean;
  };
  readonly fixtures?: { readonly root?: string; readonly watch?: boolean };
  readonly onUnknownMethod?: 404 | 405;
  readonly onNoFixture?: 404 | 501;
  readonly limits?: {
    readonly maxUrlBytes?: number;
    readonly maxHeaderBytes?: number;
    readonly maxBodyBytes?: number;
    readonly maxDecodedBodyBytes?: number;
  };
  readonly negotiation?: {
    readonly mediaTypePreference?: readonly string[];
    readonly onUnusableAccept?: 400 | 'any';
    readonly onUnacceptable?: 406 | 'ignore';
  };
  readonly diagnostics?: { readonly headers?: boolean };
  readonly dynamic?: {
    readonly now?: string | null;
    readonly clockMode?: 'frozen' | 'offset';
    readonly timezone?: string;
    readonly seed?: number | null;
    readonly strictRefs?: boolean;
    readonly aliases?: Readonly<Record<string, string>>;
  };
  readonly atlas?: { readonly resolve?: boolean };
  readonly ui?: { readonly enabled?: boolean };
  readonly cors?: {
    readonly origins?: readonly string[];
    readonly maxAge?: number;
    readonly fixtures?: {
      readonly origins?: readonly string[];
      readonly credentials?: boolean;
      readonly maxAge?: number;
    };
  };
  readonly scenarios?: { readonly default?: string };
  readonly sessions?: { readonly keyFrom?: readonly string[]; readonly idleTimeout?: number; readonly max?: number };
  readonly idempotency?: {
    readonly enabled?: boolean;
    readonly header?: string;
    readonly methods?: readonly string[];
    readonly maxEntries?: number;
  };
  readonly recording?: {
    readonly endpoints?: readonly RecordingEndpoint[];
    readonly captures?: string;
    readonly allowNonLoopback?: boolean;
    readonly maxConcurrent?: number;
    readonly timeoutMs?: number;
    readonly maxResponseBytes?: number;
  };
  readonly promotion?: { readonly mode?: 'staged' | 'auto' };
  readonly faults?: {
    readonly enabled?: boolean;
    readonly timeoutMs?: number;
    readonly maxHeldConnections?: number;
    readonly latency?: LatencyProfile | null;
  };
  readonly compression?: {
    readonly enabled?: boolean;
    readonly encodings?: readonly CompressionCoding[];
    readonly minBytes?: number;
  };
  readonly codecs?: { readonly xml?: boolean };
  readonly runner?: {
    readonly root?: string;
    readonly allowNonLoopback?: boolean;
    readonly maxActiveRuns?: number;
    readonly keepRuns?: number;
    readonly scriptTimeoutMs?: number;
    readonly scriptMemoryBytes?: number;
    readonly maxImportBytes?: number;
    readonly extraCaCerts?: readonly string[];
    readonly skipTlsVerify?: boolean;
  };
}

/** Known keys at each mapping, for unknown-key suggestions. "" is the top level. */
export const KNOWN_KEYS: Readonly<Record<string, readonly string[]>> = {
  '': [
    '$schema',
    ...Object.keys(SECTIONS).filter((section) => !section.includes('.')),
    'onUnknownMethod',
    'onNoFixture',
  ],
  ...Object.fromEntries(
    Object.keys(SECTIONS).map((section) => [
      section,
      [
        ...new Set(
          SETTING_KEYS.filter((key) => key.startsWith(`${section}.`)).map(
            (key) => key.slice(section.length + 1).split('.')[0] ?? '',
          ),
        ),
      ],
    ]),
  ),
};

/** The JSON Schema for editors, generated from the Zod schema (committed as janus.config.schema.json). */
export const configJsonSchema: Readonly<Record<string, unknown>> = Object.freeze(
  z.toJSONSchema(configFileSchema, { target: 'draft-2020-12' }),
);
