import { expect, test } from '@playwright/test';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { startJanusWith, type Janus } from './harness.js';
import { audit, pickScenario, tabTo, writeTree } from './support.js';

// The faults and transport acceptance journey:
// fixture CORS for a page on a listed origin, compressed and XML request bodies,
// 100-continue, fault sequences with latency, the explorer's Transport stage,
// and automatic OPTIONS.

const ORDER = JSON.stringify({
  id: 'o-7',
  lines: Array.from({ length: 60 }, (_, index) => ({ sku: `sku-${String(index).padStart(4, '0')}`, quantity: 1 })),
});

const TREE = (pageOrigin: string): Record<string, string> => ({
  'janus.config.yaml': [
    'fixtures:',
    '  root: fixtures',
    'cors:',
    '  fixtures:',
    `    origins: ["${pageOrigin}"]`,
    'faults:',
    '  timeoutMs: 1000',
    'sessions:',
    '  keyFrom: [header.x-session]',
    '',
  ].join('\n'),
  'fixtures/default/v1/orders/{orderId}/GET/200.json': ORDER,
  'fixtures/default/v1/orders/POST/201.json': '{"id":"o-new"}',
  'fixtures/default/v1/orders/POST/201.priority.json': '{"id":"{{$body.$.order.@id}}","priority":true}',
  'fixtures/default/v1/orders/POST/variants.yaml':
    'rules:\n  - when: { body.$.order.@priority: high }\n    serve: 201.priority\n',
  'fixtures/default/v1/orders/POST/accepts.yaml': 'accepts: [application/xml]\n',
  'fixtures/flaky-network/flow.yaml': 'latency: { ms: 300 }\n',
  'fixtures/flaky-network/v1/orders/POST/fault.yaml': 'rules: [{ fault: [reset, timeout, none] }]\n',
});

let root: string;
let janus: Janus;
let pageServer: Server;
let pageOrigin: string;

test.beforeAll(async () => {
  pageServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="en"><title>Shop</title><h1>Shop</h1></html>');
  });
  await new Promise<void>((done) => pageServer.listen(0, '127.0.0.1', done));
  pageOrigin = `http://127.0.0.1:${String((pageServer.address() as AddressInfo).port)}`;
  root = await writeTree('janus-e2e-faults-', TREE(pageOrigin));
  janus = await startJanusWith(['--config', join(root, 'janus.config.yaml'), '--host', '127.0.0.1', '--port', '0']);
});

test.afterAll(async () => {
  await janus.stop();
  await new Promise((done) => pageServer.close(done));
  await rm(root, { recursive: true, force: true });
});

interface Answer {
  readonly status: number | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  readonly error: string | undefined;
  readonly ms: number;
}

/** One request through Node's HTTP client: the answer, or the client error and when it came. */
function send(method: string, path: string, headers: Record<string, string> = {}, body?: Buffer): Promise<Answer> {
  const started = Date.now();
  return new Promise((resolve) => {
    const req = httpRequest(`${janus.url}${path}`, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
          error: undefined,
          ms: Date.now() - started,
        });
      });
    });
    req.on('error', (error: Error & { code?: string }) => {
      resolve({ status: undefined, headers: {}, body: Buffer.alloc(0), error: error.code, ms: Date.now() - started });
    });
    req.end(body);
  });
}

/** Writes a request head with `Expect: 100-continue`, sends the body only after `100 Continue`, and returns every byte. */
function expectContinue(contentType: string, body: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = connect(janus.port, '127.0.0.1', () => {
      socket.write(
        `POST /v1/orders HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: ${contentType}\r\n` +
          `Content-Length: ${String(Buffer.byteLength(body))}\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (chunk.toString('latin1').startsWith('HTTP/1.1 100 Continue')) socket.write(body);
    });
    socket.on('close', () => {
      resolve(Buffer.concat(chunks).toString('latin1'));
    });
  });
}

test('mock a flaky network for a page on another origin, and read it in the UI', async ({ page }, info) => {
  // 2. From the page on the listed origin: the preflight succeeds and the response is readable.
  await page.goto(`${pageOrigin}/`);
  const fromPage = await page.evaluate(async (url: string) => {
    const response = await fetch(`${url}/v1/orders/o-7`, { headers: { 'X-Mock-Scenario': 'default' } });
    const body = (await response.json()) as { id: string };
    return {
      status: response.status,
      id: body.id,
      identity: response.headers.get('x-mock-identity'),
      exposed: response.headers.get('access-control-expose-headers'),
    };
  }, janus.url);
  expect(fromPage).toMatchObject({ status: 200, id: 'o-7', identity: expect.stringMatching(/^fx_/) });
  // Plain browsers advertise br only over HTTPS, so the coding is checked from Node with the same request.
  const coded = await send('GET', '/v1/orders/o-7', {
    origin: pageOrigin,
    'x-mock-scenario': 'default',
    'accept-encoding': 'gzip, deflate, br',
  });
  expect(coded.headers['content-encoding']).toBe('br');
  expect(coded.headers['access-control-allow-origin']).toBe(pageOrigin);
  expect(coded.headers['vary']).toContain('Origin');

  // 3. A gzip-compressed XML body: the rule on the root's priority attribute serves 201.priority with its id.
  const xml = gzipSync('<order id="o-42" priority="high"><item sku="a"/></order>');
  const priority = await send(
    'POST',
    '/v1/orders',
    { 'content-type': 'application/xml', 'content-encoding': 'gzip' },
    xml,
  );
  expect(priority.status).toBe(201);
  expect(JSON.parse(priority.body.toString())).toEqual({ id: 'o-42', priority: true });

  // 4. A 10 KiB gzip body that expands past limits.maxDecodedBodyBytes.
  const bomb = gzipSync(Buffer.alloc(10 * 1024 * 1024));
  expect(bomb.length).toBeLessThan(11 * 1024);
  const tooLarge = await send(
    'POST',
    '/v1/orders',
    { 'content-type': 'application/xml', 'content-encoding': 'gzip' },
    bomb,
  );
  expect(tooLarge.status).toBe(413);
  expect(JSON.parse(tooLarge.body.toString())).toMatchObject({ error: { code: 'decoded-body-too-large' } });

  // 5. Expect: 100-continue is refused from the head for text/plain, and continued for XML.
  const refused = await expectContinue('text/plain', 'plain');
  expect(refused).toMatch(/^HTTP\/1\.1 415 /);
  expect(refused).not.toContain('100 Continue');
  const continued = await expectContinue('application/xml', '<order/>');
  expect(continued).toMatch(/^HTTP\/1\.1 100 Continue\r\n\r\nHTTP\/1\.1 201 /);

  // 6. In flaky-network with X-Session s1: reset after the delay, then held and closed, then answered.
  // Sequence steps are kept by sessions that exist, so s1 is created first.
  const session = await send(
    'POST',
    '/_janus/session',
    { 'x-session': 's1', 'content-type': 'application/json' },
    Buffer.from('{}'),
  );
  expect(session.status).toBe(201);
  const flaky = { 'x-mock-scenario': 'flaky-network', 'x-session': 's1', 'content-type': 'application/xml' };
  const first = await send('POST', '/v1/orders', flaky, Buffer.from('<order/>'));
  expect(first.error).toBe('ECONNRESET');
  expect(first.ms).toBeGreaterThanOrEqual(280);
  const second = await send('POST', '/v1/orders', flaky, Buffer.from('<order/>'));
  expect(second.status).toBeUndefined();
  expect(second.ms).toBeGreaterThanOrEqual(1200);
  expect(second.ms).toBeLessThan(5000);
  const third = await send('POST', '/v1/orders', flaky, Buffer.from('<order/>'));
  expect(third.status).toBe(201);
  expect(third.headers['x-mock-latency']).toBe('300');

  // 7. The explorer describes the fourth request at once: the last step and the latency.
  await page.goto(`${janus.url}/_janus/ui/#/explorer`);
  // The scenario is picked in the header; the form refuses an X-Mock-Scenario row.
  await pickScenario(page, 'flaky-network');
  const form = page.getByRole('form', { name: 'Request to simulate' });
  await form.getByLabel('Method').fill('POST');
  await form.getByLabel('Target (path and query)').fill('/v1/orders');
  await form.getByRole('button', { name: 'Add header' }).click();
  await form.getByLabel('Header 1 name').fill('X-Session');
  await form.getByLabel('Header 1 value').fill('s1');
  const started = Date.now();
  const explainButton = form.getByRole('button', { name: 'Explain' });
  await tabTo(page, explainButton);
  await page.keyboard.press('Enter');
  const decisions = page.getByRole('region', { name: 'Simulated response' }).getByRole('list', { name: 'Decisions' });
  await expect(decisions).toContainText('wait 300 ms before the first byte');
  await expect(decisions).toContainText('Fault rule 1, step 3 of 3');
  expect(Date.now() - started).toBeLessThan(3000);
  await audit(page, info, 'mouse', 'explorer transport stage');
  const fourth = await send('POST', '/v1/orders', flaky, Buffer.from('<order/>'));
  expect(fourth.status).toBe(201);

  // The explorer shows no response for a reset, and the endpoint page lists the fault rules.
  await form.getByLabel('Header 1 value').fill('s2');
  await explainButton.click();
  await expect(page.getByRole('region', { name: 'Simulated response' })).toContainText('No response');
  const inventory = (await (await fetch(`${janus.url}/_janus/endpoints?scenario=flaky-network`)).json()) as {
    items: { id: string; method: string; path: string; hasFaults?: boolean }[];
  };
  const endpoint = inventory.items.find((item) => item.method === 'POST' && item.path === '/v1/orders');
  expect(endpoint?.hasFaults).toBe(true);
  await page.goto(`${janus.url}/_janus/ui/#/endpoints/${endpoint?.id ?? ''}?scenario=flaky-network`);
  const faults = page.getByRole('region', { name: 'Faults' });
  await expect(faults.getByRole('listitem')).toHaveText([
    'Reset the connection on the first request, hold the connection open without answering on the second request, then answer normally.',
  ]);
  await audit(page, info, 'mouse', 'endpoint faults panel');

  // 8. OPTIONS without a directory is answered by Janus.
  const options = await send('OPTIONS', '/v1/orders');
  expect(options.status).toBe(204);
  expect(options.headers['allow']).toBe('OPTIONS, POST');
});
