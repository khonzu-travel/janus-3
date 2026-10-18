import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject, NEW_PROJECT_CONFIG, NEW_PROJECT_FIXTURE } from './create-project.js';
import { detectProject, lastProject, projectId } from './projects.js';

let root: string;
const asRoot = process.getuid?.() === 0;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'janus-desktop-')));
});

afterEach(async () => {
  await chmod(root, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe('project detection', () => {
  it.each([
    ['config only', ['janus.config.yaml'], []],
    ['data only', [], ['data']],
    ['both', ['janus.config.yaml'], ['data']],
  ])('treats a folder with %s as a project', async (_label, files, directories) => {
    for (const file of files) await writeFile(join(root, file), '');
    for (const directory of directories) await mkdir(join(root, directory));
    const detected = await detectProject(root);
    expect(detected).toEqual({
      kind: 'project',
      project: { path: root, name: root.split('/').pop(), id: projectId(root) },
    });
  });

  it('offers to create a project in a folder with neither', async () => {
    expect(await detectProject(root)).toEqual({ kind: 'not-project', path: root });
  });

  it('does not count a data file or a config directory', async () => {
    await writeFile(join(root, 'data'), '');
    await mkdir(join(root, 'janus.config.yaml'));
    expect((await detectProject(root)).kind).toBe('not-project');
  });

  it('identifies a project by its real path, through symbolic links', async () => {
    await mkdir(join(root, 'real', 'data'), { recursive: true });
    await symlink(join(root, 'real'), join(root, 'link'));
    const detected = await detectProject(join(root, 'link'));
    expect(detected).toMatchObject({ kind: 'project', project: { path: join(root, 'real'), name: 'real' } });
  });

  it('uses the first 16 hex digits of the SHA-256 of the path as the id', () => {
    expect(projectId('/work/shop-mocks')).toMatch(/^[0-9a-f]{16}$/);
    expect(projectId('/work/shop-mocks')).toBe(projectId('/work/shop-mocks'));
    expect(projectId('/work/shop-mocks')).not.toBe(projectId('/work/other'));
  });

  it('reports a missing folder', async () => {
    expect(await detectProject(join(root, 'gone'))).toEqual({ kind: 'missing', path: join(root, 'gone') });
  });

  it.skipIf(asRoot)('reports an unreadable folder', async () => {
    await mkdir(join(root, 'locked'));
    await chmod(join(root, 'locked'), 0o000);
    try {
      expect(await detectProject(join(root, 'locked'))).toMatchObject({ kind: 'unreadable', reason: 'EACCES' });
    } finally {
      await chmod(join(root, 'locked'), 0o755);
    }
  });

  it('reports a file as unreadable', async () => {
    await writeFile(join(root, 'file'), '');
    expect(await detectProject(join(root, 'file'))).toMatchObject({ kind: 'unreadable', reason: 'not a folder' });
  });
});

describe('project creation', () => {
  it('writes exactly the two files', async () => {
    expect(await createProject(join(root, 'new'))).toEqual({ kind: 'created' });
    expect(await readFile(join(root, 'new', 'janus.config.yaml'), 'utf8')).toBe(NEW_PROJECT_CONFIG);
    expect(await readFile(join(root, 'new', 'data', 'default', 'hello', 'GET', '200.json'), 'utf8')).toBe(
      NEW_PROJECT_FIXTURE,
    );
    expect(JSON.parse(NEW_PROJECT_FIXTURE)).toEqual({ message: 'Hello from Janus' });
    expect(NEW_PROJECT_CONFIG).toContain('  port: 4010\n');
    expect(NEW_PROJECT_CONFIG).toContain('  watch: true\n');
  });

  it.each(['janus.config.yaml', 'data'])('refuses a folder that already holds %s', async (name) => {
    await writeFile(join(root, name), 'mine');
    expect(await createProject(root)).toEqual({ kind: 'exists' });
    expect(await readFile(join(root, name), 'utf8')).toBe('mine');
  });

  it.skipIf(asRoot)('reports a failure and removes nothing', async () => {
    await writeFile(join(root, 'keep.txt'), 'keep');
    await chmod(root, 0o555);
    const result = await createProject(root);
    await chmod(root, 0o755);
    expect(result.kind).toBe('failed');
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('leaves an existing fixture tree untouched', async () => {
    await mkdir(join(root, 'data', 'default', 'hello', 'GET'), { recursive: true });
    await writeFile(join(root, 'data', 'default', 'hello', 'GET', '200.json'), 'theirs');
    expect(await createProject(root)).toEqual({ kind: 'exists' });
    expect(await readFile(join(root, 'data', 'default', 'hello', 'GET', '200.json'), 'utf8')).toBe('theirs');
  });
});

describe('the project reopened on launch', () => {
  it('is the most recent project', async () => {
    const first = join(root, 'first');
    const second = join(root, 'second');
    for (const folder of [first, second]) await mkdir(join(folder, 'data'), { recursive: true });
    expect(await lastProject([second, first])).toEqual({ path: second, name: 'second', id: projectId(second) });
  });

  it('is none with no recent projects', async () => {
    expect(await lastProject([])).toBeNull();
  });

  it('is none when the most recent folder is gone or no longer a project, never an older one', async () => {
    const older = join(root, 'older');
    await mkdir(join(older, 'data'), { recursive: true });
    expect(await lastProject([join(root, 'gone'), older])).toBeNull();
    expect(await lastProject([root, older])).toBeNull();
  });
});
