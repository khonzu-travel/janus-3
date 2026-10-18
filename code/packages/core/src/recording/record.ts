import type { EngineConfig } from '../config/merge.js';
import { rfc3339 } from '../dynamic/time.js';
import { encodeErrorEnvelope, ERROR_CONTENT_TYPE } from '../errors/index.js';
import { SCENARIO_HEADER } from '../http/session.js';
import type {
  HeaderMap,
  RecordingTrace,
  ResolutionOutcome,
  ResolutionTrace,
  ResponseDescription,
} from '../types/index.js';
import { planCapture } from './capture.js';
import { planRelayedHeaders, planUpstreamRequest, relayedBody } from './forward.js';
import type {
  CaptureFailureEntry,
  CaptureReservation,
  HeaderLine,
  RecordingPorts,
  UpstreamFailureKind,
} from './ports.js';
import { upstreamFailureText } from './ports.js';
import type { Registration } from './registrations.js';
import type { RecordingSlots } from './slots.js';

/** A request that matched a registration and is to be forwarded. */
export interface ForwardIntent {
  readonly registration: Registration;
  readonly params: Readonly<Record<string, string>>;
  readonly scenario: string;
  /** Uppercased. */
  readonly method: string;
  readonly segments: readonly string[];
  /** The request target as received. */
  readonly target: string;
  readonly headers: HeaderMap;
  /** The header lines in the order received, when the transport gave them. */
  readonly headerLines?: readonly HeaderLine[] | undefined;
  /** Decoded. */
  readonly body: Uint8Array | null;
  /** The bytes forwarded upstream: the body as received, codings and all. */
  readonly forwardBody: Uint8Array | null;
  /** The codings removed from `body`, stored as `codings` in `request.json`. */
  readonly codings: readonly string[];
  readonly requestId: string | undefined;
  /** The trace so far: snapshot, scenario, path, session and selection. */
  readonly trace: ResolutionTrace;
}

/** What recording needs from the engine. `active` counts exchanges in progress across requests. */
export interface Recorder {
  readonly ports: RecordingPorts | undefined;
  readonly config: EngineConfig;
  /** The injected wall clock, in epoch ms. */
  readonly clock: () => number;
  readonly slots: RecordingSlots;
  /** `promotion.mode: auto`: promotes a written capture before the response is relayed. */
  readonly promote?: (reservation: CaptureReservation) => Promise<'promoted' | 'skipped' | 'failed'>;
}

type RecordingError = Extract<
  ResolutionOutcome,
  {
    kind:
      | 'recording-unavailable'
      | 'recording-busy'
      | 'recording-capture-failed'
      | 'recording-upstream-failed'
      | 'recording-upstream-timeout'
      | 'recording-response-too-large';
  }
>['kind'];

const FAILURES: Readonly<
  Record<
    UpstreamFailureKind,
    { status: number; code: RecordingError; outcome: CaptureFailureEntry['outcome']; message: string }
  >
> = {
  connect: {
    status: 502,
    code: 'recording-upstream-failed',
    outcome: 'upstream-failed',
    message: 'The upstream could not be reached',
  },
  timeout: {
    status: 504,
    code: 'recording-upstream-timeout',
    outcome: 'upstream-timeout',
    message: 'The upstream did not send a complete response within recording.timeoutMs',
  },
  'too-large': {
    status: 502,
    code: 'recording-response-too-large',
    outcome: 'response-too-large',
    message: 'The upstream response body is larger than recording.maxResponseBytes',
  },
};

/**
 * Records one request: take a slot, claim an
 * exchange, forward, relay, and hand the capture to the sink. A capture
 * failure after the claim never fails the request.
 */
export async function record(
  recorder: Recorder,
  intent: ForwardIntent,
  signal: AbortSignal,
): Promise<ResponseDescription> {
  const { ports, config, slots } = recorder;
  const upstreamOrigin = intent.registration.origin;
  const trace = (recording: RecordingTrace | undefined, outcome: ResolutionOutcome): ResolutionTrace => ({
    ...intent.trace,
    outcome,
    ...(recording === undefined ? {} : { recording }),
  });
  const failure = (
    status: number,
    code: RecordingError,
    message: string,
    recording?: RecordingTrace,
    details?: Readonly<Record<string, unknown>>,
  ): ResponseDescription => ({
    kind: 'response',
    status,
    headers: {
      ...(config.diagnosticHeaders ? { [SCENARIO_HEADER]: [intent.scenario] } : {}),
      'content-type': [ERROR_CONTENT_TYPE],
    },
    body: encodeErrorEnvelope({ code, message, details, requestId: intent.requestId }),
    trace: trace(recording, { kind: code }),
  });

  if (ports === undefined) {
    return failure(501, 'recording-unavailable', 'Recording is not available in this delivery mode');
  }
  if (!slots.tryAcquire()) {
    return failure(
      503,
      'recording-busy',
      `${String(config.recording.maxConcurrent)} recordings are already in progress (recording.maxConcurrent); try again`,
    );
  }
  try {
    let reservation: CaptureReservation;
    try {
      reservation = await ports.captures.claim(intent.scenario);
    } catch {
      return failure(
        500,
        'recording-capture-failed',
        'No exchange could be claimed in the captures directory, so nothing was forwarded',
      );
    }
    const startedAt = recorder.clock();
    const request = planUpstreamRequest(
      intent.registration,
      intent.method,
      intent.segments,
      intent.target,
      intent.headers,
      intent.forwardBody,
      intent.headerLines,
    );
    const response = await ports.upstream
      .send(request, signal)
      .catch(() => ({ kind: 'failure', failure: 'connect', reason: 'unknown' }) as const);
    const finishedAt = recorder.clock();
    const durationMs = Math.max(0, Math.round(finishedAt - startedAt));
    const id = `${reservation.scenario}/${reservation.exchange}`;
    const entry = {
      exchange: reservation.exchange,
      at: rfc3339(finishedAt),
      method: intent.method,
      target: intent.target,
      registration: intent.registration.endpoint.path,
      durationMs,
    };

    if (response.kind === 'failure') {
      const spec = FAILURES[response.failure];
      // Only a connect failure has a reason; it comes from a fixed list, never the upstream's error text.
      const reason = response.failure === 'connect' ? (response.reason ?? 'unknown') : undefined;
      const message =
        reason === undefined
          ? spec.message
          : `${spec.message}: ${upstreamFailureText(reason)}; nothing was received from it`;
      // The sink reports a log it cannot append to in the server log; the caller still gets the failure.
      await ports.captures
        .fail(reservation, { ...entry, outcome: spec.outcome, ...(reason === undefined ? {} : { reason }) })
        .catch(() => undefined);
      return failure(
        spec.status,
        spec.code,
        message,
        {
          scenario: reservation.scenario,
          exchange: reservation.exchange,
          outcome: spec.outcome,
          upstreamMs: durationMs,
          upstream: upstreamOrigin,
          failure: response.failure,
          ...(reason === undefined ? {} : { reason }),
        },
        reason === undefined ? undefined : { reason },
      );
    }

    const plan = planCapture({
      reservation,
      registration: intent.registration,
      request: {
        method: intent.method,
        target: intent.target,
        params: intent.params,
        headers: intent.headers,
        body: intent.body,
        codings: intent.codings,
      },
      response,
      startedAt,
      finishedAt,
    });
    const written = await ports.captures.write(reservation, plan).catch(() => ({ ok: false }) as const);
    const recorded = written.ok ? id : 'failed';
    // A capture that failed to write is never promoted.
    const promoted = written.ok && recorder.promote !== undefined ? await recorder.promote(reservation) : undefined;
    return {
      kind: 'response',
      status: response.status,
      headers: planRelayedHeaders(
        response.headers,
        config.diagnosticHeaders
          ? { scenario: intent.scenario, recorded, ...(promoted === undefined ? {} : { promoted }) }
          : null,
      ),
      body: relayedBody(response.status, response.body),
      trace: trace(
        {
          scenario: reservation.scenario,
          exchange: reservation.exchange,
          outcome: written.ok ? 'captured' : 'capture-failed',
          upstreamMs: durationMs,
          upstream: upstreamOrigin,
        },
        {
          kind: 'recorded',
          registration: { method: intent.registration.endpoint.method, path: intent.registration.endpoint.path },
          status: response.status,
        },
      ),
    };
  } finally {
    slots.release();
  }
}
