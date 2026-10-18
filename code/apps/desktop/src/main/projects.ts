import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** The file and directory that make a folder a project. */
export const CONFIG_FILE = 'janus.config.yaml';
export const DATA_DIRECTORY = 'data';

export interface Project {
  /** The real path, symbolic links resolved. */
  readonly path: string;
  /** The folder's name. */
  readonly name: string;
  /** The first 16 hex digits of the SHA-256 of the real path. */
  readonly id: string;
}

export type Detection =
  | { readonly kind: 'project'; readonly project: Project }
  /** A readable folder with neither file: the app offers to create a project there. */
  | { readonly kind: 'not-project'; readonly path: string }
  | { readonly kind: 'missing'; readonly path: string }
  | { readonly kind: 'unreadable'; readonly path: string; readonly reason: string };

export function projectId(realPath: string): string {
  return createHash('sha256').update(realPath).digest('hex').slice(0, 16);
}

export function projectAt(realPath: string): Project {
  return { path: realPath, name: basename(realPath) || realPath, id: projectId(realPath) };
}

/** Decides whether a folder is a project: it holds `janus.config.yaml`, a `data` directory, or both. */
export async function detectProject(folder: string): Promise<Detection> {
  let real: string;
  try {
    real = await realpath(folder);
  } catch (error) {
    return code(error) === 'ENOENT' ? { kind: 'missing', path: folder } : unreadable(folder, error);
  }
  try {
    if (!(await stat(real)).isDirectory()) return { kind: 'unreadable', path: real, reason: 'not a folder' };
    await readdir(real);
  } catch (error) {
    return unreadable(real, error);
  }
  const config = await entry(join(real, CONFIG_FILE));
  const data = await entry(join(real, DATA_DIRECTORY));
  if (config instanceof Error) return unreadable(real, config);
  if (data instanceof Error) return unreadable(real, data);
  if (config === 'file' || data === 'directory') return { kind: 'project', project: projectAt(real) };
  return { kind: 'not-project', path: real };
}

async function entry(path: string): Promise<'file' | 'directory' | 'other' | null | Error> {
  try {
    const stats = await stat(path);
    return stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') return null;
    return error instanceof Error ? error : new Error(String(error));
  }
}

function unreadable(path: string, error: unknown): Detection {
  return { kind: 'unreadable', path, reason: code(error) ?? (error instanceof Error ? error.message : String(error)) };
}

function code(error: unknown): string | undefined {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === 'string' ? value : undefined;
}

/**
 * The project to reopen on a launch with no folder argument:
 * the most recent one, or null when there is none or its folder is no longer
 * a project, so the start page shows instead.
 */
export async function lastProject(recent: readonly string[]): Promise<Project | null> {
  const last = recent[0];
  if (last === undefined) return null;
  const detected = await detectProject(last);
  return detected.kind === 'project' ? detected.project : null;
}
