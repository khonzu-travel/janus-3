import { compareStrings } from '../canonical.js';
import type { EngineConfig } from '../config/merge.js';
import { sequenceSignature } from '../controls/choose.js';
import { evaluateClock, rfc3339 } from '../dynamic/time.js';
import type { RequestErrorCode } from '../errors/index.js';
import { templateKey } from '../fixtures/build.js';
import type { RouteNode, SnapshotData } from '../fixtures/snapshot.js';
import { endpointId } from '../ids.js';
import { faultSignature } from '../resolve/transport.js';
import { decodeSessionBody, SESSION_BODY_LIMIT, type SessionChanges } from '../http/session-body.js';
import { parseWriteKey, resolveSessionKey, type SessionKey } from '../http/session.js';
import type { HeaderMap } from '../types/index.js';
import { unknownScenario } from './scenario-error.js';
import {
  SESSION_CLOCK_OVERRUN,
  sessionInstant,
  type SequencePosition,
  type SessionClock,
  type SessionState,
  type SessionStore,
} from './store.js';

/** The caller's session as `/_janus/session` describes it. Instants are RFC 3339 in UTC. */
export interface SessionDocument {
  readonly id: string | null;
  readonly source: 'header' | 'derived' | 'default';
  readonly exists: boolean;
  readonly scenario: { readonly name: string; readonly known: boolean } | null;
  readonly clock: { readonly now: string; readonly mode: 'frozen' | 'offset'; readonly boundAt: string } | null;
  readonly createdAt: string | null;
  readonly lastSeenAt: string | null;
  readonly expiresAt: string | null;
  /** Positions past step 1. */
  readonly sequences: readonly SessionSequence[];
  /** How many responses are stored for replay, never which. */
  readonly replays: { readonly count: number; readonly max: number };
}

export interface SessionSequence {
  readonly scenario: string;
  readonly endpointId: string;
  /** Null for `sequence.yaml`, else the rule number. */
  readonly rule: number | null;
  /** A `fault.yaml` fault sequence; absent for a response sequence. */
  readonly kind?: 'fault';
  readonly position: number;
  readonly steps: number;
}

/** The answer to one session route call; the adapter only frames it. */
export type SessionAnswer =
  | {
      readonly ok: true;
      readonly status: 200 | 201;
      readonly document: SessionDocument;
      /** Only on the creating `POST`: sent once, in `X-Mock-Session-Key`. */
      readonly writeKey?: string;
      readonly key: SessionKey;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: RequestErrorCode;
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
      /** Null when the session key itself was malformed. */
      readonly key: SessionKey | null;
    };

/** What the session routes act on. */
export interface SessionContext {
  readonly store: SessionStore;
  readonly snapshot: SnapshotData;
  readonly config: EngineConfig;
  /** The injected wall clock. */
  readonly now: () => number;
}

/** `GET /_janus/session`: needs no write key and changes nothing but `lastSeenAt`. */
export function describeSession(context: SessionContext, headers: HeaderMap): SessionAnswer {
  const resolved = resolveSessionKey(headers, context.config.keyFrom);
  if (!resolved.ok) return failure(400, 'invalid-request', `Invalid request: ${resolved.reason}`, null);
  const key = resolved.key;
  if (key.id !== null) context.store.touch(key.id);
  const state = key.id === null ? undefined : context.store.get(key.id);
  if (state !== undefined && clockOverrun(state.clock, context.now())) return overrun(key);
  return { ok: true, status: 200, document: sessionDocument(context, key, state), key };
}

function clockOverrun(clock: SessionClock | null, now: number): boolean {
  return clock !== null && sessionInstant(clock, now).overrun;
}

/** A session whose clock ran past the Date range (review C2): only a new `now`, `null` or DELETE repairs it. */
function overrun(key: SessionKey): SessionAnswer {
  return failure(
    409,
    'no-session-clock',
    `The session has no usable clock: ${SESSION_CLOCK_OVERRUN}; bind it again with {"now": …} or drop it with {"clock": null}`,
    key,
  );
}

/**
 * `POST`, `PATCH` and `DELETE /_janus/session`, with the
 * errors checked in the order the plan lists them. The body is validated in
 * full before anything changes.
 */
export function writeSession(
  context: SessionContext,
  method: 'POST' | 'PATCH' | 'DELETE',
  headers: HeaderMap,
  body: Uint8Array | null,
): SessionAnswer {
  const { store, snapshot, config } = context;
  const resolved = resolveSessionKey(headers, config.keyFrom);
  if (!resolved.ok) return failure(400, 'invalid-request', `Invalid request: ${resolved.reason}`, null);
  const key = resolved.key;
  const id = key.id;
  const source = key.source;

  // 1. A session needs an explicit or derived key.
  if (id === null || source === 'default') {
    return failure(
      400,
      'session-required',
      'This request has no session key: send X-Mock-Session, or a credential named in sessions.keyFrom',
      key,
    );
  }
  // Every real request carrying a session key keeps an existing session
  // alive, including rejected writes. Touch before checking
  // the method-specific errors so a duplicate POST or a PATCH with a bad
  // write key follows the same lifetime rule as any other Atlas request.
  store.touch(id);
  // 2–3. Changing or dropping a session takes the session and its write key.
  if (method !== 'POST') {
    if (store.get(id) === undefined) {
      return failure(404, 'session-not-found', `No session ${JSON.stringify(id)} exists; create it with POST`, key);
    }
    const writeKey = parseWriteKey(headers);
    if (writeKey === null || !store.authorize(id, writeKey)) {
      return failure(
        403,
        'session-forbidden',
        'Changing or dropping a session needs its write key, sent once in X-Mock-Session-Key; it was absent, repeated, malformed or wrong',
        key,
      );
    }
  }

  // 4. The body.
  let changes: SessionChanges = {};
  const length = body?.length ?? 0;
  if (method === 'DELETE') {
    if (length > 0) return failure(400, 'atlas-invalid-request', 'Invalid Atlas request: DELETE takes no body', key);
  } else if (length > 0 || method === 'PATCH') {
    if (!isJsonContentType(headers['content-type'])) {
      return failure(415, 'unsupported-media-type', 'A session body must be sent as application/json', key);
    }
    if (length > SESSION_BODY_LIMIT) {
      return failure(413, 'request-too-large', 'A session body is at most 4 KiB', key);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body ?? new Uint8Array()));
    } catch {
      return failure(400, 'atlas-invalid-request', 'Invalid Atlas request: the body is not valid UTF-8 JSON', key);
    }
    const decoded = decodeSessionBody(parsed, method);
    if (!decoded.ok) return failure(400, 'atlas-invalid-request', `Invalid Atlas request: ${decoded.message}`, key);
    changes = decoded.changes;
  }

  // 5. The pin must name a scenario of the active snapshot.
  if (typeof changes.scenario === 'string' && !snapshot.scenarios.has(changes.scenario)) {
    const unknown = unknownScenario(changes.scenario, 'session', [...snapshot.scenarios.keys()]);
    return {
      ok: false,
      status: 400,
      code: 'unknown-scenario',
      message: unknown.message,
      details: unknown.details,
      key,
    };
  }

  // 6. Conflicts and limits, then the change itself.
  const now = context.now();
  if (method === 'POST') {
    const clock = changes.clock;
    const created = store.create(id, source, {
      scenario: changes.scenario ?? null,
      clock: clock === undefined || clock === null || 'advance' in clock ? null : { mode: clock.mode, at: clock.now },
    });
    if (created.kind === 'exists') {
      return failure(409, 'session-exists', `Session ${JSON.stringify(id)} already exists and was left unchanged`, key);
    }
    if (created.kind === 'limit') {
      return failure(
        503,
        'session-limit',
        `Janus already holds sessions.max (${String(config.maxSessions)}) sessions; drop one or wait for one to expire`,
        key,
      );
    }
    return {
      ok: true,
      status: 201,
      document: sessionDocument(context, key, created.state),
      writeKey: created.writeKey,
      key,
    };
  }
  if (method === 'DELETE') {
    store.delete(id);
    return { ok: true, status: 200, document: sessionDocument(context, key, undefined), key };
  }

  const current = store.get(id);
  if (current === undefined) {
    return failure(404, 'session-not-found', `No session ${JSON.stringify(id)} exists; create it with POST`, key);
  }
  let clock: SessionClock | null = current.clock;
  const requested = changes.clock;
  if (requested !== null && (requested === undefined || 'advance' in requested) && clockOverrun(clock, now)) {
    return overrun(key);
  }
  if (requested === null) clock = null;
  else if (requested !== undefined && 'advance' in requested) {
    if (clock === null) {
      return failure(409, 'no-session-clock', 'The session has no clock to advance; bind one with {"now": …}', key);
    }
    const shown = sessionInstant(clock, now).instant;
    let moved: number;
    try {
      moved = evaluateClock('now', requested.advance, config.timezone, shown).instant;
    } catch {
      return failure(
        400,
        'atlas-invalid-request',
        'Invalid Atlas request: "clock.advance" moves the clock out of range',
        key,
      );
    }
    clock = { ...clock, at: clock.at + (moved - shown) };
  } else if (requested !== undefined) {
    clock = { mode: requested.mode, at: requested.now, boundAt: now };
  }
  const scenario = changes.scenario === undefined ? current.scenario : changes.scenario;
  const updated = store.update(id, () => ({ scenario, clock: clock === null ? null : Object.freeze({ ...clock }) }));
  return { ok: true, status: 200, document: sessionDocument(context, key, updated), key };
}

/**
 * `DELETE /_janus/sequences`: restarts the caller's own
 * sequence positions, all of them or one endpoint's in every scenario, with
 * The session-route errors, in order.
 */
export function resetSequences(context: SessionContext, headers: HeaderMap, endpoint: string | null): SessionAnswer {
  const { store, snapshot, config } = context;
  const resolved = resolveSessionKey(headers, config.keyFrom);
  if (!resolved.ok) return failure(400, 'invalid-request', `Invalid request: ${resolved.reason}`, null);
  const key = resolved.key;
  const id = key.id;
  if (id === null || key.source === 'default') {
    return failure(
      400,
      'session-required',
      'This request has no session key: send X-Mock-Session, or a credential named in sessions.keyFrom',
      key,
    );
  }
  store.touch(id);
  if (store.get(id) === undefined) {
    return failure(404, 'session-not-found', `No session ${JSON.stringify(id)} exists; create it with POST`, key);
  }
  const writeKey = parseWriteKey(headers);
  if (writeKey === null || !store.authorize(id, writeKey)) {
    return failure(
      403,
      'session-forbidden',
      'Resetting sequences needs the session write key, sent once in X-Mock-Session-Key; it was absent, repeated, malformed or wrong',
      key,
    );
  }
  if (endpoint === null) store.resetPositions(id);
  else {
    const route = endpointRoute(snapshot, endpoint);
    if (route === null) {
      return failure(404, 'atlas-resource-not-found', 'No endpoint with this ID exists in the current snapshot', key);
    }
    store.resetPositions(id, (position) => position.method === route.method && position.template === route.template);
  }
  return { ok: true, status: 200, document: sessionDocument(context, key, store.get(id)), key };
}

/** The method and template of an endpoint ID of any scenario, or null. */
function endpointRoute(
  snapshot: SnapshotData,
  id: string,
): { readonly method: string; readonly template: string } | null {
  const found: { method: string; template: string }[] = [];
  for (const scenario of snapshot.scenarios.values()) {
    visitRoutes(scenario.root, (node) => {
      const template = templateKey(node.segments);
      for (const method of node.methods.keys()) {
        if (endpointId(scenario.name, method, template) === id) {
          found.push({ method, template: JSON.stringify(template) });
        }
      }
    });
  }
  return found[0] ?? null;
}

function visitRoutes(node: RouteNode, visit: (node: RouteNode) => void): void {
  visit(node);
  for (const child of node.children.values()) visitRoutes(child, visit);
  if (node.param !== null) visitRoutes(node.param.node, visit);
}

/** True when a stored position's sequence is unchanged in the active snapshot. */
export function stillCurrent(snapshot: SnapshotData, position: SequencePosition): boolean {
  let node: RouteNode | undefined = snapshot.scenarios.get(position.scenario)?.root;
  let segments: string[];
  try {
    segments = JSON.parse(position.template) as string[];
  } catch {
    return false;
  }
  for (const segment of segments) {
    if (node === undefined) return false;
    node = /^\{.*\}$/.test(segment) ? node.param?.node : node.children.get(segment);
  }
  // Same segments but renamed parameters is another template: resolve looks
  // positions up by the exact template, so the old one would never be used (review C4).
  if (node === undefined || JSON.stringify(templateKey(node.segments)) !== position.template) return false;
  const controls = node.methods.get(position.method)?.controls;
  if (controls === undefined) return false;
  if (position.kind === 'fault') {
    const rule = controls.fault?.control.rules.find((candidate) => candidate.number === position.rule);
    return rule?.steps != null && faultSignature(rule) === position.signature;
  }
  if (position.rule === null) {
    const steps = controls.sequence?.control.steps;
    return steps !== undefined && sequenceSignature(steps, null) === position.signature;
  }
  const rule = controls.rules?.control.rules.find((candidate) => candidate.number === position.rule);
  return rule?.steps != null && sequenceSignature(rule.steps, rule) === position.signature;
}

/** Describes a session, or the absence of one, at the current instant. */
export function sessionDocument(
  context: Pick<SessionContext, 'store' | 'snapshot' | 'now' | 'config'>,
  key: SessionKey,
  state: SessionState | undefined,
): SessionDocument {
  const max = context.config.idempotency.maxEntries;
  if (state === undefined) {
    return {
      id: key.id,
      source: key.source,
      exists: false,
      scenario: null,
      clock: null,
      createdAt: null,
      lastSeenAt: null,
      expiresAt: null,
      sequences: [],
      replays: { count: 0, max },
    };
  }
  const sequences = context.store
    .positions(state.id)
    .filter((position) => position.position > 1 && stillCurrent(context.snapshot, position))
    .map(({ scenario, endpointId: endpoint, rule, kind, position, steps }) => ({
      scenario,
      endpointId: endpoint,
      rule,
      ...(kind === undefined ? {} : { kind }),
      position,
      steps,
    }))
    .sort(
      (a, b) =>
        compareStrings(a.scenario, b.scenario) ||
        compareStrings(a.endpointId, b.endpointId) ||
        Number('kind' in a) - Number('kind' in b) ||
        (a.rule ?? 0) - (b.rule ?? 0),
    );
  const { clock } = state;
  return {
    id: key.id,
    source: key.source,
    exists: true,
    scenario:
      state.scenario === null ? null : { name: state.scenario, known: context.snapshot.scenarios.has(state.scenario) },
    clock:
      clock === null
        ? null
        : {
            now: rfc3339(sessionInstant(clock, context.now()).instant),
            mode: clock.mode,
            boundAt: rfc3339(clock.boundAt),
          },
    createdAt: rfc3339(state.createdAt),
    lastSeenAt: rfc3339(state.lastSeenAt),
    expiresAt: rfc3339(context.store.expiresAt(state)),
    sequences,
    replays: { count: context.store.replayCount(state.id), max },
  };
}

function failure(status: number, code: RequestErrorCode, message: string, key: SessionKey | null): SessionAnswer {
  return { ok: false, status, code, message, key };
}

/** `application/json`, any case, optionally with parameters such as `charset=utf-8`. */
function isJsonContentType(values: readonly string[] | undefined): boolean {
  if (values?.length !== 1) return false;
  return (values[0] ?? '').split(';')[0]?.trim().toLowerCase() === 'application/json';
}
