import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { build } from 'electron-builder';
import { parse } from 'yaml';

// Packages the desktop app: stages it with `pnpm deploy`,
// drops what only the UI build needs, refuses native modules, adds the UI build
// as resources/ui, and runs electron-builder on the staged copy.
//
//   node scripts/package.ts         installers for this platform
//   node scripts/package.ts --dir   the unpacked app only (the CI smoke test)

const APP = resolve(import.meta.dirname, '..');
const WORKSPACE = resolve(APP, '..', '..');
const RELEASE = join(APP, 'release');
const STAGE = join(RELEASE, 'stage');
const UI_DIST = join(WORKSPACE, 'apps', 'ui', 'dist');
const unpackedOnly = process.argv.includes('--dir');

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const readManifest = async (directory: string): Promise<Manifest> =>
  JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest;

for (const required of [
  join(APP, 'dist', 'main', 'index.js'),
  join(APP, 'dist', 'pages', 'start.html'),
  join(UI_DIST, 'index.html'),
]) {
  if (!existsSync(required)) throw new Error(`${required} is missing: run pnpm build first`);
}

await rm(RELEASE, { recursive: true, force: true });
await mkdir(RELEASE, { recursive: true });

// The app's production dependencies as plain files: @janus/server and its runtime dependencies.
execFileSync('pnpm', ['--filter', '@janus/desktop', 'deploy', '--prod', '--config.node-linker=hoisted', STAGE], {
  cwd: WORKSPACE,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

// The window and taskbar icon the main process reads at run time (deploy copies only the packed files).
await mkdir(join(STAGE, 'build'), { recursive: true });
await copyFile(join(APP, 'build', 'icon.png'), join(STAGE, 'build', 'icon.png'));

const modules = join(STAGE, 'node_modules');
await pruneUiPackages(modules);
await refuseNativeModules(modules);

const app = await readManifest(APP);
const electronVersion = app.devDependencies?.['electron'];
if (electronVersion === undefined || !/^\d+\.\d+\.\d+$/.test(electronVersion)) {
  throw new Error('electron must be pinned to an exact version in devDependencies');
}
const config = parse(await readFile(join(APP, 'electron-builder.yml'), 'utf8')) as Record<string, unknown>;
const localElectron = join(
  dirname(
    execFileSync(process.execPath, ['-p', "require.resolve('electron/package.json')"], {
      cwd: APP,
      encoding: 'utf8',
    }).trim(),
  ),
  'dist',
);

await build({
  projectDir: STAGE,
  publish: 'never',
  ...(unpackedOnly ? { dir: true } : {}),
  config: {
    ...config,
    electronVersion,
    // The unpacked build reuses the Electron that pnpm installed, so it needs no download.
    ...(unpackedOnly && existsSync(localElectron) ? { electronDist: localElectron } : {}),
    directories: { output: RELEASE, buildResources: join(APP, 'build') },
    extraMetadata: { version: app.version },
    // The UI build, passed to each server as its uiRoot.
    extraResources: [{ from: UI_DIST, to: 'ui' }],
    mac: { ...(config['mac'] as object), icon: join(APP, 'build', 'icon.png') },
    win: { ...(config['win'] as object), icon: join(APP, 'build', 'icon.png') },
    linux: { ...(config['linux'] as object), icon: join(APP, 'build', 'icon.png') },
  },
});

/**
 * The server depends on @janus/ui only to locate its files, and the app ships
 * them as resources/ui instead; packages nothing else needs are removed.
 */
async function pruneUiPackages(directory: string): Promise<void> {
  const keep = new Set<string>();
  const visit = async (name: string, from: string): Promise<void> => {
    const location = locate(name, from, directory);
    if (location === null || keep.has(location)) return;
    keep.add(location);
    const manifest = await readManifest(location);
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (dependency !== '@janus/ui') await visit(dependency, location);
    }
  };
  const staged = await readManifest(STAGE);
  for (const dependency of Object.keys(staged.dependencies ?? {})) await visit(dependency, STAGE);
  let removed = 0;
  for (const location of await packageDirectories(directory)) {
    if (!keep.has(location)) {
      await rm(location, { recursive: true, force: true });
      removed += 1;
    }
  }
  console.log(`package: kept ${String(keep.size)} packages, removed ${String(removed)} only the UI build needs`);
}

/** Node's lookup: `node_modules/<name>` in `from` and each parent, up to the staged root. */
function locate(name: string, from: string, root: string): string | null {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (directory === dirname(root) || directory === dirname(directory)) return null;
  }
}

async function packageDirectories(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scoped of await readdir(path, { withFileTypes: true })) {
        if (scoped.isDirectory()) found.push(join(path, scoped.name));
      }
    } else {
      found.push(path);
    }
  }
  return found;
}

/** Nothing is rebuilt for Electron, so a native module fails the build. */
async function refuseNativeModules(directory: string): Promise<void> {
  const native: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith('.node') || entry.name === 'binding.gyp') native.push(child);
    }
  };
  if ((await stat(directory).catch(() => null))?.isDirectory() === true) await walk(directory);
  if (native.length > 0) throw new Error(`native modules cannot be packaged:\n${native.join('\n')}`);
}
