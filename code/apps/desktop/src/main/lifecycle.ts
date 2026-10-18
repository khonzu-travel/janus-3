import type { LogLine } from '../shared/bridge.js';
import { isServerToMain, type MainToServer, type ResultData, type StartArgs } from '../shared/messages.js';

/** How long a server may take to stop: the default shutdown bound plus 2 seconds. */
export const STOP_GRACE_MS = 5000 + 2000;

/** One server process, as the lifecycle sees it. */
export interface ServerProcess {
  readonly pid?: number | undefined;
  postMessage(message: MainToServer): void;
  kill(): void;
}

export interface ProcessEvents {
  message(data: unknown): void;
  exit(code: number): void;
}

/** Starts a server process in `cwd` (an Electron utility process in the app, a fake in tests). */
export type SpawnServer = (cwd: string, events: ProcessEvents) => ServerProcess;

type Started = Extract<ResultData, { kind: 'started' }>;
type Invalid = Extract<ResultData, { kind: 'invalid' }>;
type BindFailed = Extract<ResultData, { kind: 'bind-failed' }>;

/** A project's server, from the main process's side. */
export type Phase =
  | { readonly kind: 'starting' }
  | { readonly kind: 'running'; readonly result: Started }
  | { readonly kind: 'invalid'; readonly result: Invalid }
  | { readonly kind: 'bind-failed'; readonly result: BindFailed }
  | { readonly kind: 'stopping' }
  | { readonly kind: 'stopped' }
  /** The process ended without being asked. */
  | { readonly kind: 'exited'; readonly code: number };

export interface LifecycleHooks {
  change(phase: Phase): void;
  log(line: LogLine): void;
  /** A message that failed validation; it is ignored. */
  ignored(data: unknown): void;
  /** A new process is starting, so its log run begins. */
  run?(): void;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

interface Running {
  readonly process: ServerProcess;
  readonly exited: Promise<void>;
  stopRequested: boolean;
  /** Set once the process reported `invalid` or `bind-failed` and will exit by itself. */
  ending: boolean;
}

/**
 * Starts, stops and watches one project's server processes. One process serves
 * one start: restarting stops it and starts a new one. Never restarts a server
 * by itself.
 */
export class ServerLifecycle {
  private current: Running | null = null;
  private state: Phase = { kind: 'stopped' };
  /** A newer start or stop cancels any start waiting for an old process to exit. */
  private revision = 0;

  constructor(
    private readonly cwd: string,
    private readonly spawn: SpawnServer,
    private readonly hooks: LifecycleHooks,
    private readonly graceMs: number = STOP_GRACE_MS,
    private readonly timers: Timers = realTimers,
  ) {}

  get phase(): Phase {
    return this.state;
  }

  /** The current process's id, if any. */
  get pid(): number | undefined {
    return this.current?.process.pid;
  }

  /** True while a process exists, whatever it is doing. */
  get alive(): boolean {
    return this.current !== null;
  }

  /** Stops the current process, if any, then starts a new one with `args`. */
  async start(args: StartArgs): Promise<void> {
    const revision = ++this.revision;
    if (this.current !== null) await this.stopCurrent();
    if (revision !== this.revision) return;
    this.hooks.run?.();
    this.set({ kind: 'starting' });
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((done) => {
      markExited = done;
    });
    let running: Running | null = null;
    const process = this.spawn(this.cwd, {
      message: (data) => {
        if (running !== null && this.current === running) this.receive(running, data);
      },
      exit: (code) => {
        markExited();
        if (running !== null && this.current === running) this.exit(running, code);
      },
    });
    running = { process, exited, stopRequested: false, ending: false };
    this.current = running;
    process.postMessage({ type: 'start', args });
  }

  /**
   * Asks the process to stop and resolves once it has ended. A process still
   * running after the grace period is terminated.
   */
  async stop(): Promise<void> {
    ++this.revision;
    await this.stopCurrent();
  }

  private async stopCurrent(): Promise<void> {
    const running = this.current;
    if (running === null) return;
    if (!running.stopRequested) {
      running.stopRequested = true;
      if (!running.ending) this.set({ kind: 'stopping' });
      try {
        running.process.postMessage({ type: 'stop' });
      } catch {
        // The process is already gone; its exit event follows.
      }
    }
    const timer = this.timers.setTimeout(() => {
      if (this.current === running) this.killCurrent();
    }, this.graceMs);
    await running.exited;
    this.timers.clearTimeout(timer);
  }

  /** Ends the process at once. */
  terminate(): void {
    ++this.revision;
    this.killCurrent();
  }

  private killCurrent(): void {
    const running = this.current;
    if (running === null) return;
    running.stopRequested = true;
    running.process.kill();
  }

  /** Resolves when the current process, if any, has ended. */
  async ended(): Promise<void> {
    await this.current?.exited;
  }

  private receive(running: Running, data: unknown): void {
    if (!isServerToMain(data)) {
      this.hooks.ignored(data);
      return;
    }
    switch (data.type) {
      case 'log':
        this.hooks.log({ stream: data.stream, line: data.line });
        return;
      case 'result': {
        if (this.state.kind !== 'starting' && this.state.kind !== 'stopping') return;
        const { result } = data;
        if (result.kind !== 'started') {
          // The run is over; the stop lets the process exit knowing this result arrived.
          running.ending = true;
          try {
            running.process.postMessage({ type: 'stop' });
          } catch {
            // Already gone.
          }
        }
        if (running.stopRequested && result.kind === 'started') return;
        if (result.kind === 'started') this.set({ kind: 'running', result });
        else if (result.kind === 'invalid') this.set({ kind: 'invalid', result });
        else this.set({ kind: 'bind-failed', result });
        return;
      }
      case 'stopped':
        return;
    }
  }

  private exit(running: Running, code: number): void {
    this.current = null;
    if (running.ending && !running.stopRequested) return;
    if (running.stopRequested) {
      if (!running.ending) this.set({ kind: 'stopped' });
      return;
    }
    this.set({ kind: 'exited', code });
  }

  private set(phase: Phase): void {
    this.state = phase;
    this.hooks.change(phase);
  }
}

/**
 * Quitting: every server is asked to stop, and any still
 * running after the grace period is terminated. `now` terminates the rest at
 * once, for a second quit request.
 */
export function stopAll(lifecycles: readonly ServerLifecycle[]): { readonly done: Promise<void>; now(): void } {
  const done = Promise.all(lifecycles.map((lifecycle) => lifecycle.stop())).then(() => undefined);
  return {
    done,
    now: () => {
      for (const lifecycle of lifecycles) lifecycle.terminate();
    },
  };
}
