import type { Atlas } from '../atlas/types.js';
import type { EnginePromotions } from '../promotion/promoter.js';
import type { RecordingSlots } from '../recording/slots.js';
import type { SessionAnswer } from '../sessions/api.js';
import type { FixtureSnapshot } from './fixtures.js';
import type { HeaderMap, RequestDescription } from './request.js';
import type { ResponseDescription } from './response.js';
import type { StartupWarning } from './startup.js';

export interface ResolveOptions {
  readonly signal?: AbortSignal;
}

export interface ReplaceSnapshotOptions {
  /** The startup warnings Atlas reports from now on; the current ones are kept when absent. */
  readonly warnings?: readonly StartupWarning[];
}

/** The caller's own session. Every call identifies the session from `headers`. */
export interface EngineSessions {
  /** `GET /_janus/session`. */
  describe(headers: HeaderMap): SessionAnswer;
  /** `POST`, `PATCH` and `DELETE /_janus/session`; `body` is the raw request body. */
  write(method: 'POST' | 'PATCH' | 'DELETE', headers: HeaderMap, body: Uint8Array | null): SessionAnswer;
  /** `DELETE /_janus/sequences`: all positions, or one endpoint's in every scenario. */
  resetSequences(headers: HeaderMap, endpoint: string | null): SessionAnswer;
  /** Records an Atlas request carrying a session key. A malformed key is ignored. */
  touch(headers: HeaderMap): void;
}

export interface Engine {
  /** Resolves against the snapshot active when called, and finishes on it even if another is swapped in. */
  resolve(request: RequestDescription, options?: ResolveOptions): Promise<ResponseDescription>;
  /** Read-only projections of the active snapshot, and request simulation. */
  readonly atlas: Atlas;
  /** The caller-owned sessions. Sessions survive `replaceSnapshot`. */
  readonly sessions: EngineSessions;
  /** Promotion and review; `501 promotion-unavailable` without promotion ports. */
  readonly promotions: EnginePromotions;
  /**
   * The milliseconds to wait before resolving a request to a fixture path.
   * Changes nothing: no sequence, replay record or session is
   * touched. 0 when faults are disabled or the request is recorded.
   */
  planDelay(request: RequestDescription): number;
  /**
   * The `Expect: 100-continue` head check: the response Janus
   * would send from the head alone, or null when the body may be asked for.
   * `request` has no body; a method with `accepts.yaml` checks the declared
   * `Content-Type`. Changes nothing.
   */
  checkHead(request: RequestDescription): ResponseDescription | null;
  /** `recording.maxConcurrent`, shared with the request runner's record mode. */
  readonly recordingSlots: RecordingSlots;
  /** The active snapshot. */
  snapshot(): FixtureSnapshot;
  /**
   * Makes `snapshot` active atomically and returns the version
   * it replaced. A snapshot with the active version leaves the active one in
   * place and only updates the warnings. Links carrying an older `at` are
   * `stale` from then on. Throws for a snapshot not built by `buildSnapshot`.
   */
  replaceSnapshot(snapshot: FixtureSnapshot, options?: ReplaceSnapshotOptions): string;
}
