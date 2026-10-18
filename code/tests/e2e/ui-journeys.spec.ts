import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startJanusWith, startMountProxy, startStaticSite, WORKSPACE, type Janus, type StaticSite } from './harness.js';
import {
  audit,
  bodiesAsText,
  driver,
  expectNoSidewaysScroll,
  INPUT_MODES,
  outlineStyle,
  revealFolder,
  showInventory,
  writeTree,
  type Driver,
} from './support.js';

// The UI browser journeys: each runs
// in every configured browser at 1280 px, once by mouse and once by keyboard
// alone; the axe audits run in Chromium; journeys 1–4 also run at 320 and
// 800 px in Chromium.

const DATA = join(WORKSPACE, 'examples/data');
const REVIEWS = 'default/v1/products/{productId}/reviews/GET/200.json';
const FIXED_CLOCK = ['--seed', '42', '--now', '2026-01-01T00:00:00Z'];

const serve = (...args: string[]) => startJanusWith(['--host', '127.0.0.1', '--port', '0', ...args]);

/** A temporary copy of the example fixtures, for journeys that edit files. */
async function copyExamples(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'janus-e2e-ui-'));
  await cp(DATA, root, { recursive: true });
  return root;
}

/** A free local port, for a server that is not running yet. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

const ready = (page: Page) => expect(page.getByRole('banner').getByRole('status')).toHaveText(/Ready/);

// Journeys 1–4 share one server on the example fixtures.
let examples: Janus;

test.beforeAll(async () => {
  examples = await serve('--no-config', '--data', DATA, ...FIXED_CLOCK);
});

test.afterAll(async () => {
  await examples.stop();
});

async function journeyServedUi(page: Page, input: Driver, view: (name: string) => Promise<void>): Promise<void> {
  // 1. The Janus-served UI, with no configuration at all.
  await page.goto(`${examples.url}/_janus/ui/#/endpoints`);
  await ready(page);
  await expect(page.getByRole('banner')).toContainText(`${examples.url}/_janus/`);
  await view('inventory');
  const nav = await showInventory(page, input);
  await input.activate(nav.getByRole('link', { name: 'GET /v1/products, scenario default', exact: true }));
  const heading = page.getByRole('heading', { level: 2, name: /\/v1\/products/ });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await view('endpoint detail');
  // A deep link survives a refresh.
  const deepLink = page.url();
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: /\/v1\/products/ })).toBeVisible();
  expect(page.url()).toBe(deepLink);
}

async function journeyInventory(page: Page, input: Driver, view: (name: string) => Promise<void>): Promise<void> {
  // 2. Search, filter by method, and open a template endpoint.
  await page.goto(`${examples.url}/_janus/ui/#/endpoints`);
  const nav = await showInventory(page, input);
  await input.fill(nav.getByRole('searchbox', { name: 'Filter endpoints' }), 'products');
  await input.activate(nav.getByRole('group', { name: 'Filter by method' }).getByRole('button', { name: 'GET' }));
  await expect(nav.getByRole('button', { name: 'GET' })).toHaveAttribute('aria-pressed', 'true');
  await expect(nav.getByRole('status')).toHaveText(/Showing 4 of \d+ endpoints/);
  await view('filtered inventory');
  await revealFolder(nav, input, '/v1/products/{productId}, path parameter productId');
  await input.activate(
    nav.getByRole('link', { name: 'GET /v1/products/{productId}, path parameter productId, scenario default' }),
  );
  await expect(page.getByRole('heading', { level: 2, name: /\/v1\/products\/\{productId\}/ })).toBeVisible();
  const matrix = page.getByRole('table', { name: 'Configured responses for this endpoint' });
  await expect(matrix).toContainText('application/json');
  await expect(matrix).toContainText('application/yaml');
  await view('template endpoint');
}

async function journeyFixture(page: Page, input: Driver, view: (name: string) => Promise<void>): Promise<void> {
  // 3. The representation matrix, a fixture's raw and rendered views, and a re-render.
  await page.goto(`${examples.url}/_janus/ui/#/endpoints`);
  const nav = await showInventory(page, input);
  await revealFolder(nav, input, '/v1/orders/{orderId}, path parameter orderId');
  await input.activate(
    nav.getByRole('link', { name: 'GET /v1/orders/{orderId}, path parameter orderId, scenario default', exact: true }),
  );
  await expect(page.getByRole('table', { name: 'Configured responses for this endpoint' })).toBeVisible();
  await input.activate(page.getByRole('link', { name: 'View response 200', exact: true }));
  const detail = page.getByRole('region', { name: 'Response 200' });
  await input.chooseTab(detail.getByRole('tab', { name: /^Tokens/ }));
  await expect(detail.getByRole('table', { name: 'Tokens' })).toContainText('{{$today+14d}}');
  await view('fixture detail, raw');

  // From 1024 px the panes resize, and keep their limits.
  const handle = page.getByRole('separator', { name: 'Resize endpoint tree' });
  if (await handle.isVisible()) {
    const before = Number(await handle.getAttribute('aria-valuenow'));
    await input.nudge(handle, 64);
    await expect(handle).toHaveAttribute('aria-valuenow', String(before + 64));
    const nav = page.getByRole('navigation', { name: 'Endpoints' });
    expect(Math.round((await nav.boundingBox())?.width ?? 0)).toBe(before + 64);
    await view('resized panes');
  }
  await input.activate(detail.getByRole('button', { name: 'Rendered' }));
  await expect(detail.getByText('2026-01-01T00:00:00Z (server default)')).toBeVisible();
  await view('fixture detail, rendered');
  await input.fill(detail.getByLabel('Render at'), '2026-06-30T12:00:00+02:00');
  await input.fill(detail.getByLabel('Path parameter {orderId}'), 'o-9');
  await page.keyboard.press('Enter');
  await expect(detail.getByText('2026-06-30T10:00:00Z (set here)')).toBeVisible();
  await expect(detail.getByLabel('Body preview (text)')).toContainText('"id":"o-9"');
}

async function journeyExplorer(page: Page, input: Driver, view: (name: string) => Promise<void>): Promise<void> {
  // 4. Simulate a request, read the explanation, share the link, follow the fixture link.
  await page.goto(`${examples.url}/_janus/ui/#/endpoints`);
  await ready(page);
  await input.activate(page.getByRole('banner').getByRole('link', { name: 'Requests' }));
  // The Requests tab opens in Live; the simulation form is Explore.
  await input.activate(page.getByRole('button', { name: 'Explore' }));
  const form = page.getByRole('form', { name: 'Request to simulate' });
  await view('explorer form');
  await input.fill(form.getByLabel('Target (path and query)'), '/v1/products/p-1/reviews');
  await input.activate(form.getByRole('button', { name: 'Explain' }));
  const result = page.getByRole('region', { name: 'Simulated response' });
  await expect(result.getByRole('heading', { name: 'Status 200' })).toBeVisible();
  await expect(result.getByRole('list', { name: 'Decisions' })).toContainText(
    'Matched /v1/products/{productId}/reviews',
  );
  await view('explorer result');

  // The page address is the shared link: opening it runs the explanation again.
  const shared = await page.context().newPage();
  await shared.goto(page.url());
  await expect(
    shared.getByRole('region', { name: 'Simulated response' }).getByRole('heading', { name: 'Status 200' }),
  ).toBeVisible();
  await shared.close();

  await input.activate(result.getByRole('link', { name: 'Open the fixture that answered' }));
  await expect(page.getByRole('region', { name: 'Response 200' }).getByLabel('Body preview (text)')).toContainText(
    '"Great"',
  );
}

const JOURNEYS_1_TO_4 = [
  ['1. Janus-served UI', journeyServedUi],
  ['2. inventory', journeyInventory],
  ['3. endpoint and fixture', journeyFixture],
  ['4. explorer', journeyExplorer],
] as const;

for (const mode of INPUT_MODES) {
  for (const [name, journey] of JOURNEYS_1_TO_4) {
    test(`${name} (${mode})`, async ({ page }, info) => {
      await bodiesAsText(page);
      await journey(page, driver(page, mode), (view) => audit(page, info, mode, view));
    });
  }
}

for (const width of [320, 800]) {
  test.describe(`at ${String(width)} px`, () => {
    test.skip(({ browserName }) => browserName !== 'chromium', 'other widths run in Chromium only');
    test.use({ viewport: { width, height: 800 } });
    for (const [name, journey] of JOURNEYS_1_TO_4) {
      test(`${name} (mouse)`, async ({ page }, info) => {
        await bodiesAsText(page);
        await journey(page, driver(page, 'mouse'), async (view) => {
          if (width === 320) await expectNoSidewaysScroll(page);
          await audit(page, info, 'mouse', `${view} at ${String(width)} px`);
        });
      });
    }
  });
}

test.describe('5. reload', () => {
  let root: string;
  let janus: Janus;

  test.beforeAll(async () => {
    root = await copyExamples();
    janus = await serve('--no-config', '--data', root, '--watch');
  });

  test.afterAll(async () => {
    await janus.stop();
    await rm(root, { recursive: true, force: true });
  });

  for (const mode of INPUT_MODES) {
    test(`break and fix a fixture on disk (${mode})`, async ({ page }, info) => {
      const input = driver(page, mode);
      await page.goto(`${janus.url}/_janus/ui/#/endpoints`);
      await ready(page);
      const file = join(root, ...REVIEWS.split('/'));
      await writeFile(file, '[{ "rating": 5,\n  "text": }]\n');
      const failed = page.getByRole('banner').getByRole('button', { name: 'Reload failed (1 error)' });
      await expect(failed).toBeVisible({ timeout: 10_000 });
      await input.activate(failed);
      await expect(page.getByRole('region', { name: 'Reload errors' })).toContainText('invalid-json');
      await audit(page, info, mode, 'reload errors');

      await writeFile(file, `[{ "rating": 4, "text": "Fixed ${mode}" }]\n`);
      const changed = page.getByText('The fixtures changed.');
      await expect(changed).toBeVisible({ timeout: 10_000 });
      await audit(page, info, mode, 'snapshot changed');
      await input.activate(page.getByRole('button', { name: 'Refresh view' }));
      await expect(changed).toHaveCount(0);
      await ready(page);
    });
  }
});

test.describe('6. config', () => {
  let root: string;
  let janus: Janus;

  test.beforeAll(async () => {
    root = await writeTree('janus-e2e-ui-config-', {
      'janus.config.yaml': 'fixtures:\n  root: ./fixtures\n',
      'fixtures/default/v1/products/GET/200_{application-json}.json': '[]',
      // Repeats the media type the file name sets: a startup warning.
      'fixtures/default/v1/products/GET/200.headers.json': '{"Content-Type":"application/json"}',
    });
    janus = await serve('--config', join(root, 'janus.config.yaml'));
  });

  test.afterAll(async () => {
    await janus.stop();
    await rm(root, { recursive: true, force: true });
  });

  for (const mode of INPUT_MODES) {
    test(`open the configuration and the warnings (${mode})`, async ({ page }, info) => {
      const input = driver(page, mode);
      await page.goto(`${janus.url}/_janus/ui/#/endpoints`);
      await ready(page);
      const banner = page.getByRole('banner');
      const toggle = banner.getByRole('button', { name: '1 startup warning' });
      await input.activate(toggle);
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('region', { name: 'Startup warnings' }).getByRole('listitem')).toHaveText([
        /^redundant-content-type: /,
      ]);
      await audit(page, info, mode, 'startup warnings');
      await input.activate(banner.getByRole('button', { name: 'Configuration' }));
      await expect(page.getByRole('dialog', { name: 'Configuration' })).toBeVisible();
      await expect(page.getByRole('table', { name: 'Effective settings: ui' })).toContainText('ui.enabled');
      await expect(page.getByRole('table', { name: 'Effective settings: cors' })).toContainText('cors.origins');
      await audit(page, info, mode, 'configuration');
    });
  }
});

test.describe('7. cross-origin UI', () => {
  let root: string;
  let janus: Janus;
  let listed: StaticSite;
  let unlisted: StaticSite;
  let configRoot: string;
  let janusUrl = '';

  test.beforeAll(async () => {
    listed = await startStaticSite(() => janusUrl);
    unlisted = await startStaticSite(() => janusUrl);
    root = await copyExamples();
    configRoot = await mkdtemp(join(tmpdir(), 'janus-e2e-ui-cors-'));
    const config = join(configRoot, 'janus.config.yaml');
    await writeFile(
      config,
      `fixtures:\n  root: ${JSON.stringify(root)}\ncors:\n  origins: [${JSON.stringify(listed.url)}]\n`,
    );
    janus = await serve('--config', config, '--watch');
    janusUrl = janus.url;
  });

  test.afterAll(async () => {
    await listed.close();
    await unlisted.close();
    await janus.stop();
    await rm(root, { recursive: true, force: true });
    await rm(configRoot, { recursive: true, force: true });
  });

  for (const mode of INPUT_MODES) {
    test(`a listed origin connects, an unlisted one is told why (${mode})`, async ({ page }, info) => {
      const input = driver(page, mode);

      // Listed: the inventory, a simulated request (a preflighted POST), and the event stream.
      await page.goto(`${listed.url}/`);
      await ready(page);
      await expect(page.getByRole('banner')).toContainText(`${janus.url}/_janus/`);
      await input.activate(page.getByRole('banner').getByRole('link', { name: 'Requests' }));
      // The Requests tab opens in Live; the simulation form is Explore.
      await input.activate(page.getByRole('button', { name: 'Explore' }));
      const form = page.getByRole('form', { name: 'Request to simulate' });
      await input.fill(form.getByLabel('Target (path and query)'), '/v1/products');
      await input.activate(form.getByRole('button', { name: 'Explain' }));
      await expect(
        page.getByRole('region', { name: 'Simulated response' }).getByRole('heading', { name: 'Status 200' }),
      ).toBeVisible();
      await writeFile(join(root, 'default', 'v1', 'products', 'GET', '200.json'), `["${mode}"]\n`);
      await expect(page.getByText('The fixtures changed.')).toBeVisible({ timeout: 10_000 });

      // Unlisted: the cross-origin diagnostic names the page's origin.
      await page.goto(`${unlisted.url}/`);
      const alert = page.getByRole('alert');
      await expect(alert.getByRole('heading', { name: 'Janus is unavailable' })).toBeVisible();
      await expect(alert).toContainText("it may not list this page's origin in cors.origins");
      await expect(alert).toContainText(unlisted.url);
      await audit(page, info, mode, 'cross-origin diagnostic');

      // And it cannot change the server's state: the reload is refused before it runs.
      const sent = await page.evaluate(async (url) => {
        try {
          await fetch(`${url}/_janus/reload`, { method: 'POST' });
          return 'read';
        } catch {
          return 'unreadable';
        }
      }, janus.url);
      expect(sent).toBe('unreadable');
      await expect.poll(() => janus.output.stdout).toMatch(/method=POST path=\/_janus\/reload status=403/);
    });
  }
});

test.describe('8. disabled features', () => {
  let root: string;
  let noUi: Janus;
  let noResolve: Janus;

  test.beforeAll(async () => {
    root = await writeTree('janus-e2e-ui-disabled-', {
      'janus.config.yaml': 'fixtures:\n  root: ./fixtures\natlas:\n  resolve: false\n',
      'fixtures/default/v1/products/GET/200_{application-json}.json': '[]',
    });
    noUi = await serve('--no-config', '--data', DATA, '--no-ui');
    noResolve = await serve('--config', join(root, 'janus.config.yaml'));
  });

  test.afterAll(async () => {
    await noUi.stop();
    await noResolve.stop();
    await rm(root, { recursive: true, force: true });
  });

  for (const mode of INPUT_MODES) {
    test(`--no-ui and atlas.resolve: false (${mode})`, async ({ page }, info) => {
      const input = driver(page, mode);
      const response = await page.goto(`${noUi.url}/_janus/ui/`);
      expect(response?.status()).toBe(404);

      // Requests is the home page.
      await page.goto(`${noResolve.url}/_janus/ui/`);
      await expect(page).toHaveURL(/#\/requests(\?|$)/);
      await ready(page);
      await input.activate(page.getByRole('banner').getByRole('link', { name: 'Requests' }));
      // The runner still sends; only Explore is off.
      await expect(page.getByRole('button', { name: 'Explore' })).toBeDisabled();
      await expect(page.getByRole('heading', { level: 2, name: 'Live sends saved requests' })).toBeVisible();
      await audit(page, info, mode, 'explorer disabled');
    });
  }
});

test.describe('9. reverse proxy', () => {
  let proxy: StaticSite;

  test.beforeAll(async () => {
    proxy = await startMountProxy(() => examples.port);
  });

  test.afterAll(async () => {
    await proxy.close();
  });

  for (const mode of INPUT_MODES) {
    test(`a path-prefixed proxy that passes Host through (${mode})`, async ({ page }) => {
      const input = driver(page, mode);
      await page.goto(`${proxy.url}/mock/_janus/ui`);
      await expect(page).toHaveURL(new RegExp(`^${proxy.url}/mock/_janus/ui/#/requests`));
      await ready(page);
      await expect(page.getByRole('banner')).toContainText(`${proxy.url}/mock/_janus/`);
      const nav = await showInventory(page, input);
      await expect(nav.getByRole('link', { name: 'GET /v1/products, scenario default', exact: true })).toBeVisible();

      // The page's own origin may change state: Host passes through, so it matches Origin.
      const status = await page.evaluate(async () => (await fetch('../reload', { method: 'POST' })).status);
      expect(status).toBe(200);
      await input.activate(page.getByRole('banner').getByRole('link', { name: 'Requests' }));
      // The Requests tab opens in Live; the simulation form is Explore.
      await input.activate(page.getByRole('button', { name: 'Explore' }));
      const form = page.getByRole('form', { name: 'Request to simulate' });
      await input.fill(form.getByLabel('Target (path and query)'), '/v1/products');
      await input.activate(form.getByRole('button', { name: 'Explain' }));
      await expect(
        page.getByRole('region', { name: 'Simulated response' }).getByRole('heading', { name: 'Status 200' }),
      ).toBeVisible();
    });
  }
});

test.describe('10. states and preferences', () => {
  let watched: string;
  let watchedJanus: Janus;

  test.beforeAll(async () => {
    watched = await copyExamples();
    watchedJanus = await serve('--no-config', '--data', watched, '--watch');
  });

  test.afterAll(async () => {
    await watchedJanus.stop();
    await rm(watched, { recursive: true, force: true });
  });

  for (const mode of INPUT_MODES) {
    test(`an empty inventory, an outage and its retry, a stale link (${mode})`, async ({ page }, info) => {
      const input = driver(page, mode);

      // An empty inventory. Janus refuses to start on an empty data root
      // (missing-default-scenario), so the empty state a real server reaches is a search with no match.
      await page.goto(`${examples.url}/_janus/ui/#/endpoints`);
      const inventory = await showInventory(page, input);
      await input.fill(inventory.getByRole('searchbox', { name: 'Filter endpoints' }), 'no-such-endpoint');
      await expect(inventory.getByRole('heading', { name: 'No matching endpoints' })).toBeVisible();
      await audit(page, info, mode, 'empty inventory');

      // An unreachable server, then the retry once it is up.
      const port = await freePort();
      const site = await startStaticSite(() => `http://127.0.0.1:${String(port)}`);
      const lateRoot = await mkdtemp(join(tmpdir(), 'janus-e2e-ui-late-'));
      let late: Janus | undefined;
      try {
        await page.goto(`${site.url}/`);
        const alert = page.getByRole('alert');
        await expect(alert.getByRole('heading', { name: 'Janus is unavailable' })).toBeVisible();
        await audit(page, info, mode, 'unavailable');
        const config = join(lateRoot, 'janus.config.yaml');
        await writeFile(
          config,
          `fixtures:\n  root: ${JSON.stringify(DATA)}\ncors:\n  origins: [${JSON.stringify(site.url)}]\n`,
        );
        late = await startJanusWith(['--config', config, '--host', '127.0.0.1', '--port', String(port)]);
        await input.activate(alert.getByRole('button', { name: 'Retry connection' }));
        await ready(page);
      } finally {
        await late?.stop();
        await site.close();
        await rm(lateRoot, { recursive: true, force: true });
      }

      // A detail link from an older snapshot: 409, shown as a stale view with a refresh.
      await page.goto(`${watchedJanus.url}/_janus/ui/#/endpoints`);
      const nav = await showInventory(page, input);
      await writeFile(join(watched, 'default', 'GET', '200.txt'), `changed by ${mode}\n`);
      await expect(page.getByText('The fixtures changed.')).toBeVisible({ timeout: 10_000 });
      await input.activate(nav.getByRole('link', { name: 'GET /v1/products, scenario default', exact: true }));
      const stale = page.getByRole('main').getByRole('heading', { name: 'Snapshot changed' });
      await expect(stale).toBeVisible();
      await audit(page, info, mode, 'stale detail');
      await input.activate(page.getByRole('main').getByRole('button', { name: /Refresh/ }));
      await expect(page.getByRole('heading', { level: 2, name: /\/v1\/products/ })).toBeVisible();
    });

    test(`a theme choice persists with no flash (${mode})`, async ({ page }, info) => {
      const input = driver(page, mode);
      await page.goto(`${examples.url}/_janus/ui/#/endpoints`);
      await ready(page);
      // The logo is the theme switch.
      await input.activate(page.getByRole('button', { name: 'Switch to dark theme' }));
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

      // Without the application script, the stored choice still applies before anything paints.
      await page.route(/\/assets\/index-[^/]*\.js$/, (route) => route.abort());
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.unrouteAll();
      await page.reload();
      await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await audit(page, info, mode, 'dark theme chosen');
    });
  }

  test('forced colors keep chosen states distinguishable', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Playwright emulates forced colors in Chromium only');
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto(`${examples.url}/_janus/ui/#/endpoints`);
    await ready(page);
    const methods = page.getByRole('group', { name: 'Filter by method' });
    await methods.getByRole('button', { name: 'GET' }).click();
    const outline = (name: string) => outlineStyle(methods.getByRole('button', { name }));
    expect(await outline('GET')).toBe('solid');
    expect(await outline('POST')).not.toBe('solid');
    // States carry text, not only colour.
    await expect(page.getByRole('banner').getByRole('status')).toHaveText(/Ready/);
  });

  test('nothing animates under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // The longest animation or transition seen, sampled every frame. The reduced-motion
    // rule shortens transitions to 0.01 ms, so anything longer than 1 ms is motion.
    await page.addInitScript(`
      globalThis.__janusMotion = [];
      const sample = () => {
        for (const animation of document.getAnimations()) {
          const duration = Number(animation.effect?.getComputedTiming().duration ?? 0);
          if (duration > 1) globalThis.__janusMotion.push(animation.animationName ?? animation.transitionProperty);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    `);
    await page.setViewportSize({ width: 800, height: 800 });
    await page.goto(`${examples.url}/_janus/ui/#/endpoints`);
    await ready(page);
    await page.getByRole('button', { name: 'Fold the endpoint list' }).click();
    await page.getByRole('button', { name: 'Show the endpoint list' }).click();
    await page.getByRole('banner').getByRole('link', { name: 'Requests' }).click();
    await page.getByRole('banner').getByRole('button', { name: 'Configuration' }).click();
    await expect(page.getByRole('table', { name: 'Effective settings: ui' })).toBeVisible();
    expect(await page.evaluate('[...new Set(globalThis.__janusMotion)]')).toEqual([]);
  });
});
