import { parseOffsets } from '../dynamic/grammar.js';
import { parseRfc3339 } from '../dynamic/time.js';
import type { ClockStep } from '../dynamic/types.js';
import { isScenarioName } from '../fixtures/flow.js';
import { MAX_INSTANT_MS } from './envelope.js';

/** Largest `POST` or `PATCH /_janus/session` body. */
export const SESSION_BODY_LIMIT = 4 * 1024;

/** A clock to bind: its instant in epoch milliseconds and its mode. */
export interface ClockBinding {
  readonly now: number;
  readonly mode: 'frozen' | 'offset';
}

/**
 * A decoded session write. `undefined` leaves a member as it
 * is; `null` removes it.
 */
export interface SessionChanges {
  readonly scenario?: string | null;
  readonly clock?: ClockBinding | { readonly advance: readonly ClockStep[] } | null;
}

export type SessionBodyResult =
  | { readonly ok: true; readonly changes: SessionChanges }
  | { readonly ok: false; readonly field: string; readonly message: string };

/**
 * Decodes an already-parsed `POST` or `PATCH /_janus/session` body. Every
 * member is checked before the caller changes anything, so a rejected write
 * changes nothing.
 */
export function decodeSessionBody(value: unknown, method: 'POST' | 'PATCH'): SessionBodyResult {
  const invalid = (field: string, message: string): SessionBodyResult => ({
    ok: false,
    field,
    message: `"${field}" ${message}`,
  });
  if (!isRecord(value)) return { ok: false, field: '', message: 'the body must be a JSON object' };
  const unknown = Object.keys(value).find((key) => key !== 'scenario' && key !== 'clock');
  if (unknown !== undefined) return invalid(unknown, 'is not a field of a session');
  if (method === 'PATCH' && Object.keys(value).length === 0) {
    return { ok: false, field: '', message: 'a PATCH must change "scenario", "clock" or both' };
  }

  const changes: { scenario?: string | null; clock?: NonNullable<SessionChanges['clock']> | null } = {};
  if ('scenario' in value) {
    const scenario = value['scenario'];
    if (scenario === null) {
      if (method === 'POST') return invalid('scenario', 'must be a scenario name; leave it out for no pin');
      changes.scenario = null;
    } else if (typeof scenario !== 'string' || !isScenarioName(scenario)) {
      return invalid('scenario', 'must be a scenario name, or null to remove the pin');
    } else {
      changes.scenario = scenario;
    }
  }

  if ('clock' in value) {
    const clock = value['clock'];
    if (clock === null) {
      if (method === 'POST') return invalid('clock', 'must be {"now": …, "mode": …}; leave it out for no clock');
      changes.clock = null;
    } else if (!isRecord(clock)) {
      return invalid('clock', 'must be an object with "now" and an optional "mode", or with "advance"');
    } else if ('advance' in clock) {
      if (method === 'POST')
        return invalid('clock.advance', 'applies only to PATCH: a new session has no clock to move');
      const extra = Object.keys(clock).find((key) => key !== 'advance');
      if (extra !== undefined) return invalid(`clock.${extra}`, 'cannot be sent with "advance"');
      const steps = typeof clock['advance'] === 'string' ? parseAdvance(clock['advance']) : null;
      if (steps === null) return invalid('clock.advance', 'must be a signed offset such as +30d, -2h or +1mo-1d');
      changes.clock = { advance: steps };
    } else {
      const extra = Object.keys(clock).find((key) => key !== 'now' && key !== 'mode');
      if (extra !== undefined) return invalid(`clock.${extra}`, 'is not a field of a clock');
      const now = parseNow(clock['now']);
      if (now === null) {
        return invalid(
          'clock.now',
          'must be an RFC 3339 instant with an offset, or epoch milliseconds in the Date range',
        );
      }
      const mode = clock['mode'] ?? 'frozen';
      if (mode !== 'frozen' && mode !== 'offset') return invalid('clock.mode', 'must be "frozen" or "offset"');
      changes.clock = { now, mode };
    }
  }
  return { ok: true, changes };
}

function parseNow(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) && Math.abs(raw) <= MAX_INSTANT_MS ? raw : null;
  if (typeof raw !== 'string') return null;
  const parsed = parseRfc3339(raw);
  return parsed === null || Math.abs(parsed) > MAX_INSTANT_MS ? null : parsed;
}

/** The offset syntax: one or more signed groups, nothing else. */
function parseAdvance(text: string): readonly ClockStep[] | null {
  try {
    const { steps, rest } = parseOffsets(text.trim());
    return steps.length > 0 && rest === '' ? steps : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
