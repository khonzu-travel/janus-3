import { createHoldCapacity, createHttpAdapter } from '@janus/adapter-http';
import { createEngine, engineConfig, formatStartupReport } from '@janus/core';
import type { RunRecord, StepResult } from '@janus/runner';

import { LazyCaptureStore } from './captures.js';
import type { RunArgs } from './cli.js';
import { RequestStore } from './requests.js';
import { createRunnerHost } from './runner-host.js';
import { generateSeed } from './serve.js';
import { validateStartup } from './startup.js';

export interface CommandOutput {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * `janus run`: the same startup pass as `serve`, then one
 * run with no port bound. Mock mode answers from the fixture snapshot loaded
 * here; record mode writes captures. Exit codes: 0 when every
 * step passed, 1 when a step failed or the run was refused, 2 when the
 * configuration, fixtures or requests do not load.
 */
export async function runCommand(args: RunArgs, env: CommandOutput): Promise<number> {
  const report = await validateStartup(args, env.cwd);
  if (!report.ok || report.snapshot === null) {
    env.stderr(formatStartupReport(report.errors, report.warnings, { outcome: 'not running', notes: report.notes }));
    return 2;
  }
  const values = report.effective.values;
  const silent = { info: () => undefined, error: () => undefined };
  const engine = createEngine({
    snapshot: report.snapshot,
    transport: createHoldCapacity(values.faults.maxHeldConnections),
    clock: () => Date.now(),
    randomBytes: (count) => crypto.getRandomValues(new Uint8Array(count)),
    seedSource: values.dynamic.seed === null ? 'generated' : 'config',
    config: { ...engineConfig(report.effective), seed: values.dynamic.seed ?? generateSeed() },
  });
  const store = new RequestStore(
    report.requests.absolute,
    report.requestContext,
    { tree: report.requestTree, errors: [], warnings: [] },
    silent,
  );
  const captures = new LazyCaptureStore(report.capturesDirectory.absolute, {
    error: (event, fields) => {
      env.stderr(`janus: ${event}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}\n`);
    },
  });
  const host = createRunnerHost({
    store,
    context: report.requestContext,
    sandbox: report.sandbox,
    values,
    extraCaCerts: report.extraCaCerts,
    captures,
    engine,
    // No listener is opened, so the loopback rule does not apply.
    available: true,
    // Progress is printed from the run's events; errors, such as an upstream's error text, go to stderr.
    logger: {
      info: () => undefined,
      error: (event, fields) => {
        env.stderr(`janus: ${event}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}\n`);
      },
    },
  });
  const app = createHttpAdapter({ engine, host: values.server.host, resolve: false, limits: values.limits });
  host.attach(app);
  await app.ready();
  try {
    const scenarios = engine.atlas.scenarios();
    // --scenario fills in for requests without their own X-Mock-Scenario; without it Janus decides.
    const scenario = args.scenario ?? null;
    if (scenario !== null && !scenarios.items.some((item) => item.name === scenario)) {
      env.stderr(`janus: no scenario named "${scenario}" exists in the fixtures\n`);
      return 1;
    }
    const started = host.runner.start(
      {
        target: { kind: 'node', id: args.target },
        environment: args.environment ?? null,
        mode: args.mode,
        scenario,
        vars: args.vars,
      },
      store.tree,
    );
    if (!started.ok) {
      env.stderr(`janus: ${started.message}\n`);
      return 1;
    }
    if (args.reporter === 'text') {
      const printed = new Set<number>();
      const unsubscribe = host.service.subscribe((event) => {
        if (event.type !== 'run' || event.state !== 'step' || event.step === undefined) return;
        const step = host.runner.get(started.id)?.steps[event.step - 1];
        if (step !== undefined && !printed.has(step.step)) {
          printed.add(step.step);
          env.stdout(stepLine(step));
        }
      });
      const run = await started.done;
      unsubscribe();
      for (const step of run.steps) if (!printed.has(step.step)) env.stdout(stepLine(step));
      env.stdout(`${summaryLine(run)}\n`);
      return run.outcome === 'passed' ? 0 : 1;
    }
    const run = await started.done;
    env.stdout(args.reporter === 'json' ? `${JSON.stringify(run, null, 2)}\n` : junit(run));
    return run.outcome === 'passed' ? 0 : 1;
  } finally {
    await host.close();
    await app.close();
  }
}

/** `✓ 010-create-cart  POST https://…  201  84 ms  cart/000001`. */
export function stepLine(step: StepResult): string {
  const name = step.requestId.slice(step.requestId.lastIndexOf('/') + 1);
  if (step.outcome === 'not-run') return `- ${name.padEnd(22)} not run\n`;
  const mark = step.outcome === 'passed' ? '✓' : '✗';
  const parts = [`${mark} ${name.padEnd(22)}`];
  if (step.request !== undefined) parts.push(`${step.request.method.padEnd(6)} ${step.request.url}`);
  if (step.response !== undefined) parts.push(String(step.response.status), `${String(step.response.timeMs)} ms`);
  if (step.capture !== undefined) parts.push(step.capture);
  let line = `${parts.join('  ')}\n`;
  for (const test of step.tests) {
    line += `    ${test.passed ? '✓' : '✗'} ${test.name}${test.passed || test.message === undefined ? '' : `: ${test.message}`}\n`;
  }
  if (step.failure !== undefined) line += `    ${step.failure.code}: ${step.failure.message}\n`;
  return line;
}

export function summaryLine(run: RunRecord): string {
  const passed = run.steps.filter((step) => step.outcome === 'passed').length;
  const failed = run.steps.filter((step) => step.outcome === 'failed').length;
  const notRun = run.steps.filter((step) => step.outcome === 'not-run').length;
  const tests = run.steps.flatMap((step) => step.tests);
  const testsPassed = tests.filter((test) => test.passed).length;
  const captures = run.steps.filter((step) => step.capture !== undefined && step.response !== undefined).length;
  const parts = [`${String(passed)} ${passed === 1 ? 'step' : 'steps'} passed`];
  if (failed > 0) parts.push(`${String(failed)} failed`);
  if (notRun > 0) parts.push(`${String(notRun)} not run`);
  parts.push(`${String(testsPassed)} ${testsPassed === 1 ? 'test' : 'tests'} passed`);
  if (tests.length > testsPassed) parts.push(`${String(tests.length - testsPassed)} failed`);
  if (run.mode === 'record') parts.push(`${String(captures)} ${captures === 1 ? 'capture' : 'captures'} written`);
  if (run.outcome === 'cancelled') parts.push('cancelled');
  return parts.join(', ');
}

/** `--reporter junit`: one test case per step and one per test. */
export function junit(run: RunRecord): string {
  const cases: string[] = [];
  let failures = 0;
  let skipped = 0;
  for (const step of run.steps) {
    const time = ((step.response?.timeMs ?? 0) / 1000).toFixed(3);
    const head = `    <testcase classname="${xml(step.requestId)}" name="${xml(step.name)}" time="${time}"`;
    if (step.outcome === 'not-run') {
      skipped++;
      cases.push(`${head}>\n      <skipped/>\n    </testcase>`);
    } else if (step.outcome === 'failed' && step.failure !== undefined) {
      failures++;
      cases.push(
        `${head}>\n      <failure type="${xml(step.failure.code)}" message="${xml(step.failure.message)}"/>\n    </testcase>`,
      );
    } else {
      cases.push(`${head}/>`);
    }
    for (const test of step.tests) {
      const testHead = `    <testcase classname="${xml(step.requestId)}" name="${xml(test.name)}"`;
      if (test.passed) cases.push(`${testHead}/>`);
      else {
        failures++;
        cases.push(`${testHead}>\n      <failure message="${xml(test.message ?? 'failed')}"/>\n    </testcase>`);
      }
    }
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="janus run ${xml(run.target.id)}" tests="${String(cases.length)}" failures="${String(failures)}" skipped="${String(skipped)}">`,
    `  <testsuite name="${xml(run.target.id)}" tests="${String(cases.length)}" failures="${String(failures)}" skipped="${String(skipped)}" timestamp="${xml(run.startedAt)}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

function xml(text: string): string {
  return (
    text
      .replace(/[<>&"']/g, (char) => `&#${String(char.charCodeAt(0))};`)
      // eslint-disable-next-line no-control-regex -- XML 1.0 cannot hold these characters at all.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  );
}
