import { formatStartupReport } from '@janus/core';

import type { ServeLogger } from './serve.js';

/**
 * The logger behind `janus serve`'s output: one `janus <event> key=value` line
 * per event, info to `stdout` and errors to `stderr`. The desktop app's server
 * host uses it too, so its log reads exactly like the terminal.
 */
export function createTextLogger(
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  fixturesRoot: () => string | undefined = () => undefined,
): ServeLogger {
  const format = (event: string, fields: Readonly<Record<string, string | number>> = {}): string => {
    const parts = Object.entries(fields).map(([key, value]) => `${key}=${formatValue(value)}`);
    return `janus ${event}${parts.length > 0 ? ' ' + parts.join(' ') : ''}\n`;
  };
  return {
    info: (event, fields) => {
      stdout(format(event, fields));
    },
    error: (event, fields) => {
      stderr(format(event, fields));
    },
    problems: (errors, warnings) => {
      const root = fixturesRoot();
      const report = formatStartupReport(errors, warnings, {
        outcome: 'keeping the current snapshot',
        ...(root === undefined ? {} : { fixturesRoot: root }),
      });
      stderr(report.replace(/^janus: /, 'janus: reload: '));
    },
  };
}

function formatValue(value: string | number): string {
  if (typeof value === 'number') return String(value);
  return /^[\w./:@[\]-]+$/.test(value) ? value : JSON.stringify(value);
}
