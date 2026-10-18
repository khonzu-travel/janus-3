import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { fileDigest, type StartupError, type StartupWarning } from '@janus/core';
import { readRequestDirectory, type RequestFiles } from '@janus/fixtures-fs';
import {
  buildRequestTree,
  EMPTY_TREE,
  ENVIRONMENTS_DIRECTORY,
  LOCAL_SUFFIX,
  type RequestProblem,
  type RequestTree,
  type RequestTreeWarning,
  type ValidationContext,
} from '@janus/runner';

/**
 * The request tree on disk: the snapshot the
 * runner reads, swapped whole on each reload, and every write to the files
 * beneath `runner.root`. Writes take turns, refuse links on the way, replace
 * files atomically and check each precondition against the bytes on disk.
 */

/** What a reload or the startup read found. */
export interface RequestLoad {
  readonly tree: RequestTree;
  readonly errors: readonly StartupError[];
  readonly warnings: readonly StartupWarning[];
}

/** One file change: new bytes, or null to remove the file. */
export interface FileChange {
  readonly path: string;
  readonly bytes: Uint8Array | null;
}

/** A precondition: the file's digest on disk, or null for "must not exist". */
export interface FileCheck {
  readonly path: string;
  readonly digest: string | null;
}

export type WriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'changed'; readonly path: string }
  | { readonly ok: false; readonly reason: 'failed'; readonly message: string };

const FILE_MODE = 0o644;

/** Reads and validates the tree under `root`; a missing root is an empty tree. */
export async function loadRequestTree(root: string, context: ValidationContext): Promise<RequestLoad> {
  const read = await readRequestDirectory(root);
  if (!read.ok) return { tree: EMPTY_TREE, errors: read.errors, warnings: [] };
  return buildFromFiles(read.files, context);
}

export function buildFromFiles(files: RequestFiles, context: ValidationContext): RequestLoad {
  const built = buildRequestTree(files, context);
  return {
    tree: built.tree,
    errors: built.errors.map(toStartupError),
    warnings: built.warnings.map(toStartupWarning),
  };
}

export function toStartupError(problem: RequestProblem): StartupError {
  return {
    code: problem.code,
    source: 'requests',
    path: problem.path,
    ...(problem.line === undefined ? {} : { line: problem.line }),
    ...(problem.column === undefined ? {} : { column: problem.column }),
    ...(problem.pointer === undefined ? {} : { key: problem.pointer }),
    message: problem.message,
  };
}

function toStartupWarning(warning: RequestTreeWarning): StartupWarning {
  return { code: warning.code, source: 'requests', path: warning.path, message: warning.message };
}

export interface RequestStoreLogger {
  info(event: string, fields?: Readonly<Record<string, string | number>>): void;
  error(event: string, fields?: Readonly<Record<string, string | number>>): void;
}

export class RequestStore {
  readonly #root: string;
  readonly #context: ValidationContext;
  readonly #logger: RequestStoreLogger;
  #current: RequestLoad;
  /** Writes and reloads take turns. */
  #queue: Promise<unknown> = Promise.resolve();
  readonly #listeners = new Set<(changed: readonly string[]) => void>();

  constructor(root: string, context: ValidationContext, initial: RequestLoad, logger: RequestStoreLogger) {
    this.#root = root;
    this.#context = context;
    this.#current = initial;
    this.#logger = logger;
  }

  get root(): string {
    return this.#root;
  }

  get tree(): RequestTree {
    return this.#current.tree;
  }

  /** The last load's problems; a reload with errors keeps the previous tree. */
  get problems(): RequestLoad {
    return this.#current;
  }

  subscribe(listener: (changed: readonly string[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Re-reads the tree: swapped when it validates, otherwise the previous one is kept. */
  reload(): Promise<RequestLoad> {
    return this.#turn(() => this.#reload());
  }

  async #reload(): Promise<RequestLoad> {
    const next = await loadRequestTree(this.#root, this.#context);
    const previous = this.#current.tree;
    if (next.errors.length > 0) {
      this.#current = { tree: previous, errors: next.errors, warnings: next.warnings };
      this.#logger.error('requests-reload-failed', { errors: next.errors.length });
      return this.#current;
    }
    this.#current = next;
    const changed = changedIds(previous, next.tree);
    if (changed.length > 0) {
      this.#logger.info('requests-reloaded', { changed: changed.length, version: next.tree.version });
      for (const listener of this.#listeners) {
        try {
          listener(changed);
        } catch {
          // A failing listener never breaks a reload.
        }
      }
    }
    return this.#current;
  }

  #turn<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work, work);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** The bytes of a file below the root, or null when missing, a link, or not a plain file. */
  async readFile(path: string): Promise<Uint8Array | null> {
    const absolute = await this.#resolve(path, false).catch(() => null);
    if (absolute === null) return null;
    try {
      const info = await lstat(absolute);
      if (!info.isFile() || info.nlink > 1) return null;
      const bytes = await readFile(absolute);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch {
      return null;
    }
  }

  /** The digest of a file on disk, or null when it does not exist. */
  async digestOf(path: string): Promise<string | null> {
    const bytes = await this.readFile(path);
    return bytes === null ? null : fileDigest(bytes);
  }

  /**
   * Applies changes after every check holds against the bytes on disk, then
   * reloads. A directory is created for a file whose parent is missing only
   * when `createDirectories` is set.
   */
  write(changes: readonly FileChange[], checks: readonly FileCheck[], createDirectories = false): Promise<WriteResult> {
    return this.#turn(async () => {
      for (const check of checks) {
        const digest = await this.digestOf(check.path);
        const exists = digest !== null || (await this.#exists(check.path));
        if (check.digest === null ? exists : digest !== check.digest) {
          return { ok: false, reason: 'changed', path: check.path } as const;
        }
      }
      try {
        for (const change of changes) {
          const absolute = await this.#resolve(change.path, createDirectories);
          if (change.bytes === null) await unlink(absolute).catch(ignoreMissing);
          else await writeAtomically(absolute, change.bytes);
        }
      } catch (error) {
        this.#logger.error('requests-write-failed', { message: messageOf(error) });
        await this.#reload();
        return { ok: false, reason: 'failed', message: 'The request files could not be written' } as const;
      }
      await this.#reload();
      return { ok: true } as const;
    });
  }

  /** Creates a directory below the root (and the root itself when missing). */
  makeDirectory(path: string): Promise<WriteResult> {
    return this.#turn(async () => {
      try {
        const absolute = await this.#resolve(path, true);
        await mkdir(absolute).catch((error: unknown) => {
          if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
        });
      } catch (error) {
        this.#logger.error('requests-write-failed', { message: messageOf(error) });
        return { ok: false, reason: 'failed', message: 'The folder could not be created' } as const;
      }
      await this.#reload();
      return { ok: true } as const;
    });
  }

  /** Removes an empty directory, after removing `folder.yaml` when `checks` allow. */
  removeDirectory(path: string, checks: readonly FileCheck[]): Promise<WriteResult | 'not-empty'> {
    return this.#turn(async () => {
      for (const check of checks) {
        if ((await this.digestOf(check.path)) !== check.digest)
          return { ok: false, reason: 'changed', path: check.path } as const;
      }
      try {
        const absolute = await this.#resolve(path, false);
        const entries = (await readdir(absolute)).filter((name) => name !== 'folder.yaml');
        // A collection's old environments directory, left empty, does not keep the collection.
        if (!path.includes('/') && entries.length === 1 && entries[0] === ENVIRONMENTS_DIRECTORY) {
          const environments = join(absolute, ENVIRONMENTS_DIRECTORY);
          if ((await readdir(environments)).length === 0) {
            await rmdir(environments);
            entries.pop();
          }
        }
        if (entries.length > 0) return 'not-empty' as const;
        await unlink(join(absolute, 'folder.yaml')).catch(ignoreMissing);
        await rmdir(absolute);
      } catch (error) {
        this.#logger.error('requests-write-failed', { message: messageOf(error) });
        await this.#reload();
        return { ok: false, reason: 'failed', message: 'The folder could not be removed' } as const;
      }
      await this.#reload();
      return { ok: true } as const;
    });
  }

  /**
   * Writes a whole collection and the shared environments it brings. `files` are paths below the
   * root: `<name>/…` for the
   * collection, `environments/…` for environments. The collection goes into
   * a temporary directory inside the root and is renamed into place;
   * environment files are staged beside their targets first, so a failed
   * import leaves nothing behind. When the collection or one of the
   * environments exists, nothing is written unless `replace` is set; then
   * the existing collection is removed and each environment's files are
   * replaced, both of them.
   */
  writeCollection(
    name: string,
    files: ReadonlyMap<string, Uint8Array>,
    replace: boolean,
  ): Promise<WriteResult | 'exists'> {
    return this.#turn(async () => {
      let temporary: string | null = null;
      const staged: { temporary: string; target: string }[] = [];
      const changes: { target: string; backup: string | null; installed: boolean }[] = [];
      let committed = false;
      const prefix = `${name}/`;
      const environmentPrefix = `${ENVIRONMENTS_DIRECTORY}/`;
      const environmentFiles = [...files].filter(([path]) => path.startsWith(environmentPrefix));
      const environments = new Set(
        environmentFiles.map(([path]) => path.slice(environmentPrefix.length).replace(/(\.local)?\.yaml$/, '')),
      );
      const present = (absolute: string): Promise<boolean> =>
        lstat(absolute).then(
          () => true,
          () => false,
        );
      try {
        await this.#resolve('', true);
        const target = await this.#resolve(name, false);
        let exists = await present(target);
        for (const environment of environments) {
          for (const suffix of ['.yaml', LOCAL_SUFFIX]) {
            if (await this.#exists(`${environmentPrefix}${environment}${suffix}`)) exists = true;
          }
        }
        if (exists && !replace) return 'exists' as const;
        temporary = join(this.#root, `.janus-import-${randomBytes(6).toString('hex')}.tmp`);
        await mkdir(temporary);
        for (const [path, bytes] of files) {
          if (!path.startsWith(prefix)) continue;
          const absolute = join(temporary, ...path.slice(prefix.length).split('/'));
          await mkdir(dirname(absolute), { recursive: true });
          await writeExclusive(absolute, bytes);
        }
        for (const [path, bytes] of environmentFiles) {
          const absolute = await this.#resolve(path, true);
          const staging = join(dirname(absolute), `.janus-${randomBytes(6).toString('hex')}.tmp`);
          staged.push({ temporary: staging, target: absolute });
          await writeExclusive(staging, bytes);
        }
        // Keep every original until all collection and environment changes commit.
        const install = async (destination: string, source: string | null): Promise<void> => {
          const backup = (await present(destination))
            ? join(dirname(destination), `.janus-replaced-${randomBytes(6).toString('hex')}.tmp`)
            : null;
          if (backup !== null) await rename(destination, backup);
          const change = { target: destination, backup, installed: false };
          changes.push(change);
          if (source !== null) {
            await rename(source, destination);
            change.installed = true;
          }
        };
        await install(target, temporary);
        temporary = null;
        // A replaced environment keeps no `.local.yaml` the import does not bring.
        for (const environment of environments) {
          const local = `${environmentPrefix}${environment}${LOCAL_SUFFIX}`;
          if (!files.has(local)) await install(await this.#resolve(local, false), null);
        }
        for (const item of staged) await install(item.target, item.temporary);
        committed = true;
      } catch (error) {
        this.#logger.error('requests-write-failed', { message: messageOf(error) });
        let restored = true;
        for (const change of [...changes].reverse()) {
          try {
            if (change.installed) await rm(change.target, { recursive: true, force: true });
            if (change.backup !== null) await rename(change.backup, change.target);
          } catch (rollbackError) {
            // Leave the backup in place for recovery if restoration itself fails.
            restored = false;
            this.#logger.error('requests-restore-failed', { path: change.target, message: messageOf(rollbackError) });
          }
        }
        if (!restored) await this.#reload();
        return {
          ok: false,
          reason: 'failed',
          message: restored
            ? 'The imported collection could not be written; the original files were restored'
            : 'The import and restoration failed; backups were kept for recovery',
        } as const;
      } finally {
        if (temporary !== null) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        for (const item of staged) await unlink(item.temporary).catch(() => undefined);
        if (committed) {
          for (const change of changes) {
            if (change.backup === null) continue;
            await rm(change.backup, { recursive: true, force: true }).catch((error: unknown) => {
              this.#logger.error('requests-backup-cleanup-failed', {
                path: change.backup ?? '',
                message: messageOf(error),
              });
            });
          }
        }
      }
      await this.#reload();
      return { ok: true } as const;
    });
  }

  async #exists(path: string): Promise<boolean> {
    const absolute = await this.#resolve(path, false).catch(() => null);
    if (absolute === null) return false;
    return lstat(absolute).then(
      () => true,
      () => false,
    );
  }

  /**
   * The absolute path of `path` below the root: every existing
   * component must be a real directory, never a link. Missing directories are
   * created when `create` is set.
   */
  async #resolve(path: string, create: boolean): Promise<string> {
    if (create) await mkdir(this.#root, { recursive: true });
    const root = await realpath(this.#root);
    const parts = path === '' ? [] : path.split('/');
    let current = root;
    for (const [index, part] of parts.entries()) {
      if (part === '' || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')) {
        throw new Error('invalid path component');
      }
      current = join(current, part);
      const last = index === parts.length - 1;
      const info = await lstat(current).catch(() => null);
      if (info === null) {
        if (!last && create) await mkdir(current);
        continue;
      }
      if (info.isSymbolicLink()) throw new Error('a link lies on the path');
      if (!last && !info.isDirectory()) throw new Error('a file lies on the path');
    }
    return current;
  }
}

/**
 * Requests, folders and collections that appeared, disappeared or changed;
 * a shared environment reports `environments/<name>`, an
 * ID no request or folder can have.
 */
export function changedIds(previous: RequestTree, next: RequestTree): string[] {
  const signature = (tree: RequestTree): Map<string, string> => {
    const map = new Map<string, string>();
    for (const [id, node] of tree.nodes) {
      map.set(
        id,
        node.kind === 'request'
          ? node.digest
          : `${node.digest ?? '-'}:${node.children.map((child) => child.id).join(',')}`,
      );
    }
    for (const entry of tree.environments) map.set(`${ENVIRONMENTS_DIRECTORY}/${entry.id}`, entry.digest);
    return map;
  };
  const before = signature(previous);
  const after = signature(next);
  const changed = new Set<string>();
  for (const [id, value] of after) if (before.get(id) !== value) changed.add(id);
  for (const id of before.keys()) if (!after.has(id)) changed.add(id);
  return [...changed].sort();
}

async function writeAtomically(absolute: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(dirname(absolute), `.janus-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeExclusive(temporary, bytes);
    await rename(temporary, absolute);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function writeExclusive(absolute: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(
    absolute,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    FILE_MODE,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function ignoreMissing(error: unknown): void {
  if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
