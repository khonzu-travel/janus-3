import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { launch, type LaunchResult } from './launch.js';
import type { ServeLogger } from './serve.js';

let root: string;
let uiRoot: string;
const running: { close(): Promise<void> }[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'janus-launch-')));
  uiRoot = await mkdtemp(join(tmpdir(), 'janus-launch-ui-'));
  await writeFile(join(uiRoot, 'index.html'), '<!doctype html><title>Janus Atlas</title>');
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of running.splice(0)) await server.close();
  await rm(root, { recursive: true, force: true });
  await rm(uiRoot, { recursive: true, force: true });
});

async function write(tree: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, contents] of Object.entries(tree)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
}

function recorder() {
  const lines: string[] = [];
  const logger: ServeLogger = {
    info: (event) => lines.push(`info ${event}`),
    error: (event, fields) => lines.push(`error ${event} ${JSON.stringify(fields ?? {})}`),
  };
  return { logger, lines };
}

async function run(args: Parameters<typeof launch>[0], ui: string | null = uiRoot): Promise<LaunchResult> {
  const result = await launch(args, { cwd: root, logger: recorder().logger, uiRoot: ui, shutdownTimeoutMs: 500 });
  if (result.kind === 'started') running.push(result.server);
  return result;
}

describe('launch', () => {
  it('returns every problem of an invalid tree as data', async () => {
    await write({
      'janus.config.yaml': 'server:\n  port: banana\n',
      'data/default/a/GET/200_{text-plain}.json': '{}',
    });
    const result = await run({ noConfig: false });
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((error) => error.source === 'config' && error.key === 'server.port')).toBe(true);
    expect(result.paths).toEqual({
      cwd: root,
      configFile: join(root, 'janus.config.yaml'),
      fixturesRoot: join(root, 'data'),
      captures: null,
    });
  });

  it('returns bind-failed with the code for a taken port', async () => {
    await write({ 'data/default/hello/GET/200.json': '{}' });
    const holder = createServer();
    await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done));
    const { port } = holder.address() as AddressInfo;
    try {
      const { logger, lines } = recorder();
      const result = await launch({ noConfig: true, port }, { cwd: root, logger, uiRoot });
      expect(result).toMatchObject({ kind: 'bind-failed', code: 'EADDRINUSE', host: '127.0.0.1', port });
      // The CLI's log line is still written.
      expect(lines).toContain('error startup-failed {"reason":"EADDRINUSE"}');
    } finally {
      await new Promise((done) => holder.close(done));
    }
  });

  it('starts the server and reports its URL, UI URL, warnings, summary and paths', async () => {
    await write({
      'janus.config.yaml': 'scenarios:\n  default: busy\n',
      'data/default/hello/GET/200.json': '{"hi":0}',
      'data/busy/hello/GET/200.json': '{"hi":1}',
    });
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    const result = await run({ noConfig: false, port: 0 });
    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;
    expect(result.server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(result.uiUrl).toBe(`${result.server.url}/_janus/ui/`);
    expect(result.summary).toEqual([
      `Janus listening on ${result.server.url} (data: ${join(root, 'data')})`,
      `Atlas UI: ${result.server.url}/_janus/ui/`,
      'Default scenario: busy',
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.paths.configFile).toBe(join(root, 'janus.config.yaml'));
    const response = await fetch(`${result.server.url}/hello`);
    expect(await response.json()).toEqual({ hi: 1 });
    // `launch` never touches the process's streams.
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('has no UI URL and warns when the UI build is missing', async () => {
    await write({ 'data/default/hello/GET/200.json': '{}' });
    const result = await run({ noConfig: true, port: 0 }, null);
    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;
    expect(result.uiUrl).toBeNull();
    expect(result.warnings.map((warning) => warning.code)).toEqual(['ui-assets-missing']);
    expect(result.paths.configFile).toBeNull();
  });
});
