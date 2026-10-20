import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startJanusWith, type Janus } from './harness.js';
import { audit, frontEditor, pickScenario, writeTree } from './support.js';

// The request runner acceptance journey in the browser: a Postman collection is imported from the dialog, a
// value is saved as a variable from a mock response, the collection runs in
// Record mode against a fake upstream, writing runner captures, which promotion
// promotes for a Mock mode run; then a Bruno folder and a HAR file import.
// Steps 8 and 9 (janus run, non-loopback) are in apps/server/src/runner.test.ts.

let upstream: Server;
let upstreamUrl: string;
let root: string;
let janus: Janus;
const seen: { method: string; path: string; headers: IncomingHttpHeaders }[] = [];

async function startUpstream(): Promise<void> {
  let items = 0;
  upstream = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      seen.push({ method: request.method ?? '', path: request.url ?? '', headers: request.headers });
      const json = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.method === 'POST' && request.url === '/v1/carts') {
        json(201, { id: 'c-91', items: [] });
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/carts/c-91/items') {
        items++;
        json(200, { id: 'c-91', items: Array.from({ length: items }, () => ({ sku: 'SKU-1' })) });
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/carts/c-91') {
        json(200, { id: 'c-91', items: Array.from({ length: items }, () => ({ sku: 'SKU-1' })) });
        return;
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  upstreamUrl = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
}

const test201 = ["pm.test('created', function () {", '  pm.response.to.have.status(201);', '});'];
const test200 = ["pm.test('ok', function () {", '  pm.response.to.have.status(200);', '});'];

const COLLECTION = {
  info: {
    name: 'Checkout',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  event: [
    {
      listen: 'prerequest',
      script: { exec: ["pm.request.headers.add({ key: 'X-Trace', value: 'from-script' });"], type: 'text/javascript' },
    },
  ],
  item: [
    {
      name: 'Create cart',
      event: [{ listen: 'test', script: { exec: test201, type: 'text/javascript' } }],
      request: {
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: { mode: 'raw', raw: '{}' },
        url: { raw: '{{baseUrl}}/v1/carts', host: ['{{baseUrl}}'], path: ['v1', 'carts'] },
      },
    },
    {
      name: 'Add item',
      event: [{ listen: 'test', script: { exec: test200, type: 'text/javascript' } }],
      request: {
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: { mode: 'raw', raw: '{"sku":"SKU-1"}' },
        url: { raw: '{{baseUrl}}/v1/carts/placeholder/items' },
      },
    },
    {
      name: 'Get cart',
      event: [
        {
          listen: 'test',
          script: {
            exec: [
              "pm.test('one item', function () {",
              '  pm.expect(pm.response.json().items).to.have.length(1);',
              '});',
            ],
            type: 'text/javascript',
          },
        },
      ],
      request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/v1/carts/{{cartId}}' } },
    },
  ],
};

test.beforeAll(async () => {
  await startUpstream();
  root = await writeTree('janus-e2e-requests-', {
    'janus.config.yaml': [
      'fixtures:',
      '  root: ./fixtures',
      'recording:',
      '  captures: ./captures',
      'runner:',
      '  root: ./requests',
      '',
    ].join('\n'),
    'fixtures/default/v1/carts/POST/201.json': '{"id":"c-mock","items":[]}',
    'fixtures/cart-with-one-item/flow.yaml': 'description: A cart with one item.\n',
  });
  janus = await startJanusWith(['--config', join(root, 'janus.config.yaml'), '--host', '127.0.0.1', '--port', '0']);
});

test.afterAll(async () => {
  await janus.stop();
  await new Promise((done) => upstream.close(done));
  await rm(root, { recursive: true, force: true });
});

test('imports a Postman collection, saves a value as a variable, and runs it in Record mode', async ({
  page,
}, info) => {
  await page.goto(`${janus.url}/_janus/ui/#/requests`);
  // Nothing open: a new untitled request, in Live, which needs a collection to send from.
  await expect(page.getByRole('heading', { name: 'Live sends saved requests' })).toBeVisible();
  const editor = frontEditor(page);
  const actions = page.getByRole('toolbar', { name: 'Panel actions' });
  await audit(page, info, 'mouse', 'requests page');

  // 2. Import the collection and its staging environment.
  await actions.getByRole('button', { name: 'Import' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import' });
  await dialog.getByLabel('Files or a zip').setInputFiles([
    {
      name: 'checkout.postman_collection.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(COLLECTION)),
    },
    {
      name: 'staging.postman_environment.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          name: 'Staging',
          values: [
            { key: 'baseUrl', value: upstreamUrl, enabled: true },
            { key: 'token', value: 't0ken', enabled: true },
          ],
          _postman_variable_scope: 'environment',
        }),
      ),
    },
  ]);
  await expect(dialog.getByText(/Postman collection: “Checkout”\. 3 requests/)).toBeVisible();
  await expect(dialog.getByText(/0 skipped/)).toBeVisible();
  await expect(dialog.getByLabel('Collection name')).toHaveValue('checkout');
  await audit(page, info, 'mouse', 'import dialog');
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('navigation', { name: 'Requests' }).getByRole('link', { name: /Checkout/ }),
  ).toBeVisible();

  // 3. Send "Create cart" in Mock mode and save the cart ID as a variable.
  const tree = page.getByRole('navigation', { name: 'Requests' });
  await tree.getByRole('link', { name: /Create cart/ }).click();
  await expect(editor.getByLabel('URL', { exact: true })).toHaveValue('{{baseUrl}}/v1/carts');
  // The tab opens in Live, sending to Upstream.
  await expect(
    editor.getByRole('group', { name: 'Request mode' }).getByRole('button', { name: 'Live' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.getByLabel('Send to')).toHaveValue('upstream');
  await editor.getByLabel('Send to').selectOption('mock');
  await editor.getByRole('button', { name: 'Send' }).click();
  const response = editor.getByRole('region', { name: 'Result of Create cart' });
  await expect(response.getByText('Passed', { exact: true })).toBeVisible();
  // The inspector says why: the mock's own decisions for this send.
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByText('Mock', { exact: true })).toBeVisible();
  await expect(inspector.getByRole('list', { name: 'Decisions' })).toContainText('Matched');
  const body = response.getByRole('list', { name: 'Response body (JSON tree)' });
  await expect(body.getByRole('button', { name: 'Collapse $' })).toHaveAttribute('aria-expanded', 'true');
  await body.getByText('"id"').hover();
  await response.getByRole('button', { name: 'Save $.id as variable' }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Open editors' })
      .getByRole('link', { name: /Create cart/ })
      .getByTitle('Unsaved changes'),
  ).toBeVisible();
  await editor.getByRole('tab', { name: /Extract/ }).click();
  await editor.getByRole('button', { name: 'Expand all extracts' }).click();
  await editor.getByLabel('Variable name, id').fill('cartId');
  await audit(page, info, 'mouse', 'request editor');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor.getByRole('status').getByText('Saved.')).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Open editors' })
      .getByRole('link', { name: /Create cart/ })
      .getByTitle('Unsaved changes'),
  ).toBeHidden();

  // Sending again sets cartId, which carries into the next send; Reset clears it.
  await editor.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('button', { name: 'Variables, 1 carried' }).click();
  await page.getByRole('button', { name: 'Reset variables' }).click();
  await expect(page.getByRole('button', { name: /^Variables,/ })).toBeHidden();

  // Edit "Add item" to use the cart ID.
  await tree.getByRole('link', { name: /Add item/ }).click();
  // Wait for its editor, so the edit does not land in the previous request's before it is replaced.
  await expect(editor.getByRole('heading', { level: 2, name: /Add item/ })).toBeVisible();
  await editor.getByLabel('URL', { exact: true }).fill('{{baseUrl}}/v1/carts/{{cartId}}/items');
  await expect(editor.getByRole('list', { name: 'Variables used' }).getByText('{{cartId}}')).toBeVisible();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor.getByRole('status').getByText('Saved.')).toBeVisible();

  // 4. Run the collection in Record mode into cart-with-one-item: the bar's choices apply to the run.
  await editor.getByLabel('Send to').selectOption('record');
  await pickScenario(page, 'cart-with-one-item');
  // Collections run from their menu only: a right-click on the row, or its More button.
  await tree.getByRole('link', { name: /Checkout/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Run collection/ }).click();
  const run = page.getByRole('region', { name: /Run r-/ });
  await expect(run.getByText('3 passed, 0 failed of 3')).toBeVisible();
  await audit(page, info, 'mouse', 'run view');

  const sent = seen.filter((entry) => entry.path.startsWith('/v1/carts'));
  expect(sent.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
    'POST /v1/carts',
    'POST /v1/carts/c-91/items',
    'GET /v1/carts/c-91',
  ]);
  for (const entry of sent) {
    expect(entry.headers['authorization']).toBe('Bearer t0ken');
    expect(entry.headers['x-trace']).toBe('from-script');
  }

  // Three runner captures appear in the review page.
  await page.goto(`${janus.url}/_janus/ui/#/captures?scenario=cart-with-one-item`);
  await expect(page.getByRole('cell', { name: 'Request runner' })).toHaveCount(3);

  // 5. Promote the captures and run in Mock mode: the steps are answered from the fixtures.
  const captures = (await (await fetch(`${janus.url}/_janus/captures?scenario=cart-with-one-item`)).json()) as {
    items: { id: string }[];
  };
  expect(captures.items).toHaveLength(3);
  for (const { id } of captures.items) {
    const promoted = await fetch(`${janus.url}/_janus/promotions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capture: id }),
    });
    expect(promoted.status, await promoted.clone().text()).toBe(201);
  }
  const before = seen.length;
  await page.goto(
    `${janus.url}/_janus/ui/#/requests?id=checkout%2F010-create-cart&mode=live&scenario=cart-with-one-item`,
  );
  await editor.getByLabel('Send to').selectOption('mock');
  await tree.getByRole('button', { name: 'More for Checkout' }).click();
  await page.getByRole('menuitem', { name: /Run collection/ }).click();
  await expect(page.getByRole('region', { name: /Run r-/ }).getByText('3 passed, 0 failed of 3')).toBeVisible();
  expect(seen.length).toBe(before);
});

test('stops a run at a failing step, and shows a save that conflicts with the file', async ({ page }) => {
  await page.goto(`${janus.url}/_janus/ui/#/requests?mode=live`);
  const tree = page.getByRole('navigation', { name: 'Requests' });
  const editor = frontEditor(page);

  // 6. Break the second request's test: the run stops there and the third is not sent.
  await tree.getByRole('link', { name: /Add item/ }).click();
  await expect(editor.getByRole('heading', { level: 2, name: /Add item/ })).toBeVisible();
  await editor.getByRole('tab', { name: 'Scripts' }).click();
  // The script editors indent with Tab: at the cursor, or every selected line; Shift + Tab outdents.
  const beforeScript = editor.getByLabel('Before the request is sent');
  await beforeScript.click();
  await page.keyboard.type('a();\nb();');
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  await expect(beforeScript).toHaveText('a();  b();');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Tab');
  await expect(beforeScript).toHaveText('  a();    b();');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(beforeScript).toHaveText('a();b();');
  await page.keyboard.press('Delete');
  await expect(beforeScript).toHaveText('');
  await editor
    .getByLabel('After the response arrives')
    .fill("pm.test('ok', function () {\n  pm.response.to.have.status(418);\n});\n");
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor.getByRole('status').getByText('Saved.')).toBeVisible();
  const before = seen.length;
  await editor.getByLabel('Send to').selectOption('record');
  await tree.getByRole('button', { name: 'More for Checkout' }).click();
  await page.getByRole('menuitem', { name: /Run collection/ }).click();
  const run = page.getByRole('region', { name: /Run r-/ });
  await expect(run.getByText('1 passed, 1 failed of 3')).toBeVisible();
  const steps = run.getByRole('list', { name: 'Steps' });
  await expect(steps.getByRole('listitem').nth(2)).toContainText('Not run');
  await expect(run.getByText('test-failed', { exact: false })).toBeVisible();
  expect(seen.slice(before).map((entry) => `${entry.method} ${entry.path}`)).toEqual([
    'POST /v1/carts',
    'POST /v1/carts/c-91/items',
  ]);
  await expect(page.getByRole('link', { name: 'All runs' })).toBeVisible();

  // A save after the file changed on disk shows both versions.
  const folder = join(root, 'requests', 'checkout');
  const file = (await readdir(folder)).find((name) => name.endsWith('get-cart.request.yaml'));
  expect(file).toBeDefined();
  await tree
    .getByRole('link', { name: /Get cart/ })
    .first()
    .click();
  // The request is renamed on its tab.
  const tabs = page.getByRole('navigation', { name: 'Open editors' });
  await tabs.getByRole('link', { name: /Get cart/ }).dblclick();
  await tabs.getByRole('textbox', { name: 'Request name' }).fill('Get the cart');
  await page.keyboard.press('Enter');
  const path = join(folder, file ?? '');
  await writeFile(path, (await readFile(path, 'utf8')).replace('name: Get cart', 'name: Read cart'));
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  const conflict = page.getByRole('region', { name: 'The file changed since you opened it' });
  await expect(conflict.getByText('"name": "Read cart"')).toBeVisible();
  await conflict.getByRole('button', { name: 'Keep my edit' }).click();
  await expect(editor.getByRole('status').getByText('Saved.')).toBeVisible();
  expect(await readFile(path, 'utf8')).toContain('name: Get the cart');

  // A request saved earlier in the session can still be deleted, and its tab closes like the close button would.
  await tree.getByRole('link', { name: /Add item/ }).click();
  await expect(editor.getByRole('heading', { level: 2, name: /Add item/ })).toBeVisible();
  await editor.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(tabs.getByRole('link', { name: /Add item/ })).toHaveCount(0);
  await expect(tabs.locator('[aria-current]')).toHaveCount(1);
});

test('keeps a sensitive environment value out of git', async ({ page }) => {
  await page.goto(`${janus.url}/_janus/ui/#/requests`);
  // Environments are shared by every collection, and open in a tab of their own.
  await page.getByRole('group', { name: 'Side panel' }).getByRole('button', { name: 'Environments' }).click();
  await page
    .getByRole('navigation', { name: 'Environments' })
    .getByRole('button', { name: /^Staging/ })
    .click();
  const editor = frontEditor(page);
  await editor.getByRole('button', { name: 'Sensitive, token' }).click();
  await expect(editor.getByLabel('Value, token')).toHaveAttribute('type', 'password');
  await editor.getByRole('button', { name: 'Save environment' }).click();
  await expect(editor.getByRole('status').getByText('Saved.')).toBeVisible();
  const environments = join(root, 'requests', 'environments');
  expect(await readFile(join(environments, 'staging.local.yaml'), 'utf8')).toContain('t0ken');
  expect(await readFile(join(environments, 'staging.yaml'), 'utf8')).not.toContain('t0ken');
});

test('works from the keyboard', async ({ page }) => {
  await page.goto(`${janus.url}/_janus/ui/#/requests`);
  const filter = page.getByLabel('Filter requests');
  await filter.focus();
  await page.keyboard.type('get');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('navigation', { name: 'Requests' }).getByRole('link', { name: /Checkout/ }),
  ).toBeFocused();
  // The collection's menu is next, then the only matching request under it.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'More for Checkout' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: /Get the cart/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(frontEditor(page).getByLabel('URL', { exact: true })).toHaveValue('{{baseUrl}}/v1/carts/{{cartId}}');

  const importButton = page.getByRole('toolbar', { name: 'Panel actions' }).getByRole('button', { name: 'Import' });
  await importButton.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Import' });
  await expect(dialog.getByLabel('Files or a zip')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(importButton).toBeFocused();
});

test('imports a request from a curl command, in the Import dialog or pasted into the URL', async ({ page }, info) => {
  await page.goto(`${janus.url}/_janus/ui/#/requests?import=1`);
  const dialog = page.getByRole('dialog', { name: 'Import' });
  await dialog.getByRole('button', { name: 'curl', exact: true }).click();
  const box = dialog.getByLabel('curl command');
  await expect(box).toBeFocused();
  await box.fill(
    `curl '${upstreamUrl}/v1/carts' -H 'content-type: application/json' --data-raw '{"sku":"A-1"}' --proxy http://p.test:3128`,
  );
  await expect(dialog.getByText('Left out, as a request cannot hold them: --proxy.')).toBeVisible();
  await audit(page, info, 'mouse', 'curl import');
  await dialog.getByRole('button', { name: 'Open' }).click();
  await expect(dialog).toBeHidden();
  const editor = frontEditor(page);
  await expect(editor.getByLabel('Method')).toHaveValue('POST');
  await expect(editor.getByLabel('URL', { exact: true })).toHaveValue(`${upstreamUrl}/v1/carts`);

  // A whole command pasted into the URL fills the request in the same way. Only Chromium builds a paste event with text.
  if (info.project.name !== 'chromium') return;
  await page.getByRole('button', { name: 'New request' }).first().click();
  const url = frontEditor(page).getByLabel('URL', { exact: true });
  await url.focus();
  const command = `curl -X PUT ${upstreamUrl}/v1/carts/7 -k`;
  await page.evaluate(`(() => {
    const data = new DataTransfer();
    data.setData('text/plain', ${JSON.stringify(command)});
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
  await expect(url).toHaveValue(`${upstreamUrl}/v1/carts/7`);
  await expect(frontEditor(page).getByLabel('Method')).toHaveValue('PUT');
  await expect(frontEditor(page).getByText(/runner\.skipTlsVerify/)).toBeVisible();
});

// Last, since the Bruno collection replaces the shared staging environment the tests above use.
test('imports a Bruno collection from a folder and a HAR file, and shows their reports', async ({ page }) => {
  // 7. Import a Bruno collection from a folder and a HAR file, and see their reports.
  const actions = page.getByRole('toolbar', { name: 'Panel actions' });
  const fixtures = join(import.meta.dirname, '..', '..', 'packages', 'runner', 'src', 'import', 'fixtures');
  await page.goto(`${janus.url}/_janus/ui/#/requests?import=1`);
  const bruno = page.getByRole('dialog', { name: 'Import' });
  await bruno.getByLabel('A folder').setInputFiles(join(fixtures, 'bruno', 'shop-api'));
  await expect(bruno.getByText(/^Bruno collection: “Shop API”/)).toBeVisible();
  await expect(bruno.getByText(/skipped/).first()).toBeVisible();
  // It brings its own staging environment, which the Postman import made: importing replaces it, once confirmed.
  await expect(bruno.getByText(/The environment staging exists/)).toBeVisible();
  await bruno.getByRole('button', { name: 'Replace', exact: true }).click();
  await bruno.getByRole('button', { name: 'Replace environments' }).click();
  await expect(bruno).toBeHidden();
  await expect(
    page.getByRole('navigation', { name: 'Requests' }).getByRole('link', { name: /Shop API/ }),
  ).toBeVisible();

  await actions.getByRole('button', { name: 'Import' }).click();
  const har = page.getByRole('dialog', { name: 'Import' });
  await har.getByLabel('Files or a zip').setInputFiles(join(fixtures, 'har', 'chrome.har'));
  await expect(har.getByText(/^HAR file: “chrome”/)).toBeVisible();
  await har.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(har).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Requests' }).getByRole('link', { name: /chrome/ })).toBeVisible();
});
