import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { AxeBuilder } from '@axe-core/playwright';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import electronPath from 'electron';

// Shared steps of the Electron journeys. Dialogs, the system
// browser and shell.openPath are replaced from the test through the main process.

export const APP_DIR = resolve(import.meta.dirname, '..');
export const EXAMPLES = resolve(APP_DIR, '..', '..', 'examples');

export interface Desktop {
  readonly app: ElectronApplication;
  readonly userData: string;
  close(): Promise<void>;
}

/** Launches the built app with its own data directory, optionally opening folders. */
export async function launch(options: { folders?: readonly string[]; userData?: string } = {}): Promise<Desktop> {
  const userData = options.userData ?? (await mkdtemp(join(tmpdir(), 'janus-desktop-data-')));
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    // The CI containers cannot give Chromium its setuid sandbox; the windows' own sandboxing is unchanged.
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), APP_DIR, ...(options.folders ?? [])],
    env: { ...process.env, JANUS_DESKTOP_TEST: '1', JANUS_DESKTOP_USER_DATA: userData },
  });
  await stubSystem(app);
  return {
    app,
    userData,
    close: async () => {
      await app.close().catch(() => undefined);
    },
  };
}

/** Replaces dialogs, the system browser and shell.openPath, recording what they were given. */
async function stubSystem(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog, shell }) => {
    const record = { external: [] as string[], paths: [] as string[], folders: [] as string[], boxes: [] as string[] };
    (globalThis as Record<string, unknown>)['janusStubs'] = record;
    shell.openExternal = (url: string) => {
      record.external.push(url);
      return Promise.resolve();
    };
    shell.openPath = (path: string) => {
      record.paths.push(path);
      return Promise.resolve('');
    };
    shell.showItemInFolder = (path: string) => {
      record.paths.push(path);
    };
    dialog.showOpenDialog = () => {
      const folder = record.folders.shift();
      return Promise.resolve({ canceled: folder === undefined, filePaths: folder === undefined ? [] : [folder] });
    };
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args.find((arg) => typeof arg === 'object' && arg !== null && 'message' in arg) as
        { message: string } | undefined;
      record.boxes.push(options?.message ?? '');
      return Promise.resolve({ response: 0, checkboxChecked: false });
    };
  });
}

export interface Stubs {
  readonly external: string[];
  readonly paths: string[];
  readonly boxes: string[];
}

export function stubs(app: ElectronApplication): Promise<Stubs> {
  return app.evaluate(() => (globalThis as unknown as { janusStubs: Stubs }).janusStubs);
}

/** Queues the folder the next folder picker returns. */
export async function pickFolder(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate((_electron, path) => {
    (globalThis as unknown as { janusStubs: { folders: string[] } }).janusStubs.folders.push(path);
  }, folder);
}

/** The first window whose URL matches, waiting for it to appear. */
export async function windowWhere(app: ElectronApplication, match: (url: string) => boolean): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(() => {
      found = app.windows().find((page) => !page.isClosed() && match(page.url()));
      return found !== undefined;
    })
    .toBe(true);
  return found as Page;
}

/** The status page of the project named `name`; every project window keeps one. */
export async function statusOf(app: ElectronApplication, name: string): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(async () => {
      for (const page of app.windows()) {
        if (page.isClosed() || !isStatus(page.url())) continue;
        const heading = await page
          .locator('h1')
          .textContent()
          .catch(() => null);
        if (heading === name) {
          found = page;
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  return found as Page;
}

export const isStart = (url: string): boolean => url === 'janus-app://app/start.html';
export const isStatus = (url: string): boolean => url === 'janus-app://app/status.html';
export const isLog = (url: string): boolean => url === 'janus-app://app/log.html';
export const isAtlas =
  (port: number) =>
  (url: string): boolean =>
    url.startsWith(`http://127.0.0.1:${String(port)}/_janus/ui/`);

/** Every project window's title. */
export function titles(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().map((window) => window.getTitle()));
}

/** Focuses the project window whose title contains `name`, then clicks a menu item. */
export async function menu(app: ElectronApplication, name: string, path: readonly [string, string]): Promise<void> {
  await app.evaluate(
    ({ BaseWindow, Menu }, { name, path }) => {
      const window = BaseWindow.getAllWindows().find((candidate) => candidate.getTitle().includes(` ${name} `));
      if (window === undefined) throw new Error(`no window for ${name}`);
      window.focus();
      const top = Menu.getApplicationMenu()?.items.find((item) => item.label === path[0]);
      const item = top?.submenu?.items.find((candidate) => candidate.label === path[1]);
      if (item === undefined) throw new Error(`no menu item ${path.join(' › ')}`);
      if (!item.enabled) throw new Error(`${path.join(' › ')} is disabled`);
      (item.click as () => void)();
    },
    { name, path },
  );
}

export interface ServerPid {
  readonly project: string;
  readonly pid: number | undefined;
}

export function serverPids(app: ElectronApplication): Promise<ServerPid[]> {
  return app.evaluate(() =>
    (globalThis as unknown as { janusDesktop: { serverPids(): ServerPid[] } }).janusDesktop.serverPids(),
  );
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

/** Holds a port until released. */
export async function holdPort(port: number): Promise<() => Promise<void>> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  return () =>
    new Promise((done) => {
      server.close(() => {
        done();
      });
    });
}

/** Whether something accepts connections on the port. */
export async function listening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${String(port)}/_janus/health`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * A copy of `examples/` on `port`, with `fixtures.watch` left to the app, so
 * watching is on by default.
 */
export async function copyExamples(port: number, name = 'shop-mocks'): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'janus-desktop-project-'));
  const folder = join(parent, name);
  await cp(EXAMPLES, folder, { recursive: true });
  const config = join(folder, 'janus.config.yaml');
  const text = await readFile(config, 'utf8');
  await writeFile(
    config,
    text
      .replace(/^ {2}port: 4010$/m, `  port: ${String(port)}`)
      .replace(/^ {2}watch: false\n/m, '')
      .replace(/^\$schema:.*\n/m, ''),
  );
  return folder;
}

export async function removeProject(folder: string): Promise<void> {
  await rm(resolve(folder, '..'), { recursive: true, force: true });
}

/** The Atlas UI has loaded its data. */
export async function atlasReady(page: Page): Promise<void> {
  await expect(page.getByRole('banner').getByRole('status')).toHaveText(/Ready/);
}

/** An axe-core audit at WCAG 2.2 AA. */
export async function audit(page: Page): Promise<void> {
  // Legacy mode runs in the page itself: Electron cannot open the extra page axe uses otherwise.
  const results = await new AxeBuilder({ page })
    .setLegacyMode(true)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
}
