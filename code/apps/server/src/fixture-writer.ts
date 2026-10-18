import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import {
  fileDigest,
  FixtureReadError,
  type FixtureFiles,
  type FixtureWriter,
  type WriteFile,
  type WritePlan,
  type WriteResult,
} from '@janus/core';
import { readFixtureDirectory } from '@janus/fixtures-fs';

const FILE_MODE = 0o644;
/** No-follow where the platform has it. */
const NOFOLLOW = constants.O_NOFOLLOW;

/** A violation of the fixture root's integrity; its message names no absolute path. */
export class FixtureIntegrityError extends Error {
  override readonly name = 'FixtureIntegrityError';
}

/** One file on its way into the tree. */
interface Staged {
  readonly file: WriteFile;
  readonly key: string;
  readonly directory: string;
  readonly target: string;
  readonly temporary: string;
  /** Where the replaced file was kept until the plan commits. */
  backup: string | null;
  committed: boolean;
}

/**
 * The fixture writer. The canonical root's identity is pinned
 * when it opens and checked again before every plan. Directories and files
 * are created without following links; every file is written to a
 * `.janus-<random>.tmp` beside its target, flushed, and moved into place
 * only once every precondition holds. Path components come only from the
 * plan core built from validated data.
 */
export class FsFixtureWriter implements FixtureWriter {
  readonly #root: string;
  readonly #identity: { readonly dev: number; readonly ino: number };

  private constructor(root: string, identity: Stats) {
    this.#root = root;
    this.#identity = { dev: identity.dev, ino: identity.ino };
  }

  /** Opens the fixture root, which must exist and be a directory. */
  static async open(root: string): Promise<FsFixtureWriter> {
    const canonical = await realpath(root);
    const info = await lstat(canonical);
    if (!info.isDirectory()) throw new FixtureIntegrityError('the fixture root is not a directory');
    return new FsFixtureWriter(canonical, info);
  }

  async read(): Promise<FixtureFiles> {
    const read = await readFixtureDirectory(this.#root);
    if (!read.ok) throw new FixtureReadError(read.errors);
    return read.files;
  }

  async apply(plan: WritePlan, signal: AbortSignal): Promise<WriteResult> {
    const created: string[] = [];
    const staged: Staged[] = [];
    const keys = plan.files.map((file) => file.path.join('/'));
    const discard = async (): Promise<void> => {
      for (const item of staged) await unlink(item.temporary).catch(() => undefined);
      // Directories this plan created are removed again, deepest first, if they stayed empty.
      for (const directory of [...created].reverse()) await rmdir(directory).catch(() => undefined);
    };

    try {
      await this.#checkRoot();
      for (const [index, file] of plan.files.entries()) {
        const directory = await this.#directory(file.path.slice(0, -1), created);
        const name = file.path[file.path.length - 1] ?? '';
        checkComponent(name);
        const temporary = join(directory, `.janus-${randomBytes(8).toString('hex')}.tmp`);
        staged.push({
          file,
          key: keys[index] ?? '',
          directory,
          target: join(directory, name),
          temporary,
          backup: null,
          committed: false,
        });
        await writeExclusive(temporary, file.bytes);
      }
    } catch {
      await discard();
      return { outcome: 'failed', files: keys, restored: true };
    }

    // Review preconditions apply to files that are not themselves written.
    const checkReviewed = async (): Promise<string[]> => {
      const conflicts: string[] = [];
      for (const check of plan.checks ?? []) {
        if (check.path.length === 0) throw new FixtureIntegrityError('invalid check path');
        for (const component of check.path) checkComponent(component);
        // Check every existing directory again, refusing symbolic links.
        let directory = this.#root;
        let regular = true;
        for (const component of check.path.slice(0, -1)) {
          directory = join(directory, component);
          const info = await lstat(directory).catch(() => null);
          if (info?.isDirectory() !== true) {
            regular = false;
            break;
          }
        }
        const bytes = regular ? await readRegular(join(directory, check.path.at(-1) ?? '')) : null;
        if (bytes === null || fileDigest(bytes) !== check.digest) conflicts.push(check.path.join('/'));
      }
      return conflicts;
    };
    let conflicts: string[];
    try {
      conflicts = await checkReviewed();
    } catch {
      await discard();
      return { outcome: 'failed', files: keys, restored: true };
    }
    for (const item of staged) {
      if (!(await holds(item))) conflicts.push(item.key);
    }
    if (conflicts.length > 0) {
      await discard();
      return { outcome: 'conflict', files: conflicts };
    }
    if (signal.aborted) {
      await discard();
      return { outcome: 'failed', files: [], restored: true };
    }

    try {
      for (const item of staged) {
        const changed = await checkReviewed();
        if (changed.length > 0) throw new PreconditionFailed(changed);
        if (item.file.precondition.kind === 'absent') {
          // An exclusive create of the final name: link fails if anything appeared there meanwhile.
          await link(item.temporary, item.target);
          item.committed = true;
          await unlink(item.temporary).catch(() => undefined);
        } else {
          // The digest is checked on the bytes on disk immediately before the rename.
          if (!(await holds(item))) throw new PreconditionFailed([item.key]);
          const backup = join(item.directory, `.janus-${randomBytes(8).toString('hex')}.tmp`);
          await rename(item.target, backup);
          item.backup = backup;
          await rename(item.temporary, item.target);
          item.committed = true;
        }
      }
      // An edit during a metadata rename must roll back the review too.
      const changed = await checkReviewed();
      if (changed.length > 0) throw new PreconditionFailed(changed);
    } catch (error) {
      const unrestored: string[] = [];
      for (const item of [...staged].reverse()) {
        if (!(await restore(item))) unrestored.push(item.key);
      }
      await discard();
      if (error instanceof PreconditionFailed && unrestored.length === 0) {
        return {
          outcome: 'conflict',
          files: error.files,
        };
      }
      return unrestored.length === 0
        ? { outcome: 'failed', files: keys, restored: true }
        : { outcome: 'failed', files: unrestored.reverse(), restored: false };
    }

    for (const item of staged) {
      if (item.backup !== null) await unlink(item.backup).catch(() => undefined);
    }
    return { outcome: 'written' };
  }

  /** Fails closed when the pinned root was replaced, moved or turned into a link. */
  async #checkRoot(): Promise<void> {
    const info = await lstat(this.#root).catch(() => null);
    if (info?.isDirectory() !== true || info.dev !== this.#identity.dev || info.ino !== this.#identity.ino) {
      throw new FixtureIntegrityError('the fixture root was replaced');
    }
  }

  /** The directory below the root, created one level at a time; a link or a file on the way fails. */
  async #directory(components: readonly string[], created: string[]): Promise<string> {
    let directory = this.#root;
    for (const component of components) {
      checkComponent(component);
      directory = join(directory, component);
      let info = await lstat(directory).catch(() => null);
      if (info === null) {
        try {
          await mkdir(directory);
          created.push(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        info = await lstat(directory);
      }
      if (!info.isDirectory()) throw new FixtureIntegrityError('a path component is not a directory');
    }
    return directory;
  }
}

class PreconditionFailed extends Error {
  constructor(readonly files: readonly string[]) {
    super('a file changed on disk');
  }
}

/** A path component as core plans them: never empty, a dot segment, or containing a separator or NUL. */
function checkComponent(component: string): void {
  if (component === '' || component === '.' || component === '..' || /[/\\\0]/.test(component)) {
    throw new FixtureIntegrityError('invalid path component');
  }
}

/** Whether the target still looks as the plan expects. */
async function holds(item: Staged): Promise<boolean> {
  const { precondition } = item.file;
  if (precondition.kind === 'absent') {
    return (await lstat(item.target).catch(() => null)) === null;
  }
  const bytes = await readRegular(item.target);
  return bytes !== null && fileDigest(bytes) === precondition.digest;
}

/** Undoes one committed file; true when the tree is as it was for it. */
async function restore(item: Staged): Promise<boolean> {
  try {
    if (item.file.precondition.kind === 'absent') {
      if (item.committed) await unlink(item.target);
      return true;
    }
    if (item.backup !== null) {
      await rename(item.backup, item.target);
      item.backup = null;
    }
    return true;
  } catch {
    return false;
  }
}

/** Creates a new file exclusively without following links, writes every byte and flushes. */
async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, FILE_MODE);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
      offset += bytesWritten;
    }
    await handle.datasync();
  } finally {
    await handle.close();
  }
}

/** A regular file, opened without following links; null otherwise. */
async function readRegular(path: string): Promise<Uint8Array | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const buffer = await handle.readFile();
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
