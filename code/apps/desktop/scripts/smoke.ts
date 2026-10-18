import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

// The packaged-app smoke test: launches the packaged app (not
// the source build) with a project folder, waits for the server's health
// endpoint, requests a fixture, quits, and checks the port is closed. It also
// reads the fuses back from the executable.

const APP = resolve(import.meta.dirname, '..');
const RELEASE = join(APP, 'release');
const EXAMPLES = resolve(APP, '..', '..', 'examples');

function executable(): string {
  const candidates =
    process.platform === 'darwin'
      ? ['mac-arm64', 'mac', 'mac-universal'].map((dir) =>
          join(RELEASE, dir, 'Janus.app', 'Contents', 'MacOS', 'Janus'),
        )
      : process.platform === 'win32'
        ? [join(RELEASE, 'win-unpacked', 'janus-desktop.exe')]
        : [join(RELEASE, 'linux-unpacked', 'janus-desktop')];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error(`no packaged app in ${RELEASE}: run the package script first`);
  return found;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

async function until(what: string, condition: () => Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const path = executable();
console.log(`smoke: ${path}`);

// The fuses of the packaged app.
const wire = await getCurrentFuseWire(path);
const expected: [FuseV1Options, boolean][] = [
  [FuseV1Options.RunAsNode, false],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
  [FuseV1Options.EnableNodeCliInspectArguments, false],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true],
  [FuseV1Options.OnlyLoadAppFromAsar, true],
];
for (const [fuse, enabled] of expected) {
  const state = wire[fuse];
  if (state !== (enabled ? FuseState.ENABLE : FuseState.DISABLE)) {
    throw new Error(`fuse ${FuseV1Options[fuse]} is ${String(state)}, expected ${enabled ? 'enabled' : 'disabled'}`);
  }
}
console.log('smoke: fuses ok');

const port = await freePort();
const work = await mkdtemp(join(tmpdir(), 'janus-smoke-'));
const project = join(work, 'shop-mocks');
await cp(EXAMPLES, project, { recursive: true });
const config = join(project, 'janus.config.yaml');
await writeFile(
  config,
  (await readFile(config, 'utf8'))
    .replace(/^ {2}port: 4010$/m, `  port: ${String(port)}`)
    .replace(/^\$schema:.*\n/m, ''),
);
const url = `http://127.0.0.1:${String(port)}`;

const args = [...(process.platform === 'linux' ? ['--no-sandbox'] : []), project];
const child = spawn(path, args, {
  env: { ...process.env, JANUS_DESKTOP_USER_DATA: join(work, 'user-data') },
  stdio: 'inherit',
});
const app = { exited: false };
child.on('exit', () => {
  app.exited = true;
});

try {
  await until('the health endpoint', () => answers(`${url}/_janus/health`), 60_000);
  const response = await fetch(`${url}/v1/greeting`);
  if (response.status !== 200) throw new Error(`GET /v1/greeting answered ${String(response.status)}`);
  console.log(`smoke: ${url}/v1/greeting answered 200`);

  // Quit: a termination signal, or a window close on Windows, which has no signals.
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid)]);
  else child.kill('SIGTERM');
  await until('the app to quit', () => Promise.resolve(app.exited), 20_000);
  if (await answers(`${url}/_janus/health`)) throw new Error('the port is still open after quitting');
  console.log('smoke: quit, and the port is closed');
} finally {
  if (!app.exited) child.kill('SIGKILL');
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}
