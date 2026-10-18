import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { PathsData, ProblemData } from '../shared/messages.js';

/** The file a problem names, absolute, before containment is checked. Null when it names none. */
export function problemFile(problem: ProblemData, paths: PathsData): string | null {
  if (problem.source === 'fixtures') {
    return paths.fixturesRoot === null ? null : join(paths.fixturesRoot, ...problem.path.split('/').filter(Boolean));
  }
  if (problem.source === 'config') return paths.configFile;
  return null;
}

/**
 * The file Open File may open for a problem: its real path must
 * be inside the project folder, the configured fixture root or the captures
 * directory. Null otherwise, and then the button is not shown.
 */
export async function openableFile(problem: ProblemData, paths: PathsData): Promise<string | null> {
  const file = problemFile(problem, paths);
  if (file === null) return null;
  const real = await safeRealpath(file);
  if (real === null) return null;
  const roots = await Promise.all(
    [paths.cwd, paths.fixturesRoot, paths.captures].map((root) =>
      root === null ? Promise.resolve(null) : safeRealpath(root),
    ),
  );
  return roots.some((root) => root !== null && isInside(real, root)) ? real : null;
}

export function isInside(path: string, root: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`));
}

async function safeRealpath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}
