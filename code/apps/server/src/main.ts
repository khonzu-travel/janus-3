import {
  formatStartupPath,
  formatStartupProblem,
  formatStartupReport,
  unreviewedPromotions,
  type StartupError,
  type StartupWarning,
} from '@janus/core';

import { parseCommand, USAGE, type ServeArgs, type ValidateArgs } from './cli.js';
import { importCommand } from './import-command.js';
import { launchWith } from './launch.js';
import { runCommand } from './run-command.js';
import { validateStartup, type StartupReport } from './startup.js';
import { createTextLogger } from './text-logger.js';

export type Signal = 'SIGINT' | 'SIGTERM';

/** Everything `main` needs from its process, injected so it can run in tests. */
export interface CliEnvironment {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Subscribes to termination signals; returns an unsubscribe function. */
  readonly onSignal: (handler: (signal: Signal) => void) => () => void;
  readonly shutdownTimeoutMs?: number;
  /** The built UI's directory; defaults to `@janus/ui/dist`. Null means there is no build. */
  readonly uiRoot?: string | null;
}

/**
 * Runs the `janus` CLI and resolves to the process exit code. For `serve`, it
 * resolves after a signal-triggered graceful shutdown.
 */
export async function main(argv: readonly string[], env: CliEnvironment): Promise<number> {
  const parsed = parseCommand(argv);
  if (parsed.kind === 'help') {
    env.stdout(USAGE);
    return 0;
  }
  if (parsed.kind === 'usage-error') {
    if (parsed.format === 'json') {
      env.stdout(jsonReport(false, null, null, parsed.error === undefined ? [] : [parsed.error], [], undefined));
    } else {
      const detail = parsed.error === undefined ? parsed.message : formatStartupProblem(parsed.error);
      env.stderr(`janus: ${detail}\n\n${USAGE}`);
    }
    return 2;
  }
  if (parsed.kind === 'validate') return validate(parsed.args, env);
  if (parsed.kind === 'run') return runCommand(parsed.args, env);
  if (parsed.kind === 'import') return importCommand(parsed.args, env);
  return serve(parsed.args, env);
}

/** `janus validate`: the full startup pass, then a report. Never binds a port. */
async function validate(args: ValidateArgs, env: CliEnvironment): Promise<number> {
  const checked = await validateStartup(args, env.cwd);
  // Pending promotions become errors instead of the promotions-pending warning.
  const unreviewed = args.requireReviewed && checked.snapshot !== null ? unreviewedPromotions(checked.snapshot) : [];
  const report: StartupReport = args.requireReviewed
    ? {
        ...checked,
        ok: checked.ok && unreviewed.length === 0,
        errors: [...checked.errors, ...unreviewed],
        warnings: checked.warnings.filter((warning) => warning.code !== 'promotions-pending'),
      }
    : checked;
  const failedStrict = args.strict && report.warnings.length > 0;
  const valid = report.ok && !failedStrict;
  const root = report.fixturesRoot?.display;

  if (args.format === 'json') {
    env.stdout(
      jsonReport(
        valid,
        // --strict changes the verdict for warnings, but the configuration
        // and fixture snapshot still validated successfully. Preserve their
        // identities so CI can record exactly what it checked.
        report.ok ? report.configDigest : null,
        report.ok ? (report.snapshot?.version ?? null) : null,
        report.errors,
        report.warnings,
        root,
      ),
    );
    return valid ? 0 : 1;
  }

  if (valid) {
    const outcome = `valid (config ${report.configDigest ?? ''}, snapshot ${report.snapshot?.version ?? ''})`;
    env.stdout(formatStartupReport([], report.warnings, { outcome, ...displayRoot(root) }));
    return 0;
  }
  const outcome = report.ok ? 'invalid under --strict' : 'invalid';
  env.stderr(
    formatStartupReport(report.errors, report.warnings, { outcome, notes: report.notes, ...displayRoot(root) }),
  );
  return 1;
}

async function serve(args: ServeArgs, env: CliEnvironment): Promise<number> {
  let fixturesRoot: string | undefined;
  const logger = createTextLogger(env.stdout, env.stderr, () => fixturesRoot);
  const result = await launchWith(
    args,
    {
      cwd: env.cwd,
      logger,
      ...(env.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: env.shutdownTimeoutMs }),
      ...(env.uiRoot === undefined ? {} : { uiRoot: env.uiRoot }),
    },
    {
      validated: (root) => {
        fixturesRoot = root;
      },
      warnings: (warnings) => {
        for (const warning of warnings) env.stderr(`janus: warning: ${formatStartupProblem(warning, fixturesRoot)}\n`);
      },
      bound: (summary) => {
        for (const line of summary) env.stdout(`${line}\n`);
      },
    },
  );
  if (result.kind === 'invalid') {
    env.stderr(
      formatStartupReport(result.errors, result.warnings, {
        outcome: 'not starting',
        notes: result.notes,
        ...displayRoot(fixturesRoot),
      }),
    );
    return 1;
  }
  // `launch` has already logged `startup-failed`.
  if (result.kind === 'bind-failed') return 1;

  const { server } = result;
  await new Promise<void>((done) => {
    let stopping = false;
    const unsubscribe = env.onSignal((signal) => {
      if (stopping) {
        logger.info('shutdown-in-progress', { signal });
        return;
      }
      stopping = true;
      logger.info('shutdown-started', { signal });
      server
        .close()
        .catch((error: unknown) => {
          logger.error('shutdown-error', { message: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          unsubscribe();
          logger.info('shutdown-complete');
          done();
        });
    });
  });
  return 0;
}

function displayRoot(root: string | undefined): { fixturesRoot?: string } {
  return root === undefined ? {} : { fixturesRoot: root };
}

/** The `validate --format json` document. Paths are shown as in the text report. */
function jsonReport(
  valid: boolean,
  digest: string | null,
  snapshotVersion: string | null,
  errors: readonly StartupError[],
  warnings: readonly StartupWarning[],
  fixturesRoot: string | undefined,
): string {
  const problem = (entry: StartupError | StartupWarning) => {
    // Warnings carry no key or token.
    const { key, token } = entry as Partial<StartupError>;
    return {
      code: entry.code,
      source: entry.source,
      path: formatStartupPath(entry, fixturesRoot),
      ...(entry.line === undefined ? {} : { line: entry.line }),
      ...(entry.column === undefined ? {} : { column: entry.column }),
      ...(key === undefined ? {} : { key }),
      ...(token === undefined ? {} : { token }),
      message: entry.message,
    };
  };
  const document = {
    valid,
    configDigest: digest,
    snapshotVersion,
    errors: errors.map(problem),
    warnings: warnings.map(problem),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
