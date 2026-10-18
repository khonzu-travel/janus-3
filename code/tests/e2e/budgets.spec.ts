import { cp, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { startJanusWith, WORKSPACE, type Janus } from './harness.js';
import { bodiesAsText } from './support.js';

// The timing budgets, on its reference profile: Playwright's
// Chromium, headless, 1280 × 800, 4× CPU slowdown through the DevTools
// protocol, no network throttling, and a new browser context for every sample.
// The pass rule is the statistic in the table; there are no retries.

test.skip(({ browserName }) => browserName !== 'chromium', 'the reference profile is Chromium');
test.describe.configure({ retries: 0 });
// Tracing walks the DOM after every action, on the page's main thread: it would be measured too.
test.use({ trace: 'off', screenshot: 'off' });

const DATA = join(WORKSPACE, 'examples/data');
const PREVIEW_BYTES = 64 * 1024;
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;

/** A deterministic JSON document of exactly `bytes` bytes. */
function jsonOfSize(bytes: number): string {
  const items: string[] = [];
  const text = (list: readonly string[], pad: string) =>
    `{\n  "items": [\n${list.join(',\n')}\n  ],\n  "pad": "${pad}"\n}\n`;
  for (let index = 0; ; index++) {
    const item = `    { "id": "item-${String(index)}", "name": "Example ${String(index)}", "price": ${String(index % 97)}.5, "tags": ["a", "b"], "active": ${String(index % 2 === 0)} }`;
    if (text([...items, item], '').length > bytes) break;
    items.push(item);
  }
  const body = text(items, 'x'.repeat(bytes - text(items, '').length));
  if (Buffer.byteLength(body) !== bytes) throw new Error('jsonOfSize');
  return body;
}

async function treeWith(files: Readonly<Record<string, string>>, base?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'janus-e2e-budgets-'));
  if (base !== undefined) await cp(base, root, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, contents);
  }
  return root;
}

/** The generated inventory (apps/ui/src/layouts/inventory.test.tsx), as files. */
function largeInventory(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 0; index < count; index++) {
    const method = METHODS[index % METHODS.length] ?? 'GET';
    const path = `v${String(index % 3)}/group-${String(index % 40)}/item-${String(index)}`;
    files[`default/${path}/${method}/200_{application-json}.json`] = '{}';
  }
  return files;
}

/** A cold page on the reference profile. */
async function coldPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  return page;
}

const serve = (data: string) => startJanusWith(['--no-config', '--data', data, '--host', '127.0.0.1', '--port', '0']);

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? Number.NaN;
};

test.describe('the example fixtures', () => {
  let root: string;
  let janus: Janus;

  test.beforeAll(async () => {
    root = await treeWith({ 'default/v1/large/GET/200_{application-json}.json': jsonOfSize(PREVIEW_BYTES) }, DATA);
    janus = await serve(root);
  });

  test.afterAll(async () => {
    await janus.stop();
    await rm(root, { recursive: true, force: true });
  });

  test('Largest Contentful Paint of the Janus-served UI: median of 5 cold loads ≤ 1.5 s', async ({ browser }) => {
    const samples: number[] = [];
    for (let sample = 0; sample < 5; sample++) {
      const page = await coldPage(browser);
      await page.goto(`${janus.url}/_janus/ui/#/endpoints`);
      await expect(page.getByRole('link', { name: 'GET /v1/products, scenario default', exact: true })).toBeVisible();
      samples.push(
        await page.evaluate(`new Promise((done) => {
          new PerformanceObserver((list) => {
            const entries = list.getEntries();
            done(entries[entries.length - 1].startTime);
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        })`),
      );
      await page.context().close();
    }
    const median = percentile(samples, 0.5);
    test.info().annotations.push({ type: 'lcp', description: `${samples.map(Math.round).join(', ')} ms` });
    expect(median, `LCP samples ${samples.map(Math.round).join(', ')} ms`).toBeLessThanOrEqual(1500);
  });

  test('highlighting a 64 KiB JSON preview ≤ 150 ms', async ({ browser }) => {
    const page = await coldPage(browser);
    await bodiesAsText(page);
    await page.goto(`${janus.url}/_janus/ui/#/endpoints`);
    await page.getByRole('link', { name: 'GET /v1/large, scenario default', exact: true }).click();
    await page.getByRole('link', { name: 'View response 200', exact: true }).click();
    const preview = page.getByRole('region', { name: 'Response 200' }).getByLabel('Body preview (text)');
    // Shiki and the JSON grammar load on first use; the measure covers tokenizing only.
    await expect
      .poll(() => page.evaluate("performance.getEntriesByName('janus:highlight').length"), { timeout: 30_000 })
      .toBeGreaterThan(0);
    const measures: { duration: number; detail: { chars: number; complete: boolean } }[] = await page.evaluate(
      `performance.getEntriesByName('janus:highlight').map((entry) => ({ duration: entry.duration, detail: entry.detail }))`,
    );
    const sample = measures.find((entry) => entry.detail.chars >= PREVIEW_BYTES - 1);
    expect(sample?.detail.complete).toBe(true);
    test.info().annotations.push({ type: 'highlight', description: `${String(sample?.duration)} ms` });
    expect(sample?.duration).toBeLessThanOrEqual(150);
    await expect(preview.locator('.code-token').first()).toBeAttached();
    await expect(page.getByText('shown as plain text because highlighting it took too long')).toHaveCount(0);
    await page.context().close();
  });
});

test.describe('2 000 endpoints', () => {
  let root: string;
  let janus: Janus;

  test.beforeAll(async () => {
    root = await treeWith(largeInventory(2000));
    janus = await serve(root);
  });

  test.afterAll(async () => {
    await janus.stop();
    await rm(root, { recursive: true, force: true });
  });

  test('inventory filtering: 95th percentile of 20 keystrokes ≤ 50 ms', async ({ browser }) => {
    const page = await coldPage(browser);
    await page.goto(`${janus.url}/_janus/ui/#/endpoints`);
    const nav = page.getByRole('navigation', { name: 'Endpoints' });
    await expect(nav.getByRole('status')).toHaveText(/^(Showing 2000 of )?2000 endpoints$/, { timeout: 30_000 });
    await nav.getByRole('searchbox', { name: 'Filter endpoints' }).focus();
    const query = 'v1/group-1/item-1003';
    expect(query).toHaveLength(20);
    for (const [index, key] of Array.from(query).entries()) {
      await page.keyboard.type(key);
      // One keystroke at a time: each measure covers one keystroke's work.
      await expect
        .poll(() => page.evaluate("performance.getEntriesByName('janus:inventory-filter').length"))
        .toBe(index + 1);
    }
    await expect(nav.getByRole('searchbox', { name: 'Filter endpoints' })).toHaveValue(query);
    const samples: number[] = await page.evaluate(
      "performance.getEntriesByName('janus:inventory-filter').map((entry) => entry.duration)",
    );
    expect(samples).toHaveLength(20);
    const p95 = percentile(samples, 0.95);
    test
      .info()
      .annotations.push({ type: 'filter', description: `${samples.map((ms) => ms.toFixed(1)).join(', ')} ms` });
    expect(p95, `filter samples ${samples.map((ms) => ms.toFixed(1)).join(', ')} ms`).toBeLessThanOrEqual(50);
    await page.context().close();
  });
});
