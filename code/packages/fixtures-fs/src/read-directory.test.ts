import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildSnapshot } from '@janus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readFixtureDirectory } from './read-directory.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'janus-fixtures-fs-'));
});

afterEach(async () => {
  await chmod(root, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

async function write(tree: Readonly<Record<string, string | Uint8Array>>, base = root): Promise<void> {
  for (const [path, contents] of Object.entries(tree)) {
    const absolute = join(base, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
}

/** Creates a symbolic link, or returns false when the platform refuses (EPERM on unprivileged Windows). */
async function linkOrFalse(target: string, path: string, type: 'file' | 'dir' | 'junction'): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'EPERM') return false;
    throw error;
  }
}

const TREE = {
  'default/GET/200_{text-plain}.txt': 'root',
  'default/v1/products/GET/200_{application-json}.json': '[{"id":"p-1"}]',
  'default/v1/products/GET/200.headers.json': '{"X-A":"1"}',
  'default/v1/products/p-1/DELETE/204': '',
  'default/v1/bin/GET/200_{application-octet-stream}.bin': new Uint8Array([0, 255, 1, 254]),
};

describe('readFixtureDirectory', () => {
  it('reads a nested tree into canonical "/" keys and exact bytes', async () => {
    await write(TREE);
    const result = await readFixtureDirectory(root);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect([...result.files.keys()].sort()).toEqual(Object.keys(TREE).sort());
    expect([...(result.files.get('default/v1/bin/GET/200_{application-octet-stream}.bin') ?? [])]).toEqual([
      0, 255, 1, 254,
    ]);
    expect(result.files.get('default/v1/products/p-1/DELETE/204')?.length).toBe(0);
  });

  it('produces the same snapshot as the equivalent in-memory source', async () => {
    await write(TREE);
    const read = await readFixtureDirectory(root);
    if (!read.ok) throw new Error('read failed');
    const inMemory = new Map(
      Object.entries(TREE).map(([key, value]) => [
        key,
        typeof value === 'string' ? new TextEncoder().encode(value) : value,
      ]),
    );
    const fromDisk = buildSnapshot(read.files);
    const fromMemory = buildSnapshot(inMemory);
    expect(fromDisk).toEqual(fromMemory);
    if (fromDisk.ok && fromMemory.ok) expect(fromDisk.snapshot.version).toBe(fromMemory.snapshot.version);
  });

  it('produces the same startup errors as the equivalent in-memory source', async () => {
    // Directory names must differ by more than case: `get` and `GET` are one directory on Windows and macOS.
    const bad = { 'default/v1/get/204': '', 'default/v2/GET/200': '', 'other/GET/204': '' };
    await write(bad);
    const read = await readFixtureDirectory(root);
    if (!read.ok) throw new Error('read failed');
    const inMemory = new Map(Object.entries(bad).map(([key, value]) => [key, new TextEncoder().encode(value)]));
    expect(buildSnapshot(read.files)).toEqual(buildSnapshot(inMemory));
  });

  it('is independent of creation order', async () => {
    const other = await mkdtemp(join(tmpdir(), 'janus-fixtures-fs-'));
    try {
      await write(TREE);
      await write(Object.fromEntries(Object.entries(TREE).reverse()), other);
      const a = await readFixtureDirectory(root);
      const b = await readFixtureDirectory(other);
      if (!a.ok || !b.ok) throw new Error('read failed');
      expect(buildSnapshot(a.files)).toEqual(buildSnapshot(b.files));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('fails clearly for a missing root', async () => {
    const result = await readFixtureDirectory(join(root, 'nope'));
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'data-root-missing', path: '' }] });
  });

  it('fails clearly when the root is a file', async () => {
    await write({ file: 'x' });
    const result = await readFixtureDirectory(join(root, 'file'));
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'data-root-not-directory', path: '' }] });
  });

  it('rejects a symbolic link to a file instead of following it', async (context) => {
    await write({ ...TREE, 'outside/secret.txt': 'secret' });
    // Windows only permits file symlinks with Developer Mode or elevation.
    if (!(await linkOrFalse(join(root, 'outside', 'secret.txt'), join(root, 'default', 'GET', 'link.txt'), 'file'))) {
      context.skip('this environment does not permit creating file symlinks');
    }
    const result = await readFixtureDirectory(root);
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'symbolic-link', path: 'default/GET/link.txt' }] });
  });

  it('rejects a linked directory instead of following it', async () => {
    await write({ ...TREE, 'outside/GET/200_{text-plain}.txt': 'secret' });
    // A junction on Windows (no privilege needed); an ordinary symlink elsewhere.
    await symlink(join(root, 'outside'), join(root, 'default', 'linked-dir'), 'junction');
    const result = await readFixtureDirectory(root);
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'symbolic-link', path: 'default/linked-dir' }] });
  });

  it('allows the root itself to be a linked directory', async () => {
    await write({ 'real/default/GET/204': '' });
    await symlink(join(root, 'real'), join(root, 'alias'), 'junction');
    const result = await readFixtureDirectory(join(root, 'alias'));
    expect(result.ok).toBe(true);
  });

  // Relies on POSIX permission bits, which Windows does not enforce and root bypasses.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports unreadable files and directories without absolute paths',
    async () => {
      await write({ ...TREE, 'default/locked/GET/204': '' });
      await chmod(join(root, 'default', 'locked'), 0o000);
      await chmod(join(root, 'default', 'GET', '200_{text-plain}.txt'), 0o000);
      const result = await readFixtureDirectory(root);
      await chmod(join(root, 'default', 'locked'), 0o755);
      expect(result).toMatchObject({
        ok: false,
        errors: [
          { code: 'unreadable', path: 'default/GET/200_{text-plain}.txt' },
          { code: 'unreadable', path: 'default/locked' },
        ],
      });
      if (!result.ok) for (const error of result.errors) expect(error.message).not.toContain(root);
    },
  );
});
