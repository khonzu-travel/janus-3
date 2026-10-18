import { relative } from 'node:path';

import {
  createTextLogger,
  formatStartupProblem,
  formatStartupReport,
  launch,
  loadConfig,
  type LaunchResult,
  type RunningServer,
  type ServeArgs,
} from '@janus/server';

import {
  isMainToServer,
  type MainToServer,
  type ResultData,
  type ServerToMain,
  type StartArgs,
} from '../shared/messages.js';
import { withWatchDefault } from './args.js';

// The entry point of each project's server process: an
// Electron utility process whose working directory is the project folder. It
// runs `launch` once and relays its log lines and result to the main process.

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: ServerToMain): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parentPort === undefined) throw new Error('the server host runs only as an Electron utility process');
const port = parentPort;

/** The UI build shipped with the app, passed by the main process. */
const uiRoot = process.env['JANUS_DESKTOP_UI_ROOT'] ?? null;

let server: RunningServer | null = null;
let started = false;
let stopping = false;
/** Set after an `invalid` or `bind-failed` result: the process only waits to exit. */
let ended = false;

/**
 * Exits once the main process has had the last message. A message posted just
 * before `process.exit` can be lost, so after a result that ends the run the
 * host waits for main's `stop`, or exits on its own after a short while.
 */
const END_WAIT_MS = 5000;

const send = (message: ServerToMain): void => {
  port.postMessage(message);
};
const lines =
  (stream: 'out' | 'err') =>
  (text: string): void => {
    for (const line of text.replace(/\n$/, '').split('\n')) send({ type: 'log', stream, line });
  };
const out = lines('out');
const err = lines('err');

port.on('message', ({ data }) => {
  if (!isMainToServer(data)) {
    err('janus desktop-message-ignored');
    return;
  }
  void handle(data);
});

async function handle(message: MainToServer): Promise<void> {
  if (message.type === 'start') {
    if (started) return;
    started = true;
    await start(message.args);
    return;
  }
  await stop();
}

async function start(startArgs: StartArgs): Promise<void> {
  const cwd = process.cwd();
  // Watch is on unless the file sets fixtures.watch itself.
  const loaded = await loadConfig(startArgs, cwd);
  const fileSetsWatch = loaded.effective.settings.some(
    (setting) => setting.key === 'fixtures.watch' && setting.source === 'file',
  );
  const args: ServeArgs = withWatchDefault(startArgs, fileSetsWatch);

  // The fixture root as the CLI shows it, for failed reloads' reports.
  const shown: { root?: string } = {};
  const logger = createTextLogger(out, err, () => shown.root);
  const result = await launch(args, { cwd, logger, ...(uiRoot === null ? {} : { uiRoot }) });
  if (result.paths.fixturesRoot !== null) shown.root = relative(cwd, result.paths.fixturesRoot) || '.';
  const fixturesRoot = shown.root;

  // The same lines `janus serve` prints, so the log reads like the terminal.
  if (result.kind === 'invalid') {
    err(
      formatStartupReport(result.errors, result.warnings, {
        outcome: 'not starting',
        notes: result.notes,
        ...root(fixturesRoot),
      }),
    );
  } else if (result.kind === 'started') {
    for (const warning of result.warnings) err(`janus: warning: ${formatStartupProblem(warning, fixturesRoot)}`);
    for (const line of result.summary) out(line);
    server = result.server;
  }
  send({ type: 'result', result: data(result) });
  if (result.kind !== 'started') {
    ended = true;
    setTimeout(() => process.exit(0), END_WAIT_MS);
    if (stopping) finish();
    return;
  }
  // A stop that arrived while starting.
  if (stopping) await close();
}

async function stop(): Promise<void> {
  if (ended) {
    finish();
    return;
  }
  if (stopping) {
    out('janus shutdown-in-progress signal=stop');
    return;
  }
  stopping = true;
  if (!started) finish();
  if (server !== null) await close();
}

async function close(): Promise<void> {
  const running = server;
  if (running === null) return;
  server = null;
  out('janus shutdown-started signal=stop');
  try {
    await running.close();
  } catch (error) {
    err(`janus shutdown-error message=${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
  }
  out('janus shutdown-complete');
  finish();
}

/** Acknowledges the stop and exits. */
function finish(): void {
  send({ type: 'stopped' });
  setImmediate(() => process.exit(0));
}

function root(display: string | undefined): { fixturesRoot?: string } {
  return display === undefined ? {} : { fixturesRoot: display };
}

/** The result as a message: plain data, with the server's URL in place of its handle. */
function data(result: LaunchResult): ResultData {
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  switch (result.kind) {
    case 'invalid':
      return plain(result);
    case 'bind-failed':
      return plain(result);
    case 'started':
      return plain({
        kind: 'started',
        url: result.server.url,
        uiUrl: result.uiUrl,
        warnings: result.warnings,
        summary: result.summary,
        paths: result.paths,
      });
  }
}
