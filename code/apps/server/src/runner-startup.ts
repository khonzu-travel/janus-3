import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { requestTokenGrammar, type StartupError, type StartupWarning } from '@janus/core';
import { createSandbox, EMPTY_TREE, type RequestTree, type Sandbox, type ValidationContext } from '@janus/runner';

import type { LocatedPath, LoadedConfig } from './config.js';
import { checkCaptures, canonical, contains } from './recording.js';
import { loadRequestTree } from './requests.js';

export interface RunnerStartup {
  readonly tree: RequestTree;
  readonly context: ValidationContext;
  readonly sandbox: Sandbox;
  readonly extraCaCerts: readonly string[];
  readonly available: boolean;
  readonly errors: readonly StartupError[];
  readonly warnings: readonly StartupWarning[];
}

/**
 * The runner's startup checks: the request tree
 * and its problems, `requests-overlap`, `runner-invalid-ca`,
 * `runner-exposed` and `tls-verification-off`. A project with no requests folder has an empty tree and
 * no problems.
 *
 * `captures` is set when recording did not already check the captures
 * directory against the fixture root: the runner writes captures too.
 */
export async function checkRunner(
  loaded: LoadedConfig,
  captures: LocatedPath | null,
  loopback: boolean,
  hostSource: string | undefined,
): Promise<RunnerStartup> {
  const errors: StartupError[] = [];
  const warnings: StartupWarning[] = [];
  const { values, settings } = loaded.effective;
  const where = (key: string, flag?: string): { source: 'cli' | 'config'; path: string } => {
    const setting = settings.find((entry) => entry.key === key);
    return setting?.source === 'cli' && flag !== undefined
      ? { source: 'cli', path: flag }
      : { source: 'config', path: loaded.file?.display ?? '' };
  };

  const sandbox = await createSandbox();
  const context: ValidationContext = {
    grammar: requestTokenGrammar(values.dynamic.aliases),
    checkScript: (source) => sandbox.check(source),
  };

  // Compared on canonical real paths.
  const root = await canonical(loaded.requests.absolute);
  const others = [
    ...(loaded.fixturesRoot === null ? [] : [{ path: loaded.fixturesRoot, name: 'the fixture root' }]),
    { path: loaded.captures, name: 'the captures directory' },
  ];
  let overlaps = false;
  for (const other of others) {
    const path = await canonical(other.path.absolute);
    if (root === null || path === null) continue;
    if (root === path || contains(root, path) || contains(path, root)) {
      overlaps = true;
      errors.push({
        code: 'requests-overlap',
        ...where('runner.root', '--requests'),
        key: 'runner.root',
        message: `the requests root "${loaded.requests.display}" and ${other.name} "${other.path.display}" overlap; keep them apart`,
      });
    }
  }

  const load = overlaps ? null : await loadRequestTree(loaded.requests.absolute, context);
  if (load !== null) {
    errors.push(...load.errors);
    warnings.push(...load.warnings);
  }

  const extraCaCerts: string[] = [];
  for (const file of loaded.extraCaCerts) {
    const text = await readFile(file.absolute, 'utf8').catch(() => null);
    const blocks = text?.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    const valid =
      blocks.length > 0 &&
      blocks.every((block) => {
        try {
          new X509Certificate(block);
          return true;
        } catch {
          return false;
        }
      });
    if (!valid || text === null) {
      errors.push({
        code: 'runner-invalid-ca',
        ...where('runner.extraCaCerts'),
        key: 'runner.extraCaCerts',
        message: `"${file.display}" ${text === null ? 'cannot be read' : 'does not hold PEM certificates'}`,
      });
      continue;
    }
    extraCaCerts.push(...blocks);
  }

  if (values.runner.skipTlsVerify) {
    warnings.push({
      code: 'tls-verification-off',
      ...where('runner.skipTlsVerify'),
      message:
        'runner.skipTlsVerify is on: runner and recording requests accept any upstream certificate, so use it only with dev, test or staging backends',
    });
  }

  const available = loopback || values.runner.allowNonLoopback;
  if (!loopback && values.runner.allowNonLoopback) {
    warnings.push({
      code: 'runner-exposed',
      ...(hostSource === 'cli'
        ? { source: 'cli' as const, path: '--host' }
        : { source: 'config' as const, path: loaded.file?.display ?? '' }),
      message:
        'the request runner is enabled on a non-loopback address: any client that can reach the port can make Janus send requests anywhere it can reach',
    });
  }
  // Runner captures need the same separation from the fixtures as recorded ones.
  if (available && captures !== null) {
    errors.push(
      ...(await checkCaptures(captures, loaded.fixturesRoot, where('recording.captures', '--captures'), false)),
    );
  }

  return { tree: load?.tree ?? EMPTY_TREE, context, sandbox, extraCaCerts, available, errors, warnings };
}
