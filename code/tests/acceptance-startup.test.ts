import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The startup acceptance journey, CLI steps.
// The browser steps are in tests/e2e/config.spec.ts.

const workspace = resolve(import.meta.dirname, '..');
const BIN = join(workspace, 'apps/server/src/bin.ts');
const TSX = join(workspace, 'node_modules/tsx/dist/esm/index.mjs');

let root: string;
const children: ReturnType<typeof spawn>[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'janus-startup-'));
});

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
});

async function write(tree: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, contents] of Object.entries(tree)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
}

interface Run {
  readonly output: { stdout: string; stderr: string };
  readonly exited: Promise<number | null>;
  kill(): void;
}

/** Runs `janus` from source with `root` as the working directory, so the config file is discovered there. */
function janus(args: readonly string[]): Run {
  const proc = spawn(process.execPath, ['--import', TSX, '--conditions=@janus/source', BIN, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  const output = { stdout: '', stderr: '' };
  proc.stdout.setEncoding('utf8').on('data', (chunk: string) => (output.stdout += chunk));
  proc.stderr.setEncoding('utf8').on('data', (chunk: string) => (output.stderr += chunk));
  const exited = new Promise<number | null>((done) => proc.once('exit', done));
  return { output, exited, kill: () => proc.kill('SIGTERM') };
}

async function waitForUrl(run: Run): Promise<string> {
  for (let i = 0; i < 300; i++) {
    const url = /listening on (\S+)/.exec(run.output.stdout)?.[1];
    if (url !== undefined) return url;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`janus did not start:\n${run.output.stdout}\n${run.output.stderr}`);
}

function rawGet(url: string, target: string, headers: Record<string, string> = {}) {
  const { hostname, port } = new URL(url);
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((done, fail) => {
    const req = request({ hostname, port, method: 'GET', path: target, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
      res.on('end', () => {
        done({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on('error', fail);
    req.end();
  });
}

const CONFIG = `$schema: ./node_modules/@janus/server/schema/janus.config.schema.json
server:
  host: 127.0.0.1
  port: 0
fixtures:
  root: ./fixtures
onUnknownMethod: 404
limits:
  maxUrlBytes: 512
  maxHeaderBytes: 2048
  maxBodyBytes: 64
`;

const FIXTURES = {
  'fixtures/default/v1/products/GET/200_{application-json}.json': '[{"id":"p-1"}]',
  'fixtures/default/v1/products/POST/201_{application-json}.json': '{"id":"p-2"}',
};

describe('janus validate and serve with a configuration file (acceptance)', { timeout: 30_000 }, () => {
  it('reports every problem, validates the fix, and serves exactly what the file says', async () => {
    // 1. Two typos in the config and a JSON syntax error in a fixture: all three, located, exit 1.
    await write({
      ...FIXTURES,
      'janus.config.yaml': CONFIG.replace('  port: 0', '  prot: 0').replace(
        'onUnknownMethod: 404',
        'onUnknownMethd: 404',
      ),
      'fixtures/default/v1/products/GET/200_{application-json}.json': '[{"id":"p-1"},]',
    });
    const broken = janus(['validate']);
    await expect(broken.exited).resolves.toBe(1);
    expect(broken.output.stderr).toBe(
      [
        'janus: 3 startup errors; invalid.',
        '  janus.config.yaml:4:3: unknown key "prot" under "server"; did you mean "port"? [config-unknown-key]',
        '  janus.config.yaml:7:1: unknown key "onUnknownMethd"; did you mean "onUnknownMethod"? [config-unknown-key]',
        '  fixtures/default/v1/products/GET/200_{application-json}.json:1:15: invalid JSON: unexpected "]" [invalid-json]',
        '',
      ].join('\n'),
    );
    expect(broken.output.stdout).toBe('');

    // 2. Fixed: `validate --format json` exits 0 with the digest and the snapshot version.
    await write({ ...FIXTURES, 'janus.config.yaml': CONFIG });
    const fixed = janus(['validate', '--format', 'json']);
    await expect(fixed.exited).resolves.toBe(0);
    const report = JSON.parse(fixed.output.stdout) as {
      valid: boolean;
      configDigest: string;
      snapshotVersion: string;
      errors: unknown[];
      warnings: unknown[];
    };
    expect(report).toMatchObject({ valid: true, errors: [], warnings: [] });
    expect(report.configDigest).toMatch(/^cfg_[0-9a-f]{16}$/);
    expect(report.snapshotVersion).toMatch(/^[0-9a-f]{16}$/);

    // 3. `serve` discovers the file; health reports the digest `validate` printed.
    const server = janus(['serve']);
    const url = await waitForUrl(server);
    expect(server.output.stdout).toContain(`(data: ${join(root, 'fixtures')})`);
    const health = JSON.parse((await rawGet(url, '/_janus/health')).body) as Record<string, unknown>;
    expect(health).toMatchObject({ configDigest: report.configDigest, snapshotVersion: report.snapshotVersion });
    // Running from source without a UI build adds ui-assets-missing.
    const warnings = health['warnings'] as { code: string }[];
    expect(warnings.filter((warning) => warning.code !== 'ui-assets-missing')).toEqual([]);
    const config = JSON.parse((await rawGet(url, '/_janus/config')).body) as Record<string, unknown>;
    expect(config).toEqual({
      apiVersion: 'atlas.v1',
      configDigest: report.configDigest,
      configFile: true,
      settings: [
        // atlas.resolve and fixtures.watch.
        { key: 'atlas.resolve', value: true, source: 'default' },
        // codecs, compression, cors.fixtures, faults, limits.maxDecodedBodyBytes and server.autoOptions.
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
        { key: 'fixtures.watch', value: false, source: 'default' },
        { key: 'idempotency.enabled', value: true, source: 'default' },
        { key: 'idempotency.header', value: 'Idempotency-Key', source: 'default' },
        { key: 'idempotency.maxEntries', value: 1000, source: 'default' },
        { key: 'idempotency.methods', value: ['POST', 'PATCH'], source: 'default' },
        { key: 'limits.maxBodyBytes', value: 64, source: 'file' },
        { key: 'limits.maxDecodedBodyBytes', value: 4194304, source: 'default' },
        { key: 'limits.maxHeaderBytes', value: 2048, source: 'file' },
        { key: 'limits.maxUrlBytes', value: 512, source: 'file' },
        { key: 'negotiation.mediaTypePreference', value: [], source: 'default' },
        { key: 'negotiation.onUnacceptable', value: 406, source: 'default' },
        { key: 'negotiation.onUnusableAccept', value: 400, source: 'default' },
        { key: 'onNoFixture', value: 404, source: 'default' },
        { key: 'onUnknownMethod', value: 404, source: 'file' },
        { key: 'promotion.mode', value: 'staged', source: 'default' },
        { key: 'recording.allowNonLoopback', value: false, source: 'default' },
        { key: 'recording.captures', value: 'set', source: 'default' },
        { key: 'recording.endpoints', value: [], source: 'default' },
        { key: 'recording.maxConcurrent', value: 4, source: 'default' },
        { key: 'recording.maxResponseBytes', value: 10485760, source: 'default' },
        { key: 'recording.timeoutMs', value: 30000, source: 'default' },
        { key: 'runner.allowNonLoopback', value: false, source: 'default' },
        { key: 'runner.extraCaCerts', value: [], source: 'default' },
        { key: 'runner.keepRuns', value: 50, source: 'default' },
        { key: 'runner.maxActiveRuns', value: 2, source: 'default' },
        { key: 'runner.maxImportBytes', value: 52428800, source: 'default' },
        { key: 'runner.root', value: 'set', source: 'default' },
        { key: 'runner.scriptMemoryBytes', value: 33554432, source: 'default' },
        { key: 'runner.scriptTimeoutMs', value: 1000, source: 'default' },
        { key: 'runner.skipTlsVerify', value: false, source: 'default' },
        { key: 'scenarios.default', value: 'default', source: 'default' },
        { key: 'server.autoOptions', value: true, source: 'default' },
        { key: 'server.strictTrailingSlash', value: true, source: 'default' },
        { key: 'sessions.idleTimeout', value: 1800, source: 'default' },
        { key: 'sessions.keyFrom', value: [], source: 'default' },
        { key: 'sessions.max', value: 1000, source: 'default' },
        { key: 'ui.enabled', value: true, source: 'default' },
      ],
    });
    expect(JSON.stringify(config)).not.toContain(root);

    // 5. onUnknownMethod and the limits behave as configured over HTTP.
    const hidden = await fetch(`${url}/v1/products`, { method: 'DELETE' });
    expect(hidden.status).toBe(404);
    expect(hidden.headers.get('allow')).toBeNull();
    expect(await hidden.json()).toMatchObject({ error: { code: 'route-not-found' } });

    expect((await rawGet(url, `/v1/products?q=${'x'.repeat(400)}`)).status).toBe(200);
    const long = await rawGet(url, `/v1/products?q=${'x'.repeat(600)}`);
    expect(long.status).toBe(414);
    expect(JSON.parse(long.body)).toMatchObject({ error: { code: 'url-too-long' } });

    const big = await rawGet(url, '/v1/products', { 'x-padding': 'a'.repeat(3000) });
    expect(big.status).toBe(431);
    expect(big.headers['connection']).toBe('close');
    expect(JSON.parse(big.body)).toMatchObject({ error: { code: 'headers-too-large' } });

    const small = await fetch(`${url}/v1/products`, { method: 'POST', body: 'x'.repeat(64) });
    expect(small.status).toBe(201);
    const large = await fetch(`${url}/v1/products`, { method: 'POST', body: 'x'.repeat(65) });
    expect(large.status).toBe(413);

    server.kill();
    if (process.platform !== 'win32') await expect(server.exited).resolves.toBe(0);
  });

  it('refuses to serve when the configuration and fixtures are broken, reporting both, and binds nothing', async () => {
    await write({
      'janus.config.yaml': 'server:\n  port: 0\nfixtures:\n  root: ./fixtures\nlimits:\n  maxBodyBytes: 10MiB\n',
      'fixtures/default/v1/get/204': '',
    });
    const run = janus(['serve']);
    await expect(run.exited).resolves.toBe(1);
    expect(run.output.stdout).not.toContain('listening');
    expect(run.output.stderr).toContain('janus: 2 startup errors; not starting.');
    expect(run.output.stderr).toContain('  janus.config.yaml:6:17: expected a non-negative integer, got "10MiB"');
    expect(run.output.stderr).toContain('  fixtures/default/v1/get: ');
  });

  it('lets a flag override the file', async () => {
    await write({ ...FIXTURES, 'janus.config.yaml': CONFIG.replace('port: 0', 'port: 1') });
    const run = janus(['serve', '--port', '0']);
    const url = await waitForUrl(run);
    expect(new URL(url).port).not.toBe('1');
    expect(run.output.stdout).toContain('janus config-override key=server.port file=1 cli=0');
    run.kill();
    await run.exited;
  });
});
