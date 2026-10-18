import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CONFIG_FILE, DATA_DIRECTORY } from './projects.js';

/** The files New Project writes. */
export const NEW_PROJECT_CONFIG = `# janus.config.yaml — created by the Janus app. Every key is optional;
# the full list is in the Janus README.
server:
  host: 127.0.0.1
  port: 4010
fixtures:
  root: ./data
  watch: true
`;
export const NEW_PROJECT_FIXTURE_PATH = ['default', 'hello', 'GET', '200.json'] as const;
export const NEW_PROJECT_FIXTURE = '{ "message": "Hello from Janus" }\n';

export type CreateResult =
  | { readonly kind: 'created' }
  /** The folder already holds `janus.config.yaml` or `data`: open it as a project instead. */
  | { readonly kind: 'exists' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Writes a minimal project into `folder`. Every file is created exclusively,
 * so nothing that exists is ever overwritten, and a failure removes nothing.
 */
export async function createProject(folder: string): Promise<CreateResult> {
  try {
    await mkdir(folder, { recursive: true });
    if ((await exists(join(folder, CONFIG_FILE))) || (await exists(join(folder, DATA_DIRECTORY)))) {
      return { kind: 'exists' };
    }
    await writeFile(join(folder, CONFIG_FILE), NEW_PROJECT_CONFIG, { flag: 'wx' });
    const fixture = join(folder, DATA_DIRECTORY, ...NEW_PROJECT_FIXTURE_PATH);
    await mkdir(join(fixture, '..'), { recursive: true });
    await writeFile(fixture, NEW_PROJECT_FIXTURE, { flag: 'wx' });
    return { kind: 'created' };
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return false;
    throw error;
  }
}
