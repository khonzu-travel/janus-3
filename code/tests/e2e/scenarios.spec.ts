import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startJanusWith, WORKSPACE, type Janus } from './harness.js';
import { bodiesAsText, pickScenario } from './support.js';

// The scenarios and sessions acceptance journey
// against a real server on the example fixtures: `sold-out` overrides
// GET /v1/products, and its child `sold-out-en` removes the French greeting.

const DATA = join(WORKSPACE, 'examples/data');

let root: string;
let janus: Janus;

test.beforeAll(async () => {
  // Step 7 removes scenario directories, so the server reads a copy.
  root = await mkdtemp(join(tmpdir(), 'janus-e2e-scenarios-'));
  await cp(DATA, root, { recursive: true });
  janus = await startJanusWith(['--no-config', '--data', root, '--host', '127.0.0.1', '--port', '0', '--seed', '42']);
});

test.afterAll(async () => {
  await janus.stop();
  await rm(root, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${janus.url}${path}`, { headers });

const session = (method: string, id: string, body?: unknown, key?: string) =>
  fetch(`${janus.url}/_janus/session`, {
    method,
    headers: {
      'x-mock-session': id,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key === undefined ? {} : { 'x-mock-session-key': key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const placedAt = async (headers: Record<string, string> = {}): Promise<string> => {
  const response = await get('/v1/orders/o-1', headers);
  expect(response.status).toBe(200);
  return ((await response.json()) as { placedAt: string }).placedAt;
};

test('select scenarios by header and session, bind a session clock, and inspect the inheritance in the UI', async ({
  page,
}) => {
  await bodiesAsText(page);
  // 2. The overridden endpoint differs by scenario; an inherited one answers from default.
  const plain = await get('/v1/products');
  expect(await plain.json()).toEqual([{ id: 'p-1', name: 'Example' }]);
  expect(plain.headers.get('x-mock-scenario')).toBe('default');
  expect(plain.headers.get('x-mock-resolved-from')).toBe('default');
  const soldOut = await get('/v1/products', { 'x-mock-scenario': 'sold-out' });
  expect(await soldOut.json()).toEqual([]);
  expect(soldOut.headers.get('x-mock-scenario')).toBe('sold-out');
  expect(soldOut.headers.get('x-mock-resolved-from')).toBe('sold-out');
  const grandchild = await get('/v1/products', { 'x-mock-scenario': 'sold-out-en' });
  expect(await grandchild.json()).toEqual([]);
  expect(grandchild.headers.get('x-mock-resolved-from')).toBe('sold-out');
  const inherited = await get('/health', { 'x-mock-scenario': 'sold-out' });
  expect(inherited.status).toBe(200);
  expect(inherited.headers.get('x-mock-resolved-from')).toBe('default');

  // 3. A mistyped scenario is an error that lists the known names.
  const mistyped = await get('/v1/products', { 'x-mock-scenario': 'sold-uot' });
  expect(mistyped.status).toBe(400);
  expect(((await mistyped.json()) as { error: unknown }).error).toMatchObject({
    code: 'unknown-scenario',
    known: ['default', 'flaky-network', 'payment-declined', 'sold-out', 'sold-out-en'],
  });

  // 4. Session a pins the child and freezes its clock; session b and no session are unchanged.
  const created = await session('POST', 'a', { scenario: 'sold-out', clock: { now: '2030-01-01T12:00:00Z' } });
  expect(created.ok).toBe(true);
  const key = created.headers.get('x-mock-session-key') ?? '';
  expect(key).not.toBe('');
  expect(await (await get('/v1/products', { 'x-mock-session': 'a' })).json()).toEqual([]);
  expect(await placedAt({ 'x-mock-session': 'a' })).toContain('2030-01-01');
  expect(await (await get('/v1/products', { 'x-mock-session': 'b' })).json()).toHaveLength(1);
  expect(await placedAt({ 'x-mock-session': 'b' })).not.toContain('2030-');
  expect(await (await get('/v1/products')).json()).toHaveLength(1);

  // 5. Advancing a's clock moves only a's dates; without the key the write is refused.
  const advanced = await session('PATCH', 'a', { clock: { advance: '+1d' } }, key);
  expect(advanced.status).toBe(200);
  expect(await placedAt({ 'x-mock-session': 'a' })).toContain('2030-01-02');
  expect(await placedAt({ 'x-mock-session': 'b' })).not.toContain('2030-');
  const forbidden = await session('PATCH', 'a', { clock: { advance: '+1d' } });
  expect(forbidden.status).toBe(403);
  expect(((await forbidden.json()) as { error: unknown }).error).toMatchObject({ code: 'session-forbidden' });
  expect(await placedAt({ 'x-mock-session': 'a' })).toContain('2030-01-02');

  // 6. In the UI: select the grandchild, follow the matrix to the inherited file, and simulate the request.
  await page.goto(`${janus.url}/_janus/ui/#/endpoints`);
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('status')).toHaveText(/Ready/);
  await pickScenario(page, 'sold-out-en');
  const inventory = page.getByRole('navigation', { name: 'Endpoints' });
  await inventory.getByRole('link', { name: 'GET /v1/products, scenario sold-out-en, inherited', exact: true }).click();
  const matrix = page.getByRole('table', { name: 'Responses of this endpoint in each scenario' });
  await expect(matrix.getByRole('row', { name: /sold-out-en/ })).toHaveAttribute('aria-current', 'true');
  await matrix.getByRole('link', { name: 'sold-out-en: 200 application/json, from sold-out', exact: true }).click();
  const response = page.getByRole('region', { name: 'Response 200' });
  // The response's facts are in the inspector beside it.
  const details = page.getByRole('complementary', { name: 'Details' });
  await expect(details.getByText('File held by')).toBeVisible();
  await expect(details).toContainText('scenario sold-out');
  await expect(response.getByLabel('Body preview (text)')).toContainText('[]');

  await banner.getByRole('link', { name: 'Requests' }).click();
  // The Requests tab opens in Live; the simulation form is Explore.
  await page.getByRole('button', { name: 'Explore' }).click();
  const form = page.getByRole('form', { name: 'Request to simulate' });
  // Explore simulates in the scenario selected in the header.
  await expect(banner.getByRole('button', { name: /^Scenario / })).toHaveAccessibleName('Scenario sold-out-en');
  await form.getByLabel('Target (path and query)').fill('/v1/products');
  await form.getByRole('button', { name: 'Explain' }).click();
  const decisions = page.getByRole('region', { name: 'Simulated response' }).getByRole('list', { name: 'Decisions' });
  await expect(decisions).toContainText('Selected sold-out-en');
  await expect(decisions).toContainText(/Inherits: sold-out.*default/);
  await expect(decisions).toContainText('The file is inherited from sold-out');
  await expect(decisions).toContainText('taken out by overrides');
  await decisions.getByRole('link', { name: /^fx_/ }).first().click();
  await expect(page.getByRole('region', { name: 'Response 200' }).getByLabel('Body preview (text)')).toContainText(
    'p-1',
  );

  // 7. Without the scenario directories, session a's pin is an error; other callers are served.
  await rm(join(root, 'sold-out'), { recursive: true });
  await rm(join(root, 'sold-out-en'), { recursive: true });
  expect((await fetch(`${janus.url}/_janus/reload`, { method: 'POST' })).status).toBe(200);
  const stale = await get('/v1/products', { 'x-mock-session': 'a' });
  expect(stale.status).toBe(400);
  expect(((await stale.json()) as { error: unknown }).error).toMatchObject({
    code: 'unknown-scenario',
    source: 'session',
  });
  expect((await get('/v1/products', { 'x-mock-session': 'b' })).status).toBe(200);
  expect((await get('/v1/products')).status).toBe(200);

  // 8. Dropping session a with its key: a is served default again.
  expect((await session('DELETE', 'a', undefined, key)).ok).toBe(true);
  const dropped = await get('/v1/products', { 'x-mock-session': 'a' });
  expect(dropped.status).toBe(200);
  expect(dropped.headers.get('x-mock-scenario')).toBe('default');
  expect(await dropped.json()).toHaveLength(1);
});
