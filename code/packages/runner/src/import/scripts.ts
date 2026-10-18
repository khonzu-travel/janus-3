import type { Note } from './template.js';
import type { CheckScript } from './types.js';

/**
 * Imported scripts are reviewed, never run: each use of a
 * refused call is noted, and the script is compiled through the
 * caller's `checkScript` so a syntax problem is noted too.
 */

const UNSUPPORTED: readonly (readonly [string, RegExp])[] = [
  ['pm.sendRequest', /\bpm\s*\.\s*sendRequest\b/],
  ['bru.sendRequest', /\bbru\s*\.\s*sendRequest\b/],
  ['bru.runRequest', /\bbru\s*\.\s*runRequest\b/],
  ['postman.setNextRequest', /\bpostman\s*\.\s*setNextRequest\b/],
  ['pm.execution.setNextRequest', /\bpm\s*\.\s*execution\s*\.\s*setNextRequest\b/],
  ['bru.setNextRequest', /\bbru\s*\.\s*setNextRequest\b/],
  ['pm.visualizer', /\bpm\s*\.\s*visualizer\b/],
  ['pm.cookies.jar', /\bpm\s*\.\s*cookies\s*\.\s*jar\b/],
  ['require', /(?<![.\w$])require\s*\(/],
  ['dynamic import', /(?<![.\w$])import\s*\(/],
];

/** The refused calls a script uses, in table order. */
export function unsupportedCalls(script: string): string[] {
  return UNSUPPORTED.filter(([, pattern]) => pattern.test(script)).map(([call]) => call);
}

/** Notes every unsupported call and any syntax problem of one script. */
export function reviewScript(label: string, script: string, note: Note, checkScript: CheckScript | undefined): void {
  const calls = unsupportedCalls(script);
  if (calls.length > 0) {
    note(
      `the ${label} script uses ${calls.join(', ')}, which Janus scripts cannot call (the step fails script-unsupported)`,
    );
  }
  const problem = checkScript?.(script) ?? null;
  if (problem !== null) {
    note(
      `the ${label} script does not compile: ${problem.message} (line ${String(problem.line)}, column ${String(problem.column)})`,
    );
  }
}

/** Joins script parts with blank lines, dropping empty ones; undefined when nothing is left. */
export function joinScripts(...parts: readonly (string | undefined)[]): string | undefined {
  const kept = parts.map((part) => part?.trim() ?? '').filter((part) => part !== '');
  return kept.length === 0 ? undefined : kept.join('\n\n');
}
