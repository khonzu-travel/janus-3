import { appendFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { LogLine } from '../shared/bridge.js';

/** Lines kept in memory per log. */
export const LOG_MEMORY_LINES = 5000;

/**
 * One log: the last 5 000 lines in memory, appended to `<name>.log`. Each new
 * run keeps the previous file as `<name>.1.log`, so two runs are on disk.
 * Lines are stored as written; the server never logs bodies or header values.
 */
export class LogBook {
  private lines: LogLine[] = [];
  /** Lines appended since the last `rotate`. */
  private runLines = 0;
  private readonly listeners = new Set<(line: LogLine) => void>();
  readonly file: string;
  private readonly previous: string;

  constructor(
    directory: string,
    name: string,
    private readonly limit: number = LOG_MEMORY_LINES,
  ) {
    this.file = join(directory, `${name}.log`);
    this.previous = join(directory, `${name}.1.log`);
    mkdirSync(directory, { recursive: true });
  }

  /** Starts a new run: the current file becomes `<name>.1.log`, and memory is kept. */
  rotate(): void {
    this.runLines = 0;
    try {
      rmSync(this.previous, { force: true });
      renameSync(this.file, this.previous);
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
    }
  }

  append(line: LogLine): void {
    this.lines.push(line);
    this.runLines += 1;
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
    try {
      appendFileSync(this.file, `${line.line}\n`);
    } catch {
      // A full or read-only disk never stops a project; the lines stay in memory.
    }
    for (const listener of this.listeners) listener(line);
  }

  all(): readonly LogLine[] {
    return [...this.lines];
  }

  /** The current run's last `count` lines, as text. */
  tail(count: number): readonly string[] {
    const available = Math.min(count, this.runLines, this.lines.length);
    return available === 0 ? [] : this.lines.slice(-available).map((line) => line.line);
  }

  subscribe(listener: (line: LogLine) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
