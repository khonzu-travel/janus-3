import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import type { RecentProject } from '../shared/bridge.js';
import { readJson, writeFileAtomic } from './atomic-file.js';

/** At most this many recent projects are kept. */
export const RECENT_LIMIT = 10;

interface Entry {
  readonly path: string;
  readonly openedAt: string;
}

/**
 * `recent-projects.json` in the app's data directory, most recent first. A
 * missing, unreadable or invalid file is an empty list, replaced on the next
 * write; the problem goes to the app log.
 */
export class RecentProjects {
  private entries: Entry[] = [];
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly now: () => Date,
  ) {}

  static async load(
    file: string,
    log: (line: string) => void,
    now: () => Date = () => new Date(),
  ): Promise<RecentProjects> {
    const recent = new RecentProjects(file, now);
    try {
      const data = await readJson(file);
      if (data !== null) {
        const entries = parse(data);
        if (entries === null) log(`recent-projects-invalid file=${JSON.stringify(file)}`);
        else recent.entries = entries;
      }
    } catch (error) {
      log(`recent-projects-unreadable file=${JSON.stringify(file)} reason=${JSON.stringify(reason(error))}`);
    }
    return recent;
  }

  paths(): readonly string[] {
    return this.entries.map((entry) => entry.path);
  }

  has(path: string): boolean {
    return this.entries.some((entry) => entry.path === path);
  }

  /** The list for the start page and the Open Recent menu, with missing folders marked. */
  async list(): Promise<readonly RecentProject[]> {
    return Promise.all(
      this.entries.map(async (entry) => ({
        path: entry.path,
        name: basename(entry.path) || entry.path,
        openedAt: entry.openedAt,
        missing: !(await isDirectory(entry.path)),
      })),
    );
  }

  /** Moves a project to the top each time it opens. */
  opened(path: string): Promise<void> {
    const openedAt = this.now()
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    this.entries = [{ path, openedAt }, ...this.entries.filter((entry) => entry.path !== path)].slice(0, RECENT_LIMIT);
    return this.save();
  }

  remove(path: string): Promise<void> {
    this.entries = this.entries.filter((entry) => entry.path !== path);
    return this.save();
  }

  clear(): Promise<void> {
    this.entries = [];
    return this.save();
  }

  /** Writes are queued, so the file always ends up holding the latest list. */
  private save(): Promise<void> {
    const contents = `${JSON.stringify({ version: 1, projects: this.entries }, null, 2)}\n`;
    this.writing = this.writing.catch(() => undefined).then(() => writeFileAtomic(this.file, contents));
    return this.writing;
  }
}

function parse(data: unknown): Entry[] | null {
  if (typeof data !== 'object' || data === null) return null;
  const { version, projects } = data as { version?: unknown; projects?: unknown };
  if (version !== 1 || !Array.isArray(projects)) return null;
  const entries: Entry[] = [];
  for (const project of projects as unknown[]) {
    if (typeof project !== 'object' || project === null) return null;
    const { path, openedAt } = project as { path?: unknown; openedAt?: unknown };
    if (typeof path !== 'string' || path === '' || typeof openedAt !== 'string') return null;
    if (!entries.some((entry) => entry.path === path)) entries.push({ path, openedAt });
  }
  return entries.slice(0, RECENT_LIMIT);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
