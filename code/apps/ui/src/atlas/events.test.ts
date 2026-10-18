import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeEventSources } from '../../test/fake-events.js';
import { BACKOFF_INITIAL_MS, BACKOFF_MAX_MS, decodeEvent, openSnapshotFeed, type SnapshotEvent } from './events.js';

const V1 = 'aaaaaaaaaaaaaaaa';
const V2 = 'bbbbbbbbbbbbbbbb';

describe('openSnapshotFeed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const open = (random = () => 0.5) => {
    const fakes = fakeEventSources();
    const events: SnapshotEvent[] = [];
    const connection: boolean[] = [];
    const close = openSnapshotFeed({
      url: 'http://janus.test/_janus/events',
      create: fakes.create,
      onEvent: (event) => events.push(event),
      onConnection: (connected) => connection.push(connected),
      random,
    });
    return { ...fakes, events, connection, close };
  };

  it('decodes state, snapshot and reload-failed events', () => {
    const { latest, events, connection } = open();
    latest()?.emit('state', { snapshotVersion: V1, lastReload: null });
    latest()?.emit('snapshot', { snapshotVersion: V2, previousVersion: V1 });
    latest()?.emit('reload-failed', { errorCount: 2, finishedAt: '2026-09-29T10:14:03Z' });
    expect(events).toEqual([
      { type: 'state', snapshotVersion: V1, lastReload: null },
      { type: 'snapshot', snapshotVersion: V2, previousVersion: V1 },
      { type: 'reload-failed', errorCount: 2, finishedAt: '2026-09-29T10:14:03Z' },
    ]);
    expect(connection).toEqual([true]);
    expect(latest()?.url).toBe('http://janus.test/_janus/events');
  });

  it('ignores malformed events instead of trusting them', () => {
    const { latest, events } = open();
    latest()?.emit('state', 'not json');
    latest()?.emit('state', { snapshotVersion: 'nope', lastReload: null });
    latest()?.emit('snapshot', { snapshotVersion: 7 });
    latest()?.emit('reload-failed', { errorCount: -1, finishedAt: 'x' });
    expect(events).toEqual([]);
  });

  it('leaves ordinary drops to the native source and never opens a second stream meanwhile', () => {
    const { sources, connection } = open();
    sources[0]?.emit('state', { snapshotVersion: V1, lastReload: null });
    sources[0]?.fail(false);
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.closed).toBe(false);
    expect(connection).toEqual([true, false]);
  });

  it('creates a new source with capped exponential backoff and jitter once the native one is CLOSED', () => {
    const { sources } = open(() => 0);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      const before = sources.length;
      sources.at(-1)?.fail(true);
      expect(sources.at(-2)?.closed ?? sources.at(-1)?.closed).toBe(true);
      let waited = 0;
      while (sources.length === before) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      delays.push(waited);
    }
    // With zero jitter each wait is half the ceiling: 1 s, 2 s, 4 s, … capped at 30 s.
    const ceilings = [1, 2, 4, 8, 16, 30, 30].map((seconds) => seconds * 1000);
    expect(delays).toEqual(ceilings.map((ceiling) => Math.ceil(ceiling / 2 / 100) * 100));
    expect(BACKOFF_INITIAL_MS).toBe(1000);
    expect(BACKOFF_MAX_MS).toBe(30_000);
  });

  it('resets the backoff once a state event arrives', () => {
    const { sources } = open(() => 0);
    sources[0]?.fail(true);
    vi.advanceTimersByTime(500);
    sources[1]?.fail(true);
    vi.advanceTimersByTime(1000);
    sources[2]?.emit('state', { snapshotVersion: V1, lastReload: null });
    sources[2]?.fail(true);
    vi.advanceTimersByTime(499);
    expect(sources).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(4);
  });

  it('closes for good', () => {
    const { sources, close } = open();
    sources[0]?.fail(true);
    close();
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
  });
});

describe('decodeEvent', () => {
  it('decodes a state with a last reload', () => {
    expect(
      decodeEvent(
        'state',
        JSON.stringify({ snapshotVersion: V1, lastReload: { outcome: 'failed', errorCount: 1, finishedAt: 't' } }),
      ),
    ).toEqual({
      type: 'state',
      snapshotVersion: V1,
      lastReload: { outcome: 'failed', errorCount: 1, finishedAt: 't' },
    });
  });
});
