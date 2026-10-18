import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { SHOW_SNAPSHOT_COUNTS } from '../../apps/ui/src/layouts/showSnapshotCounts.js';
import { startJanus, startProxy, WORKSPACE, type Janus, type Proxy } from './harness.js';
import { bodiesAsText } from './support.js';

// The Atlas acceptance journey: the built UI
// and Janus behind one same-origin proxy, with Janus mounted below `/mock`.

const DATA = join(WORKSPACE, 'examples/data');

let janus: Janus;
let proxy: Proxy;

test.beforeAll(async () => {
  janus = await startJanus(DATA);
  proxy = await startProxy(() => janus.port);
});

test.afterAll(async () => {
  await proxy.close();
  await janus.stop();
});

async function openResponse(page: Page, endpoint: string, response: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Endpoints' }).getByRole('link', { name: endpoint, exact: true }).click();
  await page.getByRole('link', { name: response, exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: response.replace('View response', 'Response') }),
  ).toBeVisible();
}

test('browse the active snapshot, then recover from an outage', async ({ page }) => {
  await bodiesAsText(page);
  const atlasHeaders: Record<string, string>[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/mock/_janus/')) atlasHeaders.push(response.headers());
  });
  const health = (await (await fetch(`${janus.url}/_janus/health`)).json()) as { snapshotVersion: string };

  // Ready, with the active snapshot, through the runtime serverUrl.
  await page.goto(`${proxy.url}/ui/#/endpoints`);
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('status')).toHaveText(/Ready/);
  // The header shows the snapshot version only while SHOW_SNAPSHOT_COUNTS is on.
  if (SHOW_SNAPSHOT_COUNTS) await expect(banner).toContainText(health.snapshotVersion);
  await expect(banner).toContainText(`${proxy.url}/mock/_janus/`);
  const inventory = page.getByRole('navigation', { name: 'Endpoints' });

  // A path tree open to the second level: the endpoints under p-1, {productId} and {orderId} start collapsed.
  await expect(inventory.getByRole('link')).toHaveCount(12);
  await expect(inventory.getByRole('link').first()).toHaveAccessibleName('GET /, scenario default');
  await expect(inventory.getByRole('button', { name: '/v1/products', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(inventory.getByRole('button', { name: '/v1/products/p-1', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  // Text.
  await openResponse(page, 'GET /, scenario default', 'View response 200');
  await expect(page.getByLabel('Body preview (text)')).toHaveText('Janus example fixtures. Try GET /v1/products.\n');

  // JSON.
  await openResponse(page, 'GET /v1/products, scenario default', 'View response 200');
  await expect(page.getByLabel('Body preview (text)')).toHaveText('[{ "id": "p-1", "name": "Example" }]\n');

  // Binary.
  await openResponse(page, 'GET /v1/logo, scenario default', 'View response 200');
  await expect(page.getByLabel('Body preview (binary, base64)')).toHaveText(/^iVBORw0KGgo/);

  // Localized: the neutral representation first, then locales.
  // French has two media types, so the link names the one it opens.
  await openResponse(page, 'GET /v1/greeting, scenario default', 'View response 200 (fr, application/json)');
  await expect(page.getByLabel('Body preview (text)')).toHaveText('{ "message": "Bonjour !" }\n');
  const rows = page.getByRole('table', { name: 'Configured responses for this endpoint' }).getByRole('row');
  await expect(rows.nth(1)).toContainText('Any (neutral)');
  await expect(rows.nth(2)).toContainText('en-US');
  await expect(rows.nth(3)).toContainText('fr');

  // Bodyless, stated in text.
  await inventory.getByRole('button', { name: '/v1/products/p-1', exact: true }).click();
  await openResponse(page, 'DELETE /v1/products/p-1, scenario default', 'View response 204');
  await expect(page.getByText('No body: status 204 is bodyless.')).toBeVisible();

  // Every header value is shown as served, credentials included.
  await openResponse(page, 'POST /v1/session, scenario default', 'View response 200');
  await page.getByRole('tab', { name: /^Headers/ }).click();
  const headers = page.getByRole('table', { name: 'Response headers' });
  await expect(headers.getByRole('row').filter({ hasText: /^set-cookie/ })).toHaveText([
    'set-cookiesession=example-session-not-a-secret; Path=/; HttpOnly',
    'set-cookietheme=light; Path=/',
  ]);
  await expect(headers.getByRole('row').filter({ hasText: /^authorization/ })).toHaveText(
    'authorizationBearer example-token-not-a-secret',
  );

  // A hard refresh restores the selection from the hash route.
  const deepLink = page.url();
  expect(new URL(deepLink).hash).toMatch(/^#\/endpoints\/ep_[0-9a-f]{16}\/fixtures\/fx_[0-9a-f]{16}$/);
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'Response 200' })).toBeVisible();
  await expect(page.getByLabel('Body preview (text)')).toContainText('"user": "example"');

  // No fixture path reached the DOM or Atlas JSON.
  expect(proxy.atlasBodies.join('\n')).not.toContain(DATA);
  expect(proxy.atlasBodies.join('\n')).not.toContain('.headers.json');
  expect(await page.content()).not.toContain(DATA);

  // Janus sends no CORS headers, and every Atlas response is uncacheable.
  expect(atlasHeaders.length).toBeGreaterThan(0);
  for (const headersSeen of atlasHeaders) {
    expect(headersSeen['access-control-allow-origin']).toBeUndefined();
    expect(headersSeen['cache-control']).toBe('no-store');
  }

  // Outage: the UI says so, with the target and a retry, and recovers without a rebuild.
  const port = janus.port;
  await janus.stop();
  await page.reload();
  const alert = page.getByRole('alert');
  await expect(alert.getByRole('heading', { name: 'Janus is unavailable' })).toBeVisible();
  await expect(alert).toContainText('The server answered HTTP 502');
  await expect(alert).toContainText(`${proxy.url}/mock/_janus/`);
  await expect(banner.getByRole('status')).toHaveText(/Unavailable/);

  janus = await startJanus(DATA, port);
  await alert.getByRole('button', { name: 'Retry connection' }).click();
  await expect(banner.getByRole('status')).toHaveText(/Ready/);
  await expect(page.getByLabel('Body preview (text)')).toContainText('"user": "example"');

  await expect(inventory.getByRole('link')).toHaveCount(12);
});
