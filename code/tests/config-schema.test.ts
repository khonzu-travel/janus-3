import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { configJsonSchema, parseConfig } from '@janus/core';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { CONFIG_SCHEMA_PATH, renderConfigSchema } from '../scripts/write-config-schema.js';

// The committed JSON Schema (for editors) must match the Zod schema Janus
// validates with.

describe('janus.config.schema.json', () => {
  it('is current; run `pnpm schema` after changing the config schema', async () => {
    const committed = await readFile(CONFIG_SCHEMA_PATH, 'utf8');
    expect(committed).toBe(await renderConfigSchema());
    expect(JSON.parse(committed)).toEqual(configJsonSchema);
  });

  it('ships with the server package', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(import.meta.dirname, '../apps/server/package.json'), 'utf8'),
    ) as { files: string[] };
    expect(manifest.files).toContain('schema');
  });

  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(configJsonSchema);

  const SAMPLES: readonly string[] = [
    '',
    '$schema: ./x.json\n',
    'server:\n  host: localhost\n  port: 0\n  strictTrailingSlash: false\n',
    'server:\n  host: "::1"\n',
    'fixtures:\n  root: ./fixtures\n',
    'onUnknownMethod: 404\n',
    'onUnknownMethod: 405\n',
    'limits:\n  maxUrlBytes: 256\n  maxHeaderBytes: 1024\n  maxBodyBytes: 0\n',
    // Invalid
    'server:\n  prot: 1\n',
    'server:\n  port: 65536\n',
    'server:\n  port: -1\n',
    'server:\n  port: "4010"\n',
    'server:\n  host: "not a host"\n',
    'server:\n  host: ""\n',
    'server:\n  strictTrailingSlash: "yes"\n',
    'server: 5\n',
    'fixtures:\n  root: ""\n',
    'fixtures:\n  root: 5\n',
    'onUnknownMethod: 403\n',
    'onUnknownMethod: "404"\n',
    'limits:\n  maxUrlBytes: 255\n',
    'limits:\n  maxHeaderBytes: 1023\n',
    'limits:\n  maxBodyBytes: -1\n',
    'limits:\n  maxBodyBytes: 10MiB\n',
    'limits:\n  maxBodyBytes: 1.5\n',
    'extra: 1\n',
    '$schema: 5\n',
  ];

  it.each(SAMPLES)('gives the same verdict as Zod for %j', (text) => {
    const zod = parseConfig({ text, sourceName: 'janus.config.yaml' }).ok;
    const ajv = validate((parseYaml(text) as unknown) ?? {});
    expect(ajv, JSON.stringify(validate.errors)).toBe(zod);
  });

  it('accepts some samples and rejects others', () => {
    const verdicts = SAMPLES.map((text) => parseConfig({ text, sourceName: 'x' }).ok);
    expect(verdicts.filter(Boolean)).toHaveLength(8);
  });
});
