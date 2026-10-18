import { relative } from 'node:path';

import { formatStartupProblem, type StartupError } from '@janus/server';

import type { ProblemView } from '../shared/bridge.js';
import type { PathsData, ProblemData } from '../shared/messages.js';

/** The fixture root as the CLI shows it: relative to the project folder. */
export function displayRoot(paths: PathsData): string | undefined {
  return paths.fixturesRoot === null ? undefined : relative(paths.cwd, paths.fixturesRoot) || '.';
}

/** A problem for the status page, worded as the CLI words it. */
export function problemView(
  problem: ProblemData,
  severity: 'error' | 'warning',
  paths: PathsData,
  canOpen: boolean,
): ProblemView {
  // Problems arrive validated; the formatter reads only the fields checked there.
  const text = formatStartupProblem(problem as StartupError, displayRoot(paths));
  const suffix = `: ${problem.message} [${problem.code}]`;
  return {
    severity,
    code: problem.code,
    location: text.endsWith(suffix) ? text.slice(0, -suffix.length) : problem.path,
    message: problem.message,
    ...(problem.token === undefined ? {} : { token: problem.token }),
    canOpen,
  };
}
