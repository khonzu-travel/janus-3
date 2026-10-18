import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isJanusTemporaryFile, type FixtureFiles, type StartupError } from '@janus/core';

export type ReadFixturesResult =
  | { readonly ok: true; readonly root: string; readonly files: FixtureFiles }
  | { readonly ok: false; readonly root: string; readonly errors: readonly StartupError[] };

/**
 * Reads a fixture tree completely into memory as source-relative `/` keys →
 * bytes. It does not interpret names: that is core's job.
 *
 * The root may itself be a symbolic link (it is resolved once), but symbolic
 * links inside the tree are rejected rather than followed, so fixtures can
 * never escape the root. Errors carry source-relative paths only.
 */
export async function readFixtureDirectory(root: string): Promise<ReadFixturesResult> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    return { ok: false, root, errors: [rootError(error)] };
  }
  const rootStat = await stat(realRoot).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory()) {
    return {
      ok: false,
      root: realRoot,
      errors: [
        { code: 'data-root-not-directory', source: 'fixtures', path: '', message: 'the data root is not a directory' },
      ],
    };
  }

  const files = new Map<string, Uint8Array>();
  const errors: StartupError[] = [];
  await walk(realRoot, '', files, errors);
  if (errors.length > 0) {
    errors.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { ok: false, root: realRoot, errors };
  }
  return { ok: true, root: realRoot, files };
}

async function walk(absolute: string, relative: string, files: Map<string, Uint8Array>, errors: StartupError[]) {
  let entries: Dirent[];
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    errors.push({ code: 'unreadable', source: 'fixtures', path: relative, message: 'the directory cannot be read' });
    return;
  }
  for (const entry of entries) {
    const key = relative === '' ? entry.name : `${relative}/${entry.name}`;
    const path = join(absolute, entry.name);
    // A promotion's half-written file is never read; it may vanish at any moment.
    if (isJanusTemporaryFile(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      errors.push({
        code: 'symbolic-link',
        source: 'fixtures',
        path: key,
        message: 'symbolic links are not followed; copy the file instead',
      });
    } else if (entry.isDirectory()) {
      await walk(path, key, files, errors);
    } else if (entry.isFile()) {
      try {
        const bytes = await readFile(path);
        files.set(key, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      } catch {
        errors.push({ code: 'unreadable', source: 'fixtures', path: key, message: 'the file cannot be read' });
      }
    } else {
      errors.push({
        code: 'unsupported-file-type',
        source: 'fixtures',
        path: key,
        message: 'only regular files and directories are allowed in a fixture tree',
      });
    }
  }
}

function rootError(error: unknown): StartupError {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return { code: 'data-root-missing', source: 'fixtures', path: '', message: 'the data root does not exist' };
  }
  return { code: 'unreadable', source: 'fixtures', path: '', message: 'the data root cannot be read' };
}
