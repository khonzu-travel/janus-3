import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUiAssets, type UiAssets } from '@janus/adapter-http';
import type { StartupWarning } from '@janus/core';

/**
 * Locates the built Atlas UI. `@janus/ui` is an asset-only
 * dependency: its files are resolved, never imported. Null when the package or
 * its build cannot be found, for example when running from source unbuilt.
 */
export function defaultUiRoot(): string | null {
  try {
    return dirname(fileURLToPath(import.meta.resolve('@janus/ui/dist/index.html')));
  } catch {
    return null;
  }
}

/**
 * Reads every file of the build into memory, once, at startup. Null when the
 * directory or its `index.html` is missing; the server then starts without the UI.
 */
export async function loadUi(root: string | null): Promise<UiAssets | null> {
  if (root === null) return null;
  try {
    if (!(await stat(join(root, 'index.html'))).isFile()) return null;
  } catch {
    return null;
  }
  const entries: [string, Uint8Array][] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    entries.push([relative(root, absolute).split(sep).join('/'), await readFile(absolute)]);
  }
  return createUiAssets(entries);
}

/** The structured warning for an enabled UI without a build. */
export const UI_ASSETS_MISSING: StartupWarning = Object.freeze({
  code: 'ui-assets-missing',
  source: 'ui',
  path: '@janus/ui/dist',
  message: 'the Atlas UI is not built, so /_janus/ui/ is not served; build it with pnpm build, or pass --no-ui',
});
