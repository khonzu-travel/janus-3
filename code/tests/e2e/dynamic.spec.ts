import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startJanusWith, startProxy, WORKSPACE, type Janus, type Proxy } from './harness.js';

// The dynamic values acceptance journey, browser step. The HTTP and CLI steps are in tests/acceptance-dynamic.test.ts.

const DATA = join(WORKSPACE, 'examples/data');

let janus: Janus;
let proxy: Proxy;

test.beforeAll(async () => {
  janus = await startJanusWith([
    '--no-config',
    '--data',
    DATA,
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--seed',
    '42',
    '--now',
    '2026-01-01T00:00:00Z',
  ]);
  proxy = await startProxy(() => janus.port);
});

test.afterAll(async () => {
  await proxy.close();
  await janus.stop();
});

test('toggle a dynamic fixture to Rendered, re-render at another instant, and see the clock and seed', async ({
  page,
}) => {
  await page.goto(`${proxy.url}/ui/#/endpoints`);
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('status')).toHaveText(/Ready/);
  await expect(banner.getByText('frozen at 2026-01-01T00:00:00Z, UTC')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Details' }).getByText('42 (cli)')).toBeVisible();

  const inventory = page.getByRole('navigation', { name: 'Endpoints' });
  // Third-level folders start collapsed in the path tree.
  await inventory.getByRole('button', { name: '/v1/orders/{orderId}, path parameter orderId', exact: true }).click();
  await inventory
    .getByRole('link', { name: 'GET /v1/orders/{orderId}, path parameter orderId, scenario default', exact: true })
    .click();
  await page.getByRole('link', { name: 'View response 200', exact: true }).click();
  const detail = page.getByRole('region', { name: 'Response 200' });

  // Raw: tokens are highlighted and listed.
  await expect(detail.getByLabel('Body preview (text)').locator('mark').first()).toHaveText('{{$path.orderId}}');
  await detail.getByRole('tab', { name: /^Tokens/ }).click();
  await expect(detail.getByRole('table', { name: 'Tokens' })).toContainText('{{$today+14d}}');

  // Rendered at the server's frozen instant, with the path parameter unresolved.
  await detail.getByRole('button', { name: 'Rendered' }).click();
  await expect(detail.getByText('2026-01-01T00:00:00Z (server default)')).toBeVisible();
  await expect(detail.getByLabel('Body preview (text)')).toContainText('"restockDate":"2026-01-15"');
  await expect(detail.getByText(/they render as null/)).toBeVisible();

  // Re-render at another instant with a sample parameter, by keyboard.
  await detail.getByLabel('Render at').fill('2026-06-30T12:00:00+02:00');
  await detail.getByLabel('Path parameter {orderId}').fill('o-9');
  await detail.getByLabel('Path parameter {orderId}').press('Enter');
  await expect(detail.getByText('2026-06-30T10:00:00Z (set here)')).toBeVisible();
  const body = detail.getByLabel('Body preview (text)');
  await expect(body).toContainText('"id":"o-9"');
  await expect(body).toContainText('"restockDate":"2026-07-14"');

  // The preview is exactly what the server sends for the same request.
  const served = await (
    await fetch(`${janus.url}/v1/orders/o-9`, { headers: { 'x-mock-now': '2026-06-30T12:00:00+02:00' } })
  ).text();
  await expect(body).toHaveText(served);
});
