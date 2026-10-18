import { toHex, utf8Encode } from '../bytes.js';
import { sha256 } from '../canonical.js';
import { MAX_INSTANT_MS } from '../http/envelope.js';
import type { SessionSource } from '../http/session.js';
import type { ChoiceTrace, HeaderMap } from '../types/index.js';

/**
 * A session clock: the instant it showed at `boundAt` on the
 * injected wall clock. A `frozen` clock keeps showing `at`; an `offset` one
 * advances with the wall clock.
 */
export interface SessionClock {
  readonly mode: 'frozen' | 'offset';
  readonly at: number;
  readonly boundAt: number;
}

/** What one session holds. The write key itself is never kept, only its digest. */
export interface SessionState {
  readonly id: string;
  readonly source: Exclude<SessionSource, 'default'>;
  readonly scenario: string | null;
  readonly clock: SessionClock | null;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

/**
 * A caller's position in one sequence, keyed by scenario,
 * endpoint and sequence. `position` is the step the next request gets.
 */
export interface SequencePosition {
  readonly scenario: string;
  readonly method: string;
  /** The route template's canonical segments, JSON-encoded. */
  readonly template: string;
  /** The endpoint of `scenario` this sequence belongs to. */
  readonly endpointId: string;
  /** Null for `sequence.yaml`, else the rule number. */
  readonly rule: number | null;
  /** A `fault.yaml` fault sequence; absent for response sequences. */
  readonly kind?: 'fault';
  readonly position: number;
  readonly steps: number;
  /** The sequence's steps (and rule) when stored: a changed sequence restarts at step 1. */
  readonly signature: string;
}

/** A stored response for one idempotency key. Never contains the key or an `X-Mock-*` header. */
export interface ReplayRecord {
  readonly fingerprint: string;
  readonly status: number;
  /** The headers core set: replayed sidecar headers, `Content-Type`, `Content-Language` and `Vary`. */
  readonly headers: HeaderMap;
  readonly body: Uint8Array | null;
  /** What the first response's diagnostic headers and trace were built from. */
  readonly meta: {
    readonly fixtureId: string;
    readonly source: string;
    readonly representation: string | null;
    readonly contentTypeOverride: { readonly representation: string; readonly wire: string } | null;
    readonly dropped: readonly string[];
    readonly nondeterministic: boolean;
    readonly scenario: string;
    readonly resolvedFrom: string;
    readonly choice: ChoiceTrace;
  };
}

interface Entry {
  state: SessionState;
  readonly digest: Uint8Array;
  /** Sequence positions past step 1, by key. */
  readonly sequences: Map<string, SequencePosition>;
  /** Replay records in insertion order, oldest first. */
  readonly replays: Map<string, ReplayRecord>;
}

export interface SessionStoreOptions {
  /** `sessions.idleTimeout`, in milliseconds. */
  readonly idleTimeoutMs: number;
  /** `sessions.max`. */
  readonly max: number;
  /** The injected wall clock, in epoch milliseconds. */
  readonly now: () => number;
  /** The injected entropy source; creating a session needs it. */
  readonly randomBytes: ((count: number) => Uint8Array) | undefined;
}

export type CreateResult =
  | { readonly kind: 'created'; readonly state: SessionState; readonly writeKey: string }
  | { readonly kind: 'exists' }
  | { readonly kind: 'limit' };

/**
 * The in-memory session store. It has no timer: a session
 * expires when it is next looked up after its idle timeout, and expired
 * sessions are swept whenever the store would otherwise grow. Only `create`
 * adds a session; nothing evicts a live one.
 */
export class SessionStore {
  readonly #sessions = new Map<string, Entry>();
  readonly #options: SessionStoreOptions;

  constructor(options: SessionStoreOptions) {
    this.#options = options;
  }

  /** Live sessions, sweeping expired ones first. */
  get size(): number {
    this.#sweep();
    return this.#sessions.size;
  }

  /** The live session for `id`, or undefined. Changes nothing: an expired session is only treated as absent. */
  peek(id: string): SessionState | undefined {
    const entry = this.#sessions.get(id);
    return entry === undefined || this.#expired(entry) ? undefined : entry.state;
  }

  /** The live session for `id`, discarding it when it has expired. */
  get(id: string): SessionState | undefined {
    const entry = this.#sessions.get(id);
    if (entry === undefined) return undefined;
    if (this.#expired(entry)) {
      this.#sessions.delete(id);
      return undefined;
    }
    return entry.state;
  }

  /** Records a real request carrying the key. A key that names no session stores nothing. */
  touch(id: string): void {
    const entry = this.#sessions.get(id);
    if (entry === undefined || this.#expired(entry)) return;
    entry.state = Object.freeze({ ...entry.state, lastSeenAt: this.#options.now() });
  }

  /** The instant a session expires: `lastSeenAt` plus the idle timeout. */
  expiresAt(state: SessionState): number {
    return state.lastSeenAt + this.#options.idleTimeoutMs;
  }

  /** Creates a session with a new write key, unless one exists or the store is full. */
  create(
    id: string,
    source: SessionState['source'],
    initial: { readonly scenario: string | null; readonly clock: Omit<SessionClock, 'boundAt'> | null },
  ): CreateResult {
    if (this.get(id) !== undefined) return { kind: 'exists' };
    this.#sweep();
    if (this.#sessions.size >= this.#options.max) return { kind: 'limit' };
    const random = this.#options.randomBytes;
    if (random === undefined) throw new Error('creating a session needs the injected randomBytes source');
    const bytes = random(16);
    if (bytes.length !== 16) throw new Error('randomBytes returned the wrong number of bytes');
    const writeKey = `wk_${toHex(bytes)}`;
    const now = this.#options.now();
    const state: SessionState = Object.freeze({
      id,
      source,
      scenario: initial.scenario,
      clock: initial.clock === null ? null : Object.freeze({ ...initial.clock, boundAt: now }),
      createdAt: now,
      lastSeenAt: now,
    });
    this.#sessions.set(id, { state, digest: keyDigest(writeKey), sequences: new Map(), replays: new Map() });
    return { kind: 'created', state, writeKey };
  }

  /** True when `writeKey` is the session's key, compared by digest in constant time. */
  authorize(id: string, writeKey: string): boolean {
    const entry = this.#sessions.get(id);
    if (entry === undefined || this.#expired(entry)) return false;
    return constantTimeEqual(entry.digest, keyDigest(writeKey));
  }

  /** Replaces a live session's pin and clock, and counts the write as a request. */
  update(
    id: string,
    change: (state: SessionState) => Pick<SessionState, 'scenario' | 'clock'>,
  ): SessionState | undefined {
    const entry = this.#sessions.get(id);
    if (entry === undefined || this.#expired(entry)) return undefined;
    const next = change(entry.state);
    entry.state = Object.freeze({ ...entry.state, ...next, lastSeenAt: this.#options.now() });
    return entry.state;
  }

  /** A live session's position for a sequence key, or undefined at step 1. Changes nothing. */
  position(id: string, key: string): SequencePosition | undefined {
    return this.#live(id)?.sequences.get(key);
  }

  /** Records a live session's position; step 1 is not stored. */
  setPosition(id: string, key: string, position: SequencePosition): void {
    const entry = this.#live(id);
    if (entry === undefined) return;
    if (position.position <= 1) entry.sequences.delete(key);
    else entry.sequences.set(key, Object.freeze({ ...position }));
  }

  /** A live session's positions past step 1. */
  positions(id: string): readonly SequencePosition[] {
    return [...(this.#live(id)?.sequences.values() ?? [])];
  }

  /** Restarts a live session's positions that `match`, or all of them. */
  resetPositions(id: string, match: (position: SequencePosition) => boolean = () => true): void {
    const entry = this.#live(id);
    if (entry === undefined) return;
    for (const [key, position] of [...entry.sequences]) if (match(position)) entry.sequences.delete(key);
  }

  /** Discards changed or removed sequences in every session when a snapshot is replaced. */
  retainPositions(keep: (position: SequencePosition) => boolean): void {
    for (const entry of this.#sessions.values()) {
      for (const [key, position] of entry.sequences) {
        if (!keep(position)) entry.sequences.delete(key);
      }
    }
  }

  /** A live session's replay record for a key, or undefined. */
  replay(id: string, key: string): ReplayRecord | undefined {
    return this.#live(id)?.replays.get(key);
  }

  /** Stores a replay record, dropping this session's oldest beyond `max`; other sessions are never touched. */
  storeReplay(id: string, key: string, record: ReplayRecord, max: number): void {
    const entry = this.#live(id);
    if (entry === undefined) return;
    entry.replays.delete(key);
    entry.replays.set(key, record);
    while (entry.replays.size > max) {
      const oldest = entry.replays.keys().next();
      if (oldest.done === true) break;
      entry.replays.delete(oldest.value);
    }
  }

  /** How many replay records a live session holds. */
  replayCount(id: string): number {
    return this.#live(id)?.replays.size ?? 0;
  }

  /** Drops a session, its state and its write key. */
  delete(id: string): boolean {
    return this.#sessions.delete(id);
  }

  #live(id: string): Entry | undefined {
    const entry = this.#sessions.get(id);
    return entry === undefined || this.#expired(entry) ? undefined : entry;
  }

  #expired(entry: Entry): boolean {
    return this.#options.now() - entry.state.lastSeenAt >= this.#options.idleTimeoutMs;
  }

  #sweep(): void {
    for (const [id, entry] of this.#sessions) if (this.#expired(entry)) this.#sessions.delete(id);
  }
}

function keyDigest(writeKey: string): Uint8Array {
  return sha256(utf8Encode(writeKey));
}

/** Compares two equal-length digests without stopping at the first difference. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

/** Why a session clock cannot be read: an offset clock ran past the end of the Date range (review C2). */
export const SESSION_CLOCK_OVERRUN = 'the session clock has run past the end of the Date range';

/**
 * The instant a session clock shows at wall time `now`, and whether it moves.
 * The instant stays within the Date range: an offset clock that has run past
 * either end stops there and reports `overrun`, which callers answer as an
 * error (review C2).
 */
export function sessionInstant(
  clock: SessionClock,
  now: number,
): { readonly instant: number; readonly moving: boolean; readonly overrun: boolean } {
  if (clock.mode === 'frozen') return { instant: clock.at, moving: false, overrun: false };
  const instant = clock.at + (now - clock.boundAt);
  const bounded = Math.min(MAX_INSTANT_MS, Math.max(-MAX_INSTANT_MS, instant));
  return { instant: bounded, moving: true, overrun: bounded !== instant };
}
