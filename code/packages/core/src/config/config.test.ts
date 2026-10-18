import { describe, expect, it } from 'vitest';

import { suggest } from '../suggest.js';
import type { StartupError } from '../types/index.js';
import { configDigest, engineConfig, mergeConfig, publicSettings, snapshotOptions } from './merge.js';
import { parseConfig, type ParseConfigResult } from './parse.js';
import { CONFIG_DEFAULTS, configJsonSchema, isValidHost, SETTING_KEYS, type SettingKey } from './schema.js';

const SOURCE = 'janus.config.yaml';

function parse(text: string): ParseConfigResult {
  return parseConfig({ text, sourceName: SOURCE });
}

function errorsOf(text: string): readonly StartupError[] {
  const result = parse(text);
  if (result.ok) throw new Error('expected configuration errors');
  return result.errors;
}

function valid(text: string) {
  const result = parse(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
}

/** YAML text setting one dotted key. */
function yamlFor(key: string, value: string): string {
  const [first, second, third] = key.split('.');
  if (third !== undefined) return `${first ?? ''}:\n  ${second ?? ''}:\n    ${third}: ${value}\n`;
  return second === undefined ? `${first ?? ''}: ${value}\n` : `${first ?? ''}:\n  ${second}: ${value}\n`;
}

function valueOf(key: SettingKey, text: string): unknown {
  const result = valid(text);
  return mergeConfig(result.config, {}, result.locations).settings.find((setting) => setting.key === key)?.value;
}

/** Engine settings at their defaults. */
const M12_ENGINE_DEFAULTS = {
  autoOptions: true,
  faults: { enabled: true, timeoutMs: 120000, maxHeldConnections: 128, latency: null },
  compression: { enabled: true, encodings: ['br', 'gzip', 'deflate'], minBytes: 1024 },
  fixtureCors: { origins: [], credentials: false, maxAge: 600 },
  xml: true,
};

const TABLE: readonly {
  key: SettingKey;
  default: unknown;
  valid: readonly [string, unknown][];
  invalid: readonly string[];
}[] = [
  {
    key: 'server.host',
    default: '127.0.0.1',
    valid: [
      ['localhost', 'localhost'],
      ['0.0.0.0', '0.0.0.0'],
      ['"::1"', '::1'],
      ['api.example.test', 'api.example.test'],
    ],
    invalid: ['""', '"not a host"', '4010', 'true', '[a]', '{a: 1}', '"-bad-"'],
  },
  {
    key: 'server.port',
    default: 4010,
    valid: [
      ['0', 0],
      ['4020', 4020],
      ['65535', 65535],
    ],
    invalid: ['-1', '65536', '4010.5', '4010.0', '"4010"', 'true', 'null', '[1]'],
  },
  {
    key: 'server.strictTrailingSlash',
    default: true,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"false"', '0', 'yes', 'null'],
  },
  {
    key: 'fixtures.root',
    default: './data',
    valid: [
      ['./fixtures', './fixtures'],
      ['/srv/janus', '/srv/janus'],
    ],
    invalid: ['""', '5', 'true', '[a]'],
  },
  {
    key: 'onUnknownMethod',
    default: 405,
    valid: [
      ['404', 404],
      ['405', 405],
    ],
    invalid: ['403', '"404"', '404.0', 'null'],
  },
  {
    key: 'limits.maxUrlBytes',
    default: 8192,
    valid: [
      ['256', 256],
      ['0x2000', 8192],
    ],
    invalid: ['255', '-1', '"8KiB"', '1e4', '8192.0'],
  },
  {
    key: 'limits.maxHeaderBytes',
    default: 16384,
    valid: [
      ['1024', 1024],
      ['65536', 65536],
    ],
    invalid: ['1023', '"16KiB"', 'false'],
  },
  {
    key: 'limits.maxBodyBytes',
    default: 1048576,
    valid: [
      ['0', 0],
      // The largest maxDecodedBodyBytes's default allows.
      ['4194304', 4194304],
    ],
    invalid: ['-1', '"10MiB"', '1.5', 'null'],
  },
  {
    key: 'limits.maxDecodedBodyBytes',
    default: 4194304,
    valid: [
      ['1048576', 1048576],
      ['1073741824', 1073741824],
    ],
    invalid: ['-1', '"4MiB"', '1.5', 'null'],
  },
  {
    key: 'server.autoOptions',
    default: true,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"true"', '1', 'null'],
  },
  {
    key: 'negotiation.mediaTypePreference',
    default: [],
    valid: [
      ['[]', []],
      ['[application/json, application/yaml]', ['application/json', 'application/yaml']],
      ['\n    - application/vnd.acme+json', ['application/vnd.acme+json']],
    ],
    invalid: [
      'application/json',
      '[application/*]',
      '["application/json; charset=utf-8"]',
      '[application/json, Application/JSON]',
      '[1]',
      'null',
    ],
  },
  {
    key: 'negotiation.onUnusableAccept',
    default: 400,
    valid: [
      ['400', 400],
      ['any', 'any'],
    ],
    invalid: ['"400"', '406', 'ANY', '400.0', 'null'],
  },
  {
    key: 'negotiation.onUnacceptable',
    default: 406,
    valid: [
      ['406', 406],
      ['ignore', 'ignore'],
    ],
    invalid: ['"406"', '400', 'any', '406.0', 'null'],
  },
  {
    key: 'fixtures.watch',
    default: false,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"true"', '1', 'yes', 'null'],
  },
  {
    key: 'atlas.resolve',
    default: true,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"false"', '0', 'off', 'null'],
  },
  {
    key: 'diagnostics.headers',
    default: true,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"false"', '0', 'off', 'null'],
  },
  {
    key: 'onNoFixture',
    default: 404,
    valid: [
      ['404', 404],
      ['501', 501],
    ],
    invalid: ['"404"', '405', '500', 'not-mocked', 'null'],
  },
  {
    key: 'idempotency.enabled',
    default: true,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"true"', '1', 'yes', 'null'],
  },
  {
    key: 'idempotency.header',
    default: 'Idempotency-Key',
    valid: [
      ['Idempotency-Key', 'Idempotency-Key'],
      ['X-Request-Id', 'X-Request-Id'],
    ],
    invalid: ['""', '"not a header"', 'X-Mock-Key', 'Connection', 'Content-Type', '5', 'null'],
  },
  {
    key: 'idempotency.methods',
    default: ['POST', 'PATCH'],
    valid: [
      ['[]', []],
      ['[PUT, DELETE]', ['PUT', 'DELETE']],
    ],
    invalid: ['POST', '[GET]', '[post]', '[POST, POST]', 'null'],
  },
  {
    key: 'idempotency.maxEntries',
    default: 1000,
    valid: [
      ['1', 1],
      ['100000', 100000],
    ],
    invalid: ['0', '100001', '1.5', '"10"', 'null'],
  },
  {
    key: 'dynamic.now',
    default: null,
    valid: [
      ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
      ['"2026-01-01T09:00:00.5+09:00"', '2026-01-01T09:00:00.5+09:00'],
      ['null', null],
    ],
    invalid: ['2026-01-01', '"2026-01-01T00:00:00"', '"2026-02-30T00:00:00Z"', 'yesterday', '5', 'true'],
  },
  {
    key: 'dynamic.clockMode',
    default: 'frozen',
    valid: [
      ['frozen', 'frozen'],
      ['offset', 'offset'],
    ],
    invalid: ['live', 'Frozen', '1', 'null'],
  },
  {
    key: 'dynamic.timezone',
    default: 'UTC',
    valid: [
      ['UTC', 'UTC'],
      ['Europe/Paris', 'Europe/Paris'],
      ['Asia/Tokyo', 'Asia/Tokyo'],
    ],
    // A string that is not a zone is `unknown-timezone`, tested below.
    invalid: ['5', 'true', 'null', '[UTC]'],
  },
  {
    key: 'dynamic.seed',
    default: null,
    valid: [
      ['0', 0],
      ['42', 42],
      ['4294967295', 4294967295],
      ['null', null],
    ],
    invalid: ['-1', '4294967296', '1.5', '"42"', '42.0', 'true'],
  },
  {
    key: 'dynamic.strictRefs',
    default: false,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"true"', '1', 'null'],
  },
  {
    key: 'dynamic.aliases',
    default: {},
    valid: [
      ['{}', {}],
      ['{trialEnd: today+30d, graceEnd: trialEnd+7d}', { trialEnd: 'today+30d', graceEnd: 'trialEnd+7d' }],
    ],
    invalid: ['[a]', 'x', '{a: 1}', 'null'],
  },
  {
    key: 'ui.enabled',
    default: true,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"false"', '0', 'off', 'null'],
  },
  {
    key: 'cors.origins',
    default: [],
    valid: [
      ['[]', []],
      ['["http://localhost:5173"]', ['http://localhost:5173']],
      ['["*"]', ['*']],
      // Normalized: scheme and host lowercased, default ports dropped, IPv6 kept in brackets.
      [
        '["HTTP://Atlas.Example.COM:80", "https://atlas.example.com:443"]',
        ['http://atlas.example.com', 'https://atlas.example.com'],
      ],
      ['["http://[::1]:4010", "https://[2001:DB8::1]"]', ['http://[::1]:4010', 'https://[2001:db8::1]']],
      ['["http://localhost:5173", "http://LOCALHOST:5173"]', ['http://localhost:5173']],
    ],
    invalid: [
      '"http://localhost:5173"',
      '["*", "http://localhost:5173"]',
      '["http://localhost:5173/"]',
      '["http://localhost:5173/atlas"]',
      '["ftp://example.com"]',
      '["example.com"]',
      '["null"]',
      '["http://user@example.com"]',
      '["http://example.com:99999"]',
      '["http://[fe80::1%25eth0]"]',
      '["http://[fe80::1%eth0]"]',
      '[5]',
      'null',
    ],
  },
  {
    key: 'cors.maxAge',
    default: 600,
    valid: [
      ['0', 0],
      ['600', 600],
      ['86400', 86400],
    ],
    invalid: ['-1', '86401', '1.5', '"600"', '600.0', 'null'],
  },
  {
    key: 'scenarios.default',
    default: 'default',
    valid: [
      ['payment-declined', 'payment-declined'],
      ['a1', 'a1'],
    ],
    invalid: ['Payment', 'a--b', '"-a"', '5', 'null', '[a]'],
  },
  {
    key: 'sessions.keyFrom',
    default: [],
    valid: [
      ['[]', []],
      ['[header.x-cart-token, cookie.session]', ['header.x-cart-token', 'cookie.session']],
    ],
    invalid: [
      '[query.token]',
      '[header.]',
      '["header.a b"]',
      '[header.X-A, header.x-a]',
      '[cookie.a, cookie.a]',
      '[header.a, header.b, header.c, header.d, header.e, header.f, header.g, header.h, header.i]',
      'header.a',
      'null',
    ],
  },
  {
    key: 'sessions.idleTimeout',
    default: 1800,
    valid: [
      ['60', 60],
      ['86400', 86400],
    ],
    invalid: ['59', '86401', '1.5', '"1800"', 'null'],
  },
  {
    key: 'sessions.max',
    default: 1000,
    valid: [
      ['1', 1],
      ['100000', 100000],
    ],
    invalid: ['0', '100001', '"5"', 'null'],
  },
  {
    key: 'recording.endpoints',
    default: [],
    valid: [
      ['[]', []],
      [
        '[{method: GET, path: "/v1/products/{productId}", upstream: "https://staging.example.test"}]',
        ['GET /v1/products/{productId} https://staging.example.test'],
      ],
    ],
    invalid: [
      '[{method: HEAD, path: /a, upstream: "https://x.test"}]',
      '[{method: get, path: /a, upstream: "https://x.test"}]',
      '[{method: GET, path: /a, upstream: "https://x.test", extra: 1}]',
      '[{method: GET, path: /a}]',
      '[{method: GET, path: "", upstream: "https://x.test"}]',
      '{method: GET}',
      'null',
    ],
  },
  {
    key: 'recording.captures',
    default: './captures',
    valid: [['./recorded', './recorded']],
    invalid: ['""', '5', 'null', '[a]'],
  },
  {
    key: 'recording.allowNonLoopback',
    default: false,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"true"', '1', 'null'],
  },
  {
    key: 'recording.maxConcurrent',
    default: 4,
    valid: [
      ['1', 1],
      ['64', 64],
    ],
    invalid: ['0', '65', '1.5', '"4"', 'null'],
  },
  {
    key: 'recording.timeoutMs',
    default: 30000,
    valid: [
      ['1000', 1000],
      ['600000', 600000],
    ],
    invalid: ['999', '600001', '"30000"', 'null'],
  },
  {
    key: 'recording.maxResponseBytes',
    default: 10485760,
    valid: [
      ['0', 0],
      ['1073741824', 1073741824],
    ],
    invalid: ['-1', '1073741825', '"10MB"', 'null'],
  },
  {
    key: 'runner.root',
    default: './requests',
    valid: [['./api-requests', './api-requests']],
    invalid: ['""', '5', 'null'],
  },
  {
    key: 'runner.allowNonLoopback',
    default: false,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"true"', '1', 'null'],
  },
  {
    key: 'runner.maxActiveRuns',
    default: 2,
    valid: [
      ['1', 1],
      ['16', 16],
    ],
    invalid: ['0', '17', '1.5', 'null'],
  },
  {
    key: 'runner.keepRuns',
    default: 50,
    valid: [
      ['1', 1],
      ['1000', 1000],
    ],
    invalid: ['0', '1001', '"50"'],
  },
  {
    key: 'runner.scriptTimeoutMs',
    default: 1000,
    valid: [
      ['50', 50],
      ['60000', 60000],
    ],
    invalid: ['49', '60001', 'null'],
  },
  {
    key: 'runner.scriptMemoryBytes',
    default: 33554432,
    valid: [
      ['1048576', 1048576],
      ['536870912', 536870912],
    ],
    invalid: ['1048575', '536870913', '"32MiB"'],
  },
  {
    key: 'runner.maxImportBytes',
    default: 52428800,
    valid: [
      ['1048576', 1048576],
      ['1073741824', 1073741824],
    ],
    invalid: ['1048575', '1073741825', 'null'],
  },
  {
    key: 'runner.extraCaCerts',
    default: [],
    valid: [['[certs/staging-ca.pem]', ['certs/staging-ca.pem']]],
    invalid: ['certs/ca.pem', '[""]', '[1]'],
  },
  {
    key: 'runner.skipTlsVerify',
    default: false,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"yes"', '1', 'null'],
  },
  {
    key: 'promotion.mode',
    default: 'staged',
    valid: [
      ['staged', 'staged'],
      ['auto', 'auto'],
    ],
    invalid: ['manual', '1', 'null'],
  },
  {
    key: 'faults.enabled',
    default: true,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"false"', '0', 'null'],
  },
  {
    key: 'faults.timeoutMs',
    default: 120000,
    valid: [
      ['1000', 1000],
      ['3600000', 3600000],
    ],
    invalid: ['999', '3600001', '"120000"', 'null'],
  },
  {
    key: 'faults.maxHeldConnections',
    default: 128,
    valid: [
      ['1', 1],
      ['10000', 10000],
    ],
    invalid: ['0', '10001', '1.5', 'null'],
  },
  {
    key: 'faults.latency',
    default: null,
    valid: [
      ['null', null],
      ['{ ms: 0 }', '{ ms: 0 }'],
      ['{ ms: 60000 }', '{ ms: 60000 }'],
      ['{ min: 200, max: 800 }', '{ min: 200, max: 800 }'],
      ['{ min: 5, max: 5 }', '{ min: 5, max: 5 }'],
    ],
    invalid: [
      '{ ms: 60001 }',
      '{ ms: -1 }',
      '{ ms: 1.5 }',
      '{ min: 9, max: 8 }',
      '{ min: 1 }',
      '{ ms: 1, min: 1, max: 2 }',
      '{ seconds: 1 }',
      '1500',
    ],
  },
  {
    key: 'compression.enabled',
    default: true,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"true"', '1', 'null'],
  },
  {
    key: 'compression.encodings',
    default: ['br', 'gzip', 'deflate'],
    valid: [
      ['[gzip]', ['gzip']],
      ['[deflate, br]', ['deflate', 'br']],
    ],
    invalid: ['[]', '[gzip, gzip]', '[zstd]', '[identity]', 'gzip', 'null'],
  },
  {
    key: 'compression.minBytes',
    default: 1024,
    valid: [
      ['0', 0],
      ['1073741824', 1073741824],
    ],
    invalid: ['-1', '1073741825', '"1KiB"', 'null'],
  },
  {
    key: 'cors.fixtures.origins',
    default: [],
    valid: [
      ['[]', []],
      ['["http://localhost:5173"]', ['http://localhost:5173']],
      ['["HTTP://LocalHost:80"]', ['http://localhost']],
      ['["*"]', ['*']],
    ],
    invalid: ['["*", "http://a.test"]', '["http://a.test/path"]', '["ftp://a.test"]', 'http://a.test', 'null'],
  },
  {
    key: 'cors.fixtures.credentials',
    default: false,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"true"', '1', 'null'],
  },
  {
    key: 'cors.fixtures.maxAge',
    default: 600,
    valid: [
      ['0', 0],
      ['86400', 86400],
    ],
    invalid: ['-1', '86401', '"600"', 'null'],
  },
  {
    key: 'codecs.xml',
    default: true,
    valid: [
      ['true', true],
      ['false', false],
    ],
    invalid: ['"true"', '1', 'null'],
  },
];

describe('settings checked together', () => {
  it('needs maxDecodedBodyBytes at least maxBodyBytes, located at the setting the file names', () => {
    expect(errorsOf('limits:\n  maxBodyBytes: 2048\n  maxDecodedBodyBytes: 1024\n')).toMatchObject([
      { code: 'config-invalid-value', key: 'limits.maxDecodedBodyBytes', line: 3, column: 24, token: '1024' },
    ]);
    expect(errorsOf('limits:\n  maxBodyBytes: 8388608\n')).toMatchObject([
      {
        code: 'config-invalid-value',
        key: 'limits.maxBodyBytes',
        line: 2,
        message: 'limits.maxDecodedBodyBytes (4194304) must be at least limits.maxBodyBytes (8388608)',
      },
    ]);
    expect(valid('limits:\n  maxBodyBytes: 8388608\n  maxDecodedBodyBytes: 8388608\n').ok).toBe(true);
  });

  it('refuses fixture credentials with the wildcard origin', () => {
    expect(errorsOf('cors:\n  fixtures:\n    origins: ["*"]\n    credentials: true\n')).toMatchObject([
      { code: 'config-invalid-value', key: 'cors.fixtures.credentials', line: 4, column: 18 },
    ]);
    expect(valid('cors:\n  fixtures:\n    origins: ["http://a.test"]\n    credentials: true\n').ok).toBe(true);
  });

  it('suggests keys of the nested fixture CORS section', () => {
    const [error] = errorsOf('cors:\n  fixtures:\n    origin: []\n');
    expect(error).toMatchObject({ code: 'config-unknown-key', key: 'cors.fixtures.origin' });
    expect(error?.message).toContain('"origins"');
    expect(errorsOf('cors:\n  fixture: {}\n')[0]?.message).toContain('did you mean "fixtures"?');
  });

  it('keeps the server-wide latency profile in the values and publishes its text', () => {
    const merged = mergeConfig(valid('faults:\n  latency: { min: 10, max: 20 }\n').config, {});
    expect(merged.values.faults.latency).toEqual({ min: 10, max: 20 });
    expect(engineConfig(merged).faults.latency).toEqual({ min: 10, max: 20 });
    expect(configDigest(merged)).not.toBe(configDigest(mergeConfig(undefined, {})));
  });
});

describe('settings', () => {
  it('covers every setting', () => {
    expect(TABLE.map((row) => row.key).sort()).toEqual([...SETTING_KEYS].sort());
  });

  describe.each(TABLE)('$key', (row) => {
    it('defaults without a file and with an empty one', () => {
      const setting = (file: ParseConfigResult | undefined) =>
        mergeConfig(file?.ok === true ? file.config : undefined, {}).settings.find((entry) => entry.key === row.key);
      expect(setting(undefined)).toEqual({ key: row.key, value: row.default, source: 'default' });
      expect(setting(valid(''))).toEqual({ key: row.key, value: row.default, source: 'default' });
    });

    it.each(row.valid)('accepts %s', (text, expected) => {
      expect(valueOf(row.key, yamlFor(row.key, text))).toEqual(expected);
    });

    it.each(row.invalid)('rejects %s with a located config-invalid-value', (text) => {
      const errors = errorsOf(yamlFor(row.key, text));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        code: 'config-invalid-value',
        source: 'config',
        path: SOURCE,
        key: row.key,
        line: row.key.split('.').length,
      });
      expect(errors[0]?.message).toMatch(/^expected .+, got .+/);
    });
  });

  it('lets CLI flags override the file for the settings that have one', () => {
    const file = valid('server:\n  host: 0.0.0.0\n  port: 4020\nfixtures:\n  root: ./fixtures\n');
    const merged = mergeConfig(file.config, { host: 'localhost', port: 4030, fixturesRoot: 'other' }, file.locations);
    expect(merged.values).toMatchObject({
      server: { host: 'localhost', port: 4030 },
      fixtures: { root: 'other' },
    });
    expect(merged.settings.filter((setting) => setting.source === 'cli').map((setting) => setting.key)).toEqual([
      'fixtures.root',
      'server.host',
      'server.port',
    ]);
  });

  it('lets --watch turn on fixtures.watch, and counts both settings in the digest', () => {
    const file = valid('fixtures:\n  watch: false\natlas:\n  resolve: false\n');
    const merged = mergeConfig(file.config, { watch: true }, file.locations);
    expect(merged.values.fixtures.watch).toBe(true);
    expect(merged.values.atlas.resolve).toBe(false);
    expect(merged.settings.find((setting) => setting.key === 'fixtures.watch')?.source).toBe('cli');
    const base = configDigest(mergeConfig(undefined, {}));
    expect(configDigest(mergeConfig(undefined, { watch: true }))).not.toBe(base);
    expect(configDigest(mergeConfig(valid('atlas:\n  resolve: false\n').config, {}))).not.toBe(base);
  });

  it('explains that size suffixes are not supported', () => {
    expect(errorsOf('limits:\n  maxBodyBytes: 10MiB\n')[0]?.message).toBe(
      'expected a non-negative integer, got "10MiB"; size suffixes are not supported, write the number of bytes',
    );
  });

  it('describes the allowed values of onUnknownMethod', () => {
    expect(errorsOf('onUnknownMethod: 403\n')).toEqual([
      {
        code: 'config-invalid-value',
        source: 'config',
        path: SOURCE,
        line: 1,
        column: 18,
        token: '403',
        key: 'onUnknownMethod',
        message: 'expected 404 or 405, got 403',
      },
    ]);
  });

  it('validates hosts the same way for flags', () => {
    expect(isValidHost('127.0.0.1')).toBe(true);
    expect(isValidHost('fe80::1')).toBe(true);
    expect(isValidHost('a_b')).toBe(false);
    expect(isValidHost('')).toBe(false);
  });
});

describe('parseConfig', () => {
  it('accepts an empty document, comments only, and an explicit null', () => {
    for (const text of ['', '\n', '# nothing here\n', '~\n']) {
      expect(parse(text)).toEqual({ ok: true, config: {}, warnings: [], locations: {} });
    }
  });

  it('accepts and ignores a top-level $schema', () => {
    const result = valid('$schema: ./node_modules/@janus/server/schema/janus.config.schema.json\n');
    expect(mergeConfig(result.config, {})).toEqual(mergeConfig({}, {}));
    expect(errorsOf('$schema: 5\n')[0]).toMatchObject({ code: 'config-invalid-value', key: '$schema' });
  });

  it('allows anchors and aliases', () => {
    const result = valid('limits:\n  maxUrlBytes: &size 4096\n  maxHeaderBytes: *size\n');
    expect(result.config.limits).toEqual({ maxUrlBytes: 4096, maxHeaderBytes: 4096 });
  });

  it('records where each setting is written', () => {
    expect(valid('server:\n  port: 4020\nonUnknownMethod: 404\n').locations).toEqual({
      'server.port': { line: 2, column: 9 },
      onUnknownMethod: { line: 3, column: 18 },
    });
  });

  describe('unknown keys', () => {
    it.each([
      ['prot: 1\n', 'prot', 'unknown key "prot"', 1, 1],
      ['sever:\n  port: 1\n', 'sever', 'unknown key "sever"; did you mean "server"?', 1, 1],
      ['server:\n  prot: 4010\n', 'server.prot', 'unknown key "prot" under "server"; did you mean "port"?', 2, 3],
      ['server:\n  hots: x\n', 'server.hots', 'unknown key "hots" under "server"; did you mean "host"?', 2, 3],
      ['fixtures:\n  data: x\n', 'fixtures.data', 'unknown key "data" under "fixtures"', 2, 3],
      [
        'limits:\n  maxbodybytes: 1\n',
        'limits.maxbodybytes',
        'unknown key "maxbodybytes" under "limits"; did you mean "maxBodyBytes"?',
        2,
        3,
      ],
      [
        'onUnknownMethods: 404\n',
        'onUnknownMethods',
        'unknown key "onUnknownMethods"; did you mean "onUnknownMethod"?',
        1,
        1,
      ],
      ['plugins: {}\n', 'plugins', 'unknown key "plugins"', 1, 1],
    ])('reports %j', (text, key, message, line, column) => {
      expect(errorsOf(text)).toEqual([
        {
          code: 'config-unknown-key',
          source: 'config',
          path: SOURCE,
          line,
          column,
          token: key.split('.').at(-1),
          key,
          message,
        },
      ]);
    });

    it('reports every unknown key at every depth in one pass', () => {
      expect(errorsOf('a: 1\nserver:\n  b: 2\n  port: 1\nlimits:\n  c: 3\n').map((error) => error.key)).toEqual([
        'a',
        'server.b',
        'limits.c',
      ]);
    });
  });

  it('suggests only plausibly intended keys', () => {
    expect(suggest('prot', ['host', 'port'])).toBe('port');
    expect(suggest('PORT', ['port'])).toBe('port');
    expect(suggest('xyz', ['port'])).toBeNull();
    expect(suggest('root', ['host', 'port', 'strictTrailingSlash'])).toBeNull();
  });

  it('rejects duplicate keys instead of letting the last one win', () => {
    expect(errorsOf('server:\n  port: 1\n  port: 2\n')).toEqual([
      {
        code: 'config-duplicate-key',
        source: 'config',
        path: SOURCE,
        line: 3,
        column: 3,
        token: 'port',
        key: 'server.port',
        message: 'duplicate key "port"; each key may appear only once per mapping',
      },
    ]);
  });

  it.each([
    ['a: [1,\n', 2, 1],
    ['server:\n\tport: 1\n', 2, 1],
    ['a: "unterminated\n', 2, 1],
    ['---\na: 1\n---\nb: 2\n', 3, 1],
  ])('reports YAML syntax errors with a location: %j', (text, line, column) => {
    const errors = errorsOf(text);
    expect(errors[0]).toMatchObject({ code: 'config-invalid-yaml', source: 'config', path: SOURCE, line, column });
    expect(errors[0]?.message).toMatch(/^invalid YAML: [a-z]/);
  });

  it('reports a YAML alias bomb as invalid YAML at the document start', () => {
    const levels = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 8; i++) {
      const previous = String.fromCharCode(96 + i);
      const name = String.fromCharCode(97 + i);
      levels.push(`${name}: &${name} [${Array.from({ length: 10 }, () => `*${previous}`).join(', ')}]`);
    }
    const errors = errorsOf(`# expands to 10^8 items\n${levels.join('\n')}\n`);
    expect(errors).toEqual([
      expect.objectContaining({ code: 'config-invalid-yaml', source: 'config', path: SOURCE, line: 1, column: 1 }),
    ]);
    expect(errors[0]?.message).toMatch(/^invalid YAML: [a-z].*alias/);
  });

  it.each([
    ['- a\n', 'not a list'],
    ['5\n', 'not a single value'],
    ['just text\n', 'not a single value'],
  ])('requires a mapping: %j', (text, message) => {
    expect(errorsOf(text)).toEqual([
      expect.objectContaining({
        code: 'config-invalid-yaml',
        line: 1,
        column: 1,
        message: expect.stringContaining(message) as unknown,
      }),
    ]);
  });

  it('rejects custom tags and still reports the other problems', () => {
    expect(errorsOf('server:\n  host: !env HOST\nfixtures:\n  root: !!js/function x\nprot: 1\n')).toEqual([
      expect.objectContaining({ code: 'config-invalid-yaml', token: '!env', line: 2, column: 9 }),
      expect.objectContaining({ code: 'config-invalid-yaml', token: '!!js/function', line: 4, column: 9 }),
      expect.objectContaining({ code: 'config-unknown-key', key: 'prot', line: 5 }),
    ]);
  });

  it('accepts core tags', () => {
    expect(valid('fixtures:\n  root: !!str 5\n').config).toEqual({ fixtures: { root: '5' } });
  });

  it('reports a section of the wrong type', () => {
    expect(errorsOf('server: 5\n')).toEqual([
      expect.objectContaining({
        code: 'config-invalid-value',
        key: 'server',
        line: 1,
        column: 9,
        token: '5',
        message: 'expected a mapping of server settings, got 5',
      }),
    ]);
  });

  it('collects every problem, sorted by position', () => {
    const errors = errorsOf(
      [
        'server:',
        '  host: 127.0.0.1',
        '  prot: 4010',
        '  port: 70000',
        'fixtures:',
        '  root: ./data',
        'onUnknownMethod: 403',
        'limits:',
        '  maxBodyBytes: 10MiB',
        '',
      ].join('\n'),
    );
    expect(errors.map((error) => `${String(error.line)}:${String(error.column)} ${error.code}`)).toEqual([
      '3:3 config-unknown-key',
      '4:9 config-invalid-value',
      '7:18 config-invalid-value',
      '9:17 config-invalid-value',
    ]);
  });

  describe('partial', () => {
    const partialOf = (text: string) => {
      const result = parse(text);
      if (result.ok) throw new Error('expected errors');
      return result.partial;
    };

    it('holds exactly the settings that validated', () => {
      expect(
        partialOf('server:\n  host: 127.0.0.1\n  port: x\nfixtures:\n  root: ./fx\nonUnknownMethod: 403\nextra: 1\n'),
      ).toEqual({ server: { host: '127.0.0.1' }, fixtures: { root: './fx' } });
    });

    it('omits duplicated, custom-tagged, and mistyped sections', () => {
      expect(partialOf('fixtures:\n  root: a\n  root: b\nserver: 5\n')).toEqual({});
      expect(partialOf('fixtures:\n  root: !env DATA\nlimits:\n  maxBodyBytes: 5\n')).toEqual({
        limits: { maxBodyBytes: 5 },
      });
    });

    it('is empty after a YAML syntax error', () => {
      expect(partialOf('fixtures:\n  root: ./fx\nserver: [\n')).toEqual({});
    });
  });
});

describe('mergeConfig', () => {
  it('uses defaults, then the file, then CLI flags, and records each source', () => {
    const file = valid('server:\n  port: 4020\n  strictTrailingSlash: false\nonUnknownMethod: 404\n');
    const merged = mergeConfig(file.config, { port: 4030 }, file.locations);
    expect(merged.configFile).toBe(true);
    expect(merged.settings).toEqual([
      { key: 'atlas.resolve', value: true, source: 'default' },
      { key: 'codecs.xml', value: true, source: 'default' },
      { key: 'compression.enabled', value: true, source: 'default' },
      { key: 'compression.encodings', value: ['br', 'gzip', 'deflate'], source: 'default' },
      { key: 'compression.minBytes', value: 1024, source: 'default' },
      { key: 'cors.fixtures.credentials', value: false, source: 'default' },
      { key: 'cors.fixtures.maxAge', value: 600, source: 'default' },
      { key: 'cors.fixtures.origins', value: [], source: 'default' },
      { key: 'cors.maxAge', value: 600, source: 'default' },
      { key: 'cors.origins', value: [], source: 'default' },
      { key: 'diagnostics.headers', value: true, source: 'default' },
      { key: 'dynamic.aliases', value: {}, source: 'default' },
      { key: 'dynamic.clockMode', value: 'frozen', source: 'default' },
      { key: 'dynamic.now', value: null, source: 'default' },
      { key: 'dynamic.seed', value: null, source: 'default' },
      { key: 'dynamic.strictRefs', value: false, source: 'default' },
      { key: 'dynamic.timezone', value: 'UTC', source: 'default' },
      { key: 'faults.enabled', value: true, source: 'default' },
      { key: 'faults.latency', value: null, source: 'default' },
      { key: 'faults.maxHeldConnections', value: 128, source: 'default' },
      { key: 'faults.timeoutMs', value: 120000, source: 'default' },
      { key: 'fixtures.root', value: './data', source: 'default' },
      { key: 'fixtures.watch', value: false, source: 'default' },
      { key: 'idempotency.enabled', value: true, source: 'default' },
      { key: 'idempotency.header', value: 'Idempotency-Key', source: 'default' },
      { key: 'idempotency.maxEntries', value: 1000, source: 'default' },
      { key: 'idempotency.methods', value: ['POST', 'PATCH'], source: 'default' },
      { key: 'limits.maxBodyBytes', value: 1048576, source: 'default' },
      { key: 'limits.maxDecodedBodyBytes', value: 4194304, source: 'default' },
      { key: 'limits.maxHeaderBytes', value: 16384, source: 'default' },
      { key: 'limits.maxUrlBytes', value: 8192, source: 'default' },
      { key: 'negotiation.mediaTypePreference', value: [], source: 'default' },
      { key: 'negotiation.onUnacceptable', value: 406, source: 'default' },
      { key: 'negotiation.onUnusableAccept', value: 400, source: 'default' },
      { key: 'onNoFixture', value: 404, source: 'default' },
      { key: 'onUnknownMethod', value: 404, source: 'file', line: 4, column: 18 },
      { key: 'promotion.mode', value: 'staged', source: 'default' },
      { key: 'recording.allowNonLoopback', value: false, source: 'default' },
      { key: 'recording.captures', value: './captures', source: 'default' },
      { key: 'recording.endpoints', value: [], source: 'default' },
      { key: 'recording.maxConcurrent', value: 4, source: 'default' },
      { key: 'recording.maxResponseBytes', value: 10485760, source: 'default' },
      { key: 'recording.timeoutMs', value: 30000, source: 'default' },
      { key: 'runner.allowNonLoopback', value: false, source: 'default' },
      { key: 'runner.extraCaCerts', value: [], source: 'default' },
      { key: 'runner.keepRuns', value: 50, source: 'default' },
      { key: 'runner.maxActiveRuns', value: 2, source: 'default' },
      { key: 'runner.maxImportBytes', value: 52428800, source: 'default' },
      { key: 'runner.root', value: './requests', source: 'default' },
      { key: 'runner.scriptMemoryBytes', value: 33554432, source: 'default' },
      { key: 'runner.scriptTimeoutMs', value: 1000, source: 'default' },
      { key: 'runner.skipTlsVerify', value: false, source: 'default' },
      { key: 'scenarios.default', value: 'default', source: 'default' },
      { key: 'server.autoOptions', value: true, source: 'default' },
      { key: 'server.host', value: '127.0.0.1', source: 'default' },
      { key: 'server.port', value: 4030, source: 'cli' },
      { key: 'server.strictTrailingSlash', value: false, source: 'file', line: 3, column: 24 },
      { key: 'sessions.idleTimeout', value: 1800, source: 'default' },
      { key: 'sessions.keyFrom', value: [], source: 'default' },
      { key: 'sessions.max', value: 1000, source: 'default' },
      { key: 'ui.enabled', value: true, source: 'default' },
    ]);
    expect(engineConfig(merged)).toEqual({
      strictTrailingSlash: false,
      onUnknownMethod: 404,
      mediaTypePreference: [],
      onUnusableAccept: 400,
      onUnacceptable: 406,
      diagnosticHeaders: true,
      now: null,
      clockMode: 'frozen',
      timezone: 'UTC',
      seed: null,
      strictRefs: false,
      defaultScenario: 'default',
      keyFrom: [],
      idleTimeout: 1800,
      maxSessions: 1000,
      onNoFixture: 404,
      idempotency: { enabled: true, header: 'idempotency-key', methods: ['POST', 'PATCH'], maxEntries: 1000 },
      recording: { endpoints: [], maxConcurrent: 4, timeoutMs: 30000, maxResponseBytes: 10485760 },
      promotionMode: 'staged',
      ...M12_ENGINE_DEFAULTS,
    });
  });

  it('passes the negotiation and diagnostics sections to the engine', () => {
    const file = valid(
      'negotiation:\n  mediaTypePreference: [application/yaml]\n  onUnusableAccept: any\n  onUnacceptable: ignore\ndiagnostics:\n  headers: false\n',
    );
    expect(engineConfig(mergeConfig(file.config, {}, file.locations))).toEqual({
      strictTrailingSlash: true,
      onUnknownMethod: 405,
      mediaTypePreference: ['application/yaml'],
      onUnusableAccept: 'any',
      onUnacceptable: 'ignore',
      diagnosticHeaders: false,
      now: null,
      clockMode: 'frozen',
      timezone: 'UTC',
      seed: null,
      strictRefs: false,
      defaultScenario: 'default',
      keyFrom: [],
      idleTimeout: 1800,
      maxSessions: 1000,
      onNoFixture: 404,
      idempotency: { enabled: true, header: 'idempotency-key', methods: ['POST', 'PATCH'], maxEntries: 1000 },
      recording: { endpoints: [], maxConcurrent: 4, timeoutMs: 30000, maxResponseBytes: 10485760 },
      promotionMode: 'staged',
      ...M12_ENGINE_DEFAULTS,
    });
  });

  it('passes the scenarios and sessions sections to the engine, with --scenario over the file', () => {
    const file = valid(
      'scenarios:\n  default: guest\nsessions:\n  keyFrom: [header.x-cart]\n  idleTimeout: 60\n  max: 5\n',
    );
    expect(engineConfig(mergeConfig(file.config, {}, file.locations))).toMatchObject({
      defaultScenario: 'guest',
      keyFrom: ['header.x-cart'],
      idleTimeout: 60,
      maxSessions: 5,
    });
    const merged = mergeConfig(file.config, { scenario: 'other' }, file.locations);
    expect(engineConfig(merged).defaultScenario).toBe('other');
    expect(snapshotOptions(merged)).toEqual({ aliases: {}, defaultScenario: 'other', fixtureCors: false });
  });

  it('passes the dynamic section to the engine, with --seed and --now over the file', () => {
    const file = valid(
      'dynamic:\n  now: 2026-01-01T09:00:00+09:00\n  clockMode: offset\n  timezone: Asia/Tokyo\n  seed: 7\n  strictRefs: true\n',
    );
    expect(engineConfig(mergeConfig(file.config, {}, file.locations))).toMatchObject({
      now: Date.UTC(2026, 0, 1),
      clockMode: 'offset',
      timezone: 'Asia/Tokyo',
      seed: 7,
      strictRefs: true,
    });
    const merged = mergeConfig(file.config, { seed: 42, now: '2027-01-01T00:00:00Z' }, file.locations);
    expect(engineConfig(merged)).toMatchObject({ now: Date.UTC(2027, 0, 1), seed: 42 });
    expect(merged.settings.filter((setting) => setting.source === 'cli').map((setting) => setting.key)).toEqual([
      'dynamic.now',
      'dynamic.seed',
    ]);
  });

  it('reproduces the built-in defaults with no file', () => {
    const merged = mergeConfig(undefined, {});
    expect(merged.configFile).toBe(false);
    expect(merged.values).toEqual(CONFIG_DEFAULTS);
    expect(Object.isFrozen(merged.settings[0])).toBe(true);
  });

  it('publishes no path or bind details', () => {
    const merged = mergeConfig(valid('server:\n  host: 0.0.0.0\nfixtures:\n  root: /secret/place\n').config, {});
    const published = publicSettings(merged);
    expect(published.map((setting) => setting.key)).toEqual([
      'atlas.resolve',
      'codecs.xml',
      'compression.enabled',
      'compression.encodings',
      'compression.minBytes',
      'cors.fixtures.credentials',
      'cors.fixtures.maxAge',
      'cors.fixtures.origins',
      'cors.maxAge',
      'cors.origins',
      'diagnostics.headers',
      'dynamic.aliases',
      'dynamic.clockMode',
      'dynamic.now',
      'dynamic.seed',
      'dynamic.strictRefs',
      'dynamic.timezone',
      'faults.enabled',
      'faults.latency',
      'faults.maxHeldConnections',
      'faults.timeoutMs',
      'fixtures.watch',
      'idempotency.enabled',
      'idempotency.header',
      'idempotency.maxEntries',
      'idempotency.methods',
      'limits.maxBodyBytes',
      'limits.maxDecodedBodyBytes',
      'limits.maxHeaderBytes',
      'limits.maxUrlBytes',
      'negotiation.mediaTypePreference',
      'negotiation.onUnacceptable',
      'negotiation.onUnusableAccept',
      'onNoFixture',
      'onUnknownMethod',
      'promotion.mode',
      'recording.allowNonLoopback',
      'recording.captures',
      'recording.endpoints',
      'recording.maxConcurrent',
      'recording.maxResponseBytes',
      'recording.timeoutMs',
      'runner.allowNonLoopback',
      'runner.extraCaCerts',
      'runner.keepRuns',
      'runner.maxActiveRuns',
      'runner.maxImportBytes',
      'runner.root',
      'runner.scriptMemoryBytes',
      'runner.scriptTimeoutMs',
      'runner.skipTlsVerify',
      'scenarios.default',
      'server.autoOptions',
      'server.strictTrailingSlash',
      'sessions.idleTimeout',
      'sessions.keyFrom',
      'sessions.max',
      'ui.enabled',
    ]);
    expect(JSON.stringify(published)).not.toContain('/secret/place');
    expect(published.every((setting) => !('line' in setting))).toBe(true);
  });
});

describe('configDigest', () => {
  const digestOf = (text: string, overrides = {}): string => {
    const result = valid(text);
    return configDigest(mergeConfig(result.config, overrides));
  };

  it('has the documented form', () => {
    expect(digestOf('')).toMatch(/^cfg_[0-9a-f]{16}$/);
  });

  it('ignores key order, comments, anchors, formatting, and whether a value is defaulted', () => {
    const base = digestOf('onUnknownMethod: 404\nlimits:\n  maxUrlBytes: 4096\n  maxHeaderBytes: 4096\n');
    expect(digestOf('limits: {maxHeaderBytes: 4096, maxUrlBytes: 4096}\n# note\nonUnknownMethod:   404\n')).toBe(base);
    expect(digestOf('limits:\n  maxUrlBytes: &n 4096\n  maxHeaderBytes: *n\nonUnknownMethod: 404\n')).toBe(base);
    expect(digestOf('server:\n  strictTrailingSlash: true\n')).toBe(digestOf(''));
  });

  it('ignores fixtures.root, server.host and server.port', () => {
    const base = digestOf('');
    expect(digestOf('server:\n  host: 0.0.0.0\n  port: 1\nfixtures:\n  root: ./elsewhere\n')).toBe(base);
    expect(digestOf('', { host: 'localhost', port: 9, fixturesRoot: 'x' })).toBe(base);
  });

  it.each([
    'server:\n  strictTrailingSlash: false\n',
    'onUnknownMethod: 404\n',
    'limits:\n  maxUrlBytes: 4096\n',
    'limits:\n  maxHeaderBytes: 4096\n',
    'limits:\n  maxBodyBytes: 0\n',
    'negotiation:\n  mediaTypePreference: [application/yaml]\n',
    'negotiation:\n  mediaTypePreference: [application/yaml, application/json]\n',
    'negotiation:\n  onUnusableAccept: any\n',
    'negotiation:\n  onUnacceptable: ignore\n',
    'diagnostics:\n  headers: false\n',
    'dynamic:\n  now: 2026-01-01T00:00:00Z\n',
    'dynamic:\n  clockMode: offset\n',
    'dynamic:\n  timezone: Europe/Paris\n',
    'dynamic:\n  seed: 0\n',
    'dynamic:\n  strictRefs: true\n',
    'dynamic:\n  aliases: {a: today}\n',
  ])('changes when a behaviour-affecting value changes: %j', (text) => {
    expect(digestOf(text)).not.toBe(digestOf(''));
  });

  it('includes --seed and --now, and tells aliases apart by name and expression', () => {
    expect(digestOf('', { seed: 1 })).not.toBe(digestOf(''));
    expect(digestOf('', { now: '2026-01-01T00:00:00Z' })).toBe(digestOf('dynamic:\n  now: 2026-01-01T00:00:00Z\n'));
    expect(digestOf('dynamic:\n  aliases: {a: today, b: now}\n')).toBe(
      digestOf('dynamic:\n  aliases: {b: now, a: today}\n'),
    );
    expect(digestOf('dynamic:\n  aliases: {a: today}\n')).not.toBe(digestOf('dynamic:\n  aliases: {b: today}\n'));
  });
});

describe('dynamic section errors', () => {
  it('reports a zone that is not an IANA zone as unknown-timezone', () => {
    expect(errorsOf('dynamic:\n  timezone: Mars/Olympus\n')).toEqual([
      expect.objectContaining({ code: 'unknown-timezone', key: 'dynamic.timezone', line: 2, column: 13 }),
    ]);
  });

  it.each([
    ['{today: now}', 'today', 'shadows the built-in value'],
    ['{uuid: now}', 'uuid', 'shadows the built-in value'],
    ['{a: b, b: a}', 'a', 'refers to itself through a → b → a'],
    ['{a: a+1d}', 'a', 'refers to itself through a → a'],
    ['{a: tommorow}', 'a', 'expands to unknown value "tommorow"; did you mean "tomorrow"?'],
    ['{a: uuid}', 'a', 'expands to unknown value "uuid"'],
    ['{a: today+1m}', 'a', 'write min for minutes or mo for months'],
    ['{a: today@UTC}', 'a', 'may only add offsets'],
    ['{"bad name": today}', 'bad name', 'must be a letter'],
  ])('reports aliases %s as invalid-alias', (aliases, name, message) => {
    const errors = errorsOf(`dynamic:\n  aliases: ${aliases}\n`);
    expect(errors[0]).toMatchObject({ code: 'invalid-alias', key: 'dynamic.aliases', token: name, line: 2 });
    expect(errors.map((error) => error.message).join('\n')).toContain(message);
  });

  it('accepts aliases of aliases in any order', () => {
    expect(valid('dynamic:\n  aliases: {graceEnd: trialEnd+7d, trialEnd: oneMonthFromToday-1d}\n').ok).toBe(true);
  });
});

describe('configJsonSchema', () => {
  it('is a strict draft 2020-12 schema with every setting and its default', () => {
    interface Property {
      properties?: Record<string, Property>;
      default?: unknown;
    }
    const schema = configJsonSchema as unknown as { $schema: string; additionalProperties: boolean } & Property;
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.additionalProperties).toBe(false);
    for (const row of TABLE) {
      const property = row.key
        .split('.')
        .reduce<Property | undefined>((node, part) => node?.properties?.[part], schema);
      expect(property?.default, row.key).toEqual(row.default);
    }
  });
});
