import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readRequestDirectory } from './read-requests.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'janus-requests-fs-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readRequestDirectory', () => {
  it('reads files and directories, skipping editor files', async () => {
    await mkdir(join(root, 'checkout', 'environments'), { recursive: true });
    await writeFile(join(root, 'checkout', '010-a.request.yaml'), 'name: A\n');
    await writeFile(join(root, 'checkout', '.DS_Store'), 'x');
    const result = await readRequestDirectory(root);
    if (!result.ok) throw new Error('expected ok');
    expect([...result.files.files.keys()]).toEqual(['checkout/010-a.request.yaml']);
    expect([...result.files.directories].sort()).toEqual(['checkout', 'checkout/environments']);
  });

  it('treats a missing root as an empty tree', async () => {
    const result = await readRequestDirectory(join(root, 'missing'));
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.files.files.size).toBe(0);
  });

  it('rejects symbolic links and files with more than one link', async () => {
    await writeFile(join(root, 'a.request.yaml'), 'name: A\n');
    await link(join(root, 'a.request.yaml'), join(root, 'b.request.yaml'));
    let linked = true;
    try {
      await symlink(join(root, 'a.request.yaml'), join(root, 'c.request.yaml'));
    } catch {
      linked = false;
    }
    const result = await readRequestDirectory(root);
    if (result.ok) throw new Error('expected errors');
    const codes = result.errors.map((error) => `${error.path} ${error.code}`);
    expect(codes).toContain('a.request.yaml unsupported-file-type');
    expect(codes).toContain('b.request.yaml unsupported-file-type');
    if (linked) expect(codes).toContain('c.request.yaml symbolic-link');
  });
});
