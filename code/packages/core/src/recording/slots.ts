/**
 * `recording.maxConcurrent` slots, shared by `X-Mock-Record`
 * requests and the request runner's record-mode sends. A
 * recorded request takes a slot or is refused at once; a runner step waits for
 * one, up to a deadline.
 */
export class RecordingSlots {
  #active = 0;
  readonly #max: number;
  readonly #waiting: (() => void)[] = [];

  constructor(max: number) {
    this.#max = max;
  }

  get active(): number {
    return this.#active;
  }

  /** Takes a slot when one is free. */
  tryAcquire(): boolean {
    if (this.#active >= this.#max) return false;
    this.#active++;
    return true;
  }

  release(): void {
    this.#active = Math.max(0, this.#active - 1);
    const next = this.#waiting.shift();
    next?.();
  }

  /** Waits for a slot for up to `timeoutMs`; resolves false when none came free or `signal` aborted. */
  acquire(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.tryAcquire()) return Promise.resolve(true);
    if (signal?.aborted === true) return Promise.resolve(false);
    return new Promise((resolve) => {
      const wake = (): void => {
        if (!this.tryAcquire()) {
          this.#waiting.unshift(wake);
          return;
        }
        cleanup();
        resolve(true);
      };
      const give = (): void => {
        cleanup();
        resolve(false);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', give);
        const index = this.#waiting.indexOf(wake);
        if (index !== -1) this.#waiting.splice(index, 1);
      };
      const timer = setTimeout(give, timeoutMs);
      signal?.addEventListener('abort', give, { once: true });
      this.#waiting.push(wake);
    });
  }
}
