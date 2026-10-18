import { compareStrings } from '../canonical.js';
import type { StartupError, StartupSource, StartupWarning } from '../types/index.js';

/** Either kind of startup problem; they share location fields and ordering. */
export type StartupProblem = StartupError | StartupWarning;

const SOURCE_ORDER: Readonly<Record<StartupSource, number>> = { cli: 0, config: 1, fixtures: 2, requests: 3, ui: 4 };

/**
 * Orders problems by source (`cli`, `config`, `fixtures`), then path, line,
 * column and code. Remaining fields break ties, so the same
 * problems always sort the same way whatever order they were found in.
 */
export function compareStartupProblems(a: StartupProblem, b: StartupProblem): number {
  return (
    SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
    compareStrings(a.path, b.path) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    compareStrings(a.code, b.code) ||
    compareStrings(a.message, b.message) ||
    compareStrings(field(a, 'key'), field(b, 'key')) ||
    compareStrings(field(a, 'token'), field(b, 'token'))
  );
}

function field(problem: StartupProblem, name: 'key' | 'token'): string {
  return name in problem ? ((problem as StartupError)[name] ?? '') : '';
}

/** A sorted, frozen copy. */
export function sortStartupProblems<T extends StartupProblem>(problems: readonly T[]): readonly T[] {
  return Object.freeze([...problems].sort(compareStartupProblems));
}

export interface StartupReportOptions {
  /**
   * The fixture root as the user gave it (e.g. "data"). Fixture paths print as
   * `<fixturesRoot>/<path>`, and a problem with the root itself as `<fixturesRoot>`.
   * Without it, fixture paths print source-relative, with "." for the root.
   */
  readonly fixturesRoot?: string;
  /** Ends the summary line, e.g. "not starting". */
  readonly outcome: string;
  /** Extra lines printed after the problems, e.g. why a step was skipped. */
  readonly notes?: readonly string[];
}

/** Where a problem is, for people: the display path plus `:line:column` when known. */
export function formatStartupLocation(problem: StartupProblem, fixturesRoot?: string): string {
  let location = formatStartupPath(problem, fixturesRoot);
  if (problem.line !== undefined) {
    location += `:${String(problem.line)}`;
    if (problem.column !== undefined) location += `:${String(problem.column)}`;
  }
  return location;
}

/** `<path>[:<line>[:<column>]]: <message> [<code>]`. */
export function formatStartupProblem(problem: StartupProblem, fixturesRoot?: string): string {
  return `${formatStartupLocation(problem, fixturesRoot)}: ${problem.message} [${problem.code}]`;
}

/**
 * The complete text report shared by `janus serve`, `janus validate` and tests:
 * a summary line with the counts, one line per error, then one per warning.
 */
export function formatStartupReport(
  errors: readonly StartupError[],
  warnings: readonly StartupWarning[],
  options: StartupReportOptions,
): string {
  const counts = [plural(errors.length, 'startup error')];
  if (warnings.length > 0) counts.push(plural(warnings.length, 'warning'));
  const lines = [`janus: ${counts.join(' and ')}; ${options.outcome}.`];
  for (const error of sortStartupProblems(errors)) lines.push(`  ${formatStartupProblem(error, options.fixturesRoot)}`);
  for (const warning of sortStartupProblems(warnings)) {
    lines.push(`  warning: ${formatStartupProblem(warning, options.fixturesRoot)}`);
  }
  for (const note of options.notes ?? []) lines.push(`  note: ${note}`);
  return `${lines.join('\n')}\n`;
}

/** The problem's path for people: fixture paths under the displayed root, others as they are. */
export function formatStartupPath(problem: StartupProblem, fixturesRoot?: string): string {
  if (problem.source !== 'fixtures') return problem.path;
  if (fixturesRoot === undefined || fixturesRoot === '.') return problem.path === '' ? '.' : problem.path;
  return problem.path === '' ? fixturesRoot : `${fixturesRoot}/${problem.path}`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}
