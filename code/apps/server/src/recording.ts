import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { StartupError, StartupWarning } from '@janus/core';

import type { LocatedPath } from './config.js';

/** Where a recording problem is reported: the flag or the configuration file. */
export interface ProblemSource {
  readonly source: 'cli' | 'config';
  readonly path: string;
}

/**
 * The startup checks of the captures directory. `validate`
 * never creates it and compares the canonical identity of each existing
 * ancestor; `serve` creates it, checks it can be written, and compares both
 * final real paths before the port is bound.
 */
export async function checkCaptures(
  captures: LocatedPath,
  fixturesRoot: LocatedPath | null,
  where: ProblemSource,
  create: boolean,
): Promise<StartupError[]> {
  const errors: StartupError[] = [];
  const problem = (code: StartupError['code'], message: string): void => {
    errors.push({ code, ...where, key: 'recording.captures', message });
  };
  if (create) {
    try {
      await mkdir(captures.absolute, { recursive: true });
      const info = await lstat(captures.absolute);
      if (!info.isDirectory()) throw new Error('not a directory');
      await access(captures.absolute, constants.W_OK);
    } catch {
      problem(
        'captures-not-writable',
        `the captures directory "${captures.display}" cannot be created or written; recording needs it`,
      );
      return errors;
    }
  }
  if (fixturesRoot === null) return errors;
  const a = await canonical(captures.absolute);
  const b = await canonical(fixturesRoot.absolute);
  if (a === null || b === null) return errors;
  if (a === b || contains(a, b) || contains(b, a)) {
    problem(
      'captures-inside-fixtures',
      `the captures directory "${captures.display}" and the fixture root "${fixturesRoot.display}" overlap; captures must never be served, so keep them apart`,
    );
  }
  return errors;
}

/** `recording-non-loopback` and `recording-exposed`. */
export function checkExposure(
  host: string,
  loopback: boolean,
  allowNonLoopback: boolean,
  where: ProblemSource,
): { readonly errors: StartupError[]; readonly warnings: StartupWarning[] } {
  if (loopback) return { errors: [], warnings: [] };
  if (!allowNonLoopback) {
    return {
      errors: [
        {
          code: 'recording-non-loopback',
          ...where,
          key: 'recording.allowNonLoopback',
          message: `recording is configured but Janus binds to the non-loopback address "${host}"; set recording.allowNonLoopback: true to allow it`,
        },
      ],
      warnings: [],
    };
  }
  return {
    errors: [],
    warnings: [
      {
        code: 'recording-exposed',
        ...where,
        message:
          'recording is enabled on a non-loopback address: any client that can reach the port can call every registered upstream and read the captures',
      },
    ],
  };
}

/**
 * The real path of `path`, or of its deepest existing ancestor with the
 * missing components appended. Symbolic links in the existing part resolve,
 * so an alias through a link compares equal.
 */
export async function canonical(path: string): Promise<string | null> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** True when `inner` lies strictly inside `outer`, compared by path components. */
export function contains(outer: string, inner: string): boolean {
  const between = relative(outer, inner);
  return between !== '' && between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between);
}
