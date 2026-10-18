import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startJanusWith, startProxy, WORKSPACE, type Janus, type Proxy } from './harness.js';
import { bodiesAsText } from './support.js';

// The acceptance journey, in a
// browser against a real `janus serve --watch` writing to a temporary fixture tree.

const REVIEWS = 'default/v1/products/{productId}/reviews/GET/200.json';

let root: string;
let janus: Janus;
let proxy: Proxy;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'janus-e2e-explorer-'));
  await cp(join(WORKSPACE, 'examples/data'), root, { recursive: true });
  janus = await startJanusWith([
    '--no-config',
    '--data',
    root,
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--seed',
    '42',
    '--now',
    '2026-01-01T00:00:00Z',
    '--watch',
  ]);
  proxy = await startProxy(() => janus.port);
});

test.afterAll(async () => {
  await proxy.close();
  await janus.stop();
  await rm(root, { recursive: true, force: true });
});

const fixture = (path: string) => join(root, ...path.split('/'));

test('explain a request, survive a broken edit, see the fix, and share a filtered inventory', async ({ page }) => {
  await bodiesAsText(page);
  // 1. A watched server with a literal route (/v1/products/p-1) beside a template route.
  await page.goto(`${proxy.url}/ui/#/endpoints`);
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('status')).toHaveText(/Ready/);

  // 2. The explorer explains the abandoned literal branch and the matched template.
  await banner.getByRole('link', { name: 'Requests' }).click();
  // The Requests tab opens in Live; the simulation form is Explore.
  await page.getByRole('button', { name: 'Explore' }).click();
  const form = page.getByRole('form', { name: 'Request to simulate' });
  await expect(form.getByText('Simulation only — nothing is served, stored or sent.')).toBeVisible();
  await form.getByLabel('Target (path and query)').fill('/v1/products/p-1/reviews');
  await form.getByRole('button', { name: 'Explain' }).click();
  const result = page.getByRole('region', { name: 'Simulated response' });
  // The body sits behind its own tab.
  const body = async () => {
    await result.getByRole('tab', { name: 'Body' }).click();
    return result.getByLabel('Body preview (text)');
  };
  await expect(result.getByRole('heading', { name: 'Status 200' })).toBeVisible();
  const decisions = result.getByRole('list', { name: 'Decisions' });
  await expect(decisions).toContainText('Matched /v1/products/{productId}/reviews');
  await expect(decisions).toContainText('Templates considered and abandoned: /v1/products/p-1.');
  await expect(decisions).toContainText('{productId} = p-1');
  await expect(await body()).toContainText('"Great"');
  // Simulating served nothing: the request log has the Atlas call, not the simulated path.
  expect(janus.output.stdout).toContain('path=/_janus/resolve');
  expect(janus.output.stdout).not.toContain('path=/v1/products/p-1/reviews');

  // 3. A broken edit: "Reload failed" with file and line, and the old snapshot keeps serving.
  await writeFile(fixture(REVIEWS), '[{ "rating": 5,\n  "text": }]\n');
  const failed = banner.getByRole('button', { name: 'Reload failed (1 error)' });
  await expect(failed).toBeVisible({ timeout: 10_000 });
  await failed.click();
  const errors = page.getByRole('region', { name: 'Reload errors' });
  await expect(errors).toContainText('GET /v1/products/{productId}/reviews — 200.json line 2');
  await expect(errors).toContainText('invalid-json');
  expect(await (await fetch(`${janus.url}/v1/products/p-1/reviews`)).text()).toContain('Great');

  // 4. The fix: the snapshot-changed banner, and after Refresh the change is everywhere.
  await writeFile(fixture(REVIEWS), '[{ "rating": 4, "text": "Fixed" }]\n');
  const changed = page.getByText('The fixtures changed.');
  await expect(changed).toBeVisible({ timeout: 10_000 });
  await expect(failed).toHaveCount(0);
  // The explanation on screen is labelled stale; re-running it answers from the new snapshot.
  await expect(result.getByText('Stale result')).toBeVisible();
  await result.getByRole('button', { name: 'Re-run' }).click();
  await expect(await body()).toContainText('"Fixed"');
  await expect(result.getByText('Stale result')).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh view' }).click();
  await expect(changed).toHaveCount(0);
  await expect(banner.getByRole('status')).toHaveText(/Ready/);
  // The refreshed view runs the explanation in its link again.
  await expect(result.getByRole('heading', { name: 'Status 200' })).toBeVisible();
  await expect(await body()).toContainText('"Fixed"');
  await result.getByRole('link', { name: 'Open the fixture that answered' }).click();
  await expect(page.getByRole('region', { name: 'Response 200' }).getByLabel('Body preview (text)')).toContainText(
    '"Fixed"',
  );

  // 5. Filter the inventory to POST and search for products; the hash reproduces the view.
  const inventory = page.getByRole('navigation', { name: 'Endpoints' });
  await inventory.getByRole('group', { name: 'Filter by method' }).getByRole('button', { name: 'POST' }).click();
  await inventory.getByRole('searchbox', { name: 'Filter endpoints' }).fill('products');
  const post = inventory.getByRole('link', { name: 'POST /v1/products, scenario default' });
  await expect(inventory.getByRole('link')).toHaveCount(1);
  await expect(post).toBeVisible();
  await expect(inventory.getByRole('status')).toHaveText(/Showing 1 of \d+ endpoints/);
  await page.reload();
  await expect(inventory.getByRole('searchbox', { name: 'Filter endpoints' })).toHaveValue('products');
  await expect(inventory.getByRole('button', { name: 'POST' })).toHaveAttribute('aria-pressed', 'true');
  await expect(inventory.getByRole('link')).toHaveCount(1);
  await expect(post).toBeVisible();

  // Nothing path-like reached the page or the Atlas responses.
  expect(await page.content()).not.toContain(root);
  expect(proxy.atlasBodies.join('\n')).not.toContain(root);
});

test('a header added after an explanation takes effect on the first Explain', async ({ page }) => {
  await bodiesAsText(page);
  const resolves: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/_janus/resolve')) resolves.push(request.postData() ?? '');
  });
  await page.goto(`${proxy.url}/ui/#/explorer`);
  const form = page.getByRole('form', { name: 'Request to simulate' });
  const result = page.getByRole('region', { name: 'Simulated response' });
  const body = async () => {
    await result.getByRole('tab', { name: 'Body' }).click();
    return result.getByLabel('Body preview (text)');
  };
  await form.getByLabel('Target (path and query)').fill('/v1/products');
  await form.getByRole('button', { name: 'Explain' }).click();
  await expect(await body()).toContainText('"Example"');
  expect(resolves).toHaveLength(1);

  // The hash gains the header, and the one request sent carries it: the old link is not re-run after it.
  await form.getByRole('button', { name: 'Add header' }).click();
  await form.getByLabel('Header 1 name').fill('X-Trace');
  await form.getByLabel('Header 1 value').fill('t-1');
  await form.getByRole('button', { name: 'Explain' }).click();
  await expect(page).toHaveURL(/h=X-Trace%3A\+t-1/);
  await expect.poll(() => resolves.length).toBe(2);
  expect(resolves[1]).toContain('"x-trace":["t-1"]');
});
