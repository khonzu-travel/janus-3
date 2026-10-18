import { expect, test } from '@playwright/test';
import { join } from 'node:path';

import { startJanusWith, WORKSPACE, type Janus } from './harness.js';

// The choosing-responses acceptance journey
// against a real server on the example fixtures: GET /v1/orders/{orderId}/status
// has rules, a rule sequence, sequence.yaml and a 304 variant; GET /v1/orders has
// pages; POST /v1/payments has expect.yaml in the child scenario payment-declined.

const DATA = join(WORKSPACE, 'examples/data');

let janus: Janus;

test.beforeAll(async () => {
  janus = await startJanusWith(['--no-config', '--data', DATA, '--host', '127.0.0.1', '--port', '0', '--seed', '42']);
});

test.afterAll(async () => {
  await janus.stop();
});

const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  fetch(`${janus.url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const status = (session?: string, query = '', method = 'GET') =>
  call(method, `/v1/orders/ord-1/status${query}`, session === undefined ? {} : { 'x-mock-session': session });

const choice = async (response: Promise<Response>): Promise<string | null> =>
  (await response).headers.get('x-mock-choice');

test('choose responses by rule, step, page and expectation, replay a retry, and read it all in the UI', async ({
  page,
}) => {
  // 2. A rule serves 404.missing; a matching If-None-Match gets 304 with its ETag.
  const missing = await call('GET', '/v1/orders/ord-missing/status');
  expect(missing.status).toBe(404);
  expect(missing.headers.get('x-mock-choice')).toBe('404.missing; by=rule; rule=1');
  const fresh = await call('GET', '/v1/orders/ord-1/status', { 'if-none-match': 'W/"o-v2"' });
  expect(fresh.status).toBe(304);
  expect(fresh.headers.get('etag')).toBe('"o-v2"');

  // 3. Session a steps through the sequence; HEAD does not advance it; b and anonymous callers start at step 1.
  const created = await call('POST', '/_janus/session', { 'x-mock-session': 'a' }, {});
  expect(created.status).toBe(201);
  const key = created.headers.get('x-mock-session-key') ?? '';
  expect((await call('POST', '/_janus/session', { 'x-mock-session': 'b' }, {})).status).toBe(201);

  expect(await choice(status('a'))).toBe('202.pending; by=sequence; step=1');
  expect(await choice(status('a', '', 'HEAD'))).toBe('202.pending; by=sequence; step=2');
  expect(await choice(status('a'))).toBe('202.pending; by=sequence; step=2');
  expect(await choice(status('a'))).toBe('200; by=sequence; step=3');
  expect(await choice(status('a'))).toBe('200; by=sequence; step=3');
  expect(await choice(status('b'))).toBe('202.pending; by=sequence; step=1');
  expect(await choice(status())).toBe('202.pending; by=sequence; step=1');
  expect(await choice(status())).toBe('202.pending; by=sequence; step=1');
  expect(await choice(status('a', '?express=true'))).toBe('202.pending; by=rule; rule=3; step=1');
  expect(await choice(status('a', '?express=true'))).toBe('200.shipped; by=rule; rule=3; step=2');
  expect(await choice(status('a'))).toBe('200; by=sequence; step=3');

  // 4. Pages 1 and 2, and an unknown page.
  const page1 = await call('GET', '/v1/orders');
  expect([page1.headers.get('x-mock-choice'), ((await page1.json()) as { page: unknown }).page]).toEqual([
    '200; by=page',
    1,
  ]);
  expect(await choice(call('GET', '/v1/orders?page=2'))).toBe('200.page-2; by=page');
  expect(await choice(call('GET', '/v1/orders?page=zz'))).toBe('200.empty; by=page');

  // 5. In payment-declined, the expected payment passes; a wrong currency names the reference only.
  const declined = { 'x-mock-scenario': 'payment-declined', 'x-mock-session': 'a' };
  const payment = { orderId: 'ord-7', amount: { value: 10, currency: 'EUR' } };
  const paid = await call('POST', '/v1/payments', { ...declined, 'idempotency-key': 'k-1' }, payment);
  expect(paid.status).toBe(402);
  const paidBody = await paid.text();
  const wrong = await call(
    'POST',
    '/v1/payments',
    { ...declined, 'idempotency-key': 'k-2' },
    { ...payment, amount: { value: 10, currency: 'USD' } },
  );
  expect(wrong.status).toBe(422);
  const wrongBody = await wrong.text();
  expect(JSON.parse(wrongBody)).toMatchObject({
    error: { code: 'expectation-failed', failed: [{ reference: 'body.$.amount.currency', expected: 'EUR' }] },
  });
  expect(wrongBody).not.toContain('USD');

  // 6. The retry replays; the same key with another body is refused.
  const retried = await call('POST', '/v1/payments', { ...declined, 'idempotency-key': 'k-1' }, payment);
  expect([retried.status, await retried.text(), retried.headers.get('x-mock-replayed')]).toEqual([
    402,
    paidBody,
    'true',
  ]);
  const reused = await call(
    'POST',
    '/v1/payments',
    { ...declined, 'idempotency-key': 'k-1' },
    { ...payment, amount: { value: 11, currency: 'EUR' } },
  );
  expect(reused.status).toBe(422);
  expect(((await reused.json()) as { error: { code: string } }).error.code).toBe('idempotency-key-reused');

  // 7. Resetting needs the write key; with it, a's polling restarts at step 1.
  const forbidden = await call('DELETE', '/_janus/sequences', { 'x-mock-session': 'a' });
  expect(forbidden.status).toBe(403);
  expect(await choice(status('a', '', 'HEAD'))).toBe('200; by=sequence; step=3');
  const reset = await call('DELETE', '/_janus/sequences', { 'x-mock-session': 'a', 'x-mock-session-key': key });
  expect(reset.status).toBe(200);
  expect(await choice(status('a'))).toBe('202.pending; by=sequence; step=1');

  // 8. In the UI: the rules and steps as sentences, then the explorer says which rule chose.
  const inventory = (await (await call('GET', '/_janus/endpoints')).json()) as {
    items: { id: string; method: string; path: string }[];
  };
  const endpoint = inventory.items.find((item) => item.method === 'GET' && item.path === '/v1/orders/{orderId}/status');
  await page.goto(`${janus.url}/_janus/ui/#/endpoints/${endpoint?.id ?? ''}`);
  const controls = page.getByRole('region', { name: 'Controls' });
  const rules = controls.getByRole('list', { name: 'Rules' });
  await expect(rules.getByRole('listitem').first()).toHaveText(
    'If path parameter orderId is ord-missing, respond with 404.missing.',
  );
  await expect(rules.getByRole('listitem').nth(2)).toHaveText(
    'If query parameter express is true, respond with 202.pending, then 200.shipped for every later matching request.',
  );
  await expect(controls.getByRole('list', { name: 'Steps' }).getByRole('listitem').last()).toHaveText(
    'and then 200 for every later request.',
  );
  await rules.getByRole('link', { name: 'Response 404.missing' }).click();
  await expect(page.getByRole('region', { name: 'Response 404.missing' })).toBeVisible();

  await page.getByRole('banner').getByRole('link', { name: 'Requests' }).click();
  // The Requests tab opens in Live; the simulation form is Explore.
  await page.getByRole('button', { name: 'Explore' }).click();
  const form = page.getByRole('form', { name: 'Request to simulate' });
  await form.getByLabel('Target (path and query)').fill('/v1/orders/ord-1/status?express=true');
  await form.getByRole('button', { name: 'Explain' }).click();
  const decisions = page.getByRole('region', { name: 'Simulated response' }).getByRole('list', { name: 'Decisions' });
  await expect(decisions).toContainText('Chose 202.pending by a rule in variants.yaml (rule 3), step 1.');
  await expect(decisions).toContainText('requests without a session always get step 1');
});
