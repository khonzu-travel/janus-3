import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';

import { CHAI_SOURCE } from './chai-source.generated.js';
import { ScriptHost, scriptLine } from './host.js';
import { PRELUDE_SOURCE } from './prelude.js';
import type { ScriptFailure, ScriptInput, ScriptOutcome, ScriptSyntaxProblem } from './types.js';

/** The script sandbox. */
export interface Sandbox {
  /** Compiles without running; null when the script parses. */
  check(source: string): ScriptSyntaxProblem | null;
  /** Runs one script in a fresh context with its limits. Never rejects for script behaviour. */
  run(input: ScriptInput): Promise<ScriptOutcome>;
}

/**
 * QuickJS's own stack limits. Its frames run on the host's native stack too,
 * and some recursion (JSON.stringify, the parser) uses much more native stack
 * per byte QuickJS counts, so these are small: 32 KiB keeps parsing safe in
 * `check`, 64 KiB allows a few hundred nested calls in a script. A native
 * stack overflow that still happens is caught (see {@link ModulePool}).
 */
const RUN_STACK_BYTES = 64 * 1024;
const CHECK_STACK_BYTES = 32 * 1024;
/** Compiling needs memory but runs nothing; this bounds a pathological source. */
const CHECK_MEMORY_BYTES = 64 * 1024 * 1024;

const SCRIPT_FILE = 'script.js';
const UNFINISHED_TEST = 'the test did not finish';

/**
 * The QuickJS WebAssembly modules. A host exception out of QuickJS (in
 * practice the native stack running out inside deep recursion) leaves that
 * module's memory in an unknown state, so the module is dropped without
 * disposing anything in it and a spare takes its place; a new spare loads in
 * the background. `run` waits for a module; `check` is synchronous and uses
 * the current one.
 */
class ModulePool {
  #current: QuickJSWASMModule | null;
  #spare: QuickJSWASMModule | null;
  #loading: Promise<void> | null = null;

  private constructor(current: QuickJSWASMModule, spare: QuickJSWASMModule) {
    this.#current = current;
    this.#spare = spare;
  }

  static async create(): Promise<ModulePool> {
    const [current, spare] = await Promise.all([newQuickJSWASMModule(), newQuickJSWASMModule()]);
    return new ModulePool(current, spare);
  }

  current(): QuickJSWASMModule {
    if (this.#current === null) throw new Error('the script sandbox is restarting');
    return this.#current;
  }

  async ready(): Promise<QuickJSWASMModule> {
    while (this.#current === null) await this.#refill();
    return this.#current;
  }

  /** Drops a module whose state is unknown. */
  poison(module: QuickJSWASMModule): void {
    if (this.#current !== module) return;
    this.#current = this.#spare;
    this.#spare = null;
    this.#refill().catch(() => undefined);
  }

  #refill(): Promise<void> {
    this.#loading ??= newQuickJSWASMModule()
      .then((module) => {
        if (this.#current === null) this.#current = module;
        else this.#spare ??= module;
      })
      .finally(() => {
        this.#loading = null;
      });
    return this.#loading;
  }
}

/** Loads QuickJS once; each `run` then gets its own runtime and context. */
export async function createSandbox(): Promise<Sandbox> {
  const modules = await ModulePool.create();
  return {
    check(source) {
      const module = modules.current();
      try {
        return checkScript(module, source);
      } catch (error) {
        modules.poison(module);
        return { message: `the script could not be compiled: ${errorText(error)}`, line: 1, column: 1 };
      }
    },
    async run(input) {
      const module = await modules.ready();
      const host = new ScriptHost(input);
      let failure: ScriptFailure | null;
      try {
        const result = runScript(module, input, host);
        failure = result.failure;
        if (!result.reusable) modules.poison(module);
      } catch (error) {
        modules.poison(module);
        failure = {
          code: 'script-error',
          message: error instanceof RangeError ? 'stack overflow' : `the script engine failed: ${errorText(error)}`,
        };
      }
      const unsupported = host.unsupported;
      if (unsupported !== null) {
        const message = `${unsupported.name} is not supported in Janus scripts`;
        failure =
          unsupported.line === undefined
            ? { code: 'script-unsupported', message }
            : { code: 'script-unsupported', message, line: unsupported.line };
      }
      return { failure, tests: host.tests(UNFINISHED_TEST), console: host.console };
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Compiles the script in a fresh context without running it. */
function checkScript(module: QuickJSWASMModule, source: string): ScriptSyntaxProblem | null {
  const runtime = module.newRuntime();
  try {
    runtime.setMaxStackSize(CHECK_STACK_BYTES);
    const context = runtime.newContext();
    try {
      runtime.setMemoryLimit(CHECK_MEMORY_BYTES);
      const result = context.evalCode(source, SCRIPT_FILE, { type: 'global', compileOnly: true });
      if (result.error === undefined) {
        result.value.dispose();
        return null;
      }
      runtime.setMemoryLimit(-1);
      const error = dumpAndDispose(context, result.error);
      const position = syntaxPosition(error);
      return { message: describe(error), line: position.line, column: position.column };
    } finally {
      context.dispose();
    }
  } finally {
    runtime.dispose();
  }
}

function syntaxPosition(error: unknown): { line: number; column: number } {
  const stack = isRecord(error) ? error['stack'] : undefined;
  const match = typeof stack === 'string' ? /\bscript\.js:(\d+)(?::(\d+))?/.exec(stack) : null;
  if (match?.[1] !== undefined) return { line: Number(match[1]), column: Number(match[2] ?? 1) };
  const lineNumber = isRecord(error) ? error['lineNumber'] : undefined;
  return { line: typeof lineNumber === 'number' ? lineNumber : 1, column: 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function dumpAndDispose(context: QuickJSContext, handle: QuickJSHandle): unknown {
  try {
    return context.dump(handle) as unknown;
  } finally {
    handle.dispose();
  }
}

/** An error's text: its message, prefixed with its name unless it is a plain `Error`. */
function describe(error: unknown): string {
  if (isRecord(error) && typeof error['message'] === 'string') {
    const name = typeof error['name'] === 'string' ? error['name'] : 'Error';
    return name === 'Error' ? error['message'] : `${name}: ${error['message']}`;
  }
  if (typeof error === 'string') return error;
  try {
    // undefined, a function or a symbol has no JSON text.
    const json = JSON.stringify(error) as string | undefined;
    return json ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Runs the prelude and the script in a fresh runtime, then the pending jobs
 * (promise-returning tests) until none remain or the time is
 * up. Throws only when QuickJS itself fails; the caller drops the module then.
 *
 * A runtime stopped by its time or memory limit is not disposed and its
 * module is not reused (`reusable: false`): QuickJS can leak objects when it
 * is interrupted inside a promise job, and freeing such a runtime aborts the
 * whole WebAssembly module. Dropping the module frees everything in it.
 */
function runScript(
  module: QuickJSWASMModule,
  input: ScriptInput,
  host: ScriptHost,
): { failure: ScriptFailure | null; reusable: boolean } {
  const deadline = Date.now() + input.limits.timeoutMs;
  const runtime = module.newRuntime();
  runtime.setMaxStackSize(RUN_STACK_BYTES);
  runtime.setModuleLoader(() => {
    host.recordUnsupported('import()');
    return { error: new Error('import() is not supported in Janus scripts') };
  });
  const context = runtime.newContext();
  runtime.setMemoryLimit(input.limits.memoryBytes);
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const failure = execute(runtime, context, input, host, deadline);
  if (failure?.code === 'script-timeout' || failure?.code === 'script-memory') return { failure, reusable: false };
  context.dispose();
  runtime.dispose();
  return { failure, reusable: true };
}

function execute(
  runtime: QuickJSRuntime,
  context: QuickJSContext,
  input: ScriptInput,
  host: ScriptHost,
  deadline: number,
): ScriptFailure | null {
  const fail = (error: QuickJSHandle): ScriptFailure => {
    // Lift the limits so the error can be read.
    runtime.removeInterruptHandler();
    runtime.setMemoryLimit(-1);
    return classify(dumpAndDispose(context, error), input);
  };

  const prelude = context.evalCode(PRELUDE_SOURCE, 'prelude.js', { type: 'global' });
  if (prelude.error !== undefined) return fail(prelude.error);
  const hostCall = context.newFunction('hostCall', (op, args) => {
    let reply: string;
    try {
      const value = host.call(context.getString(op), JSON.parse(context.getString(args)) as unknown[]);
      reply = JSON.stringify(value === undefined ? {} : { v: value });
    } catch (error) {
      reply = JSON.stringify({ e: errorText(error) });
    }
    return context.newString(reply);
  });
  const loadChai = context.newFunction('loadChai', () => context.evalCode(CHAI_SOURCE, 'chai.js', { type: 'global' }));
  const phase = context.newString(input.phase);
  const installed = context.callFunction(prelude.value, context.undefined, hostCall, loadChai, phase);
  for (const handle of [prelude.value, hostCall, loadChai, phase]) handle.dispose();
  if (installed.error !== undefined) return fail(installed.error);
  installed.value.dispose();

  const result = context.evalCode(input.source, SCRIPT_FILE, { type: 'global' });
  if (result.error !== undefined) return fail(result.error);
  result.value.dispose();

  while (runtime.hasPendingJob()) {
    if (Date.now() > deadline) return { code: 'script-timeout', message: timeoutMessage(input) };
    const jobs = runtime.executePendingJobs();
    if (jobs.error !== undefined) return fail(jobs.error);
  }
  // QuickJS drops a job's interrupt instead of reporting it, so a deadline passed here means one was stopped.
  if (Date.now() > deadline) return { code: 'script-timeout', message: timeoutMessage(input) };
  return null;
}

function timeoutMessage(input: ScriptInput): string {
  return `the script ran longer than ${String(input.limits.timeoutMs)} ms`;
}

/** Maps what the script threw to a failure. */
function classify(error: unknown, input: ScriptInput): ScriptFailure {
  if (isRecord(error) && error['name'] === 'InternalError') {
    if (error['message'] === 'interrupted') return { code: 'script-timeout', message: timeoutMessage(input) };
    if (error['message'] === 'out of memory') {
      return { code: 'script-memory', message: `the script used more than ${String(input.limits.memoryBytes)} bytes` };
    }
  }
  const line = isRecord(error) ? (scriptLine(error['stack']) ?? syntaxLine(error)) : undefined;
  const message = describe(error);
  return line === undefined ? { code: 'script-error', message } : { code: 'script-error', message, line };
}

/** A SyntaxError raised while compiling the script carries its line as `lineNumber`. */
function syntaxLine(error: Record<string, unknown>): number | undefined {
  return error['fileName'] === SCRIPT_FILE && typeof error['lineNumber'] === 'number' ? error['lineNumber'] : undefined;
}
