import type { EventSourceFactory, EventSourceLike } from '../src/atlas/events.js';

/** A hand-driven stand-in for the browser's `EventSource`. */
export class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** Delivers one event, as the server would send it. */
  emit(type: string, data: unknown): void {
    this.readyState = 1;
    const event = new MessageEvent<string>(type, { data: typeof data === 'string' ? data : JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** A dropped connection: the native source retries (`CONNECTING`) or gives up (`CLOSED`). */
  fail(gaveUp: boolean): void {
    this.readyState = gaveUp ? 2 : 0;
    this.onerror?.(new Event('error'));
  }
}

/** A factory that records every source it creates. */
export function fakeEventSources() {
  const sources: FakeEventSource[] = [];
  const create: EventSourceFactory = (url) => {
    const source = new FakeEventSource(url);
    sources.push(source);
    return source;
  };
  return { sources, create, latest: () => sources.at(-1) };
}
