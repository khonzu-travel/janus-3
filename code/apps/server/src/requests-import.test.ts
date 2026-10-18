import { createHash } from 'node:crypto';
import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These tests exercise file transactions, independently of YAML parsing and snapshots.
const faults = vi.hoisted(() => ({ target: null as string | null, remaining: 1 }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof FsPromises>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      if (faults.target !== null && to.endsWith(faults.target)) {
        faults.remaining--;
        if (faults.remaining === 0) faults.target = null; // Restoration can normally succeed.
        throw Object.assign(new Error('disk error'), { code: 'EIO' });
      }
      await real.rename(from, to);
    },
  };
});
vi.mock('@janus/core', () => ({
  fileDigest: (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
}));
vi.mock('@janus/fixtures-fs', () => ({ readRequestDirectory: () => ({ ok: false, errors: [] }) }));
vi.mock('@janus/runner', () => ({
  EMPTY_TREE: { nodes: new Map(), collections: [], environments: [], version: 'v1' },
  ENVIRONMENTS_DIRECTORY: 'environments',
  LOCAL_SUFFIX: '.local.yaml',
}));

import { EMPTY_TREE } from '@janus/runner';
import type { ValidationContext } from '@janus/runner';
import { RequestStore } from './requests.js';

let root: string;
beforeEach(async () => {
  faults.remaining = 1;
  root = await mkdtemp(join(tmpdir(), 'janus-import-'));
});
afterEach(async () => {
  faults.target = null;
  await rm(root, { recursive: true, force: true });
});

async function write(files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

async function filesAt(directory = root, prefix = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, await filesAt(join(directory, entry.name), `${path}/`));
    else files[path] = await readFile(join(directory, entry.name), 'utf8');
  }
  return files;
}

const ORIGINAL = {
  'orders/old.request.yaml': 'old request',
  'environments/staging.yaml': 'old staging',
  'environments/staging.local.yaml': 'staging secret',
  'environments/production.yaml': 'old production',
  'environments/production.local.yaml': 'production secret',
};
const IMPORTED = {
  'orders/new.request.yaml': 'new request',
  'environments/staging.yaml': 'new staging',
  'environments/production.yaml': 'new production',
};
const bytesOf = (files: Record<string, string>): Map<string, Uint8Array> =>
  new Map(Object.entries(files).map(([path, text]) => [path, new TextEncoder().encode(text)]));
function store(): RequestStore {
  return new RequestStore(
    root,
    {} as ValidationContext,
    { tree: EMPTY_TREE, errors: [], warnings: [] },
    { info: () => undefined, error: () => undefined },
  );
}

describe('collection import transactions', () => {
  it.each(['/orders', '/environments/staging.yaml', '/environments/production.yaml'])(
    'restores every file when installing %s fails',
    async (target) => {
      await write(ORIGINAL);
      faults.target = target;
      expect(await store().writeCollection('orders', bytesOf(IMPORTED), true)).toMatchObject({
        ok: false,
        reason: 'failed',
      });
      expect(await filesAt()).toEqual(ORIGINAL);
    },
  );

  it('removes a new collection and environment files when a later installation fails', async () => {
    faults.target = '/environments/production.yaml';
    expect(await store().writeCollection('orders', bytesOf(IMPORTED), false)).toMatchObject({
      ok: false,
      reason: 'failed',
    });
    expect(await filesAt()).toEqual({});
    expect(await readdir(root)).not.toContain('orders');
  });

  it('replaces the collection and environments together, dropping obsolete local files', async () => {
    await write(ORIGINAL);
    expect(await store().writeCollection('orders', bytesOf(IMPORTED), true)).toEqual({ ok: true });
    expect(await filesAt()).toEqual(IMPORTED);
  });

  it('keeps imported local overrides on success', async () => {
    await write(ORIGINAL);
    const imported = { ...IMPORTED, 'environments/staging.local.yaml': 'new secret' };
    expect(await store().writeCollection('orders', bytesOf(imported), true)).toEqual({ ok: true });
    expect(await filesAt()).toEqual(imported);
  });

  it('retains the original backup when restoration also fails', async () => {
    await write(ORIGINAL);
    faults.target = '/environments/staging.yaml';
    faults.remaining = 2;
    expect(await store().writeCollection('orders', bytesOf(IMPORTED), true)).toMatchObject({
      ok: false,
      reason: 'failed',
      message: 'The import and restoration failed; backups were kept for recovery',
    });
    const files = await filesAt();
    expect(files['orders/old.request.yaml']).toBe(ORIGINAL['orders/old.request.yaml']);
    expect(files['environments/staging.local.yaml']).toBe(ORIGINAL['environments/staging.local.yaml']);
    expect(
      Object.entries(files).some(
        ([path, value]) =>
          path.startsWith('environments/.janus-replaced-') && value === ORIGINAL['environments/staging.yaml'],
      ),
    ).toBe(true);
  });

  it('refuses existing destinations without replacing anything', async () => {
    await write(ORIGINAL);
    expect(await store().writeCollection('orders', bytesOf(IMPORTED), false)).toBe('exists');
    expect(await filesAt()).toEqual(ORIGINAL);
  });
});
