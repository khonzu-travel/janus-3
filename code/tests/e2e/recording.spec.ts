import { readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startJanusWith, type Janus } from './harness.js';
import { audit, tabTo, writeTree } from './support.js';

// The recording acceptance journey: a real
// server records two registered endpoints from a local fake upstream, and the
// UI reviews the captures. Captures are never served.

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

let upstream: Server;
let upstreamUrl: string;
const seen: Seen[] = [];
let root: string;
let janus: Janus;

const ECHO_BODY = (request: Seen): string =>
  JSON.stringify({ declined: true, saw: { url: request.url, body: JSON.parse(request.body) as unknown } });

async function startUpstream(): Promise<void> {
  upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      if (entry.method === 'GET') {
        response.writeHead(302, { location: '/elsewhere' });
        response.end();
        return;
      }
      response.writeHead(402, {
        'content-type': 'application/json',
        'set-cookie': 'upstream-session=abc; Path=/',
        'strict-transport-security': 'max-age=600',
      });
      response.end(ECHO_BODY(entry));
    });
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  upstreamUrl = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
}

const config = () =>
  [
    'fixtures:',
    '  root: ./fixtures',
    'recording:',
    '  captures: ./captures',
    '  endpoints:',
    '    - method: POST',
    "      path: '/v1/carts/{cartId}/items'",
    `      upstream: ${upstreamUrl}/shop`,
    '    - method: GET',
    "      path: '/v1/products/{productId}'",
    `      upstream: ${upstreamUrl}`,
    '',
  ].join('\n');

const serve = () => startJanusWith(['--config', join(root, 'janus.config.yaml'), '--host', '127.0.0.1', '--port', '0']);

test.beforeAll(async () => {
  await startUpstream();
  root = await writeTree('janus-e2e-recording-', {
    'janus.config.yaml': config(),
    'fixtures/default/v1/carts/{cartId}/items/POST/201.json': '{"added":true}',
    'fixtures/default/v1/products/{productId}/GET/200.json': '{"id":"p-1"}',
    'fixtures/payment-declined/flow.yaml': 'description: Payments are declined.\n',
  });
  janus = await serve();
});

test.afterAll(async () => {
  await janus.stop();
  await new Promise((done) => upstream.close(done));
  await rm(root, { recursive: true, force: true });
});

const RECORD = { 'x-mock-record': 'true', 'x-mock-scenario': 'payment-declined' };

const recordPost = () =>
  fetch(`${janus.url}/v1/carts/c-9/items?coupon=SPRING`, {
    method: 'POST',
    headers: {
      ...RECORD,
      authorization: 'Bearer staging-token',
      cookie: 'basket=42',
      'content-type': 'application/json',
      forwarded: 'for=1.2.3.4',
      via: '1.1 proxy',
      'x-forwarded-for': '1.2.3.4',
    },
    body: '{"sku":"s-1"}',
  });

const exchanges = async () =>
  (await readdir(join(root, 'captures', 'payment-declined'))).filter((name) => /^[0-9a-f]{8}$/.test(name)).sort();

test('records registered endpoints, reviews the captures, and never serves them', async ({ page }, info) => {
  // 2. An unregistered path is refused with no outbound activity.
  const refused = await fetch(`${janus.url}/v1/orders/o-1`, { headers: RECORD });
  expect(refused.status).toBe(403);
  expect(seen).toHaveLength(0);

  // 3. A POST with credentials, a cookie, a query, a path parameter and a body.
  const posted = await recordPost();
  expect(posted.status).toBe(402);
  const postedBody = await posted.text();
  expect(postedBody).toBe(ECHO_BODY(seen[0] as Seen));
  expect(posted.headers.get('set-cookie')).toBeNull();
  expect(posted.headers.get('strict-transport-security')).toBeNull();
  // Capture IDs are random: eight hex digits, not a counter.
  const postedId = posted.headers.get('x-mock-recorded') ?? '';
  expect(postedId).toMatch(/^payment-declined\/[0-9a-f]{8}$/);
  const firstExchange = postedId.split('/')[1] ?? '';
  const sent = seen[0] as Seen;
  expect(sent.url).toBe('/shop/v1/carts/c-9/items?coupon=SPRING');
  expect(sent.headers['authorization']).toBe('Bearer staging-token');
  expect(sent.headers['cookie']).toBe('basket=42');
  for (const name of Object.keys(sent.headers)) {
    expect(name).not.toMatch(/^(x-mock-|x-forwarded-|forwarded$|via$)/);
  }

  // 4. A redirect is relayed, not followed.
  const redirected = await fetch(`${janus.url}/v1/products/p-1`, { headers: RECORD, redirect: 'manual' });
  expect(redirected.status).toBe(302);
  expect(seen).toHaveLength(2);
  const secondExchange = (redirected.headers.get('x-mock-recorded') ?? '').split('/')[1] ?? '';

  // 5. Both exchanges, valid under the fixture grammar and literal.
  expect(await exchanges()).toEqual([firstExchange, secondExchange].sort());
  const first = join(root, 'captures', 'payment-declined', firstExchange);
  const files = (await readdir(first)).sort();
  expect(files).toEqual(['402.headers.json', '402.json', '402.meta.json', 'request.json']);
  expect(await readFile(join(first, '402.json'), 'utf8')).toBe(postedBody);
  const sidecar = JSON.parse(await readFile(join(first, '402.headers.json'), 'utf8')) as Record<string, unknown>;
  expect(sidecar['set-cookie']).toBe('upstream-session=abc; Path=/');
  const request = await readFile(join(first, 'request.json'), 'utf8');
  for (const value of ['Bearer staging-token', 'basket=42', 'coupon=SPRING', 'c-9', 's-1']) {
    expect(request).toContain(value);
  }

  // 6. The review page shows both, and the first as exchanged.
  await page.goto(`${janus.url}/_janus/ui/#/captures?scenario=payment-declined`);
  const table = page.getByRole('table', { name: /Recorded exchanges/ });
  await expect(table.getByRole('row')).toHaveCount(3);
  await page.getByRole('button', { name: 'About captures' }).click();
  await expect(page.getByRole('tooltip')).toContainText('Captures are not served.');
  await audit(page, info, 'mouse', 'captures');
  // By keyboard: Tab reaches the capture's link, Enter opens it.
  await tabTo(page, table.getByRole('link', { name: '/v1/carts/c-9/items?coupon=SPRING' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Request' })).toContainText('Bearer staging-token');
  await expect(page.getByRole('region', { name: 'Response' })).toContainText('upstream-session=abc');
  await audit(page, info, 'mouse', 'capture detail');

  // 7. Without X-Mock-Record, fixtures answer; the explorer only simulates.
  const mocked = await fetch(`${janus.url}/v1/carts/c-9/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(mocked.status).toBe(201);
  expect(await mocked.text()).toBe('{"added":true}');
  const simulated = (await (
    await fetch(`${janus.url}/_janus/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'GET', target: '/v1/products/p-1', headers: { 'x-mock-record': ['true'] } }),
    })
  ).json()) as { trace: { outcome: { kind: string } } };
  expect(simulated.trace.outcome.kind).toBe('would-record');
  expect(seen).toHaveLength(2);

  // 8. After a restart, a new exchange gets a new ID and earlier exchanges are unchanged.
  const before = await readFile(join(first, '402.json'), 'utf8');
  await janus.stop();
  janus = await serve();
  const again = await recordPost();
  const third = again.headers.get('x-mock-recorded') ?? '';
  expect(third).toMatch(/^payment-declined\/[0-9a-f]{8}$/);
  const thirdExchange = third.split('/')[1] ?? '';
  expect(await exchanges()).toEqual([firstExchange, secondExchange, thirdExchange].sort());
  expect(await readFile(join(first, '402.json'), 'utf8')).toBe(before);

  // 9. Deleting a capture from its page removes its files and its row, after a confirmation.
  await page.goto(`${janus.url}/_janus/ui/#/captures/${third}?scenario=payment-declined`);
  await page.getByRole('button', { name: 'Delete capture' }).click();
  const confirm = page.getByRole('dialog', { name: `Delete capture ${third}?` });
  await audit(page, info, 'mouse', 'delete capture');
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(table.getByRole('row')).toHaveCount(3);
  expect(await exchanges()).toEqual([firstExchange, secondExchange].sort());
});
