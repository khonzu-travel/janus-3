import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureFileKind,
  capturedEntry,
  EXCHANGE_PATTERN,
  formatCaptureLogLine,
  isScenarioName,
  type CaptureFailureEntry,
  type CaptureLog,
  type CaptureLogEntry,
  type CaptureOutcome,
  type CapturePlan,
  type CaptureReservation,
  type CaptureSink,
  type CaptureWriteResult,
} from '@janus/core';

/** A `capture` event: no request values. */
export interface CaptureEvent {
  readonly id: string;
  readonly scenario: string;
  readonly outcome: CaptureOutcome;
}

/** What the Atlas capture routes read. */
export interface CaptureReader {
  /** Every scenario's log, or one scenario's; a scenario without a log has none. */
  logs(scenario?: string): Promise<readonly CaptureLog[]>;
  /**
   * An exchange with a `captured` line and its allowlisted files, or null.
   * A file that exists but cannot be read safely maps to null bytes.
   */
  exchange(
    scenario: string,
    exchange: string,
  ): Promise<{ readonly entry: CaptureLogEntry; readonly files: ReadonlyMap<string, Uint8Array | null> } | null>;
  /** Subscribes to `capture` events; returns the unsubscribe function. */
  subscribe(listener: (event: CaptureEvent) => void): () => void;
}

/** Reports problems the caller never sees: a claim, write or log failure. */
export interface CaptureLogger {
  error(event: string, fields?: Readonly<Record<string, string | number>>): void;
}

const LOG_FILE = 'log.jsonl';
const MAX_EXCHANGE = 999_999;
const FILE_MODE = 0o644;
/** No-follow where the platform has it. */
const NOFOLLOW = constants.O_NOFOLLOW;

/** A violation of the capture root's integrity; its message names no absolute path. */
export class CaptureIntegrityError extends Error {
  override readonly name = 'CaptureIntegrityError';
}

/**
 * The captures directory: the recording sink and the Atlas
 * reader. The canonical root's identity is pinned when it opens; every
 * operation checks it again, refuses links, creates exclusively and writes
 * only names from the fixed allowlist. Paths come only from validated
 * scenario names, six-digit exchanges and core-planned file names.
 */
export class CaptureStore implements CaptureSink, CaptureReader {
  readonly #root: string;
  readonly #identity: { readonly dev: number; readonly ino: number };
  readonly #logger: CaptureLogger;
  /** The next number to try per scenario; the exclusive create decides. */
  readonly #next = new Map<string, number>();
  readonly #listeners = new Set<(event: CaptureEvent) => void>();

  private constructor(root: string, identity: Stats, logger: CaptureLogger) {
    this.#root = root;
    this.#identity = { dev: identity.dev, ino: identity.ino };
    this.#logger = logger;
  }

  /** Opens an existing captures directory, pinning its canonical identity. */
  static async open(directory: string, logger: CaptureLogger): Promise<CaptureStore> {
    const root = await realpath(directory);
    const info = await lstat(root);
    if (!info.isDirectory()) throw new CaptureIntegrityError('the captures directory is not a directory');
    return new CaptureStore(root, info, logger);
  }

  async claim(scenario: string): Promise<CaptureReservation> {
    try {
      if (!isScenarioName(scenario)) throw new CaptureIntegrityError('invalid scenario name');
      const directory = await this.#scenarioDirectory(scenario, true);
      let number = this.#next.get(scenario) ?? (await this.#highest(directory)) + 1;
      for (;;) {
        if (number > MAX_EXCHANGE) throw new CaptureIntegrityError('the scenario has no exchange numbers left');
        const exchange = String(number).padStart(6, '0');
        try {
          await mkdir(join(directory, exchange));
          this.#next.set(scenario, number + 1);
          return Object.freeze({ scenario, exchange });
        } catch (error) {
          if (code(error) !== 'EEXIST') throw error;
          number++;
        }
      }
    } catch (error) {
      this.#logger.error('capture-claim-failed', { scenario, reason: reason(error) });
      throw error;
    }
  }

  async write(reservation: CaptureReservation, plan: CapturePlan): Promise<CaptureWriteResult> {
    const written: string[] = [];
    try {
      const directory = await this.#exchangeDirectory(reservation);
      const status = plan.log.status ?? 0;
      for (const file of plan.files) {
        if (captureFileKind(file.name, status) === null) throw new CaptureIntegrityError('unexpected capture file');
        const path = join(directory, file.name);
        const handle = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
          FILE_MODE,
        );
        written.push(path);
        await writeAll(handle, file.bytes);
      }
      await this.#append(reservation.scenario, formatCaptureLogLine(plan.log));
      this.#publish(reservation, 'captured');
      return { ok: true };
    } catch (error) {
      this.#logger.error('capture-write-failed', {
        capture: `${reservation.scenario}/${reservation.exchange}`,
        reason: reason(error),
      });
      for (const path of written) await unlink(path).catch(() => undefined);
      await this.#finish(reservation, { ...plan.log, outcome: 'capture-failed' });
      return { ok: false };
    }
  }

  async fail(reservation: CaptureReservation, entry: CaptureFailureEntry): Promise<void> {
    await this.#finish(reservation, entry);
  }

  async logs(scenario?: string): Promise<readonly CaptureLog[]> {
    await this.#checkRoot();
    let names: string[];
    if (scenario === undefined) {
      names = (await readdir(this.#root)).filter(isScenarioName);
    } else {
      if (!isScenarioName(scenario)) return [];
      names = [scenario];
    }
    const logs: CaptureLog[] = [];
    for (const name of names.sort()) {
      const directory = await this.#scenarioDirectory(name, false).catch(() => null);
      if (directory === null) continue;
      const bytes = await readRegular(join(directory, LOG_FILE));
      if (bytes === null) continue;
      logs.push({ scenario: name, lines: splitLines(bytes) });
    }
    return logs;
  }

  async exchange(
    scenario: string,
    exchange: string,
  ): Promise<{ readonly entry: CaptureLogEntry; readonly files: ReadonlyMap<string, Uint8Array | null> } | null> {
    if (!isScenarioName(scenario) || !EXCHANGE_PATTERN.test(exchange)) return null;
    const [log] = await this.logs(scenario);
    const entry = log === undefined ? null : capturedEntry(log, exchange);
    if (entry === null) return null;
    const directory = join(this.#root, scenario, exchange);
    const info = await lstat(directory).catch(() => null);
    const files = new Map<string, Uint8Array | null>();
    if (info === null || !info.isDirectory()) return { entry, files };
    // Only allowlisted names are opened; nothing found in a log or provenance file is used as a path.
    for (const name of await readdir(directory).catch(() => [])) {
      if (captureFileKind(name, entry.status ?? 0) === null) continue;
      files.set(name, await readRegular(join(directory, name)));
    }
    return { entry, files };
  }

  subscribe(listener: (event: CaptureEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Exchange directories with no log line, except those
   * created within `recentMs`, which another process may still be recording.
   */
  async incomplete(recentMs: number, now = Date.now()): Promise<readonly CaptureReservation[]> {
    const found: CaptureReservation[] = [];
    for (const name of (await readdir(this.#root).catch(() => [])).filter(isScenarioName).sort()) {
      const directory = await this.#scenarioDirectory(name, false).catch(() => null);
      if (directory === null) continue;
      const logged = new Set<string>();
      const bytes = await readRegular(join(directory, LOG_FILE));
      for (const line of bytes === null ? [] : splitLines(bytes)) {
        const exchange = (/"exchange":"([0-9]{6})"/.exec(line) ?? [])[1];
        if (exchange !== undefined) logged.add(exchange);
      }
      for (const exchange of (await readdir(directory).catch(() => []))
        .filter((entry) => EXCHANGE_PATTERN.test(entry))
        .sort()) {
        if (logged.has(exchange)) continue;
        const info = await lstat(join(directory, exchange)).catch(() => null);
        if (info === null || !info.isDirectory()) continue;
        const created = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
        if (now - created < recentMs) continue;
        found.push({ scenario: name, exchange });
      }
    }
    return found;
  }

  /** Completes an exchange with a failure line; a log that cannot be appended to is reported in the server log. */
  async #finish(reservation: CaptureReservation, entry: CaptureLogEntry): Promise<void> {
    try {
      await this.#append(reservation.scenario, formatCaptureLogLine(entry));
      this.#publish(reservation, entry.outcome);
    } catch (error) {
      this.#logger.error('capture-log-failed', {
        capture: `${reservation.scenario}/${reservation.exchange}`,
        outcome: entry.outcome,
        reason: reason(error),
      });
    }
  }

  /** One append per line, after every file of the exchange is flushed. */
  async #append(scenario: string, line: string): Promise<void> {
    const directory = await this.#scenarioDirectory(scenario, false);
    const path = join(directory, LOG_FILE);
    const existing = await lstat(path).catch(() => null);
    if (existing !== null && (!existing.isFile() || existing.nlink !== 1)) {
      throw new CaptureIntegrityError('the scenario log is not a regular file');
    }
    const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW, FILE_MODE);
    await writeAll(handle, new TextEncoder().encode(line));
  }

  #publish(reservation: CaptureReservation, outcome: CaptureOutcome): void {
    const event: CaptureEvent = {
      id: `${reservation.scenario}/${reservation.exchange}`,
      scenario: reservation.scenario,
      outcome,
    };
    for (const listener of [...this.#listeners]) listener(event);
  }

  /** Fails closed when the pinned root was replaced, moved or turned into a link. */
  async #checkRoot(): Promise<void> {
    const info = await lstat(this.#root).catch(() => null);
    if (info?.isDirectory() !== true || info.dev !== this.#identity.dev || info.ino !== this.#identity.ino) {
      throw new CaptureIntegrityError('the captures directory was replaced');
    }
  }

  /** The scenario's directory, never through a link; created on the first claim. */
  async #scenarioDirectory(scenario: string, create: boolean): Promise<string> {
    await this.#checkRoot();
    const directory = join(this.#root, scenario);
    if (create) {
      await mkdir(directory).catch((error: unknown) => {
        if (code(error) !== 'EEXIST') throw error;
      });
    }
    const info = await lstat(directory);
    if (!info.isDirectory()) throw new CaptureIntegrityError('a scenario entry is not a directory');
    return directory;
  }

  /** A claimed exchange's directory, which must still be a plain directory. */
  async #exchangeDirectory(reservation: CaptureReservation): Promise<string> {
    if (!EXCHANGE_PATTERN.test(reservation.exchange)) throw new CaptureIntegrityError('invalid exchange');
    const directory = join(await this.#scenarioDirectory(reservation.scenario, false), reservation.exchange);
    const info = await lstat(directory);
    if (!info.isDirectory()) throw new CaptureIntegrityError('an exchange entry is not a directory');
    return directory;
  }

  /** The highest exchange number present in a scenario directory, or 0. */
  async #highest(directory: string): Promise<number> {
    let highest = 0;
    for (const name of await readdir(directory)) {
      if (EXCHANGE_PATTERN.test(name)) highest = Math.max(highest, Number(name));
    }
    return highest;
  }
}

/** Writes every byte, flushes, and closes. */
async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
      offset += bytesWritten;
    }
    await handle.datasync();
  } finally {
    await handle.close();
  }
}

/** A regular file with one link, opened without following links; null otherwise. */
async function readRegular(path: string): Promise<Uint8Array | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) return null;
    const buffer = await handle.readFile();
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function splitLines(bytes: Uint8Array): string[] {
  const lines = new TextDecoder().decode(bytes).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function code(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** A failure as a code or class name: never a path or message from the filesystem. */
function reason(error: unknown): string {
  const errorCode = code(error);
  if (typeof errorCode === 'string') return errorCode;
  return error instanceof CaptureIntegrityError ? error.message : 'unknown';
}

/**
 * The captures directory for the request runner, which needs
 * no `recording.endpoints`: created on the first claim, so a project that
 * never records gets no `captures/` directory. Reads find nothing until then.
 */
export class LazyCaptureStore implements CaptureSink, CaptureReader {
  readonly #directory: string;
  readonly #logger: CaptureLogger;
  #store: CaptureStore | null = null;
  readonly #listeners = new Set<(event: CaptureEvent) => void>();

  constructor(directory: string, logger: CaptureLogger, existing: CaptureStore | null = null) {
    this.#directory = directory;
    this.#logger = logger;
    if (existing !== null) this.#adopt(existing);
  }

  #adopt(store: CaptureStore): CaptureStore {
    this.#store = store;
    store.subscribe((event) => {
      for (const listener of this.#listeners) listener(event);
    });
    return store;
  }

  async #get(create: boolean): Promise<CaptureStore | null> {
    if (this.#store !== null) return this.#store;
    if (create) await mkdir(this.#directory, { recursive: true });
    try {
      const store = await CaptureStore.open(this.#directory, this.#logger);
      // Another call may have opened it meanwhile; keep the first.
      const opened = this.#store as CaptureStore | null;
      return opened ?? this.#adopt(store);
    } catch (error) {
      if (create) throw error;
      return null;
    }
  }

  async claim(scenario: string): Promise<CaptureReservation> {
    const store = await this.#get(true).catch((error: unknown) => {
      this.#logger.error('capture-claim-failed', { scenario, reason: reason(error) });
      throw error;
    });
    if (store === null) throw new CaptureIntegrityError('the captures directory cannot be opened');
    return store.claim(scenario);
  }

  async write(reservation: CaptureReservation, plan: CapturePlan): Promise<CaptureWriteResult> {
    const store = await this.#get(true);
    return store === null ? { ok: false } : store.write(reservation, plan);
  }

  async fail(reservation: CaptureReservation, entry: CaptureFailureEntry): Promise<void> {
    await (await this.#get(true))?.fail(reservation, entry);
  }

  async logs(scenario?: string): Promise<readonly CaptureLog[]> {
    return (await this.#get(false))?.logs(scenario) ?? [];
  }

  async exchange(
    scenario: string,
    exchange: string,
  ): Promise<{ readonly entry: CaptureLogEntry; readonly files: ReadonlyMap<string, Uint8Array | null> } | null> {
    return (await this.#get(false))?.exchange(scenario, exchange) ?? null;
  }

  subscribe(listener: (event: CaptureEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
