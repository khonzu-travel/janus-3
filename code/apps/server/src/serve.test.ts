import { describe, expect, it } from 'vitest';

import { buildSnapshot } from '@janus/core';

import { startServer, type ServeLogger } from './serve.js';

describe('startServer dynamic seed', () => {
  it('generates one seed for direct callers, logs it, and reports it through Atlas', async () => {
    const built = buildSnapshot(new Map([['default/GET/200_{text-plain}.txt', new TextEncoder().encode('{{$uuid}}')]]));
    if (!built.ok) throw new Error('fixture should be valid');

    const entries: { event: string; fields?: Readonly<Record<string, string | number>> }[] = [];
    const logger: ServeLogger = {
      info: (event, fields) => {
        entries.push({ event, ...(fields === undefined ? {} : { fields }) });
      },
      error: () => undefined,
    };
    const result = await startServer({ dataRoot: '.', host: '127.0.0.1', port: 0, snapshot: built.snapshot }, logger);
    if (!result.ok) throw new Error('server should start');

    try {
      const clock = (await (await fetch(`${result.server.url}/_janus/clock`)).json()) as {
        seed: number;
        seedSource: string;
      };
      const publishedConfig = (await (await fetch(`${result.server.url}/_janus/config`)).json()) as {
        settings: { key: string; value: unknown }[];
      };
      expect(clock.seedSource).toBe('generated');
      expect(clock.seed).toBeGreaterThanOrEqual(0);
      expect(clock.seed).toBeLessThanOrEqual(0xffff_ffff);
      expect(entries).toContainEqual({ event: 'seed', fields: { seed: clock.seed, source: 'generated' } });
      expect(publishedConfig.settings.find(({ key }) => key === 'dynamic.seed')?.value).toBeNull();
    } finally {
      await result.server.close();
    }
  });
});
