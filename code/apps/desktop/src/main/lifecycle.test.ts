import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MainToServer, ResultData } from '../shared/messages.js';
import { ServerLifecycle, stopAll, type Phase, type ProcessEvents, type SpawnServer } from './lifecycle.js';
import { LogBook } from './logs.js';

const paths = { cwd: '/p', configFile: null, fixturesRoot: '/p/data', captures: null };
const started: ResultData = {
  kind: 'started',
  url: 'http://127.0.0.1:4010',
  uiUrl: 'http://127.0.0.1:4010/_janus/ui/',
  warnings: [],
  summary: [],
  paths,
};

/** A fake server process that records what it was sent. */
class FakeProcess {
  readonly sent: MainToServer[] = [];
  killed = false;
  constructor(readonly events: ProcessEvents) {}
  postMessage(message: MainToServer): void {
    this.sent.push(message);
  }
  kill(): void {
    this.killed = true;
    this.events.exit(15);
  }
  reply(data: unknown): void {
    this.events.message(data);
  }
}

function setup(graceMs = 7000) {
  const processes: FakeProcess[] = [];
  const phases: Phase['kind'][] = [];
  const ignored: unknown[] = [];
  const spawn: SpawnServer = (_cwd, events) => {
    const fake = new FakeProcess(events);
    processes.push(fake);
    return fake;
  };
  const lifecycle = new ServerLifecycle(
    '/p',
    spawn,
    {
      change: (phase) => phases.push(phase.kind),
      log: () => undefined,
      ignored: (data) => ignored.push(data),
    },
    graceMs,
  );
  return { lifecycle, processes, phases, ignored, last: () => processes.at(-1) as FakeProcess };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the server lifecycle', () => {
  it('starts, runs and stops', async () => {
    const { lifecycle, phases, last } = setup();
    await lifecycle.start({ noConfig: false });
    expect(last().sent).toEqual([{ type: 'start', args: { noConfig: false } }]);
    last().reply({ type: 'result', result: started });
    expect(lifecycle.phase).toEqual({ kind: 'running', result: started });
    const stopping = lifecycle.stop();
    expect(last().sent.at(-1)).toEqual({ type: 'stop' });
    last().reply({ type: 'stopped' });
    last().events.exit(0);
    await stopping;
    expect(phases).toEqual(['starting', 'running', 'stopping', 'stopped']);
    expect(lifecycle.alive).toBe(false);
  });

  it('keeps the invalid and bind-failed states when the process exits by itself', async () => {
    const { lifecycle, last } = setup();
    await lifecycle.start({ noConfig: false });
    last().reply({ type: 'result', result: { kind: 'invalid', errors: [], warnings: [], notes: [], paths } });
    last().events.exit(0);
    expect(lifecycle.phase.kind).toBe('invalid');
    await lifecycle.start({ noConfig: false });
    last().reply({
      type: 'result',
      result: { kind: 'bind-failed', code: 'EADDRINUSE', host: '127.0.0.1', port: 4010, paths },
    });
    last().events.exit(0);
    expect(lifecycle.phase).toMatchObject({ kind: 'bind-failed', result: { code: 'EADDRINUSE' } });
  });

  it('reports a server that exits without being asked, and never restarts it', async () => {
    const { lifecycle, processes, last } = setup();
    await lifecycle.start({ noConfig: false });
    last().reply({ type: 'result', result: started });
    last().events.exit(9);
    expect(lifecycle.phase).toEqual({ kind: 'exited', code: 9 });
    expect(processes).toHaveLength(1);
  });

  it('restarts as a new process, after the old one has ended', async () => {
    const { lifecycle, processes } = setup();
    await lifecycle.start({ noConfig: false });
    const first = processes[0] as FakeProcess;
    first.reply({ type: 'result', result: started });
    const restarting = lifecycle.start({ noConfig: false, port: 0 });
    expect(processes).toHaveLength(1);
    first.events.exit(0);
    await restarting;
    expect(processes).toHaveLength(2);
    expect(processes[1]?.sent).toEqual([{ type: 'start', args: { noConfig: false, port: 0 } }]);
    // Messages from the old process are ignored.
    first.reply({ type: 'result', result: started });
    expect(lifecycle.phase.kind).toBe('starting');
  });

  it('stops a server that is still starting without showing it as running', async () => {
    const { lifecycle, phases, last } = setup();
    await lifecycle.start({ noConfig: false });
    const stopping = lifecycle.stop();
    last().reply({ type: 'result', result: started });
    last().events.exit(0);
    await stopping;
    expect(phases).toEqual(['starting', 'stopping', 'stopped']);
  });

  it('coalesces overlapping restarts into one process with the latest arguments', async () => {
    const { lifecycle, processes, last } = setup();
    await lifecycle.start({ noConfig: false });
    const first = last();
    const a = lifecycle.start({ noConfig: false });
    const b = lifecycle.start({ noConfig: false, port: 0 });
    first.events.exit(0);
    await Promise.all([a, b]);
    expect(processes).toHaveLength(2);
    expect(last().sent).toEqual([{ type: 'start', args: { noConfig: false, port: 0 } }]);
    const stopping = lifecycle.stop();
    last().events.exit(0);
    await stopping;
    expect(lifecycle.alive).toBe(false);
  });

  it('cancels a pending restart when the project closes or the app quits', async () => {
    const { lifecycle, processes, last } = setup();
    await lifecycle.start({ noConfig: false });
    const restarting = lifecycle.start({ noConfig: false });
    const stopping = lifecycle.stop();
    last().events.exit(0);
    await Promise.all([restarting, stopping]);
    expect(processes).toHaveLength(1);
    expect(lifecycle.alive).toBe(false);
    expect(lifecycle.phase.kind).toBe('stopped');
  });

  it('cancels a pending restart on forced termination', async () => {
    const { lifecycle, processes } = setup();
    await lifecycle.start({ noConfig: false });
    const restarting = lifecycle.start({ noConfig: false });
    lifecycle.terminate();
    await restarting;
    expect(processes).toHaveLength(1);
    expect(lifecycle.alive).toBe(false);
  });

  it('ignores malformed messages', async () => {
    const { lifecycle, ignored, last } = setup();
    await lifecycle.start({ noConfig: false });
    last().reply({ type: 'result', result: { kind: 'started', url: 'file:///x' } });
    last().reply('hello');
    expect(ignored).toHaveLength(2);
    expect(lifecycle.phase.kind).toBe('starting');
  });

  it('terminates a server that does not stop within the grace period', async () => {
    vi.useFakeTimers();
    const { lifecycle, last } = setup(7000);
    await lifecycle.start({ noConfig: false });
    last().reply({ type: 'result', result: started });
    const stopping = lifecycle.stop();
    await vi.advanceTimersByTimeAsync(6999);
    expect(last().killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(last().killed).toBe(true);
    expect(lifecycle.phase.kind).toBe('stopped');
  });

  it('quits by stopping every server, and a second quit terminates them at once', async () => {
    vi.useFakeTimers();
    const a = setup();
    const b = setup();
    await a.lifecycle.start({ noConfig: false });
    await b.lifecycle.start({ noConfig: false });
    const quitting = stopAll([a.lifecycle, b.lifecycle]);
    expect(a.last().sent.at(-1)).toEqual({ type: 'stop' });
    a.last().events.exit(0);
    let done = false;
    void quitting.done.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false);
    quitting.now();
    await quitting.done;
    expect(b.last().killed).toBe(true);
    expect(a.lifecycle.alive || b.lifecycle.alive).toBe(false);
  });
});

describe('message validation', async () => {
  const { isMainToServer, isServerToMain } = await import('../shared/messages.js');

  it('accepts only the messages main sends', () => {
    expect(isMainToServer({ type: 'start', args: { noConfig: false } })).toBe(true);
    expect(isMainToServer({ type: 'start', args: { noConfig: false, port: 0 } })).toBe(true);
    expect(isMainToServer({ type: 'stop' })).toBe(true);
    for (const bad of [
      null,
      { type: 'start' },
      { type: 'start', args: { noConfig: true } },
      { type: 'start', args: { noConfig: false, port: 70000 } },
      { type: 'start', args: { noConfig: false, data: '/etc' } },
      { type: 'stop', now: true },
      { type: 'exec' },
    ]) {
      expect(isMainToServer(bad)).toBe(false);
    }
  });

  it('accepts only the messages a server sends', () => {
    expect(isServerToMain({ type: 'log', stream: 'out', line: 'janus started' })).toBe(true);
    expect(isServerToMain({ type: 'stopped' })).toBe(true);
    expect(isServerToMain({ type: 'result', result: started })).toBe(true);
    expect(
      isServerToMain({
        type: 'result',
        result: {
          kind: 'invalid',
          errors: [{ code: 'c', source: 'fixtures', path: 'a', line: 1, column: 2, token: 't', message: 'm' }],
          warnings: [],
          notes: ['n'],
          paths,
        },
      }),
    ).toBe(true);
    for (const bad of [
      { type: 'log', stream: 'debug', line: 'x' },
      { type: 'log', stream: 'out', line: 3 },
      { type: 'result', result: { ...started, url: 'javascript:alert(1)' } },
      { type: 'result', result: { ...started, paths: { cwd: 1 } } },
      { type: 'result', result: { kind: 'bind-failed', code: 'X', host: 'h', port: -1, paths } },
      { type: 'result', result: { kind: 'invalid', errors: [{ code: 'c' }], warnings: [], notes: [], paths } },
      { type: 'result', result: { kind: 'other', paths } },
      { type: 'stopped', extra: 1 },
    ]) {
      expect(isServerToMain(bad)).toBe(false);
    }
  });
});

describe('logs', () => {
  it('keeps the last lines in memory and two runs on disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'janus-logs-'));
    try {
      const book = new LogBook(directory, 'abc', 3);
      book.rotate();
      for (const line of ['1', '2']) book.append({ stream: 'out', line });
      book.rotate();
      for (const line of ['3', '4', '5']) book.append({ stream: 'err', line });
      expect(book.all().map((line) => line.line)).toEqual(['3', '4', '5']);
      expect(book.tail(50)).toEqual(['3', '4', '5']);
      expect(await readFile(join(directory, 'abc.1.log'), 'utf8')).toBe('1\n2\n');
      expect(await readFile(join(directory, 'abc.log'), 'utf8')).toBe('3\n4\n5\n');
      book.rotate();
      expect(book.tail(50)).toEqual([]);
      const seen: string[] = [];
      const unsubscribe = book.subscribe((line) => seen.push(line.line));
      book.append({ stream: 'out', line: '6' });
      unsubscribe();
      book.append({ stream: 'out', line: '7' });
      expect(seen).toEqual(['6']);
      expect(await readFile(join(directory, 'abc.1.log'), 'utf8')).toBe('3\n4\n5\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
