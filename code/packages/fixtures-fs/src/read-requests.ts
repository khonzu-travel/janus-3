import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { isIgnoredFileName, isJanusTemporaryFile, type StartupError } from '@janus/core';

/** The request tree's files and directories, keyed by "/"-separated paths below the root. */
export interface RequestFiles {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly directories: ReadonlySet<string>;
}

export type ReadRequestsResult =
  | { readonly ok: true; readonly root: string; readonly files: RequestFiles }
  | { readonly ok: false; readonly root: string; readonly errors: readonly StartupError[] };

/**
 * Reads the request tree under `runner.root` into memory.
 * A missing root is an empty tree: the runner starts with no collections.
 * Symbolic links and files with more than one hard link are rejected, so a
 * request file can never reach outside the root. It does not interpret the
 * files: `@janus/runner` does.
 */
export async function readRequestDirectory(root: string): Promise<ReadRequestsResult> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') return { ok: true, root, files: { files: new Map(), directories: new Set() } };
    return { ok: false, root, errors: [problem('unreadable', '', 'the requests root cannot be read')] };
  }
  const info = await lstat(realRoot).catch(() => null);
  if (info === null || !info.isDirectory()) {
    return {
      ok: false,
      root: realRoot,
      errors: [problem('unsupported-file-type', '', 'the requests root is not a directory')],
    };
  }
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const errors: StartupError[] = [];
  await walk(realRoot, '', files, directories, errors);
  if (errors.length > 0) {
    errors.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { ok: false, root: realRoot, errors };
  }
  return { ok: true, root: realRoot, files: { files, directories } };
}

async function walk(
  absolute: string,
  relative: string,
  files: Map<string, Uint8Array>,
  directories: Set<string>,
  errors: StartupError[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    errors.push(problem('unreadable', relative, 'the directory cannot be read'));
    return;
  }
  for (const entry of entries) {
    if (isJanusTemporaryFile(entry.name) || isIgnoredFileName(entry.name)) continue;
    const key = relative === '' ? entry.name : `${relative}/${entry.name}`;
    const path = join(absolute, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(problem('symbolic-link', key, 'symbolic links are not followed; copy the file instead'));
    } else if (entry.isDirectory()) {
      directories.add(key);
      await walk(path, key, files, directories, errors);
    } else if (entry.isFile()) {
      try {
        const info = await lstat(path);
        if (info.nlink > 1) {
          errors.push(
            problem(
              'unsupported-file-type',
              key,
              'files with more than one hard link are not allowed; copy the file instead',
            ),
          );
          continue;
        }
        const bytes = await readFile(path);
        files.set(key, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      } catch {
        errors.push(problem('unreadable', key, 'the file cannot be read'));
      }
    } else {
      errors.push(
        problem('unsupported-file-type', key, 'only regular files and directories are allowed in the requests root'),
      );
    }
  }
}

function problem(
  code: 'unreadable' | 'symbolic-link' | 'unsupported-file-type',
  path: string,
  message: string,
): StartupError {
  return { code, source: 'requests', path, message };
}
