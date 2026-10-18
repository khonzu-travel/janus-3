import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RECENT_LIMIT, RecentProjects } from './recent.js';
import { clampBounds, WindowStates } from './window-state.js';

let root: string;
let file: string;
let logged: string[];
const log = (line: string): void => {
  logged.push(line);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'janus-recent-'));
  file = join(root, 'recent-projects.json');
  logged = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const clock = () => {
  let second = 0;
  return () => new Date(Date.UTC(2026, 9, 9, 15, 4, second++));
};

describe('recent projects', () => {
  it('starts empty without a file', async () => {
    const recent = await RecentProjects.load(file, log);
    expect(await recent.list()).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('keeps the most recent first and moves a reopened project to the top', async () => {
    const recent = await RecentProjects.load(file, log, clock());
    for (const name of ['a', 'b', 'c']) await mkdir(join(root, name));
    await recent.opened(join(root, 'a'));
    await recent.opened(join(root, 'b'));
    await recent.opened(join(root, 'c'));
    await recent.opened(join(root, 'a'));
    expect(recent.paths()).toEqual([join(root, 'a'), join(root, 'c'), join(root, 'b')]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      projects: [
        { path: join(root, 'a'), openedAt: '2026-10-09T15:04:03Z' },
        { path: join(root, 'c'), openedAt: '2026-10-09T15:04:02Z' },
        { path: join(root, 'b'), openedAt: '2026-10-09T15:04:01Z' },
      ],
    });
  });

  it(`keeps at most ${String(RECENT_LIMIT)}`, async () => {
    const recent = await RecentProjects.load(file, log);
    for (let i = 0; i < RECENT_LIMIT + 3; i++) await recent.opened(`/p/${String(i)}`);
    expect(recent.paths()).toHaveLength(RECENT_LIMIT);
    expect(recent.paths()[0]).toBe(`/p/${String(RECENT_LIMIT + 2)}`);
  });

  it('marks missing folders instead of dropping them', async () => {
    const recent = await RecentProjects.load(file, log);
    await mkdir(join(root, 'here'));
    await recent.opened(join(root, 'gone'));
    await recent.opened(join(root, 'here'));
    expect((await recent.list()).map((entry) => [entry.name, entry.missing])).toEqual([
      ['here', false],
      ['gone', true],
    ]);
  });

  it('removes and clears', async () => {
    const recent = await RecentProjects.load(file, log);
    await recent.opened('/a');
    await recent.opened('/b');
    await recent.remove('/a');
    expect(recent.paths()).toEqual(['/b']);
    await recent.clear();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, projects: [] });
  });

  it('writes atomically, leaving no temporary files', async () => {
    const recent = await RecentProjects.load(file, log);
    await Promise.all([recent.opened('/a'), recent.opened('/b'), recent.opened('/c')]);
    expect(await readdir(root)).toEqual(['recent-projects.json']);
    const reloaded = await RecentProjects.load(file, log);
    expect(reloaded.paths()).toEqual(['/c', '/b', '/a']);
  });

  it.each([
    ['not JSON', '{nope'],
    ['the wrong version', '{"version":2,"projects":[]}'],
    ['a bad entry', '{"version":1,"projects":[{"path":3}]}'],
  ])('treats a file with %s as empty, logs it, and replaces it on the next write', async (_label, contents) => {
    await writeFile(file, contents);
    const recent = await RecentProjects.load(file, log);
    expect(recent.paths()).toEqual([]);
    expect(logged).toHaveLength(1);
    await recent.opened('/a');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, projects: [{ path: '/a' }] });
  });
});

describe('window state', () => {
  const display = { x: 0, y: 0, width: 1920, height: 1080 };
  const second = { x: 1920, y: 0, width: 1280, height: 1024 };

  it('saves and restores bounds by project id', async () => {
    const states = await WindowStates.load(join(root, 'window-state.json'), log);
    await states.save('0123456789abcdef', { x: 10, y: 20, width: 1000, height: 700 });
    const reloaded = await WindowStates.load(join(root, 'window-state.json'), log);
    expect(reloaded.get('0123456789abcdef')).toEqual({ x: 10, y: 20, width: 1000, height: 700 });
    expect(reloaded.get('fedcba9876543210')).toBeUndefined();
  });

  it('ignores an invalid file', async () => {
    await writeFile(join(root, 'window-state.json'), '[]');
    const states = await WindowStates.load(join(root, 'window-state.json'), log);
    expect(states.get('x')).toBeUndefined();
    expect(logged).toHaveLength(1);
  });

  it('keeps bounds that are on a display', () => {
    const bounds = { x: 2000, y: 100, width: 1000, height: 700 };
    expect(clampBounds(bounds, [display, second])).toBe(bounds);
  });

  it('moves a window from a display that is gone onto the nearest one', () => {
    expect(clampBounds({ x: 2000, y: 100, width: 1000, height: 700 }, [display])).toEqual({
      x: 920,
      y: 100,
      width: 1000,
      height: 700,
    });
  });

  it('shrinks a window larger than the display', () => {
    expect(clampBounds({ x: -50, y: -50, width: 4000, height: 3000 }, [display])).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
  });

  it('moves a window whose title bar is above the display', () => {
    expect(clampBounds({ x: 100, y: -500, width: 800, height: 600 }, [display])).toEqual({
      x: 100,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  it('has nothing to clamp to without a display', () => {
    expect(clampBounds({ x: 0, y: 0, width: 800, height: 600 }, [])).toBeNull();
  });
});
