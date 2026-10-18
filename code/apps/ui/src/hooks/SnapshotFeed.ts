import { createContext, useContext, useEffect, useState } from 'react';

import type { AtlasClient, Health } from '../atlas/client.js';
import { openSnapshotFeed, type EventSourceFactory, type SnapshotEvent } from '../atlas/events.js';
import type { WireReloadSummary } from '../atlas/wire.js';

/**
 * What the server has announced since health loaded: the
 * active snapshot and the last reload. The view keeps showing `loadedVersion`
 * until the user refreshes.
 */
export interface SnapshotFeed {
  /** The snapshot the current view was loaded from. */
  readonly loadedVersion: string | null;
  /** The snapshot the server serves now, as last announced; null until the stream says. */
  readonly currentVersion: string | null;
  readonly lastReload: WireReloadSummary | null;
  /** Whether the event stream is connected. */
  readonly connected: boolean;
  /** Capture events received since the stream opened, newest last; the review page refreshes on each. */
  readonly captures: readonly CaptureAnnouncement[];
  /** Total capture events received, independent of the bounded history. */
  readonly captureCount: number;
  /** `requests` events received: the request tree refetches on each. */
  readonly requestsCount: number;
  /** `run` events received, and the latest; run views refetch on each. */
  readonly runCount: number;
  readonly lastRun: RunAnnouncement | null;
}

/** One `run` event: the run and where it is, never request values. */
export interface RunAnnouncement {
  readonly id: string;
  readonly state: 'started' | 'step' | 'finished';
  readonly step: number | null;
  readonly outcome: string | null;
}

/** One `capture` event: the exchange and its outcome, never request values. */
export interface CaptureAnnouncement {
  readonly id: string;
  readonly scenario: string;
  readonly outcome: string;
}

export const NO_FEED: SnapshotFeed = {
  loadedVersion: null,
  currentVersion: null,
  lastReload: null,
  connected: false,
  captures: [],
  captureCount: 0,
  requestsCount: 0,
  runCount: 0,
  lastRun: null,
};

/** Only the latest captures are kept: the page needs the newest, not the history. */
const KEPT_CAPTURES = 20;

export const SnapshotFeedContext = createContext<SnapshotFeed>(NO_FEED);

export function useSnapshotFeed(): SnapshotFeed {
  return useContext(SnapshotFeedContext);
}

/** The browser's `EventSource`, when there is one. */
export const nativeEventSource: EventSourceFactory | null =
  typeof EventSource === 'undefined' ? null : (url) => new EventSource(url);

interface FeedState {
  readonly currentVersion: string | null;
  readonly lastReload: WireReloadSummary | null;
  readonly connected: boolean;
  readonly captures: readonly CaptureAnnouncement[];
  /** Total capture events received, independent of the bounded history. */
  readonly captureCount: number;
  readonly requestsCount: number;
  readonly runCount: number;
  readonly lastRun: RunAnnouncement | null;
}

/**
 * Opens the event stream once health has loaded and the server offers it. The
 * stream outlives Refresh: it describes the server, not the loaded view.
 */
export function useSnapshotFeedState(
  client: AtlasClient,
  health: Health | undefined,
  factory: EventSourceFactory | null,
): SnapshotFeed {
  const [state, setState] = useState<FeedState>({
    currentVersion: null,
    lastReload: null,
    connected: false,
    captures: [],
    captureCount: 0,
    requestsCount: 0,
    runCount: 0,
    lastRun: null,
  });
  const [seededFrom, setSeededFrom] = useState<Health | undefined>(undefined);
  // From the last health that loaded, so a refresh (health briefly pending) keeps the stream open.
  const enabled = seededFrom?.capabilities.events === true && factory !== null;

  // Health's own report of the last reload seeds the state, so a failure is shown even without events.
  if (health !== undefined && health !== seededFrom) {
    setSeededFrom(health);
    setState((previous) => ({ ...previous, lastReload: newest(previous.lastReload, health.lastReload) }));
  }

  useEffect(() => {
    if (!enabled) return undefined;
    return openSnapshotFeed({
      url: client.eventsUrl.href,
      create: factory,
      onConnection: (connected) => {
        setState((previous) => (previous.connected === connected ? previous : { ...previous, connected }));
      },
      onEvent: (event) => {
        setState((previous) => apply(previous, event));
      },
    });
  }, [client, enabled, factory]);

  return {
    loadedVersion: health?.snapshotVersion ?? null,
    currentVersion: state.currentVersion,
    lastReload: state.lastReload,
    connected: state.connected,
    captures: state.captures,
    captureCount: state.captureCount,
    requestsCount: state.requestsCount,
    runCount: state.runCount,
    lastRun: state.lastRun,
  };
}

function apply(previous: FeedState, event: SnapshotEvent): FeedState {
  switch (event.type) {
    case 'state':
      // Authoritative on every (re)connection: it repairs whatever was missed.
      return { ...previous, currentVersion: event.snapshotVersion, lastReload: event.lastReload };
    case 'snapshot':
      if (previous.currentVersion === event.snapshotVersion) return previous;
      return {
        ...previous,
        currentVersion: event.snapshotVersion,
        // A swap is a successful reload; it clears an earlier failure.
        lastReload: { outcome: 'swapped', errorCount: 0, finishedAt: previous.lastReload?.finishedAt ?? '' },
      };
    case 'reload-failed':
      if (previous.lastReload?.outcome === 'failed' && previous.lastReload.finishedAt === event.finishedAt) {
        return previous;
      }
      return {
        ...previous,
        lastReload: { outcome: 'failed', errorCount: event.errorCount, finishedAt: event.finishedAt },
      };
    case 'capture':
      return {
        ...previous,
        captureCount: previous.captureCount + 1,
        captures: [...previous.captures, { id: event.id, scenario: event.scenario, outcome: event.outcome }].slice(
          -KEPT_CAPTURES,
        ),
      };
    case 'requests':
      return { ...previous, requestsCount: previous.requestsCount + 1 };
    case 'run':
      return {
        ...previous,
        runCount: previous.runCount + 1,
        lastRun: { id: event.id, state: event.state, step: event.step, outcome: event.outcome },
      };
  }
}

/** The later of two reload summaries by `finishedAt` (RFC 3339 UTC sorts as text). */
function newest(a: WireReloadSummary | null, b: WireReloadSummary | null): WireReloadSummary | null {
  if (a === null) return b;
  if (b === null) return a;
  return b.finishedAt >= a.finishedAt ? b : a;
}

/** True when the server announced a snapshot other than the one the view was loaded from. */
export function feedChanged(feed: SnapshotFeed): boolean {
  return feed.currentVersion !== null && feed.loadedVersion !== null && feed.currentVersion !== feed.loadedVersion;
}
