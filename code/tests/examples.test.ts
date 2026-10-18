import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { buildSnapshot, CONFIG_DEFAULTS, createEngine, configJsonSchema, mergeConfig, parseConfig } from '@janus/core';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import { readFixtureDirectory } from '@janus/fixtures-fs';
import { describe, expect, it } from 'vitest';

describe('examples/data', () => {
  it('is a valid fixture tree', async () => {
    const read = await readFixtureDirectory(resolve(import.meta.dirname, '../examples/data'));
    if (!read.ok) throw new Error(JSON.stringify(read.errors));
    const built = buildSnapshot(read.files);
    expect(built.ok ? [] : built.errors).toEqual([]);
    expect(built).toMatchObject({ ok: true, snapshot: { routeCount: 15, fixtureCount: 18 } });
    // v1/legacy demonstrates both relaxed errors.
    expect(built.warnings.map((warning) => `${warning.code} ${warning.path}`)).toEqual([
      'content-type-override default/v1/legacy/GET/200.headers.json',
      'janus-computed-header default/v1/legacy/GET/200.headers.json',
    ]);
  });

  it('has child and grandchild scenarios using overrides, removes, ids, latency and faults', async () => {
    const read = await readFixtureDirectory(resolve(import.meta.dirname, '../examples/data'));
    if (!read.ok) throw new Error(JSON.stringify(read.errors));
    const built = buildSnapshot(read.files);
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    const engine = createEngine({ snapshot: built.snapshot });
    const { items } = engine.atlas.scenarios();
    expect(items.find((item) => item.name === 'flaky-network')?.latency).toEqual({
      own: { min: 200, max: 800 },
      effective: { profile: { min: 200, max: 800 }, scenario: 'flaky-network' },
    });
    const payments = engine.atlas
      .inventory('flaky-network')
      ?.items.find((item) => item.method === 'POST' && item.path === '/v1/payments');
    expect(payments?.hasFaults).toBe(true);
    expect(items.map(({ name, chain, overrides, removes, ids }) => ({ name, chain, overrides, removes, ids }))).toEqual(
      [
        { name: 'default', chain: ['default'], overrides: [], removes: [], ids: [] },
        { name: 'flaky-network', chain: ['flaky-network', 'default'], overrides: [], removes: [], ids: [] },
        {
          name: 'payment-declined',
          chain: ['payment-declined', 'default'],
          overrides: ['/v1/payments/POST'],
          removes: [],
          ids: [{ name: 'orderId', value: 'ord-7', from: 'payment-declined' }],
        },
        {
          name: 'sold-out',
          chain: ['sold-out', 'default'],
          overrides: ['/v1/products/GET'],
          removes: [],
          ids: [
            { name: 'cartId', value: 'cart_sold_out', from: 'sold-out' },
            { name: 'storeId', value: 'store_main', from: 'sold-out' },
          ],
        },
        {
          name: 'sold-out-en',
          chain: ['sold-out-en', 'sold-out', 'default'],
          overrides: [],
          removes: ['/v1/greeting/GET/200_[fr].json'],
          ids: [
            { name: 'cartId', value: 'cart_sold_out_en', from: 'sold-out-en' },
            { name: 'storeId', value: 'store_main', from: 'sold-out' },
          ],
        },
      ],
    );
  });
});

describe('examples/janus.config.yaml', () => {
  const path = resolve(import.meta.dirname, '../examples/janus.config.yaml');

  it('is valid, sets every setting to its default, and references the schema', async () => {
    const text = await readFile(path, 'utf8');
    const parsed = parseConfig({ text, sourceName: 'examples/janus.config.yaml' });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const merged = mergeConfig(parsed.config, {});
    expect(merged.values).toEqual(CONFIG_DEFAULTS);
    expect(merged.settings.every((setting) => setting.source === 'file')).toBe(true);
    expect(parsed.config.$schema).toBe('../apps/server/schema/janus.config.schema.json');
    expect(resolve(path, '..', parsed.config.$schema ?? '')).toBe(
      resolve(import.meta.dirname, '../apps/server/schema/janus.config.schema.json'),
    );
    expect(new Ajv2020({ strict: true }).validate(configJsonSchema, parseYaml(text))).toBe(true);
  });
});
