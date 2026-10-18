import { toHex } from '../bytes.js';
import { CanonicalWriter, canonicalJsonText, compareStrings } from '../canonical.js';
import { expectedOf, firstMatchingRule, pageText, sequenceSignature } from '../controls/choose.js';
import { failing, holds, InvalidRequestBody, jsonBody, MISSING, requestFacts } from '../controls/conditions.js';
import type { FaultRule, Rule } from '../fixtures/controls.js';
import { parseIdempotencyKey } from '../http/idempotency.js';
import type { QueryPair } from '../http/target.js';
import { endpointId } from '../ids.js';
import type { EngineConfig } from '../config/merge.js';
import { encodeErrorEnvelope, ERROR_CONTENT_TYPE, type RequestErrorCode } from '../errors/index.js';
import type { AcceptsPolicy } from '../fixtures/accepts.js';
import { DEFAULT_SCENARIO, RESERVED_SEGMENT, templateKey } from '../fixtures/build.js';
import {
  provenanceOf,
  searchRoute,
  type RepresentationGroup,
  type RepresentationSet,
  type ScenarioData,
  type SnapshotData,
  type StoredMethod,
  type StoredResponse,
} from '../fixtures/snapshot.js';
import { ACCEPT_ANY, chooseMediaType, firstByPreference, parseAccept } from '../http/accept.js';
import { chooseLanguage } from '../http/language.js';
import { parseMediaType } from '../http/media-type.js';
import { parseRecordHeader } from '../http/record.js';
import { normalizeRequest } from '../http/request.js';
import { forwardedHeaderNames } from '../recording/forward.js';
import type { ForwardIntent } from '../recording/record.js';
import { matchRegistration, registrationsOf, upstreamUrl } from '../recording/registrations.js';
import { parseScenarioHeader, RESOLVED_FROM_HEADER, resolveSessionKey, SCENARIO_HEADER } from '../http/session.js';
import { unknownScenario } from '../sessions/scenario-error.js';
import {
  SESSION_CLOCK_OVERRUN,
  sessionInstant,
  type ReplayRecord,
  type SequencePosition,
  type SessionState,
} from '../sessions/store.js';
import { formatPath, formatTemplate } from '../http/target.js';
import { chooseInstant, createEngineClock, type EngineClock } from '../dynamic/clock.js';
import { canonicalRequestDigest, renderFixture } from '../dynamic/render.js';
import { allowedFixtureOrigin, decidePreflight, isPreflightRequest } from './fixture-cors.js';
import {
  chooseCoding,
  chooseLatency,
  codedHeaders,
  FAULT_HEADER,
  faultSignature,
  faultTrace,
  formatFaultHeader,
  LATENCY_HEADER,
  UNLIMITED_TICKET,
} from './transport.js';
import { rfc3339 } from '../dynamic/time.js';
import type {
  ChoiceTrace,
  FaultTrace,
  FixtureRef,
  HeaderMap,
  HttpMethod,
  NegotiationTrace,
  RequestDescription,
  ResolutionOutcome,
  RenderTrace,
  ResolutionTrace,
  ResponseDescription,
  RouteTrace,
  SelectionTrace,
  SequenceTrace,
  TransportCapacity,
  TransportDirective,
  TransportTrace,
} from '../types/index.js';

/** `shadowed` lists at most this many files. */
export const MAX_SHADOWED = 64;

/** The defaults used when an engine is created without configuration. */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = Object.freeze({
  strictTrailingSlash: true,
  onUnknownMethod: 405,
  mediaTypePreference: Object.freeze([]),
  onUnusableAccept: 400,
  onUnacceptable: 406,
  diagnosticHeaders: true,
  now: null,
  clockMode: 'frozen',
  timezone: 'UTC',
  seed: null,
  strictRefs: false,
  defaultScenario: 'default',
  keyFrom: Object.freeze([]),
  idleTimeout: 1800,
  maxSessions: 1000,
  onNoFixture: 404,
  idempotency: Object.freeze({
    enabled: true,
    header: 'idempotency-key',
    methods: Object.freeze(['POST', 'PATCH']),
    maxEntries: 1000,
  }),
  recording: Object.freeze({
    endpoints: Object.freeze([]),
    maxConcurrent: 4,
    timeoutMs: 30000,
    maxResponseBytes: 10485760,
  }),
  promotionMode: 'staged',
  autoOptions: true,
  faults: Object.freeze({ enabled: true, timeoutMs: 120000, maxHeldConnections: 128, latency: null }),
  compression: Object.freeze({
    enabled: true,
    encodings: Object.freeze(['br', 'gzip', 'deflate'] as const),
    minBytes: 1024,
  }),
  fixtureCors: Object.freeze({ origins: Object.freeze([]), credentials: false, maxAge: 600 }),
  xml: true,
});

/** What rendering needs beyond the configuration: the injected clock and entropy. */
export interface DynamicRuntime {
  readonly clock: EngineClock;
  readonly randomBytes: ((count: number) => Uint8Array) | undefined;
}

/** No wall clock and no entropy: dynamic fixtures render only against a requested instant. */
export const NO_RUNTIME: DynamicRuntime = Object.freeze({
  clock: createEngineClock({ now: null, clockMode: 'frozen' }, undefined),
  randomBytes: undefined,
});

/** Diagnostic response headers. Fixtures can never set `X-Mock-*` names. */
export const IDENTITY_HEADER = 'x-mock-identity';
export const REPRESENTATION_HEADER = 'x-mock-representation';
export const WARNING_HEADER = 'x-mock-warning';
/** Set when a response's bytes can differ for the same request. */
export const NONDETERMINISTIC_HEADER = 'x-mock-nondeterministic';
/** The selected scenario, on every response once one was selected. */
export const SCENARIO_RESPONSE_HEADER = SCENARIO_HEADER;
/** Which identity answered and what chose it. */
export const CHOICE_HEADER = 'x-mock-choice';
/** Set on a replayed response. */
export const REPLAYED_HEADER = 'x-mock-replayed';

/** Read-only access to the engine's sessions while resolving. */
export interface SessionReader {
  /** The live session for an ID, or undefined. */
  read(id: string): SessionState | undefined;
  /** The injected wall clock, for `offset` session clocks. */
  now(): number;
  /** A live session's stored position for a sequence key; undefined at step 1. */
  position(id: string, key: string): SequencePosition | undefined;
  /** A live session's replay record for a key. */
  replay(id: string, key: string): ReplayRecord | undefined;
}

/** No sessions: every key names no session. */
export const NO_SESSIONS: SessionReader = Object.freeze({
  read: () => undefined,
  now: () => 0,
  position: () => undefined,
  replay: () => undefined,
});

/** Session changes a served request makes once it is resolved. A simulation makes none. */
export type ResolveEffect =
  | { readonly kind: 'advance'; readonly session: string; readonly key: string; readonly position: SequencePosition }
  | {
      readonly kind: 'store';
      readonly session: string;
      readonly key: string;
      readonly record: ReplayRecord;
      readonly max: number;
    };

export interface Resolution {
  readonly response: ResponseDescription;
  readonly effects: readonly ResolveEffect[];
  /**
   * `head` mode only: true when nothing the head decides refuses the request,
   * so the body may be asked for; `response` is then a placeholder.
   */
  readonly headPassed?: boolean;
  /**
   * A served request to forward instead: `response` is then
   * only a placeholder, and the engine records the exchange.
   */
  readonly forward?: ForwardIntent;
}

/**
 * `serve` answers a real request; `simulate` explains one and changes no
 * session. `plan` and `head` stop before the fault decision
 * and change nothing: `plan` only finds the request's delay,
 * `head` runs the `100-continue` head check.
 */
export type ResolveMode = 'serve' | 'simulate' | 'plan' | 'head';

/**
 * Resolves one request against an immutable snapshot. Pure apart from `sessions.read`: it reads no global state
 * and mutates neither the request nor the snapshot. Misses are complete
 * responses, including the error envelope and `Allow`.
 */
export function resolveRequest(
  snapshot: SnapshotData,
  request: RequestDescription,
  config: EngineConfig = DEFAULT_ENGINE_CONFIG,
  runtime: DynamicRuntime = NO_RUNTIME,
  sessions: SessionReader = NO_SESSIONS,
): ResponseDescription {
  return resolveWithEffects(snapshot, request, config, runtime, sessions, 'serve').response;
}

/** A sequence a request is positioned in. */
interface ActiveSequence {
  readonly rule: number | null;
  readonly steps: readonly string[];
  readonly key: string;
  readonly signature: string;
  readonly position: number;
}

/**
 * `resolveRequest`, also returning the session changes to commit: the sequence position to advance
 * and the replay record to store.
 */
export function resolveWithEffects(
  snapshot: SnapshotData,
  request: RequestDescription,
  config: EngineConfig,
  runtime: DynamicRuntime,
  sessions: SessionReader,
  mode: ResolveMode,
  capacity?: TransportCapacity,
): Resolution {
  const effects: ResolveEffect[] = [];
  const requested = request.scenario ?? DEFAULT_SCENARIO;
  // Transport decisions, filled in as resolution learns them and attached by `done`.
  const transport: {
    scenario: ScenarioData | null;
    stored: StoredMethod | null;
    method: string;
    route: string;
    params: Readonly<Record<string, string>>;
    query: readonly QueryPair[];
    body: Uint8Array | null;
    headers: HeaderMap;
    fault: FaultTrace | null;
    directiveFault: TransportDirective['fault'];
    rulesTried: number;
    faultSequence: TransportTrace['faultSequence'];
    coding: TransportDirective['coding'];
    headBody: Uint8Array | undefined;
    cors: TransportTrace['cors'];
    noCors: boolean;
    close: boolean;
    recorded: boolean;
  } = {
    scenario: null,
    stored: null,
    method: request.method.toUpperCase(),
    route: '',
    params: {},
    query: [],
    body: request.body ?? null,
    headers: request.headers,
    fault: null,
    directiveFault: null,
    rulesTried: 0,
    faultSequence: undefined,
    coding: null,
    headBody: undefined,
    cors: undefined,
    noCors: false,
    close: false,
    recorded: false,
  };
  const faultsOn = config.faults.enabled;
  let active: ScenarioData | null = null;
  const context: { -readonly [K in keyof ResolutionTrace]?: ResolutionTrace[K] } = {};
  // `OPTIONS *` names no path.
  if (request.target === '*' && transport.method === 'OPTIONS' && config.autoOptions) {
    return done(automaticOptions(requested, '', [], null));
  }
  const normalized = normalizeRequest(request, { strictTrailingSlash: config.strictTrailingSlash });
  if (!normalized.ok) {
    return done(
      errorResponse(snapshot, request, config, {
        scenario: requested,
        path: '',
        head: normalized.method === 'HEAD',
        status: 400,
        message: `Invalid request: ${normalized.reason}`,
        outcome: { kind: 'invalid-request', reason: normalized.reason },
      }),
    );
  }

  const { method, pathSegments, headers, body, query } = normalized.request;
  const path = formatPath(pathSegments);
  Object.assign(transport, { method, route: path, query, body, headers });
  const head = method === 'HEAD';
  let scenario = requested;
  const fail = (spec: Omit<ErrorSpec, 'scenario' | 'path' | 'head'>): Resolution =>
    done(errorResponse(snapshot, request, config, { scenario, path, head, active: active?.name, context, ...spec }));
  const invalid = (reason: string, extra: Partial<ErrorSpec> = {}): Resolution =>
    fail({
      status: 400,
      message: `Invalid request: ${reason}`,
      outcome: { kind: 'invalid-request', reason },
      ...extra,
    });

  // 2. The session key.
  const key = resolveSessionKey(headers, config.keyFrom);
  if (!key.ok) return invalid(key.reason);
  const sessionId = key.key.id;
  const session = sessionId === null ? undefined : sessions.read(sessionId);
  context.session = Object.freeze({ id: sessionId, source: key.key.source, exists: session !== undefined });

  // 3. Select the scenario: the first source present decides, and never falls back.
  let source: SelectionTrace['source'];
  if (request.scenario !== undefined) source = 'caller';
  else {
    const header = parseScenarioHeader(headers);
    if (header.kind === 'invalid') return invalid(header.reason);
    if (header.kind === 'name') {
      scenario = header.name;
      source = 'request-header';
    } else if (session?.scenario != null) {
      scenario = session.scenario;
      source = 'session';
    } else if (config.defaultScenario !== DEFAULT_SCENARIO) {
      scenario = config.defaultScenario;
      source = 'config';
    } else {
      scenario = DEFAULT_SCENARIO;
      source = 'default';
    }
  }
  const found = snapshot.scenarios.get(scenario);
  if (found === undefined) {
    const unknown = unknownScenario(scenario, source, [...snapshot.scenarios.keys()]);
    return fail({ status: 400, message: unknown.message, outcome: unknown.outcome, details: unknown.details });
  }
  active = found;
  transport.scenario = found;
  context.selection = Object.freeze({ source, chain: found.chain });

  // With fixture CORS on, Janus answers every preflight from every scenario's routes.
  if (config.fixtureCors.origins.length > 0 && isPreflightRequest(method, headers)) {
    const decision = decidePreflight(snapshot, pathSegments, headers, config.fixtureCors);
    if (decision.ok) {
      transport.cors = 'preflight';
      return done({
        kind: 'response',
        status: 204,
        headers: { ...decision.headers, ...scenarioHeader() },
        body: null,
        trace: {
          snapshotVersion: snapshot.version,
          scenario,
          normalizedPath: path,
          outcome: { kind: 'preflight', allowed: decision.allowed },
          ...context,
        },
      });
    }
    // Refused: the answer a plain OPTIONS gets here, without CORS headers.
    transport.cors = 'preflight-refused';
    transport.noCors = true;
  } else if (allowedFixtureOrigin(headers, config.fixtureCors) !== null) {
    transport.cors = 'actual';
  }

  // 4. Recording skips everything after scenario selection.
  const recordHeader = parseRecordHeader(headers);
  if (recordHeader.kind === 'invalid') return invalid(recordHeader.reason);
  if (recordHeader.kind === 'record' && recordHeader.record) {
    const matched = matchRegistration(registrationsOf(config.recording.endpoints), method, pathSegments);
    if (matched === null) {
      return fail({
        status: 403,
        message: head
          ? 'HEAD requests cannot be recorded'
          : `${method} ${path} is not listed in recording.endpoints, so it cannot be recorded`,
        outcome: { kind: 'recording-not-allowed' },
      });
    }
    const { registration, params } = matched;
    // A recorded request is never delayed, and its head passes once a registration matches.
    transport.recorded = true;
    if (mode === 'head') return { ...done(placeholder()), headPassed: true };
    if (mode === 'plan') return done(placeholder());
    const baseTrace: ResolutionTrace = {
      snapshotVersion: snapshot.version,
      scenario,
      normalizedPath: path,
      outcome: { kind: 'recording-not-allowed' },
      ...context,
    };
    if (mode === 'simulate') {
      // The decision only; nothing is sent, resolved or written.
      return done({
        kind: 'response',
        status: 0,
        headers: {},
        body: null,
        trace: {
          ...baseTrace,
          outcome: {
            kind: 'would-record',
            registration: { method: registration.endpoint.method, path: registration.endpoint.path },
            upstream: upstreamUrl(registration, pathSegments, request.target),
            forwardedHeaders: forwardedHeaderNames(headers),
          },
        },
      });
    }
    return {
      response: { kind: 'response', status: 0, headers: {}, body: null, trace: baseTrace },
      effects,
      forward: Object.freeze({
        registration,
        params,
        scenario,
        method,
        segments: pathSegments,
        target: request.target,
        headers,
        headerLines: request.headerLines,
        body,
        forwardBody: request.receivedBody ?? body,
        codings: Object.freeze([...(request.bodyCodings ?? [])]),
        requestId: request.requestId,
        trace: baseTrace,
      }),
    };
  }

  // 1–2. Match the route by the backtracking walk; bind parameters.
  const { match, considered } = searchRoute(found.root, pathSegments, RESERVED_SEGMENT);
  // A miss still explains which prefixes were tried, when any were.
  const missedRoute: RouteTrace | undefined =
    considered.length === 0
      ? undefined
      : Object.freeze({ template: null, params: Object.freeze({}), considered: Object.freeze(considered) });
  const notFound = (routeMiss: boolean): Resolution =>
    fail({
      // Only a route miss follows `onNoFixture`; the outcome is the same either way.
      ...(routeMiss && config.onNoFixture === 501 ? { status: 501, code: 'not-mocked' as const } : { status: 404 }),
      message: `No fixture matches ${method} ${path}`,
      outcome: { kind: 'route-not-found' },
      ...(missedRoute === undefined ? {} : { route: missedRoute }),
    });
  if (match === undefined) return notFound(true);
  const template = formatTemplate(match.node.segments);
  transport.route = template;
  const route: RouteTrace = Object.freeze({
    template,
    params: Object.freeze(Object.fromEntries(match.params)),
    considered: Object.freeze(considered),
  });
  transport.params = route.params;

  // 3. Select the method; the matched node's methods are authoritative.
  const methods = match.node.methods;
  const storedMethod = methods.has(method) ? method : head && methods.has('GET') ? 'GET' : null;
  const stored = storedMethod === null ? undefined : methods.get(storedMethod);
  // OPTIONS without an OPTIONS directory, answered by Janus; under 404 without Allow.
  if (stored === undefined && method === 'OPTIONS' && config.autoOptions) {
    const allowed = config.onUnknownMethod === 404 ? [] : allowedMethods(methods.keys(), true);
    return done(automaticOptions(scenario, path, allowed, route));
  }
  // Answer as if the path did not exist, disclosing no methods.
  if (stored === undefined && config.onUnknownMethod === 404) return notFound(false);
  if (stored === undefined || storedMethod === null) {
    const allowed = allowedMethods(methods.keys(), config.autoOptions);
    return fail({
      status: 405,
      message: `${method} is not allowed for ${path}; allowed: ${allowed.join(', ')}`,
      outcome: { kind: 'method-not-allowed', allowed },
      extraHeaders: { allow: [allowed.join(', ')] },
      route,
    });
  }

  transport.stored = stored;
  const hidden = match.node.shadowed.get(storedMethod) ?? [];
  context.shadowed = Object.freeze(hidden.slice(0, MAX_SHADOWED));
  if (hidden.length > MAX_SHADOWED) context.shadowedCount = hidden.length;

  // 4. Check the request body against accepts.yaml; the head check uses the declared Content-Type.
  if (stored.accepts !== null && ((body !== null && body.length > 0) || mode === 'head')) {
    const refusal = checkRequestMediaType(stored.accepts, headers['content-type']);
    if (refusal === 'malformed') {
      return invalid('the Content-Type header is not a valid media type', { route });
    }
    if (refusal === 'unsupported') {
      const accepted = stored.accepts.mediaTypes;
      const list = accepted.join(', ');
      const advertise = method === 'POST' ? 'accept-post' : method === 'PATCH' ? 'accept-patch' : null;
      return fail({
        status: 415,
        message: `${method} ${path} does not accept this request body's media type; accepted: ${list}`,
        outcome: { kind: 'unsupported-media-type', accepted },
        extraHeaders: advertise === null ? {} : { [advertise]: [list] },
        route,
      });
    }
  }

  // The delay plan and the head check end before anything is decided.
  if (mode === 'head') return { ...done(placeholder()), headPassed: true };
  if (mode === 'plan') return done(placeholder());

  const ids = new Map(found.ids.map((id) => [id.name, id.value]));
  const facts = requestFacts({ params: route.params, query, headers, body, scenarioIds: ids, xml: config.xml });
  const templateSegments = templateKey(match.node.segments);
  const templateJson = JSON.stringify(templateSegments);
  const endpoint = endpointId(scenario, storedMethod, templateSegments);
  /** The caller's position in a sequence: always step 1 without a session. */
  const positioned = (rule: Rule | null, steps: readonly string[]): ActiveSequence => {
    const sequenceKey = JSON.stringify([scenario, storedMethod, templateJson, rule?.number ?? 0]);
    const signature = sequenceSignature(steps, rule);
    const saved = session === undefined || sessionId === null ? undefined : sessions.position(sessionId, sequenceKey);
    const position =
      saved === undefined || saved.signature !== signature ? 1 : Math.min(Math.max(saved.position, 1), steps.length);
    return { rule: rule?.number ?? null, steps, key: sequenceKey, signature, position };
  };

  // 4. Decide the fault: the first matching rule, at the caller's step for a sequence.
  const faultRules = stored.controls.fault?.control.rules ?? [];
  if (faultRules.length > 0) {
    let decided: FaultRule | null = null;
    try {
      for (const rule of faultRules) {
        transport.rulesTried++;
        if (rule.when.every((condition) => holds(condition, facts))) {
          decided = rule;
          break;
        }
      }
    } catch (error) {
      if (error instanceof InvalidRequestBody) return invalid(error.message, { route });
      throw error;
    }
    if (decided !== null) {
      const steps = decided.steps;
      let step: number | null = null;
      let advance: ResolveEffect | null = null;
      if (steps !== null) {
        const sequenceKey = JSON.stringify([scenario, storedMethod, templateJson, 'fault', decided.number]);
        const signature = faultSignature(decided);
        const saved =
          session === undefined || sessionId === null ? undefined : sessions.position(sessionId, sequenceKey);
        step =
          saved === undefined || saved.signature !== signature
            ? 1
            : Math.min(Math.max(saved.position, 1), steps.length);
        const notAdvancedBecause = head
          ? ('head' as const)
          : session === undefined || sessionId === null
            ? ('no-session' as const)
            : mode === 'simulate'
              ? ('simulation' as const)
              : null;
        const advances = notAdvancedBecause === null && faultsOn && sessionId !== null;
        transport.faultSequence = Object.freeze({
          position: step,
          steps: steps.length,
          advanced: advances,
          ...(notAdvancedBecause === null ? {} : { notAdvancedBecause }),
        });
        if (advances) {
          advance = {
            kind: 'advance',
            session: sessionId,
            key: sequenceKey,
            position: {
              scenario,
              method: storedMethod,
              template: templateJson,
              endpointId: endpoint,
              rule: decided.number,
              kind: 'fault',
              position: Math.min(step + 1, steps.length),
              steps: steps.length,
              signature,
            },
          };
        }
      }
      const fault = steps === null ? decided.fault : steps[(step ?? 1) - 1];
      if (fault !== null && fault !== undefined) {
        transport.fault = faultTrace(decided, fault, step);
        const kind = fault.kind;
        if (kind === 'reset' || kind === 'timeout') {
          if (mode === 'simulate' || !faultsOn) {
            // Described, not performed: a simulation or disabled faults still report the decision.
            if (mode === 'simulate') return done(faultResponse(kind, route));
          } else if (kind === 'reset') {
            if (advance !== null) effects.push(advance);
            transport.directiveFault = { kind: 'reset' };
            return done(faultResponse(kind, route));
          } else {
            const ticket = capacity === undefined ? UNLIMITED_TICKET : capacity.tryHold();
            if (ticket === null) {
              // A full held-connection limit performs nothing and consumes no step.
              if (transport.faultSequence !== undefined) {
                transport.faultSequence = { ...transport.faultSequence, advanced: false };
              }
              transport.close = true;
              return fail({
                status: 503,
                message: `Every held connection is in use (faults.maxHeldConnections is ${String(config.faults.maxHeldConnections)}), so the timeout fault was not performed`,
                outcome: { kind: 'fault-capacity-exceeded' },
                extraHeaders: { connection: ['close'] },
                route,
              });
            }
            if (advance !== null) effects.push(advance);
            transport.directiveFault = { kind: 'timeout', holdMs: config.faults.timeoutMs, ticket };
            return done(faultResponse(kind, route));
          }
        } else {
          if (advance !== null) effects.push(advance);
          if (faultsOn && mode === 'serve') {
            if (kind === 'truncate') transport.directiveFault = { kind: 'truncate', bytes: fault.bytes };
            else if (kind === 'malformed') transport.directiveFault = { kind: 'malformed', form: fault.form };
          }
        }
      }
    }
  }

  // 4. Replay a retried request.
  let pendingReplay: { readonly key: string; readonly fingerprint: string } | null = null;
  const idempotency = config.idempotency;
  if (idempotency.enabled && idempotency.methods.includes(method)) {
    const parsed = parseIdempotencyKey(headers[idempotency.header], displayHeader(idempotency.header));
    if (parsed.kind === 'invalid') return invalid(parsed.reason, { route });
    if (parsed.kind === 'key') {
      if (session === undefined || sessionId === null) {
        context.replay = { outcome: 'no-session' };
      } else {
        const recordKey = JSON.stringify([scenario, parsed.key]);
        const fingerprint = requestFingerprint(method, template, path, query, headers, body);
        const record = sessions.replay(sessionId, recordKey);
        if (record !== undefined && record.fingerprint === fingerprint) {
          return done(replayed(record, mode === 'serve' ? 'replayed' : 'would-replay'));
        }
        if (record !== undefined) {
          context.replay = { outcome: 'key-reused' };
          return fail({
            status: 422,
            message: `This ${displayHeader(idempotency.header)} was already used for a different request; use a new key`,
            outcome: { kind: 'idempotency-key-reused' },
            route,
          });
        }
        pendingReplay = { key: recordKey, fingerprint };
        context.replay = { outcome: 'not-stored' };
      }
    }
  }

  // 5–6. Check expect.yaml, then choose the identity.
  const controls = stored.controls;
  let chosen: { identity: string; trace: Omit<ChoiceTrace, 'identity' | 'rulesTried'> } | null = null;
  let rulesTried = 0;
  let sequence: ActiveSequence | null = null;
  try {
    if (controls.expect !== null) {
      const failed = failing(controls.expect.control.expect, facts);
      context.expect = Object.freeze({
        passed: failed.length === 0,
        failed: Object.freeze(failed.map((condition) => condition.reference.text)),
      });
      if (failed.length > 0) {
        const onMismatch = controls.expect.control.onMismatch;
        if (onMismatch === null) {
          return fail({
            status: 422,
            message: `the request does not match expect.yaml for ${storedMethod} ${template}`,
            outcome: { kind: 'expectation-failed', failed: context.expect.failed },
            details: {
              failed: failed.map((condition) => ({
                reference: condition.reference.text,
                expected: expectedOf(condition, ids),
              })),
            },
            route,
          });
        }
        chosen = { identity: onMismatch, trace: { by: 'expect' } };
      }
    }
    if (chosen === null && controls.rules !== null) {
      const matched = firstMatchingRule(controls.rules.control.rules, facts);
      rulesTried = matched.tried;
      const rule = matched.rule;
      if (rule !== null && rule.serve !== null)
        chosen = { identity: rule.serve, trace: { by: 'rule', rule: rule.number } };
      else if (rule !== null && rule.steps !== null) {
        sequence = positioned(rule, rule.steps);
        chosen = {
          identity: rule.steps[sequence.position - 1] ?? '',
          trace: { by: 'rule', rule: rule.number, step: sequence.position },
        };
      }
    }
    if (chosen === null && controls.pages !== null) {
      const pages = controls.pages.control;
      const text = pageText(pages.by, facts);
      const entry = text === MISSING || text === null ? undefined : pages.pages.find(([page]) => page === text);
      if (entry !== undefined) {
        chosen = { identity: entry[1], trace: { by: 'page', page: { key: entry[0], via: 'value' } } };
      } else if (text === MISSING && pages.whenAbsent !== null) {
        const absent = pages.pages.find(([page]) => page === pages.whenAbsent);
        if (absent !== undefined) {
          chosen = { identity: absent[1], trace: { by: 'page', page: { key: absent[0], via: 'whenAbsent' } } };
        }
      } else if (text !== MISSING && pages.otherwise !== null) {
        chosen = { identity: pages.otherwise, trace: { by: 'page', page: { key: null, via: 'otherwise' } } };
      }
    }
  } catch (error) {
    if (error instanceof InvalidRequestBody) return invalid(error.message, { route });
    throw error;
  }
  const fileSequence = controls.sequence === null ? null : positioned(null, controls.sequence.control.steps);
  if (chosen === null && fileSequence !== null) {
    sequence = fileSequence;
    chosen = {
      identity: fileSequence.steps[fileSequence.position - 1] ?? '',
      trace: { by: 'sequence', step: fileSequence.position },
    };
  }
  const describedSequence = sequence ?? fileSequence;
  const notAdvanced = (reason: NonNullable<SequenceTrace['notAdvancedBecause']>): SequenceTrace =>
    Object.freeze({
      rule: describedSequence?.rule ?? null,
      position: describedSequence?.position ?? 1,
      steps: describedSequence?.steps.length ?? 0,
      advanced: false,
      notAdvancedBecause: reason,
    });
  if (describedSequence !== null) notAdvancedSequence();
  if (chosen !== null) context.choice = Object.freeze({ identity: chosen.identity, ...chosen.trace, rulesTried });

  // 7. Negotiate within the chosen identity, or across every plain response.
  const set: RepresentationSet =
    chosen === null ? stored : (stored.identities.get(chosen.identity) ?? { fallback: null, localized: [] });

  // 7a. Locale selects a representation group.
  const languageHeader = headers['accept-language'];
  const localized = selectGroup(set, languageHeader);
  const language: NegotiationTrace['language'] =
    set.localized.length === 0
      ? undefined
      : {
          requested: languageHeader === undefined || localized.kind === 'none' ? null : localized.range,
          selected: localized.kind === 'group' ? localized.group.locale : null,
        };
  if (localized.kind === 'none') {
    const available = Object.freeze(set.localized.map((group) => group.locale ?? ''));
    return fail({
      status: 406,
      message: `No response for ${method} ${path} matches Accept-Language; available: ${available.join(', ')}`,
      outcome: { kind: 'not-acceptable', axis: 'language', available },
      extraHeaders: { vary: ['Accept-Language'] },
      route,
      negotiation: { ...(language === undefined ? {} : { language }) },
    });
  }
  const group = localized.group;

  // 7b. Media type selects one file of the group; a bodyless group skips it.
  let selected: StoredResponse | undefined = group.representations[0];
  let mediaTypeTrace: NegotiationTrace['mediaType'];
  let droppedRanges: readonly string[] = [];
  if (!group.bodyless) {
    const accept = parseAccept(headers['accept']);
    droppedRanges = accept.dropped;
    const available = Object.freeze(group.representations.map((entry) => entry.mediaType ?? ''));
    const usable = accept.ranges.length > 0 || !accept.present;
    if (!usable && config.onUnusableAccept === 400) {
      return invalid('the Accept header has no usable media range', {
        route,
        negotiation: {
          ...(language === undefined ? {} : { language }),
          mediaType: { requested: null, available, selected: null, droppedRanges: accept.droppedPositions },
        },
      });
    }
    const ranges = accept.ranges.length > 0 ? accept.ranges : ACCEPT_ANY;
    const preferred = chooseMediaType(ranges, available, config.mediaTypePreference);
    let picked = preferred?.mediaType ?? null;
    if (picked === null && chosen === null && config.onUnacceptable === 'ignore') {
      picked = firstByPreference(available, config.mediaTypePreference);
    }
    mediaTypeTrace = {
      requested: preferred === null || !accept.present ? null : preferred.range.text,
      available,
      selected: picked,
      droppedRanges: accept.droppedPositions,
    };
    const negotiation = { ...(language === undefined ? {} : { language }), mediaType: mediaTypeTrace };
    if (picked === null) {
      const vary = set.localized.length > 0 ? 'Accept, Accept-Language' : 'Accept';
      return fail({
        status: 406,
        message: `No response for ${method} ${path} matches Accept; available: ${available.join(', ')}`,
        outcome: { kind: 'not-acceptable', axis: 'media-type', available },
        extraHeaders: { vary: [vary] },
        route,
        negotiation,
      });
    }
    selected = group.representations.find((entry) => entry.mediaType === picked);
  }
  if (selected === undefined) throw new Error('a representation group is never empty');
  // For the plain responses the selected file decides the identity.
  const choice: ChoiceTrace = Object.freeze(
    chosen === null
      ? { identity: selected.identity, by: 'plain' as const, rulesTried }
      : { identity: chosen.identity, ...chosen.trace, rulesTried },
  );
  context.choice = choice;

  // The header policy ran at load; add the diagnostic headers last.
  const negotiation: NegotiationTrace = {
    ...(language === undefined ? {} : { language }),
    ...(mediaTypeTrace === undefined ? {} : { mediaType: mediaTypeTrace }),
  };
  const negotiated = Object.keys(negotiation).length === 0 ? {} : { negotiation };

  // 8. Render dynamic values. HEAD renders exactly as GET.
  let served: { readonly headers: HeaderMap; readonly body: Uint8Array | null } = selected;
  let render: RenderTrace | undefined;
  let nondeterministic = false;
  const dynamic = selected.dynamic;
  if (dynamic !== null) {
    const tokens = dynamic.tokens.length;
    let instant = 0;
    let moving = false;
    if (tokens > 0) {
      const clock = session?.clock ?? null;
      const shown = clock === null ? null : sessionInstant(clock, sessions.now());
      const instantChoice = chooseInstant(
        runtime.clock,
        request.nowMs,
        headers,
        clock === null || shown === null ? null : { instant: shown.instant, mode: clock.mode },
      );
      if (!instantChoice.ok && instantChoice.kind === 'invalid-request') {
        return invalid(instantChoice.reason, { route, ...negotiated });
      }
      if (!instantChoice.ok || (instantChoice.source === 'session' && shown?.overrun === true)) {
        const reason = instantChoice.ok ? SESSION_CLOCK_OVERRUN : instantChoice.reason;
        return renderFailed(selected, dynamic.tokens[0]?.expression ?? '', reason, { route, ...negotiated });
      }
      instant = instantChoice.instant;
      moving = instantChoice.moving;
      render = { instant: rfc3339(instant), clockSource: instantChoice.source, tokens, nondeterministic: false };
    }
    const renderMethod = head && !methods.has('HEAD') ? 'GET' : method;
    const rendered = renderFixture(
      dynamic,
      selected,
      { method: renderMethod, routeTemplate: template, params: route.params, query, headers, body },
      {
        instant,
        timezone: config.timezone,
        seed: config.seed ?? 0,
        strictRefs: config.strictRefs,
        randomBytes: runtime.randomBytes,
        fixtureId: selected.id,
        status: selected.status,
        preview: false,
        context: {
          scenario,
          ids,
          sequencePosition: sequence?.position ?? fileSequence?.position ?? null,
        },
      },
    );
    if (!rendered.ok && rendered.kind === 'invalid-request') return invalid(rendered.reason, { route, ...negotiated });
    if (!rendered.ok) return renderFailed(selected, rendered.token, rendered.reason, { route, ...negotiated });
    served = { headers: rendered.headers, body: rendered.body ?? selected.body };
    nondeterministic = dynamic.usesUnique || (moving && dynamic.usesInstant);
    if (render !== undefined) render = { ...render, nondeterministic };
  }

  // 9. Advance the sequence that chose the response, and store the replay record.
  if (describedSequence !== null) {
    let trace: SequenceTrace;
    if (sequence === null) trace = notAdvanced('not-chosen');
    else if (head) trace = notAdvanced('head');
    else if (session === undefined || sessionId === null) trace = notAdvanced('no-session');
    else if (mode === 'simulate') trace = notAdvanced('simulation');
    else {
      trace = Object.freeze({
        rule: sequence.rule,
        position: sequence.position,
        steps: sequence.steps.length,
        advanced: true,
      });
      effects.push({
        kind: 'advance',
        session: sessionId,
        key: sequence.key,
        position: {
          scenario,
          method: storedMethod,
          template: templateJson,
          endpointId: endpoint,
          rule: sequence.rule,
          position: Math.min(sequence.position + 1, sequence.steps.length),
          steps: sequence.steps.length,
          signature: sequence.signature,
        },
      });
    }
    context.sequence = trace;
  }

  if (pendingReplay !== null && sessionId !== null) {
    if (mode === 'serve') {
      context.replay = { outcome: 'stored' };
      effects.push({
        kind: 'store',
        session: sessionId,
        key: pendingReplay.key,
        max: idempotency.maxEntries,
        record: Object.freeze({
          fingerprint: pendingReplay.fingerprint,
          status: selected.status,
          headers: served.headers,
          body: served.body === null ? null : served.body.slice(),
          meta: Object.freeze({
            fixtureId: selected.id,
            source: selected.source,
            representation: selected.contentTypeOverride?.representation ?? null,
            contentTypeOverride: selected.contentTypeOverride,
            dropped: Object.freeze(selected.dropped.map((header) => header.name)),
            nondeterministic,
            scenario,
            resolvedFrom: selected.scenario,
            choice,
          }),
        }),
      });
    }
  }

  const trace: ResolutionTrace = {
    snapshotVersion: snapshot.version,
    scenario,
    normalizedPath: path,
    outcome: { kind: 'matched', fixture: fixtureRef(snapshot, selected.source) },
    route,
    ...negotiated,
    headers: {
      identity: selected.id,
      dropped: Object.freeze(selected.dropped.map((header) => header.name)),
      contentTypeOverride: selected.contentTypeOverride,
    },
    ...(render === undefined ? {} : { render }),
    ...context,
    resolvedFrom: selected.scenario,
  };
  let responseHeaders = config.diagnosticHeaders
    ? withDiagnostics(selected, served.headers, droppedRanges, nondeterministic, scenario, choice)
    : served.headers;
  // HEAD carries the length GET would send, so the two agree.
  if (head && served.body !== null) {
    responseHeaders = { ...responseHeaders, 'content-length': [String(served.body.length)] };
  }
  // 6. Choose the response coding.
  responseHeaders = withCoding(selected.status, selected.mediaType, served.body, responseHeaders);
  return done({
    kind: 'response',
    status: selected.status,
    headers: responseHeaders,
    body: head || served.body === null ? null : served.body === selected.body ? served.body.slice() : served.body,
    trace,
  });

  function done(response: ResponseDescription): Resolution {
    return { response: withTransport(response), effects };
  }

  /** Attaches the transport directive and trace, and `X-Mock-Latency` / `X-Mock-Fault`. */
  function withTransport(response: ResponseDescription): ResponseDescription {
    const latency = transport.recorded
      ? null
      : chooseLatency(
          {
            stored: transport.stored,
            scenario: transport.scenario,
            method: transport.method,
            route: transport.route,
            requestDigest: () =>
              canonicalRequestDigest({
                params: transport.params,
                query: transport.query,
                body: transport.body,
                headers: transport.headers,
              }),
          },
          config,
        );
    const delayMs = faultsOn && latency !== null ? latency.ms : 0;
    const performed = faultsOn && mode === 'serve';
    let headers = response.headers;
    if (config.diagnosticHeaders && response.status !== 0) {
      const extra: Record<string, readonly string[]> = {};
      if (delayMs > 0) extra[LATENCY_HEADER] = [String(delayMs)];
      const fault = transport.fault;
      if (faultsOn && fault !== null && (fault.kind === 'truncate' || fault.kind === 'malformed')) {
        extra[FAULT_HEADER] = [formatFaultHeader(fault)];
      }
      if (Object.keys(extra).length > 0) headers = { ...headers, ...extra };
    }
    const trace: TransportTrace = Object.freeze({
      latency,
      fault: transport.fault,
      rulesTried: transport.rulesTried,
      ...(transport.faultSequence === undefined ? {} : { faultSequence: transport.faultSequence }),
      performed,
      requestCodings: Object.freeze([...(request.bodyCodings ?? [])]),
      responseCoding: transport.coding,
      ...(transport.cors === undefined ? {} : { cors: transport.cors }),
    });
    const directive: TransportDirective = Object.freeze({
      delayMs,
      fault: transport.directiveFault,
      coding: transport.coding,
      ...(transport.headBody === undefined ? {} : { headBody: transport.headBody }),
      ...(transport.noCors || transport.recorded ? { noCors: true } : {}),
      ...(transport.close ? { close: true } : {}),
    });
    return { ...response, headers, trace: { ...response.trace, transport: trace }, transport: directive };
  }

  /** A placeholder for the `plan` and `head` modes, and for a forwarded request. */
  function placeholder(): ResponseDescription {
    return {
      kind: 'response',
      status: 0,
      headers: {},
      body: null,
      trace: {
        snapshotVersion: snapshot.version,
        scenario,
        normalizedPath: path,
        outcome: { kind: 'route-not-found' },
        ...context,
      },
    };
  }

  /** `X-Mock-Scenario` once a scenario was selected, as errors carry it. */
  function scenarioHeader(): HeaderMap {
    return active !== null && config.diagnosticHeaders ? { [SCENARIO_RESPONSE_HEADER]: [active.name] } : {};
  }

  /** `OPTIONS` answered by Janus: `204`, with `Allow` unless `allowed` is empty. */
  function automaticOptions(
    name: string,
    at: string,
    allowed: readonly HttpMethod[],
    matched: RouteTrace | null,
  ): ResponseDescription {
    return {
      kind: 'response',
      status: 204,
      headers: { ...(allowed.length === 0 ? {} : { allow: [allowed.join(', ')] }), ...scenarioHeader() },
      body: null,
      trace: {
        snapshotVersion: snapshot.version,
        scenario: name,
        normalizedPath: at,
        outcome: { kind: 'automatic-options', allowed },
        ...(matched === null ? {} : { route: matched }),
        ...context,
      },
    };
  }

  /** A `reset` or `timeout`: no response is produced. */
  function faultResponse(kind: 'reset' | 'timeout', matched: RouteTrace): ResponseDescription {
    return {
      kind: 'response',
      status: 0,
      headers: {},
      body: null,
      trace: {
        snapshotVersion: snapshot.version,
        scenario,
        normalizedPath: path,
        outcome: { kind: 'fault', fault: kind },
        route: matched,
        ...context,
      },
    };
  }

  /** `Vary`, `Content-Encoding` and a weak `ETag` for a compressible response, and the coding. */
  function withCoding(
    status: number,
    contentType: string | null,
    getBody: Uint8Array | null,
    responseHeaders: HeaderMap,
  ): HeaderMap {
    const { compressible, coding } = chooseCoding(config, headers, { status, contentType, body: getBody });
    if (!compressible) return responseHeaders;
    transport.coding = coding;
    let coded = codedHeaders(responseHeaders, coding);
    if (coding !== null && head && getBody !== null) {
      // The adapter compresses GET's body to send the compressed length.
      transport.headBody = getBody;
      const { 'content-length': _length, ...rest } = coded;
      coded = rest;
    }
    return coded;
  }

  /** Marks the sequence trace as not advanced until a fixture answers. */
  function notAdvancedSequence(): void {
    context.sequence = notAdvanced(sequence === null ? 'not-chosen' : 'not-served');
  }

  /** The stored response of a retried request, with its diagnostic headers rebuilt. */
  function replayed(record: ReplayRecord, outcome: 'replayed' | 'would-replay'): ResponseDescription {
    const { meta } = record;
    let replayHeaders: HeaderMap = record.headers;
    if (config.diagnosticHeaders) {
      const rebuilt: Record<string, readonly string[]> = {
        ...record.headers,
        [IDENTITY_HEADER]: [meta.fixtureId],
        [SCENARIO_RESPONSE_HEADER]: [meta.scenario],
        [RESOLVED_FROM_HEADER]: [meta.resolvedFrom],
        [CHOICE_HEADER]: [formatChoice(meta.choice)],
        [REPLAYED_HEADER]: ['true'],
      };
      if (meta.nondeterministic) rebuilt[NONDETERMINISTIC_HEADER] = ['true'];
      if (meta.representation !== null) rebuilt[REPRESENTATION_HEADER] = [meta.representation];
      replayHeaders = rebuilt;
    }
    context.replay = { outcome };
    // A replay is compressed by the request that receives it.
    const replayType = record.headers['content-type'];
    replayHeaders = withCoding(
      record.status,
      replayType?.length === 1 ? (replayType[0] ?? null) : null,
      record.body,
      replayHeaders,
    );
    return {
      kind: 'response',
      status: record.status,
      headers: replayHeaders,
      body: record.body === null ? null : record.body.slice(),
      trace: {
        snapshotVersion: snapshot.version,
        scenario,
        normalizedPath: path,
        outcome: { kind: 'matched', fixture: fixtureRef(snapshot, meta.source) },
        route,
        headers: { identity: meta.fixtureId, dropped: meta.dropped, contentTypeOverride: meta.contentTypeOverride },
        ...context,
        choice: meta.choice,
        resolvedFrom: meta.resolvedFrom,
      },
    };
  }

  function renderFailed(
    response: StoredResponse,
    token: string,
    reason: string,
    extra: Pick<ErrorSpec, 'route' | 'negotiation'>,
  ): Resolution {
    return fail({
      status: 500,
      message: `Fixture ${response.id} could not be rendered at {{$${token}}}: ${reason}`,
      outcome: { kind: 'render-failed', fixture: { path: response.source }, token, reason },
      ...extra,
    });
  }
}

/** The configured key header as people write it: `idempotency-key` → `Idempotency-Key`. */
function displayHeader(name: string): string {
  return name.replace(/(^|-)([a-z])/g, (_match, dash: string, letter: string) => dash + letter.toUpperCase());
}

/**
 * The fingerprint a replay compares: method, route template,
 * normalised path, sorted query pairs and the body, JSON canonicalised.
 */
function requestFingerprint(
  method: string,
  template: string,
  path: string,
  query: readonly QueryPair[],
  headers: HeaderMap,
  body: Uint8Array | null,
): string {
  const writer = new CanonicalWriter().string('janus-replay/1').string(method).string(template).string(path);
  const pairs = [...query].sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]));
  writer.number(pairs.length);
  for (const [name, value] of pairs) writer.string(name).string(value);
  if (body === null || body.length === 0) writer.string('no-body');
  else {
    const canonical = canonicalJsonBody(body, headers);
    if (canonical === null) writer.string('bytes').bytes(body);
    else writer.string('json').string(canonical);
  }
  return toHex(writer.digest());
}

/** A JSON body with sorted keys and no insignificant whitespace, or null when it is not one or nests too deep. */
function canonicalJsonBody(body: Uint8Array, headers: HeaderMap): string | null {
  let value: unknown;
  try {
    value = jsonBody(body, headers);
  } catch {
    return null;
  }
  return value === MISSING ? null : canonicalJsonText(value);
}

/** `X-Mock-Choice`: `200.empty; by=rule; rule=2`. */
export function formatChoice(choice: ChoiceTrace): string {
  let value = `${choice.identity}; by=${choice.by}`;
  if (choice.rule !== undefined) value += `; rule=${String(choice.rule)}`;
  if (choice.step !== undefined) value += `; step=${String(choice.step)}`;
  return value;
}

type GroupChoice =
  | { readonly kind: 'group'; readonly group: RepresentationGroup; readonly range: string | null }
  | { readonly kind: 'none' };

/** Picks a representation group for `Accept-Language`. */
function selectGroup(stored: RepresentationSet, acceptLanguage: readonly string[] | undefined): GroupChoice {
  if (stored.localized.length === 0) {
    return stored.fallback === null ? { kind: 'none' } : { kind: 'group', group: stored.fallback, range: null };
  }
  const choice = chooseLanguage(
    acceptLanguage,
    stored.localized.map((group) => group.key ?? ''),
    stored.fallback !== null,
  );
  if (choice.kind === 'fallback' && stored.fallback !== null) {
    return { kind: 'group', group: stored.fallback, range: choice.range };
  }
  if (choice.kind === 'tag') {
    const group = stored.localized.find((entry) => entry.key === choice.key);
    if (group !== undefined) return { kind: 'group', group, range: choice.range };
  }
  return { kind: 'none' };
}

/** For a request with a non-empty body and a method with `accepts.yaml`. */
function checkRequestMediaType(
  accepts: AcceptsPolicy,
  contentType: readonly string[] | undefined,
): 'accepted' | 'unsupported' | 'malformed' {
  if (contentType === undefined || contentType.length === 0) {
    return accepts.allowMissingContentType === null ? 'unsupported' : 'accepted';
  }
  const parsed = contentType.length === 1 ? parseMediaType(contentType[0] ?? '') : null;
  if (parsed === null) return 'malformed';
  const essence = `${parsed.type}/${parsed.subtype}`;
  return accepts.mediaTypes.some((entry) => entry.toLowerCase() === essence) ? 'accepted' : 'unsupported';
}

/**
 * Adds `X-Mock-Identity`, `X-Mock-Representation` and `X-Mock-Warning`, `X-Mock-Nondeterministic`, `X-Mock-Scenario`
 * and `X-Mock-Resolved-From`, and `X-Mock-Choice`.
 */
function withDiagnostics(
  response: StoredResponse,
  served: HeaderMap,
  droppedRanges: readonly string[],
  nondeterministic: boolean,
  scenario: string,
  choice: ChoiceTrace,
): HeaderMap {
  const headers: Record<string, readonly string[]> = {
    ...served,
    [IDENTITY_HEADER]: [response.id],
    [SCENARIO_RESPONSE_HEADER]: [scenario],
    [RESOLVED_FROM_HEADER]: [response.scenario],
    [CHOICE_HEADER]: [formatChoice(choice)],
  };
  if (nondeterministic) headers[NONDETERMINISTIC_HEADER] = ['true'];
  if (response.contentTypeOverride !== null) {
    headers[REPRESENTATION_HEADER] = [response.contentTypeOverride.representation];
  }
  if (droppedRanges.length > 0) {
    headers[WARNING_HEADER] = droppedRanges.map((range) => `199 janus "ignored Accept range ${range}"`);
  }
  return headers;
}

/** Sorted methods for `Allow`; `HEAD` is implied by `GET`, and `OPTIONS` by automatic OPTIONS. */
function allowedMethods(methods: Iterable<HttpMethod>, options = false): readonly HttpMethod[] {
  const allowed = new Set(methods);
  if (allowed.has('GET')) allowed.add('HEAD');
  if (options) allowed.add('OPTIONS');
  return Object.freeze([...allowed].sort(compareStrings));
}

interface ErrorSpec {
  readonly scenario: string;
  readonly path: string;
  readonly head: boolean;
  readonly status: number;
  readonly message: string;
  readonly outcome: Exclude<
    ResolutionOutcome,
    { kind: 'matched' | 'would-record' | 'recorded' | 'fault' | 'automatic-options' | 'preflight' }
  >;
  /** The envelope's code when it differs from the outcome: `not-mocked`. */
  readonly code?: RequestErrorCode;
  readonly extraHeaders?: HeaderMap;
  readonly route?: RouteTrace;
  readonly negotiation?: NegotiationTrace;
  /** Error members after `message`. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** The selected scenario, once one was: errors then carry `X-Mock-Scenario`. */
  readonly active?: string | undefined;
  /** Trace fields known so far: the session, selection and shadowed files. */
  readonly context?: Partial<ResolutionTrace>;
}

/**
 * Janus-generated errors carry no `X-Mock-*` header apart from
 * `X-Mock-Scenario` once a scenario was selected: the envelope names the outcome.
 */
function errorResponse(
  snapshot: SnapshotData,
  request: RequestDescription,
  config: EngineConfig,
  spec: ErrorSpec,
): ResponseDescription {
  const code: RequestErrorCode = spec.code ?? spec.outcome.kind;
  const scenarioHeader =
    spec.active !== undefined && config.diagnosticHeaders ? { [SCENARIO_RESPONSE_HEADER]: [spec.active] } : {};
  const body = encodeErrorEnvelope({
    code,
    message: spec.message,
    details: spec.details,
    requestId: request.requestId,
  });
  // HEAD carries the length of the envelope it withholds, as for a fixture.
  const length = spec.head ? { 'content-length': [String(body.length)] } : {};
  return {
    kind: 'response',
    status: spec.status,
    headers: { ...spec.extraHeaders, ...scenarioHeader, 'content-type': [ERROR_CONTENT_TYPE], ...length },
    body: spec.head ? null : body,
    trace: {
      snapshotVersion: snapshot.version,
      scenario: spec.scenario,
      normalizedPath: spec.path,
      outcome: spec.outcome,
      ...(spec.route === undefined ? {} : { route: spec.route }),
      ...(spec.negotiation === undefined ? {} : { negotiation: spec.negotiation }),
      ...spec.context,
    },
  };
}

/** The served file, with its capture and review state when it was promoted. */
function fixtureRef(snapshot: SnapshotData, source: string): FixtureRef {
  const record = provenanceOf(snapshot, source);
  return record === undefined
    ? { path: source }
    : { path: source, provenance: { capture: record.entry.capture, review: record.entry.review } };
}
