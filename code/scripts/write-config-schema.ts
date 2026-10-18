import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { configJsonSchema } from '@janus/core';
import { format, resolveConfig } from 'prettier';

// `pnpm schema`: regenerates the committed JSON Schema for janus.config.yaml
// from the Zod schema in packages/core/src/config/.
// tests/config-schema.test.ts fails when the committed file is out of date.

export const CONFIG_SCHEMA_PATH = resolve(import.meta.dirname, '../apps/server/schema/janus.config.schema.json');

export async function renderConfigSchema(): Promise<string> {
  // The repository's Prettier options, so `pnpm format:check` agrees with the generated file.
  const options = await resolveConfig(CONFIG_SCHEMA_PATH);
  return format(JSON.stringify(configJsonSchema), { ...options, parser: 'json' });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await writeFile(CONFIG_SCHEMA_PATH, await renderConfigSchema());
  process.stdout.write(`wrote ${CONFIG_SCHEMA_PATH}\n`);
}
