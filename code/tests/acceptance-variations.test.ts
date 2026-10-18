import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The fixture variations acceptance journey, HTTP steps, against examples/data. The browser step is in
// tests/e2e/variations.spec.ts.

const workspace = resolve(import.meta.dirname, '..');
const BIN = join(workspace, 'apps/server/src/bin.ts');
const TSX = join(workspace, 'node_modules/tsx/dist/esm/index.mjs');
const DATA = join(workspace, 'examples/data');

let proc: ReturnType<typeof spawn>;
const output = { stdout: '', stderr: '' };
let url: string;

beforeAll(async () => {
  proc = spawn(
    process.execPath,
    ['--import', TSX, '--conditions=@janus/source', BIN, 'serve', '--no-config', '--data', DATA, '--port', '0'],
    { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stdout?.setEncoding('utf8').on('data', (chunk: string) => (output.stdout += chunk));
  proc.stderr?.setEncoding('utf8').on('data', (chunk: string) => (output.stderr += chunk));
  for (let i = 0; i < 300; i++) {
    const found = /listening on (\S+)/.exec(output.stdout)?.[1];
    if (found !== undefined) {
      url = found;
      return;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`janus did not start:\n${output.stdout}\n${output.stderr}`);
});

afterAll(() => {
  if (proc.exitCode === null) proc.kill('SIGKILL');
});

describe('fixture variations (acceptance)', () => {
  it('starts with the two documented header-policy warnings', () => {
    expect(output.stderr).toContain('[content-type-override]');
    expect(output.stderr).toContain('[janus-computed-header]');
  });

  it('answers the literal route for its own value, and the template for others and deeper paths', async () => {
    const literal = await fetch(`${url}/v1/products/p-1`);
    expect(await literal.json()).toEqual({ id: 'p-1', name: 'Example' });

    const other = await fetch(`${url}/v1/products/p-42`);
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ id: 'any', name: 'Any product' });

    // p-1 has no reviews directory, so the walk backtracks into {productId}.
    const deeper = await fetch(`${url}/v1/products/p-1/reviews`);
    expect(deeper.status).toBe(200);
    expect(await deeper.json()).toEqual([{ rating: 5, text: 'Great' }]);
  });

  it('negotiates Accept, refuses unacceptable media types, and refuses unsupported request bodies', async () => {
    const yaml = await fetch(`${url}/v1/products/p-42`, { headers: { accept: 'application/yaml' } });
    expect(yaml.status).toBe(200);
    expect(yaml.headers.get('content-type')).toBe('application/yaml');
    expect(yaml.headers.get('vary')).toBe('Accept');
    expect(await yaml.text()).toBe('id: any\nname: Any product\n');

    const csv = await fetch(`${url}/v1/products/p-42`, { headers: { accept: 'text/csv' } });
    expect(csv.status).toBe(406);
    expect(csv.headers.get('content-type')).toBe('application/json');
    expect(await csv.json()).toMatchObject({ error: { code: 'not-acceptable' } });

    const xml = await fetch(`${url}/v1/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: '<p/>',
    });
    expect(xml.status).toBe(415);
    expect(xml.headers.get('accept-post')).toBe('application/json');
    expect(await xml.json()).toMatchObject({ error: { code: 'unsupported-media-type' } });

    const json = await fetch(`${url}/v1/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"New"}',
    });
    expect(json.status).toBe(201);
  });

  it('negotiates locale first, then media type', async () => {
    const html = await fetch(`${url}/v1/greeting`, { headers: { 'accept-language': 'fr', accept: 'text/html' } });
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toBe('text/html');
    expect(html.headers.get('content-language')).toBe('fr');
    expect(html.headers.get('vary')).toBe('Accept, Accept-Language');
  });

  it('names what it served, sends a Content-Type override with the representation, and computes Date', async () => {
    const product = await fetch(`${url}/v1/products/p-42`);
    const identity = product.headers.get('x-mock-identity') ?? '';
    expect(identity).toMatch(/^fx_[0-9a-f]{16}$/);

    const health = (await (await fetch(`${url}/_janus/health`)).json()) as { snapshotVersion: string };
    const inventory = (await (await fetch(`${url}/_janus/endpoints`)).json()) as {
      items: { path: string; method: string; detailHref: string }[];
    };
    const item = inventory.items.find((entry) => entry.path === '/v1/products/{productId}' && entry.method === 'GET');
    const endpoint = (await (await fetch(`${url}/_janus/${item?.detailHref ?? ''}`)).json()) as {
      fixtures: { id: string }[];
      snapshotVersion: string;
    };
    expect(endpoint.snapshotVersion).toBe(health.snapshotVersion);
    expect(endpoint.fixtures.map((fixture) => fixture.id)).toContain(identity);

    const legacy = await fetch(`${url}/v1/legacy`);
    expect(legacy.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(legacy.headers.get('x-mock-representation')).toBe('application/json');
    expect(legacy.headers.get('date')).not.toBe('Mon, 01 Jan 2001 00:00:00 GMT');
    expect(Date.parse(legacy.headers.get('date') ?? '')).toBeGreaterThan(Date.parse('2020-01-01'));

    const miss = await fetch(`${url}/v1/nowhere`);
    expect(miss.status).toBe(404);
    expect(miss.headers.get('x-mock-identity')).toBeNull();
  });
});
