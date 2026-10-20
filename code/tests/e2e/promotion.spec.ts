import { readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startJanusWith, type Janus } from './harness.js';
import { audit, writeTree } from './support.js';

// The promotion acceptance journey in the browser: a recorded payment is promoted from the UI with its
// ID bound explicitly, served with the scenario's ID, and marked reviewed.

let upstream: Server;
let upstreamUrl: string;
let root: string;
let janus: Janus;

const CARD = '4000000000000002';

async function startUpstream(): Promise<void> {
  upstream = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(402, { 'content-type': 'application/json', location: '/v1/payments/pay_8f2e91c0' });
      response.end(JSON.stringify({ id: 'pay_8f2e91c0', status: 'declined', card: CARD }));
    });
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  upstreamUrl = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
}

test.beforeAll(async () => {
  await startUpstream();
  root = await writeTree('janus-e2e-promotion-', {
    'janus.config.yaml': [
      'fixtures:',
      '  root: ./fixtures',
      'recording:',
      '  captures: ./captures',
      '  endpoints:',
      '    - method: POST',
      '      path: /v1/payments',
      `      upstream: ${upstreamUrl}`,
      '',
    ].join('\n'),
    'fixtures/default/v1/payments/POST/201.json': '{"status":"paid"}',
    'fixtures/payment-declined/flow.yaml':
      'description: Declined.\nids:\n  paymentId: pay_declined_1\noverrides:\n  - /v1/payments/POST\n',
  });
  janus = await startJanusWith(['--config', join(root, 'janus.config.yaml'), '--host', '127.0.0.1', '--port', '0']);
});

test.afterAll(async () => {
  await janus.stop();
  await new Promise((done) => upstream.close(done));
  await rm(root, { recursive: true, force: true });
});

test('promotes a capture from the UI, serves it with the scenario ID, and marks it reviewed', async ({
  page,
}, info) => {
  const recorded = await fetch(`${janus.url}/v1/payments`, {
    method: 'POST',
    headers: { 'x-mock-record': 'true', 'x-mock-scenario': 'payment-declined', 'content-type': 'application/json' },
    body: '{}',
  });
  const capture = recorded.headers.get('x-mock-recorded') ?? '';
  expect(capture).toMatch(/^payment-declined\/[0-9a-f]{8}$/);

  // 3. Open the capture, bind paymentId explicitly on the page, and Promote it.
  await page.goto(`${janus.url}/_janus/ui/#/captures/${capture}?scenario=payment-declined`);
  await page.getByRole('button', { name: 'Edit before promoting' }).click();
  const target = page.getByRole('region', { name: 'Promote to' });
  await target.getByRole('button', { name: 'Bind an ID' }).click();
  await target.getByLabel('Captured value 1').fill('pay_8f2e91c0');
  await expect(target.getByText(/exact, from you/)).toBeVisible();
  await audit(page, info, 'mouse', 'capture editing');
  await page.getByRole('button', { name: 'Promote', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`Promote capture ${capture}\\?`) });
  await expect(dialog.getByText(/replaces the captured value at \/id/)).toBeVisible();
  await expect(dialog.getByText(/replaces the captured value in the location header/)).toBeVisible();
  await audit(page, info, 'mouse', 'promote confirmation');
  await dialog.getByRole('button', { name: 'Promote' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/It is pending review/)).toBeVisible();

  // 4. The scenario answers the promoted 402 with its own ID; default still answers 201.
  const declined = await fetch(`${janus.url}/v1/payments`, {
    method: 'POST',
    headers: { 'x-mock-scenario': 'payment-declined', 'content-type': 'application/json' },
    body: '{}',
  });
  expect(declined.status).toBe(402);
  expect(declined.headers.get('location')).toBe('/v1/payments/pay_declined_1');
  expect(await declined.json()).toEqual({ id: 'pay_declined_1', status: 'declined', card: CARD });
  const paid = await fetch(`${janus.url}/v1/payments`, { method: 'POST', body: '{}' });
  expect(paid.status).toBe(201);

  // 7. The Promotions page lists the pending files; Mark reviewed clears them.
  await page.getByRole('link', { name: /^Promotions/ }).click();
  // The response file and its header file are one promotion, in one row.
  const table = page.getByRole('table', { name: /Promotions/ });
  await expect(table.getByRole('row')).toHaveCount(2);
  await audit(page, info, 'mouse', 'promotions');
  await table.getByRole('link', { name: '/v1/payments/POST/402.json' }).click();
  const panel = page.getByRole('region', { name: 'Promoted' });
  await expect(panel).toContainText(capture);
  await panel.getByRole('button', { name: 'Mark reviewed' }).focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: 'Mark reviewed' })).toBeHidden();
  await expect(panel).toContainText('Reviewed');

  const meta = JSON.parse(
    await readFile(join(root, 'fixtures/payment-declined/v1/payments/POST/402.meta.json'), 'utf8'),
  ) as { files: Record<string, { review: string }> };
  expect(Object.values(meta.files).map((entry) => entry.review)).toEqual(['reviewed', 'reviewed']);
});

test('edits the response on the capture page before promoting it, and copies the body', async ({ page, context }) => {
  const recorded = await fetch(`${janus.url}/v1/payments`, {
    method: 'POST',
    headers: { 'x-mock-record': 'true', 'x-mock-scenario': 'payment-declined', 'content-type': 'application/json' },
    body: '{}',
  });
  const id = recorded.headers.get('x-mock-recorded') ?? '';
  await page.goto(`${janus.url}/_janus/ui/#/captures/${id}?scenario=payment-declined`);

  const response = page.getByRole('region', { name: 'Response' });
  await page.getByRole('button', { name: 'Edit before promoting' }).click();
  await page.getByLabel(/^Variant/).fill('edited');
  const editor = response.locator('.cm-content');
  await expect(editor).toContainText('"status": "declined"');
  // JSON folds from the gutter.
  await expect(response.locator('.cm-foldGutter')).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('{"status":"edited"}');
  await response.getByRole('button', { name: 'Add header' }).click();
  await response.getByLabel('Response headers name 2').fill('x-edited');
  await response.getByLabel('Response headers value 2').fill('yes');

  // Copy takes the body as edited.
  if (test.info().project.name === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await response.getByRole('button', { name: 'Copy response body' }).click();
    const copied: string = await page.evaluate('navigator.clipboard.readText()');
    expect(copied).toBe('{"status":"edited"}');
  }

  await page.getByRole('button', { name: 'Promote', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Promote capture/ });
  await expect(dialog.getByRole('button', { name: 'Promote' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Promote' }).click();
  await expect(dialog).toBeHidden();

  const directory = join(root, 'fixtures/payment-declined/v1/payments/POST');
  expect(JSON.parse(await readFile(join(directory, '402.edited.json'), 'utf8'))).toEqual({ status: 'edited' });
  expect(JSON.parse(await readFile(join(directory, '402.edited.headers.json'), 'utf8'))).toMatchObject({
    'x-edited': 'yes',
  });
});
