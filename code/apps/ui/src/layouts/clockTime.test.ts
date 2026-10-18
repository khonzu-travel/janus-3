import { describe, expect, it } from 'vitest';

import type { Clock } from '../atlas/client.js';
import { clockTime } from './ConnectionHeader.js';

// The Clock tooltip's date and time.

const clock = (mode: Clock['mode'], now: string | null, timezone = 'UTC'): Clock => ({
  now,
  mode,
  source: 'server-default',
  session: null,
  timezone,
  seed: 1,
  seedSource: 'config',
  serverDefault: { now, mode },
});

const format = (instant: number, timeZone: string): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long', timeZone }).format(instant);

describe('clockTime', () => {
  const at = Date.parse('2026-10-17T00:34:02Z');

  it('is the wall clock when live, in the clock’s timezone', () => {
    expect(clockTime(clock('live', null, 'Asia/Tokyo'), at - 5000, at)).toBe(format(at, 'Asia/Tokyo'));
  });

  it('stays put when frozen, and moves on from the instant read when offset', () => {
    const now = '2030-01-01T09:00:00Z';
    expect(clockTime(clock('frozen', now), at - 60_000, at)).toBe(format(Date.parse(now), 'UTC'));
    expect(clockTime(clock('offset', now), at - 60_000, at)).toBe(format(Date.parse(now) + 60_000, 'UTC'));
  });

  it('falls back to the browser’s timezone for one it does not know', () => {
    expect(clockTime(clock('live', null, 'Nowhere/Here'), at, at)).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' }).format(at),
    );
  });
});
