import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startJanus, startProxy, WORKSPACE, type Janus, type Proxy } from './harness.js';

// The fixture variations acceptance journey, browser step. The HTTP steps are in tests/acceptance-variations.test.ts.

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

test('see a template endpoint, its representations and accepted media types, and marked headers', async ({ page }) => {
  await page.goto(`${proxy.url}/ui/#/endpoints`);
  await expect(page.getByRole('banner').getByRole('status')).toHaveText(/Ready/);
  const inventory = page.getByRole('navigation', { name: 'Endpoints' });

  // The template, with its parameter set apart and announced, under a folder that starts closed.
  await inventory
    .getByRole('button', { name: '/v1/products/{productId}, path parameter productId', exact: true })
    .click();
  const template = inventory.getByRole('link', {
    name: 'GET /v1/products/{productId}, path parameter productId, scenario default',
    exact: true,
  });
  await expect(template.getByTitle('Path parameter')).toHaveText('{productId}');
  await template.click();

  // The representation matrix: one row, one column per media type.
  const matrix = page.getByRole('table', { name: 'Configured responses for this endpoint' });
  await expect(matrix.getByRole('columnheader')).toHaveText([
    'Locale',
    'Response',
    'application/json',
    'application/yaml',
  ]);
  await expect(page.getByText('Path parameters')).toBeVisible();

  // Opening the YAML representation, by keyboard, highlights it without changing its text.
  await matrix.getByRole('link', { name: 'View response 200 (application/yaml)', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: 'Response 200 (application/yaml)' })).toBeVisible();
  const preview = page.getByLabel('Body preview (text)');
  await expect(preview).toHaveText('id: any\nname: Any product\n');
  await expect(preview.locator('span[style]').first()).toBeVisible();

  // Accepted request media types on POST /v1/products.
  await inventory.getByRole('link', { name: 'POST /v1/products, scenario default', exact: true }).click();
  // They sit in the inspector, beside the details.
  const details = page.getByRole('complementary', { name: 'Details' });
  await expect(details.getByRole('list', { name: 'Accepted request media types' }).getByRole('listitem')).toHaveText([
    'application/json',
  ]);

  // A fixture whose Content-Type is overridden and whose Date is dropped, both stated in text.
  await inventory.getByRole('link', { name: 'GET /v1/legacy, scenario default', exact: true }).click();
  await page.getByRole('link', { name: 'View response 200', exact: true }).click();
  await expect(details.getByText('Overridden by the header sidecar')).toBeVisible();
  await page.getByRole('tab', { name: /^Headers/ }).click();
  const headers = page.getByRole('table', { name: 'Response headers' });
  await expect(headers.getByRole('row').filter({ hasText: /^date/ })).toContainText(
    'Computed by Janus: this value is not sent',
  );
  await expect(headers.getByRole('row').filter({ hasText: /^content-type/ })).toContainText(
    'text/plain; charset=utf-8',
  );
});

test('a long inventory scrolls on its own, keeping the details in view', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 300 });
  await page.goto(`${proxy.url}/ui/#/endpoints`);
  const inventory = page.getByRole('navigation', { name: 'Endpoints' });
  for (const folder of ['/v1/products/p-1', '/v1/products/{productId}, path parameter productId']) {
    await inventory.getByRole('button', { name: folder, exact: true }).click();
  }
  await inventory
    .getByRole('button', { name: '/v1/products/{productId}/reviews, path parameter productId', exact: true })
    .click();

  // Only the tree scrolls: its tail is hidden, and reaching it moves neither the window nor the header.
  // (Strings, as the tests compile without the DOM library.)
  const banner = page.getByRole('banner');
  const last = inventory.getByRole('link', { name: 'POST /v1/session, scenario default', exact: true });
  await expect(last).not.toBeInViewport();
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect(page.getByRole('heading', { level: 2, name: /\/v1\/session/ })).toBeInViewport();
  expect(await page.evaluate('window.scrollY')).toBe(0);
  await expect(banner).toBeInViewport({ ratio: 1 });

  // The details scroll on their own too, and start at the top for the next endpoint.
  await page.getByRole('main').hover();
  await page.mouse.wheel(0, 2000);
  await inventory.getByRole('link', { name: 'GET /v1/greeting, scenario default', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: /\/v1\/greeting/ })).toBeInViewport();
  expect(await page.evaluate('window.scrollY')).toBe(0);
  await expect(banner).toBeInViewport({ ratio: 1 });

  // Under 640 px the inventory is its own view: details link back to it.
  await page.setViewportSize({ width: 390, height: 640 });
  await expect(inventory).toHaveCount(0);
  await page.getByRole('link', { name: '← All endpoints' }).click();
  await inventory.getByRole('link', { name: 'GET /, scenario default', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: /GET \/(,|$|\s)/ })).toBeInViewport();
});
