import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  atlasReady,
  audit,
  copyExamples,
  freePort,
  holdPort,
  isAtlas,
  isLog,
  isStart,
  launch,
  listening,
  menu,
  removeProject,
  serverPids,
  statusOf,
  stubs,
  titles,
  windowWhere,
  type Desktop,
} from './support.js';

// The Electron journeys, against the built app.

const REVIEWS = ['data', 'default', 'v1', 'products', '{productId}', 'reviews', 'GET', '200.json'];
const engines = JSON.parse(await readFile(join(import.meta.dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
  engines: { node: string };
};

let desktop: Desktop | undefined;
const projects: string[] = [];

test.afterEach(async () => {
  await desktop?.close();
  desktop = undefined;
  for (const folder of projects.splice(0)) await removeProject(folder);
});

test('1. the start page with no recent projects, by keyboard and axe', async () => {
  desktop = await launch();
  const start = await windowWhere(desktop.app, isStart);
  await expect(start.getByRole('heading', { level: 1, name: 'Janus' })).toBeVisible();
  await expect(start.getByText('No recent projects.')).toBeVisible();
  await audit(start);
  // A keyboard-only walk: both actions are reachable with Tab, in order.
  await start.keyboard.press('Tab');
  await expect(start.getByRole('button', { name: 'Open Project…' })).toBeFocused();
  await start.keyboard.press('Tab');
  await expect(start.getByRole('button', { name: 'New Project…' })).toBeFocused();
  await start.emulateMedia({ colorScheme: 'dark' });
  await audit(start);
});

test('2 to 4. a project opens on the Atlas, which has no bridge or way out, and follows edits', async () => {
  const port = await freePort();
  const folder = await copyExamples(port);
  projects.push(folder);
  desktop = await launch({ folders: [folder] });
  const { app } = desktop;

  // 2. The Atlas UI loads, the title shows the mock URL, and mocks answer.
  const atlas = await windowWhere(app, isAtlas(port));
  await atlasReady(atlas);
  const url = `http://127.0.0.1:${String(port)}`;
  expect(await titles(app)).toContain(`Janus — shop-mocks — ${url}`);
  const greeting = await fetch(`${url}/v1/greeting`);
  expect(greeting.status).toBe(200);
  // Watch is on because the file no longer sets it; the app passes it as the CLI's --watch.
  const config = (await (await fetch(`${url}/_janus/config`)).json()) as {
    settings: { key: string; value: unknown; source: string }[];
  };
  expect(config.settings.find((setting) => setting.key === 'fixtures.watch')).toMatchObject({
    value: true,
    source: 'cli',
  });

  // 4. Editing a fixture shows up without any action.
  await writeFile(join(folder, ...REVIEWS), '[{ "rating": 4, "text": "Edited in the app" }]\n');
  await expect(atlas.getByText('The fixtures changed.')).toBeVisible();

  // 3. No bridge; navigation away is cancelled and handed to the system browser; window.open opens nothing.
  // (Strings, as the tests compile without the DOM library.)
  expect(await atlas.evaluate('typeof window.janusApp')).toBe('undefined');
  const windows = app.windows().length;
  await atlas.evaluate(`window.location.href = ${JSON.stringify(`${url}/v1/greeting`)}`);
  await expect.poll(async () => (await stubs(app)).external).toContain(`${url}/v1/greeting`);
  expect(atlas.url()).toContain('/_janus/ui/');
  await atlas.evaluate(
    "window.open('https://example.com/docs', '_blank'); window.open('file:///etc/passwd', '_blank');",
  );
  await expect.poll(async () => (await stubs(app)).external).toContain('https://example.com/docs');
  expect((await stubs(app)).external).not.toContain('file:///etc/passwd');
  expect(app.windows().length).toBe(windows);

  // File › Import Collection… opens the Requests page with the import dialog.
  await menu(app, 'shop-mocks', ['File', 'Import Collection…']);
  await expect(atlas.getByRole('dialog', { name: 'Import' })).toBeVisible();
  expect(atlas.url()).toContain('#/requests?import=1');

  // Server › Configuration… opens the settings as a dialog over the current view; the app has no button for it.
  await atlas.keyboard.press('Escape');
  await menu(app, 'shop-mocks', ['Server', 'Configuration…']);
  await expect(atlas.getByRole('dialog', { name: 'Configuration' })).toBeVisible();
  expect(atlas.url()).toContain('config=1');
  await expect(atlas.getByRole('banner').getByRole('button', { name: 'Configuration' })).toHaveCount(0);
});

test('5. a broken fixture lists its error, opens its file, and recovers on Retry', async () => {
  const port = await freePort();
  const folder = await copyExamples(port);
  projects.push(folder);
  desktop = await launch({ folders: [folder] });
  const { app } = desktop;
  await atlasReady(await windowWhere(app, isAtlas(port)));

  const reviews = join(folder, ...REVIEWS);
  const original = await readFile(reviews, 'utf8');
  await writeFile(reviews, '[{ "rating": 5,\n  "text": }]\n');
  await menu(app, 'shop-mocks', ['Server', 'Restart']);
  const status = await statusOf(app, 'shop-mocks');
  const problem = status.getByRole('list', { name: 'Problems' }).getByRole('listitem').first();
  await expect(problem).toContainText('data/default/v1/products/{productId}/reviews/GET/200.json:2:');
  await expect(problem).toContainText('invalid-json');
  await expect.poll(() => titles(app)).toContain('Janus — shop-mocks — needs attention');
  await audit(status);
  await problem.getByRole('button', { name: /Open File/ }).click();
  await expect.poll(async () => (await stubs(app)).paths).toContain(reviews);

  await writeFile(reviews, original);
  await status.getByRole('button', { name: 'Retry' }).click();
  await atlasReady(await windowWhere(app, isAtlas(port)));
});

test('6. a taken port offers Start on a Free Port', async () => {
  const port = await freePort();
  const folder = await copyExamples(port);
  projects.push(folder);
  const release = await holdPort(port);
  try {
    desktop = await launch({ folders: [folder] });
    const { app } = desktop;
    const status = await statusOf(app, 'shop-mocks');
    await expect(status.getByRole('heading', { name: 'Port in use' })).toBeVisible();
    await expect(status.getByText(`127.0.0.1:${String(port)}`)).toBeVisible();
    await audit(status);
    // Restarting changes nothing while the port is held: the app never picks another port by itself.
    await menu(app, 'shop-mocks', ['Server', 'Restart']);
    await expect(status.getByRole('heading', { name: 'Port in use' })).toBeVisible();
    expect(await titles(app)).toContain('Janus — shop-mocks — needs attention');

    await status.getByRole('button', { name: 'Start on a Free Port' }).click();
    await expect
      .poll(async () => (await titles(app)).find((title) => /shop-mocks — http:\/\/127\.0\.0\.1:\d+$/.test(title)))
      .toBeDefined();
    const title = (await titles(app)).find((candidate) => candidate.includes('shop-mocks')) ?? '';
    const moved = Number(/:(\d+)$/.exec(title)?.[1]);
    expect(moved).not.toBe(port);
    expect((await fetch(`http://127.0.0.1:${String(moved)}/v1/greeting`)).status).toBe(200);
    await atlasReady(await windowWhere(app, isAtlas(moved)));
  } finally {
    await release();
  }
});

test('7 to 9. two projects side by side, one killed, then quit and relaunch', async () => {
  const first = await freePort();
  const second = await freePort();
  const a = await copyExamples(first, 'shop-mocks');
  const b = await copyExamples(second, 'pay-mocks');
  projects.push(a, b);
  desktop = await launch({ folders: [a, b] });
  const { app, userData } = desktop;

  // 7. Two windows, two servers, both answering.
  await atlasReady(await windowWhere(app, isAtlas(first)));
  await atlasReady(await windowWhere(app, isAtlas(second)));
  expect((await fetch(`http://127.0.0.1:${String(first)}/v1/greeting`)).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${String(second)}/v1/greeting`)).status).toBe(200);
  const pids = await serverPids(app);
  expect(new Set(pids.map((entry) => entry.pid)).size).toBe(2);

  // 8. A server killed from outside: its window shows the stopped state with the last log lines.
  const killed = pids.find((entry) => entry.project.endsWith('pay-mocks'))?.pid;
  expect(killed).toBeDefined();
  process.kill(killed as number, 'SIGKILL');
  const status = await statusOf(app, 'pay-mocks');
  await expect(status.getByRole('heading', { name: 'The server stopped unexpectedly' })).toBeVisible();
  await expect(status.getByLabel('Last log lines')).toContainText('janus started');
  await audit(status);
  await status.getByRole('button', { name: 'Show Server Log' }).click();
  const log = await windowWhere(app, isLog);
  await expect(log.getByLabel('Log lines')).toContainText('Janus listening on');
  await audit(log);

  // 9. Quitting closes every port within the bound; relaunching reopens the last project opened,
  // and both projects are recent.
  const quitting = Date.now();
  await desktop.close();
  expect(Date.now() - quitting).toBeLessThan(7000 + 3000);
  expect(await listening(first)).toBe(false);
  expect(await listening(second)).toBe(false);
  desktop = await launch({ userData });
  await atlasReady(await windowWhere(desktop.app, isAtlas(second)));
  expect((await serverPids(desktop.app)).map((entry) => entry.project)).toEqual([expect.stringMatching(/pay-mocks$/)]);
  expect(desktop.app.windows().some((page) => isStart(page.url()))).toBe(false);
  await menu(desktop.app, 'pay-mocks', ['File', 'Close Window']);
  const start = await windowWhere(desktop.app, isStart);
  await expect(start.getByRole('button', { name: /^pay-mocks/ })).toBeVisible();
  await expect(start.getByRole('button', { name: /^shop-mocks/ })).toBeVisible();
  await audit(start);

  // When the last project's folder is gone, the next launch shows the start page instead.
  await desktop.close();
  await removeProject(b);
  desktop = await launch({ userData });
  const fallback = await windowWhere(desktop.app, isStart);
  await expect(fallback.getByText('· folder missing')).toBeVisible();
  await expect(fallback.getByRole('button', { name: 'Remove pay-mocks from recent projects' })).toBeVisible();
  await expect(fallback.getByRole('button', { name: /^shop-mocks/ })).toBeVisible();
  expect(await serverPids(desktop.app)).toEqual([]);
});

test('10. the bundled Node satisfies engines.node', async () => {
  desktop = await launch();
  const version = await desktop.app.evaluate(() => process.versions.node);
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const [wantMajor = 0, wantMinor = 0] = (/>=\s*(\d+)\.(\d+)/.exec(engines.engines.node) ?? []).slice(1).map(Number);
  expect(major > wantMajor || (major === wantMajor && minor >= wantMinor), `Node ${version}`).toBe(true);
});
