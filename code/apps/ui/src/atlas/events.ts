import { DecodeError, string } from './decode.js';
import { reloadSummary, type WireReloadSummary } from './wire.js';

/**
 * The snapshot event stream. The browser's `EventSource`
 * reconnects ordinary drops itself, honouring the server's `retry` hint; only
 * once it gives up (`CLOSED`, e.g. after the stream-limit `503`) does this
 * create a new one, with capped exponential backoff and jitter. Every opening
 * `state` event is authoritative; no history is replayed.
 */

/** The authoritative state every (re)connection starts with. */
export interface SnapshotState {
  readonly snapshotVersion: string;
  readonly lastReload: WireReloadSummary | null;
}

export type SnapshotEvent =
  | ({ readonly type: 'state' } & SnapshotState)
  | { readonly type: 'snapshot'; readonly snapshotVersion: string; readonly previousVersion: string }
  | { readonly type: 'reload-failed'; readonly errorCount: number; readonly finishedAt: string }
  /** A recorded exchange was logged. It carries no request values. */
  | { readonly type: 'capture'; readonly id: string; readonly scenario: string; readonly outcome: string }
  /** Request files changed on disk: the IDs, never their content. */
  | { readonly type: 'requests'; readonly changed: readonly string[] }
  /** A run started, finished a step, or finished. It carries no request or response values. */
  | {
      readonly type: 'run';
      readonly id: string;
      readonly state: 'started' | 'step' | 'finished';
      readonly step: number | null;
      readonly outcome: string | null;
    };

/** The part of `EventSource` this module uses, so tests can substitute one. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

/** `EventSource.CLOSED`, spelled out so this works where `EventSource` is not defined. */
export const CLOSED = 2;

export const BACKOFF_INITIAL_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

export interface SnapshotFeedOptions {
  readonly url: string;
  readonly create: EventSourceFactory;
  readonly onEvent: (event: SnapshotEvent) => void;
  /** Whether a stream is currently connected, for the connection header. */
  readonly onConnection?: (connected: boolean) => void;
  /** 0 ≤ value < 1, for jitter. */
  readonly random?: () => number;
}

/** Opens the feed and returns a function that closes it for good. */
export function openSnapshotFeed(options: SnapshotFeedOptions): () => void {
  const random = options.random ?? Math.random;
  let source: EventSourceLike | null = null;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const connect = (): void => {
    if (stopped) return;
    const current = options.create(options.url);
    source = current;
    const listen = (type: SnapshotEvent['type']) => {
      current.addEventListener(type, (message) => {
        const event = decodeEvent(type, message.data);
        if (event === null) return;
        if (type === 'state') {
          attempts = 0;
          options.onConnection?.(true);
        }
        options.onEvent(event);
      });
    };
    listen('state');
    listen('snapshot');
    listen('reload-failed');
    listen('capture');
    listen('requests');
    listen('run');
    current.onerror = () => {
      options.onConnection?.(false);
      // While CONNECTING, the native source is already retrying: never start a second stream.
      if (current.readyState !== CLOSED || stopped || source !== current) return;
      current.close();
      source = null;
      const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** attempts);
      attempts++;
      // "Equal jitter": at least half the ceiling, so retries never bunch up at zero.
      const delay = ceiling / 2 + random() * (ceiling / 2);
      timer = setTimeout(connect, delay);
    };
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
    source = null;
  };
}

const version = /^[0-9a-f]{16}$/;
const CAPTURE_ID = /^[a-z0-9]+(-[a-z0-9]+)*\/(?:[0-9a-f]{8}|[0-9]{6})$/;
const RUN_ID = /^r-[0-9]{6,}$/;

/** Decodes one event's data; a malformed event is ignored rather than trusted. */
export function decodeEvent(type: SnapshotEvent['type'], data: string): SnapshotEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  try {
    const record = value as Record<string, unknown>;
    switch (type) {
      case 'state': {
        const snapshotVersion = string(record['snapshotVersion'], 'snapshotVersion');
        if (!version.test(snapshotVersion)) return null;
        const lastReload = record['lastReload'] === null ? null : reloadSummary(record['lastReload'], 'lastReload');
        return { type, snapshotVersion, lastReload };
      }
      case 'snapshot': {
        const snapshotVersion = string(record['snapshotVersion'], 'snapshotVersion');
        if (!version.test(snapshotVersion)) return null;
        return { type, snapshotVersion, previousVersion: string(record['previousVersion'], 'previousVersion') };
      }
      case 'reload-failed': {
        const errorCount = record['errorCount'];
        if (typeof errorCount !== 'number' || !Number.isSafeInteger(errorCount) || errorCount < 0) return null;
        return { type, errorCount, finishedAt: string(record['finishedAt'], 'finishedAt') };
      }
      case 'capture': {
        const id = string(record['id'], 'id');
        const scenario = string(record['scenario'], 'scenario');
        if (!CAPTURE_ID.test(id) || !id.startsWith(`${scenario}/`)) return null;
        return { type, id, scenario, outcome: string(record['outcome'], 'outcome') };
      }
      case 'requests': {
        const changed: unknown = record['changed'];
        if (!Array.isArray(changed)) return null;
        const ids = changed.filter((item): item is string => typeof item === 'string');
        return ids.length === changed.length ? { type, changed: ids } : null;
      }
      case 'run': {
        const id = string(record['id'], 'id');
        const state = record['state'];
        if (!RUN_ID.test(id) || (state !== 'started' && state !== 'step' && state !== 'finished')) return null;
        const step = record['step'];
        const outcome = record['outcome'];
        return {
          type,
          id,
          state,
          step: typeof step === 'number' && Number.isSafeInteger(step) && step > 0 ? step : null,
          outcome: typeof outcome === 'string' ? outcome : null,
        };
      }
    }
  } catch (error) {
    if (error instanceof DecodeError) return null;
    throw error;
  }
}
