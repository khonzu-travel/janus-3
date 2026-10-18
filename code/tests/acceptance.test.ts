import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import { dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The acceptance journey, run against a
// real `janus` process started from source.

const workspace = resolve(import.meta.dirname, '..');
const BIN = join(workspace, 'apps/server/src/bin.ts');
const PRODUCTS_JSON = '[ { "id": "p-1",  "name": "Example" } ]\n';

let root: string;
let child: ChildProcess | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'janus-acceptance-'));
});

afterEach(async () => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  child = undefined;
  await rm(root, { recursive: true, force: true });
});

async function write(tree: Readonly<Record<string, string>>): Promise<string> {
  for (const [path, contents] of Object.entries(tree)) {
    const absolute = join(root, 'data', ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  return join(root, 'data');
}

interface Janus {
  readonly process: ChildProcessByStdio<null, Readable, Readable>;
  readonly output: { stdout: string; stderr: string };
  readonly exited: Promise<number | null>;
}

function startJanus(args: readonly string[]): Janus {
  const proc = spawn(process.execPath, ['--import', 'tsx', '--conditions=@janus/source', BIN, ...args], {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  const output = { stdout: '', stderr: '' };
  proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output.stdout += chunk;
  });
  proc.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output.stderr += chunk;
  });
  const exited = new Promise<number | null>((done) => {
    proc.once('exit', (code) => {
      done(code);
    });
  });
  return { process: proc, output, exited };
}

async function waitForUrl(janus: Janus): Promise<string> {
  for (let i = 0; i < 300; i++) {
    const url = /listening on (\S+)/.exec(janus.output.stdout)?.[1];
    if (url !== undefined) return url;
    if (janus.process.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`janus did not start:\n${janus.output.stdout}\n${janus.output.stderr}`);
}

/** Sends a request with the target exactly as written (fetch would normalise it). */
function rawRequest(url: string, method: string, target: string) {
  const { hostname, port } = new URL(url);
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>(
    (done, fail) => {
      const req = request({ hostname, port, method, path: target }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
      });
      req.on('error', fail);
      req.end();
    },
  );
}

describe('janus serve (acceptance)', { timeout: 30_000 }, () => {
  it('replays fixtures, classifies misses, and shuts down cleanly', async () => {
    const data = await write({
      'default/v1/products/GET/200_{application-json}.json': PRODUCTS_JSON,
      'default/v1/products/GET/200.headers.json': '{"X-Example":"fixture","Set-Cookie":["a=1","b=2"]}',
      'default/v1/products/POST/201_{application-json}.json': '{"id":"p-2"}',
      'default/v1/products/POST/201.headers.json': '{"Location":"/v1/products/p-2"}',
      'default/v1/products/p-1/DELETE/204': '',
      'default/v1/greeting/GET/200_[en-US]_{text-plain}.txt': 'Hello',
      'default/v1/greeting/GET/200_[fr]_{text-plain}.txt': 'Bonjour',
    });
    const janus = startJanus(['serve', '--data', data, '--host', '127.0.0.1', '--port', '0']);
    const url = await waitForUrl(janus);
    expect(janus.output.stdout).toContain(`(data: ${data})`);

    // Health reports ready with the active snapshot.
    const health = await fetch(`${url}/_janus/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    expect(healthBody).toMatchObject({ status: 'ready', fixtureCount: 4, routeCount: 3 });
    expect(healthBody['snapshot']).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(healthBody)).not.toContain(root);

    // JSON replay: exact status, headers, and bytes.
    const products = await rawRequest(url, 'GET', '/v1/products?page=1');
    expect(products.status).toBe(200);
    expect(products.headers['content-type']).toBe('application/json');
    expect(products.headers['content-length']).toBe(String(Buffer.byteLength(PRODUCTS_JSON)));
    expect(products.headers['x-example']).toBe('fixture');
    expect(products.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(products.body.toString('utf8')).toBe(PRODUCTS_JSON);

    const created = await fetch(`${url}/v1/products`, { method: 'POST', body: '{"name":"x"}' });
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe('/v1/products/p-2');

    // Bodyless replay.
    const deleted = await rawRequest(url, 'DELETE', '/v1/products/p-1');
    expect(deleted.status).toBe(204);
    expect(deleted.body.length).toBe(0);

    // HEAD mirrors GET without a body.
    const head = await rawRequest(url, 'HEAD', '/v1/products');
    expect(head.status).toBe(200);
    expect(head.headers['x-example']).toBe('fixture');
    expect(head.body.length).toBe(0);

    // Accept-Language selects a localized response; no match → 406.
    const french = await fetch(`${url}/v1/greeting`, { headers: { 'Accept-Language': 'fr-CA,en;q=0.5' } });
    expect(french.status).toBe(200);
    expect(french.headers.get('content-language')).toBe('fr');
    // Every bodyful response now varies on Accept as well.
    expect(french.headers.get('vary')).toBe('Accept, Accept-Language');
    expect(await french.text()).toBe('Bonjour');
    const english = await fetch(`${url}/v1/greeting`, { headers: { 'Accept-Language': 'en-us' } });
    expect(await english.text()).toBe('Hello');
    const german = await fetch(`${url}/v1/greeting`, { headers: { 'Accept-Language': 'de' } });
    expect(german.status).toBe(406);
    expect(await german.json()).toMatchObject({ error: { code: 'not-acceptable' } });

    // Unknown path → 404; wrong method → 405 with Allow.
    const missing = await fetch(`${url}/v1/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'route-not-found' } });

    const wrong = await fetch(`${url}/v1/products`, { method: 'PATCH' });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET, HEAD, OPTIONS, POST');
    expect(await wrong.json()).toMatchObject({ error: { code: 'method-not-allowed' } });

    // Invalid targets never reach lookup, including traversal attempts.
    for (const target of ['/v1/%2e%2e/products', '/v1/../products', '/v1/%zz', '/v1/a%2Fb']) {
      const invalid = await rawRequest(url, 'GET', target);
      expect(invalid.status, target).toBe(400);
      expect(JSON.parse(invalid.body.toString('utf8'))).toMatchObject({ error: { code: 'invalid-request' } });
    }

    // SIGTERM → graceful, successful exit. Windows has no POSIX signals: `kill()`
    // terminates the process outright, so only the stop itself is checked there.
    // The signal-handling path is covered on every platform by apps/server/src/main.test.ts.
    janus.process.kill('SIGTERM');
    if (process.platform === 'win32') {
      await janus.exited;
    } else {
      await expect(janus.exited).resolves.toBe(0);
      expect(janus.output.stdout).toContain('janus shutdown-started signal=SIGTERM');
      expect(janus.output.stdout).toContain('janus shutdown-complete');
    }
    await expect(fetch(`${url}/_janus/health`)).rejects.toThrow();
  });

  it('refuses to start on an invalid tree, printing every error', async () => {
    const data = await write({
      'default/v1/get/204': '',
      'default/v1/products/GET/200_{application-json}.json': '{"broken":',
      'default/v1/p-{id}/GET/204': '',
      'Staging/GET/204': '',
    });
    const janus = startJanus(['serve', '--data', data, '--port', '0']);
    await expect(janus.exited).resolves.toBe(1);
    const { stdout, stderr } = janus.output;
    expect(stdout).not.toContain('listening');
    expect(stderr).toContain('janus: 4 startup errors; not starting.');
    expect(stderr).toContain(`  ${data}/default/v1/get: `);
    expect(stderr).toContain('[invalid-method]');
    expect(stderr).toContain(`  ${data}/default/v1/products/GET/200_{application-json}.json:1:11: invalid JSON`);
    // {name} is a template; braces with other text are an error.
    expect(stderr).toContain('[invalid-path-parameter]');
    expect(stderr).toContain('Staging: ');
  });

  it('prints help and rejects bad usage', async () => {
    const help = startJanus(['serve', '--help']);
    await expect(help.exited).resolves.toBe(0);
    expect(help.output.stdout).toContain('Usage: janus serve');

    const bad = startJanus(['serve', '--bogus']);
    await expect(bad.exited).resolves.not.toBe(0);
    expect(bad.output.stderr).toContain('Usage: janus serve');
  });
});
