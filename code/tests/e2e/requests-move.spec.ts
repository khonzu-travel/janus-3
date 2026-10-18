import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startJanusWith, type Janus } from './harness.js';
import { frontEditor, writeTree } from './support.js';

// Moving a saved request by dragging it in the Collections panel, and undoing the move.

let root: string;
let janus: Janus;

test.beforeAll(async () => {
  root = await writeTree('janus-e2e-requests-move-', {
    'janus.config.yaml': ['fixtures:', '  root: ./fixtures', 'runner:', '  root: ./requests', ''].join('\n'),
    'fixtures/default/v1/carts/GET/200.json': '{"items":[]}',
    'requests/checkout/folder.yaml': 'name: Checkout\n',
    'requests/checkout/010-get-cart.request.yaml': "name: Get cart\nmethod: GET\nurl: '{{baseUrl}}/v1/carts'\n",
    'requests/checkout/carts/folder.yaml': 'name: Carts\n',
    'requests/admin/folder.yaml': 'name: Admin\n',
    'requests/admin/010-list-users.request.yaml': "name: List users\nmethod: GET\nurl: '{{baseUrl}}/v1/users'\n",
  });
  janus = await startJanusWith(['--config', join(root, 'janus.config.yaml'), '--host', '127.0.0.1', '--port', '0']);
});

test.afterAll(async () => {
  await janus.stop();
  await rm(root, { recursive: true, force: true });
});

const files = async (folder: string): Promise<string[]> =>
  (await readdir(join(root, 'requests', folder))).filter((name) => name.endsWith('.request.yaml'));

test('drags a request into a folder and another collection, its tab following, and undoes a move', async ({ page }) => {
  await page.goto(`${janus.url}/_janus/ui/#/requests?mode=live`);
  const tree = page.getByRole('navigation', { name: 'Requests' });
  const panel = page.getByRole('complementary', { name: 'Request collections' });
  const tabs = page.getByRole('navigation', { name: 'Open editors' });
  await tree.getByRole('link', { name: /Get cart/ }).click();
  await expect(frontEditor(page).getByRole('heading', { level: 2, name: /Get cart/ })).toBeVisible();

  // Into a folder of the same collection: no confirmation, and the open tab follows the file.
  await tree.getByRole('link', { name: /Get cart/ }).dragTo(tree.getByRole('link', { name: /Carts/ }));
  await expect(panel.getByRole('status')).toContainText('Moved Get cart to Carts.');
  await expect.poll(() => files('checkout/carts')).toEqual(['010-get-cart.request.yaml']);
  await expect.poll(() => files('checkout')).toEqual([]);
  await expect(tabs.getByRole('link', { name: /Get cart/ })).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/id=checkout%2Fcarts%2F010-get-cart/);

  // Onto a request in another collection: it lands beside it, numbered after it.
  await tree.getByRole('link', { name: /Get cart/ }).dragTo(tree.getByRole('link', { name: /List users/ }));
  await expect(panel.getByRole('status')).toContainText('Moved Get cart to Admin.');
  await expect.poll(() => files('admin')).toEqual(['010-list-users.request.yaml', '020-get-cart.request.yaml']);

  // Undo puts it back where it was.
  await panel.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => files('checkout/carts')).toEqual(['010-get-cart.request.yaml']);
  await expect.poll(() => files('admin')).toEqual(['010-list-users.request.yaml']);
  await expect(panel.getByRole('status')).toHaveCount(0);
  await expect(tabs.getByRole('link', { name: /Get cart/ })).toHaveAttribute('aria-current', 'page');

  // Its X dismisses the popup, keeping the move.
  await tree.getByRole('link', { name: /Get cart/ }).dragTo(tree.getByRole('link', { name: /Checkout/ }));
  await expect(panel.getByRole('status')).toContainText('Moved Get cart to Checkout.');
  await panel.getByRole('button', { name: 'Dismiss' }).click();
  await expect(panel.getByRole('status')).toHaveCount(0);
  await expect.poll(() => files('checkout')).toEqual(['010-get-cart.request.yaml']);
});

test('keeps an open request’s unsaved edits when it moves, without saving them', async ({ page }) => {
  await page.goto(`${janus.url}/_janus/ui/#/requests?mode=live`);
  const tree = page.getByRole('navigation', { name: 'Requests' });
  const tabs = page.getByRole('navigation', { name: 'Open editors' });
  await tree.getByRole('link', { name: /Get cart/ }).click();
  const url = frontEditor(page).getByLabel('URL', { exact: true });
  await expect(url).toHaveValue('{{baseUrl}}/v1/carts');
  await url.fill('{{baseUrl}}/v1/carts/edited');

  await tree.getByRole('link', { name: /Get cart/ }).dragTo(tree.getByRole('link', { name: /Carts/ }));
  await expect.poll(() => files('checkout/carts')).toEqual(['010-get-cart.request.yaml']);
  // The tab still holds the edit, marked unsaved; the moved file is the saved version.
  await expect(tabs.getByRole('link', { name: /Get cart/ })).toHaveAttribute('aria-current', 'page');
  await expect(frontEditor(page).getByLabel('URL', { exact: true })).toHaveValue('{{baseUrl}}/v1/carts/edited');
  await expect(tabs.getByRole('link', { name: /Get cart.*unsaved/ })).toBeVisible();
  expect(
    await readFile(join(root, 'requests', 'checkout', 'carts', '010-get-cart.request.yaml'), 'utf8'),
  ).not.toContain('edited');
});
