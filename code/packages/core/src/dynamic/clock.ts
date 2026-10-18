import { parseMockNow } from '../http/mock-now.js';
import type { HeaderMap } from '../types/index.js';
import { MAX_INSTANT } from './time.js';

/** Where a request's instant came from. */
export type ClockSource = 'caller' | 'request-header' | 'session' | 'server-default' | 'wall-clock';

/** The request's session clock, as the instant it shows now. */
export interface SessionInstant {
  readonly instant: number;
  readonly mode: 'frozen' | 'offset';
}

export interface ClockSettings {
  /** `dynamic.now` in epoch milliseconds, or null for the wall clock. */
  readonly now: number | null;
  readonly clockMode: 'frozen' | 'offset';
}

/** The engine's clock: its settings, the injected wall clock, and when the engine was created. */
export interface EngineClock {
  readonly settings: ClockSettings;
  readonly wallClock: (() => number) | undefined;
  /** Wall-clock time at engine creation, for `offset` mode; null without a wall clock. */
  readonly createdAt: number | null;
}

export type InstantChoice =
  | {
      readonly ok: true;
      readonly instant: number;
      readonly source: ClockSource;
      /** True when the instant advances between requests: an `offset` default or the live wall clock. */
      readonly moving: boolean;
    }
  | { readonly ok: false; readonly kind: 'invalid-request' | 'unavailable'; readonly reason: string };

export function createEngineClock(settings: ClockSettings, wallClock: (() => number) | undefined): EngineClock {
  const createdAt =
    wallClock !== undefined && settings.now !== null && settings.clockMode === 'offset' ? wallClock() : null;
  return Object.freeze({ settings, wallClock, createdAt });
}

/**
 * Chooses the instant a request renders against, in the order: the caller's `nowMs`, then `X-Mock-Now`, then the
 * session's clock, then `dynamic.now`, then the injected wall clock. Core
 * never reads a clock of its own.
 */
export function chooseInstant(
  clock: EngineClock,
  nowMs: number | undefined,
  headers: HeaderMap,
  session: SessionInstant | null = null,
): InstantChoice {
  if (nowMs !== undefined) {
    if (!Number.isInteger(nowMs) || Math.abs(nowMs) > MAX_INSTANT) {
      return {
        ok: false,
        kind: 'invalid-request',
        reason: 'nowMs must be an integer number of milliseconds within the Date range',
      };
    }
    return { ok: true, instant: nowMs, source: 'caller', moving: false };
  }
  const header = parseMockNow(headers);
  if (header.kind === 'invalid') return { ok: false, kind: 'invalid-request', reason: header.reason };
  if (header.kind === 'instant') return { ok: true, instant: header.instant, source: 'request-header', moving: false };
  if (session !== null) {
    return { ok: true, instant: session.instant, source: 'session', moving: session.mode === 'offset' };
  }
  return serverInstant(clock);
}

/** The instant without any per-request override: `dynamic.now`, or the wall clock. */
export function serverInstant(clock: EngineClock): InstantChoice {
  const { settings, wallClock, createdAt } = clock;
  if (settings.now !== null) {
    if (settings.clockMode === 'offset' && wallClock !== undefined && createdAt !== null) {
      return { ok: true, instant: settings.now + (wallClock() - createdAt), source: 'server-default', moving: true };
    }
    return { ok: true, instant: settings.now, source: 'server-default', moving: false };
  }
  if (wallClock === undefined) {
    return {
      ok: false,
      kind: 'unavailable',
      reason: 'no clock was provided to the engine and no instant was requested',
    };
  }
  return { ok: true, instant: wallClock(), source: 'wall-clock', moving: true };
}
