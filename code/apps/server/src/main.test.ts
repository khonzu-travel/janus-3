import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { main, type CliEnvironment, type Signal } from './main.js';

let root: string;
/** A stand-in for the UI build, so these tests never depend on `pnpm build` having run. */
let uiRoot: string;

beforeAll(async () => {
  uiRoot = await mkdtemp(join(tmpdir(), 'janus-ui-'));
  await mkdir(join(uiRoot, 'assets'));
  await writeFile(join(uiRoot, 'index.html'), '<!doctype html><title>Janus Atlas</title>');
  await writeFile(join(uiRoot, 'assets', 'index-abc123.js'), 'console.log(1);');
  await writeFile(join(uiRoot, 'atlas-config.js'), '// the template for static hosts');
});

afterAll(async () => {
  await rm(uiRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'janus-main-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function write(tree: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, contents] of Object.entries(tree)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
}

function environment(options: { uiRoot?: string | null } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let handler: ((signal: Signal) => void) | undefined;
  const env: CliEnvironment = {
    cwd: root,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    onSignal: (next) => {
      handler = next;
      return () => {
        handler = undefined;
      };
    },
    shutdownTimeoutMs: 1000,
    uiRoot: options.uiRoot === undefined ? uiRoot : options.uiRoot,
  };
  return {
    env,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    signal: (signal: Signal) => handler?.(signal),
    subscribed: () => handler !== undefined,
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((done) => setTimeout(done, 10));
  if (!condition()) throw new Error('condition not met');
}

describe('main', () => {
  it('prints help to stdout and exits 0', async () => {
    const io = environment();
    await expect(main(['--help'], io.env)).resolves.toBe(0);
    expect(io.stdout()).toContain('Usage: janus serve');
    expect(io.stderr()).toBe('');
  });

  it('prints usage errors to stderr and exits nonzero', async () => {
    const io = environment();
    await expect(main(['serve', '--port', 'nope'], io.env)).resolves.toBe(2);
    expect(io.stderr()).toContain('janus: invalid port "nope"');
    expect(io.stderr()).toContain('Usage:');
    expect(io.stdout()).toBe('');
  });

  it('prints every startup error and does not listen', async () => {
    await write({ 'data/default/v1/get/204': '', 'data/default/v2/GET/200': '', 'data/Extra/GET/204': '' });
    const io = environment();
    await expect(main(['serve', '--port', '0'], io.env)).resolves.toBe(1);
    const stderr = io.stderr();
    expect(stderr).toContain('janus: 3 startup errors; not starting.');
    expect(stderr).toContain('  data/default/v1/get: ');
    expect(stderr).toContain('[invalid-method]');
    expect(stderr).toContain('  data/default/v2/GET/200: ');
    expect(stderr).toContain('  data/Extra: ');
    expect(io.stdout()).not.toContain('listening');
    expect(io.subscribed()).toBe(false);
  });

  it('reports a missing data root', async () => {
    const io = environment();
    await expect(main(['serve', '--data', 'missing', '--port', '0'], io.env)).resolves.toBe(1);
    expect(io.stderr()).toContain('  missing: the data root does not exist [data-root-missing]');
  });

  it('reports a port that is already in use', async () => {
    await write({ 'data/default/GET/204': '' });
    const blocker = createServer();
    await new Promise<void>((done) => blocker.listen(0, '127.0.0.1', done));
    const address = blocker.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const io = environment();
      await expect(main(['serve', '--port', String(port)], io.env)).resolves.toBe(1);
      expect(io.stderr()).toContain('startup-failed reason=EADDRINUSE');
    } finally {
      await new Promise((done) => blocker.close(done));
    }
  });

  it('serves until a signal, ignores repeated signals, and exits 0', async () => {
    await write({ 'data/default/GET/200_{text-plain}.txt': 'hello' });
    const io = environment();
    const running = main(['serve', '--port', '0'], io.env);
    await until(() => io.stdout().includes('listening'));
    const url = /listening on (\S+)/.exec(io.stdout())?.[1] ?? '';
    expect(io.stdout()).toContain(`(data: ${join(root, 'data')})`);

    const response = await fetch(`${url}/`);
    expect(await response.text()).toBe('hello');
    await until(() => io.stdout().includes('janus request '));
    expect(io.stdout()).toMatch(/janus request id=\S+ method=GET path=\/ status=200 ms=/);

    io.signal('SIGTERM');
    io.signal('SIGINT');
    await expect(running).resolves.toBe(0);
    expect(io.stdout()).toContain('janus shutdown-started signal=SIGTERM');
    expect(io.stdout()).toContain('janus shutdown-in-progress signal=SIGINT');
    expect(io.stdout().match(/shutdown-started/g)).toHaveLength(1);
    expect(io.stdout()).toContain('janus shutdown-complete');
    expect(io.subscribed()).toBe(false);
    await expect(fetch(`${url}/`)).rejects.toThrow();
  });

  it('generates, logs and reports a seed when none is configured, and honours --seed and --now', async () => {
    await write({
      'data/default/{id}/GET/200_{text-plain}.txt': '{{$path.id}} {{$today}} {{$uuid}}',
    });
    const serveWith = async (args: readonly string[]) => {
      const io = environment();
      const running = main(['serve', '--port', '0', ...args], io.env);
      await until(() => io.stdout().includes('listening'));
      const url = /listening on (\S+)/.exec(io.stdout())?.[1] ?? '';
      const clock = (await (await fetch(`${url}/_janus/clock`)).json()) as {
        seed: number;
        seedSource: string;
        now: string;
      };
      const body = await (await fetch(`${url}/p-1`)).text();
      io.signal('SIGTERM');
      await running;
      return { stdout: io.stdout(), clock, body };
    };
    const generated = await serveWith([]);
    expect(generated.clock.seedSource).toBe('generated');
    expect(generated.stdout).toContain(`janus seed seed=${String(generated.clock.seed)} source=generated`);
    const fixed = await serveWith(['--seed', '42', '--now', '2026-01-01T00:00:00Z']);
    expect(fixed.clock).toMatchObject({ seed: 42, seedSource: 'cli', now: '2026-01-01T00:00:00Z' });
    expect(fixed.stdout).toContain('janus seed seed=42 source=cli');
    const again = await serveWith(['--seed', '42', '--now', '2026-01-01T00:00:00Z']);
    expect(again.body).toBe(fixed.body);
    expect(fixed.body).toMatch(/^p-1 2026-01-01 [0-9a-f-]{36}$/);
  });

  it('serves the --scenario default, prints it, and logs session writes', async () => {
    await write({
      'data/default/GET/200_{text-plain}.txt': 'default',
      'data/child/GET/200_{text-plain}.txt': 'child',
    });
    const io = environment();
    const running = main(['serve', '--port', '0', '--scenario', 'child'], io.env);
    await until(() => io.stdout().includes('listening'));
    const url = /listening on (\S+)/.exec(io.stdout())?.[1] ?? '';
    expect(io.stdout()).toContain('Default scenario: child\n');
    expect(await (await fetch(`${url}/`)).text()).toBe('child');
    expect(await (await fetch(`${url}/`, { headers: { 'x-mock-scenario': 'default' } })).text()).toBe('default');
    const created = await fetch(`${url}/_janus/session`, {
      method: 'POST',
      headers: { 'x-mock-session': 'a', 'content-type': 'application/json' },
      body: '{"scenario":"default"}',
    });
    expect(created.status).toBe(201);
    const key = created.headers.get('x-mock-session-key') ?? '';
    expect(key).toMatch(/^wk_[0-9a-f]{32}$/);
    expect(await (await fetch(`${url}/`, { headers: { 'x-mock-session': 'a' } })).text()).toBe('default');
    await until(() => io.stdout().includes('janus session-write '));
    expect(io.stdout()).toMatch(
      /janus session-write id=\S+ route=\/_janus\/session method=POST source=header session=a status=201 outcome=created/,
    );
    expect(io.stdout()).not.toContain(key);
    io.signal('SIGTERM');
    await expect(running).resolves.toBe(0);

    const plain = environment();
    const second = main(['serve', '--port', '0'], plain.env);
    await until(() => plain.stdout().includes('listening'));
    expect(plain.stdout()).not.toContain('Default scenario:');
    plain.signal('SIGTERM');
    await expect(second).resolves.toBe(0);
  });

  it('warns when bound to a non-loopback address', async () => {
    await write({ 'data/default/GET/204': '' });
    const io = environment();
    const running = main(['serve', '--host', '0.0.0.0', '--port', '0'], io.env);
    await until(() => io.stdout().includes('listening'));
    expect(io.stderr()).toContain('non-loopback');
    io.signal('SIGINT');
    await expect(running).resolves.toBe(0);
  });

  it('warns when bound to a non-loopback address from the file, with its location', async () => {
    await write({ 'data/default/GET/204': '', 'janus.config.yaml': 'server:\n  host: 0.0.0.0\n  port: 0\n' });
    const io = environment();
    const running = main(['serve'], io.env);
    await until(() => io.stdout().includes('listening'));
    expect(io.stderr()).toContain('janus: warning: janus.config.yaml:2:9: ');
    expect(io.stderr()).toContain('[non-loopback-bind]');
    io.signal('SIGINT');
    await expect(running).resolves.toBe(0);
  });
});

/** Fails the test if anything binds a socket. */
function forbidListening(): void {
  vi.spyOn(Server.prototype, 'listen').mockImplementation(() => {
    throw new Error('a socket was opened');
  });
}

async function serveAndProbe(argv: readonly string[], path = '/_janus/health') {
  const io = environment();
  const running = main(argv, io.env);
  await until(() => io.stdout().includes('listening') || io.stderr().includes('not starting'));
  const url = /listening on (\S+)/.exec(io.stdout())?.[1];
  if (url === undefined) throw new Error(io.stderr());
  const response = await fetch(`${url}${path}`);
  const body = await response.text();
  io.signal('SIGTERM');
  await expect(running).resolves.toBe(0);
  return { response, body, stdout: io.stdout(), stderr: io.stderr() };
}

describe('the Atlas UI', () => {
  async function serveWith(
    argv: readonly string[],
    options: { uiRoot?: string | null },
    probe: (url: string) => Promise<void>,
  ) {
    const io = environment(options);
    const running = main(argv, io.env);
    await until(() => io.stdout().includes('listening') || io.stderr().includes('not starting'));
    const url = /listening on (\S+)/.exec(io.stdout())?.[1];
    if (url === undefined) throw new Error(io.stderr());
    await probe(url);
    io.signal('SIGTERM');
    await expect(running).resolves.toBe(0);
    return { stdout: io.stdout(), stderr: io.stderr() };
  }

  it('prints the UI address, logs the loaded size, and serves the build', async () => {
    await write({ 'data/default/GET/204': '' });
    const { stdout, stderr } = await serveWith(['serve', '--port', '0'], {}, async (url) => {
      const page = await fetch(`${url}/_janus/ui/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Janus Atlas');
      const config = await fetch(`${url}/_janus/ui/atlas-config.js`);
      expect(await config.text()).toBe('globalThis.__JANUS_ATLAS_CONFIG__ = { serverUrl: "../../" };\n');
      const health = (await (await fetch(`${url}/_janus/health`)).json()) as Record<string, unknown>;
      expect(health).toMatchObject({ capabilities: { ui: true }, warnings: [] });
    });
    const url = /listening on (\S+)/.exec(stdout)?.[1] ?? '';
    expect(stdout).toContain(`Atlas UI: ${url}/_janus/ui/\n`);
    // index.html, the asset, and the generated atlas-config.js in place of the build's.
    expect(stdout).toMatch(/janus ui files=3 bytes=\d+/);
    expect(stderr).toBe('');
  });

  it('starts without a build, with ui: false and the ui-assets-missing warning kept across a reload', async () => {
    await write({ 'data/default/GET/204': '' });
    const { stdout, stderr } = await serveWith(
      ['serve', '--port', '0'],
      { uiRoot: join(root, 'no-build') },
      async (url) => {
        const expected = {
          capabilities: { ui: false },
          warnings: [{ code: 'ui-assets-missing', message: expect.stringContaining('not built') as unknown }],
        };
        expect(await (await fetch(`${url}/_janus/health`)).json()).toMatchObject(expected);
        expect((await fetch(`${url}/_janus/ui/`)).status).toBe(404);
        expect((await fetch(`${url}/_janus/reload`, { method: 'POST' })).status).toBe(200);
        expect(await (await fetch(`${url}/_janus/health`)).json()).toMatchObject(expected);
      },
    );
    expect(stdout).not.toContain('Atlas UI:');
    expect(stderr).toContain('janus: warning: @janus/ui/dist: the Atlas UI is not built');
  });

  it.each([
    ['--no-ui', ['serve', '--port', '0', '--no-ui'], ''],
    ['ui.enabled: false', ['serve', '--port', '0'], 'ui:\n  enabled: false\n'],
  ])('serves no UI and warns about nothing with %s', async (_name, argv, config) => {
    await write({ 'data/default/GET/204': '', ...(config === '' ? {} : { 'janus.config.yaml': config }) });
    const { stdout, stderr } = await serveWith(argv, { uiRoot: join(root, 'no-build') }, async (url) => {
      const response = await fetch(`${url}/_janus/ui/`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'route-not-found' } });
      expect(await (await fetch(`${url}/_janus/health`)).json()).toMatchObject({
        capabilities: { ui: false },
        warnings: [],
      });
    });
    expect(stdout).not.toContain('Atlas UI:');
    expect(stderr).toBe('');
  });
});

describe('configuration file', () => {
  it('discovers janus.config.yaml in the working directory', async () => {
    await write({
      'data/default/GET/204': '',
      'janus.config.yaml': 'server:\n  port: 0\nonUnknownMethod: 404\n',
    });
    const { response, body } = await serveAndProbe(['serve'], '/_janus/config');
    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      configFile: true,
      settings: expect.arrayContaining([{ key: 'onUnknownMethod', value: 404, source: 'file' }]) as unknown,
    });
  });

  it('turns on watching with --watch or fixtures.watch, and disables the explorer with atlas.resolve', async () => {
    await write({ 'data/default/GET/204': '', 'janus.config.yaml': 'server:\n  port: 0\natlas:\n  resolve: false\n' });
    const flagged = await serveAndProbe(['serve', '--watch']);
    expect(JSON.parse(flagged.body)).toMatchObject({
      capabilities: { resolve: false, reload: true, watch: true, events: true, ui: true, cors: { origins: 0 } },
    });
    expect(flagged.stdout).toContain('janus watching active=yes');
    await write({ 'janus.config.yaml': 'server:\n  port: 0\nfixtures:\n  watch: true\n' });
    const filed = await serveAndProbe(['serve']);
    expect(JSON.parse(filed.body)).toMatchObject({ capabilities: { resolve: true, watch: true } });
    const off = await serveAndProbe(['serve', '--no-config', '--port', '0']);
    expect(JSON.parse(off.body)).toMatchObject({ capabilities: { resolve: true, reload: true, watch: false } });
  });

  it('prints a failed reload with the startup formatter and keeps serving', async () => {
    await write({ 'data/default/v1/GET/200_{application-json}.json': '{}' });
    const io = environment();
    const running = main(['serve', '--no-config', '--port', '0'], io.env);
    await until(() => io.stdout().includes('listening'));
    const url = /listening on (\S+)/.exec(io.stdout())?.[1] ?? '';
    await write({ 'data/default/v1/GET/200_{application-json}.json': '{"a":' });
    const reload = await fetch(`${url}/_janus/reload`, { method: 'POST' });
    expect(reload.status).toBe(422);
    expect(io.stdout()).toContain('janus reload-started triggers=request');
    expect(io.stderr()).toContain('janus reload-failed errors=1');
    expect(io.stderr()).toMatch(/janus: reload: 1 startup error; keeping the current snapshot\./);
    expect(io.stderr()).toContain('data/default/v1/GET/200_{application-json}.json:1:6');
    expect(await (await fetch(`${url}/v1`)).text()).toBe('{}');
    io.signal('SIGTERM');
    await expect(running).resolves.toBe(0);
  });

  it('runs on defaults and flags alone without a file', async () => {
    await write({ 'data/default/GET/204': '' });
    const { body } = await serveAndProbe(['serve', '--port', '0'], '/_janus/config');
    const config = JSON.parse(body) as { configFile: boolean; settings: { source: string }[] };
    expect(config.configFile).toBe(false);
    expect(config.settings.every((setting) => setting.source === 'default')).toBe(true);
  });

  it('reads the file named by --config and resolves its paths against its own directory', async () => {
    await write({
      'conf/fixtures/default/GET/200_{text-plain}.txt': 'from conf',
      'conf/janus.config.yaml': 'fixtures:\n  root: ./fixtures\nserver:\n  port: 0\n',
      'data/default/GET/200_{text-plain}.txt': 'from data',
    });
    const { body, stdout } = await serveAndProbe(['serve', '--config', 'conf/janus.config.yaml'], '/');
    expect(body).toBe('from conf');
    expect(stdout).toContain(`(data: ${join(root, 'conf', 'fixtures')})`);
  });

  it('reports an implicitly discovered config path that is a directory', async () => {
    await mkdir(join(root, 'janus.config.yaml'));
    const io = environment();
    await expect(main(['validate'], io.env)).resolves.toBe(1);
    expect(io.stderr()).toContain(
      'janus.config.yaml: the configuration path is a directory, not a file [config-unreadable]',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'reports an implicitly discovered config path that is a dangling symlink',
    async () => {
      await write({ 'data/default/GET/204': '' });
      await symlink('missing.yaml', join(root, 'janus.config.yaml'));
      const io = environment();
      await expect(main(['validate'], io.env)).resolves.toBe(1);
      expect(io.stderr()).toContain('janus.config.yaml: the configuration file does not exist [config-not-found]');
    },
  );

  it.skipIf(process.platform === 'win32').each([[[]], [['--config', 'janus.config.yaml']]])(
    'reports a config path that is a FIFO without blocking on it (%j)',
    async (flags) => {
      await write({ 'data/default/GET/204': '' });
      execFileSync('mkfifo', [join(root, 'janus.config.yaml')]);
      const io = environment();
      await expect(main(['validate', ...flags], io.env)).resolves.toBe(1);
      expect(io.stderr()).toContain(
        'janus.config.yaml: the configuration path is not a regular file [config-unreadable]',
      );
    },
  );

  it('resolves --data against the working directory, overriding the file, and logs the override once', async () => {
    await write({
      'conf/fixtures/default/GET/200_{text-plain}.txt': 'from conf',
      'conf/janus.config.yaml': 'fixtures:\n  root: ./fixtures\nserver:\n  port: 0\n',
      'data/default/GET/200_{text-plain}.txt': 'from data',
    });
    const { body, stdout } = await serveAndProbe(
      ['serve', '--config', 'conf/janus.config.yaml', '--data', 'data'],
      '/',
    );
    expect(body).toBe('from data');
    expect(stdout.match(/janus config-override key=fixtures.root file=.\/fixtures cli=data/g)).toHaveLength(1);
  });

  it('ignores the file with --no-config', async () => {
    await write({ 'data/default/GET/204': '', 'janus.config.yaml': 'nonsense: true\n' });
    const { body } = await serveAndProbe(['serve', '--no-config', '--port', '0'], '/_janus/config');
    expect(JSON.parse(body)).toMatchObject({ configFile: false });
  });

  it('warns about a near-miss file name that was not loaded', async () => {
    await write({ 'data/default/GET/204': '', 'janus.config.yml': 'server:\n  port: 1\n' });
    const { body, stderr } = await serveAndProbe(['serve', '--port', '0']);
    expect(stderr).toContain('janus: warning: janus.config.yml: "janus.config.yml" was not loaded;');
    expect(JSON.parse(body)).toMatchObject({ warnings: [{ code: 'config-similar-file-ignored', source: 'config' }] });
  });

  it.each([
    [['serve', '--config', 'nope.yaml'], 'nope.yaml: the configuration file does not exist [config-not-found]'],
    [['serve', '--config', 'dir'], 'dir: the configuration path is a directory, not a file [config-unreadable]'],
    [
      ['serve', '--config', 'latin1.yaml'],
      'latin1.yaml: the configuration file is not valid UTF-8 [config-unreadable]',
    ],
  ])('reports an unusable file: %j', async (argv, line) => {
    await write({ 'data/default/GET/204': '', 'dir/x': '' });
    await writeFile(join(root, 'latin1.yaml'), Buffer.from([0x61, 0x3a, 0x20, 0xe9, 0x0a]));
    forbidListening();
    const io = environment();
    await expect(main(argv, io.env)).resolves.toBe(1);
    expect(io.stderr()).toContain(`  ${line}`);
    expect(io.stderr()).toContain('note: fixture validation was skipped');
  });

  it('reports configuration and fixture errors together and never binds', async () => {
    await write({
      'janus.config.yaml': 'server:\n  prot: 4010\nonUnknownMethod: 403\n',
      'data/default/v1/GET/200_{application-json}.json': '{"a":}',
    });
    forbidListening();
    const io = environment();
    await expect(main(['serve'], io.env)).resolves.toBe(1);
    expect(io.stderr()).toBe(
      [
        'janus: 3 startup errors; not starting.',
        '  janus.config.yaml:2:3: unknown key "prot" under "server"; did you mean "port"? [config-unknown-key]',
        '  janus.config.yaml:3:18: expected 404 or 405, got 403 [config-invalid-value]',
        '  data/default/v1/GET/200_{application-json}.json:1:6: invalid JSON: unexpected "}" [invalid-json]',
        '',
      ].join('\n'),
    );
    expect(io.subscribed()).toBe(false);
  });

  it('skips fixture validation, and says so, when fixtures.root itself is invalid', async () => {
    await write({ 'janus.config.yaml': 'fixtures:\n  root: 5\n' });
    const io = environment();
    await expect(main(['serve'], io.env)).resolves.toBe(1);
    expect(io.stderr()).toContain('janus.config.yaml:2:9: expected a non-empty path, got 5 [config-invalid-value]');
    expect(io.stderr()).toContain('note: fixture validation was skipped because fixtures.root could not be determined');
    expect(io.stderr()).not.toContain('data-root-missing');
  });

  it('still validates the fixtures when --data overrides an invalid fixtures.root', async () => {
    await write({ 'janus.config.yaml': 'fixtures:\n  root: 5\n' });
    const io = environment();
    await expect(main(['serve', '--data', 'missing'], io.env)).resolves.toBe(1);
    expect(io.stderr()).toContain('missing: the data root does not exist [data-root-missing]');
  });

  it('reports --config with --no-config as a usage error', async () => {
    const io = environment();
    await expect(main(['serve', '--config', 'a.yaml', '--no-config'], io.env)).resolves.toBe(2);
    expect(io.stderr()).toContain('janus: --no-config: --config and --no-config cannot be combined [cli-conflict]');
  });
});

describe('janus validate', () => {
  beforeEach(() => {
    forbidListening();
  });

  it('exits 0 with the digest and snapshot for a valid setup, without opening a socket', async () => {
    await write({ 'data/default/GET/204': '' });
    const io = environment();
    await expect(main(['validate'], io.env)).resolves.toBe(0);
    expect(io.stdout()).toMatch(
      /^janus: 0 startup errors; valid \(config cfg_[0-9a-f]{16}, snapshot [0-9a-f]{16}\)\.\n$/,
    );
    expect(io.stderr()).toBe('');
  });

  it('exits 1 and reports every error', async () => {
    await write({ 'janus.config.yaml': 'sever: {}\n', 'data/default/v1/get/204': '' });
    const io = environment();
    await expect(main(['validate'], io.env)).resolves.toBe(1);
    expect(io.stderr()).toContain('janus: 2 startup errors; invalid.');
    expect(io.stderr()).toContain('janus.config.yaml:1:1: unknown key "sever"; did you mean "server"?');
    expect(io.stderr()).toContain('data/default/v1/get: ');
  });

  it('reports an unknown --scenario as a startup error', async () => {
    await write({ 'data/default/GET/204': '' });
    const io = environment();
    await expect(main(['validate', '--scenario', 'missing'], io.env)).resolves.toBe(1);
    expect(io.stderr()).toContain('missing');
    await expect(main(['validate', '--scenario', 'Bad'], environment().env)).resolves.toBe(2);
  });

  it("warns about a method directory Node's HTTP parser cannot receive", async () => {
    await write({ 'data/default/GET/204': '', 'data/default/PURGE/204': '', 'data/default/FOO/204': '' });
    const io = environment();
    await expect(main(['validate'], io.env)).resolves.toBe(0);
    expect(io.stdout()).toContain('janus: 0 startup errors and 1 warning; valid');
    expect(io.stdout()).toContain('  warning: data/default/FOO: "FOO" is a valid method token');
  });

  it('allows warnings, unless --strict', async () => {
    await write({
      'data/default/GET/200_{text-plain}.txt': 'x',
      'data/default/GET/200.headers.json': '{"Content-Type":"text/plain"}',
    });
    const lenient = environment();
    await expect(main(['validate'], lenient.env)).resolves.toBe(0);
    expect(lenient.stdout()).toContain('janus: 0 startup errors and 1 warning; valid');
    expect(lenient.stdout()).toContain('  warning: data/default/GET/200.headers.json:1:2: ');

    const strict = environment();
    await expect(main(['validate', '--strict'], strict.env)).resolves.toBe(1);
    expect(strict.stderr()).toContain('janus: 0 startup errors and 1 warning; invalid under --strict.');

    const json = environment();
    await expect(main(['validate', '--strict', '--format', 'json'], json.env)).resolves.toBe(1);
    const report = JSON.parse(json.stdout()) as {
      readonly valid: unknown;
      readonly configDigest: unknown;
      readonly snapshotVersion: unknown;
    };
    expect(report.valid).toBe(false);
    expect(report.configDigest).toMatch(/^cfg_[0-9a-f]{16}$/);
    expect(report.snapshotVersion).toMatch(/^[0-9a-f]{16}$/);
  });

  it('validates --host and --port without binding', async () => {
    await write({ 'data/default/GET/204': '' });
    const ok = environment();
    await expect(main(['validate', '--host', '0.0.0.0', '--port', '80'], ok.env)).resolves.toBe(0);
    expect(ok.stdout()).toContain('warning: --host: ');
    const bad = environment();
    await expect(main(['validate', '--port', '99999'], bad.env)).resolves.toBe(2);
  });

  it('prints one JSON document with every located error', async () => {
    await write({
      'janus.config.yaml': 'server:\n  prot: 1\n',
      'data/default/v1/GET/200_{application-json}.json': '[',
    });
    const io = environment();
    await expect(main(['validate', '--format', 'json'], io.env)).resolves.toBe(1);
    expect(JSON.parse(io.stdout())).toEqual({
      valid: false,
      configDigest: null,
      snapshotVersion: null,
      errors: [
        {
          code: 'config-unknown-key',
          source: 'config',
          path: 'janus.config.yaml',
          line: 2,
          column: 3,
          key: 'server.prot',
          token: 'prot',
          message: 'unknown key "prot" under "server"; did you mean "port"?',
        },
        {
          code: 'invalid-json',
          source: 'fixtures',
          path: 'data/default/v1/GET/200_{application-json}.json',
          line: 1,
          column: 2,
          message: 'invalid JSON: unexpected end of input',
        },
      ],
      warnings: [],
    });
    expect(io.stderr()).toBe('');
  });

  it('reports the digest serve publishes in health', async () => {
    await write({ 'data/default/GET/204': '', 'janus.config.yaml': 'server:\n  port: 0\nonUnknownMethod: 404\n' });
    const io = environment();
    await expect(main(['validate', '--format', 'json'], io.env)).resolves.toBe(0);
    const report = JSON.parse(io.stdout()) as { valid: boolean; configDigest: string; snapshotVersion: string };
    expect(report.valid).toBe(true);
    vi.restoreAllMocks();
    const { body } = await serveAndProbe(['serve']);
    expect(JSON.parse(body)).toMatchObject({
      configDigest: report.configDigest,
      snapshotVersion: report.snapshotVersion,
    });
  });

  it('applies --no-ui to the configuration it validates, like serve', async () => {
    await write({ 'data/default/GET/204': '', 'janus.config.yaml': 'server:\n  port: 0\n' });
    const digest = async (args: readonly string[]): Promise<string> => {
      const io = environment();
      await expect(main(['validate', '--format', 'json', ...args], io.env)).resolves.toBe(0);
      const report = JSON.parse(io.stdout()) as { configDigest: string; warnings: unknown[] };
      // validate never loads UI files, so it never reports ui-assets-missing.
      expect(report.warnings).toEqual([]);
      return report.configDigest;
    };
    const withUi = await digest([]);
    const withoutUi = await digest(['--no-ui']);
    expect(withoutUi).not.toBe(withUi);
    await write({ 'janus.config.yaml': 'server:\n  port: 0\nui:\n  enabled: false\n' });
    expect(await digest([])).toBe(withoutUi);
    vi.restoreAllMocks();
    const { body } = await serveAndProbe(['serve', '--no-ui']);
    expect(JSON.parse(body)).toMatchObject({ configDigest: withoutUi, capabilities: { ui: false } });
  });

  it('reports a usage conflict as JSON when JSON was asked for', async () => {
    const io = environment();
    await expect(main(['validate', '--format', 'json', '--config', 'a.yaml', '--no-config'], io.env)).resolves.toBe(2);
    expect(JSON.parse(io.stdout())).toMatchObject({
      valid: false,
      errors: [{ code: 'cli-conflict', source: 'cli', path: '--no-config' }],
    });
  });
});
