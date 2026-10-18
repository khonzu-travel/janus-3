import type { EngineConfig } from '../config/merge.js';
import type { CompressionCoding } from '../config/schema.js';
import { bodyKind } from '../fixtures/body-kind.js';
import type { Fault, FaultRule } from '../fixtures/controls.js';
import { drawLatency } from '../fixtures/latency.js';
import type { ScenarioData, StoredMethod } from '../fixtures/snapshot.js';
import { isBodylessStatus } from '../fixtures/status.js';
import { describeCondition } from '../controls/choose.js';
import { chooseResponseCoding } from '../http/coding.js';
import type { FaultTrace, HeaderMap, HoldTicket, LatencyTrace } from '../types/index.js';

/** Faults, latency and response codings: decisions only. */

/** `X-Mock-Latency` and `X-Mock-Fault`. */
export const LATENCY_HEADER = 'x-mock-latency';
export const FAULT_HEADER = 'x-mock-fault';

/** A ticket for an engine created without a held-connection limit: nothing to release. */
export const UNLIMITED_TICKET: HoldTicket = Object.freeze({ release: () => undefined });

/**
 * A request's latency: the effective method directory's
 * `fault.yaml`, else the selected scenario's along its chain, else
 * `faults.latency`, else none.
 */
export function chooseLatency(
  input: {
    readonly stored: StoredMethod | null;
    readonly scenario: ScenarioData | null;
    readonly method: string;
    /** The route template, or the normalised path for a route miss. */
    readonly route: string;
    readonly requestDigest: () => Uint8Array;
  },
  config: EngineConfig,
): LatencyTrace | null {
  const own = input.stored?.controls.fault?.control.latency ?? null;
  const inherited = input.scenario?.effectiveLatency ?? null;
  let trace: Omit<LatencyTrace, 'ms'>;
  if (own !== null) trace = { source: 'fault-file', profile: own };
  else if (inherited !== null) trace = { source: 'scenario', scenario: inherited.scenario, profile: inherited.profile };
  else if (config.faults.latency !== null) trace = { source: 'config', profile: config.faults.latency };
  else return null;
  const ms =
    'ms' in trace.profile
      ? trace.profile.ms
      : drawLatency(trace.profile, {
          seed: config.seed ?? 0,
          method: input.method,
          route: input.route,
          requestDigest: input.requestDigest(),
        });
  return Object.freeze({ ms, ...trace });
}

/** The fault a rule gives a request at a step, as the trace records it. */
export function faultTrace(rule: FaultRule, fault: Fault, step: number | null): FaultTrace {
  return Object.freeze({
    kind: fault.kind,
    rule: rule.number,
    ...(step === null ? {} : { step }),
    ...(fault.kind === 'truncate' && fault.bytes !== null ? { bytes: fault.bytes } : {}),
    ...(fault.kind === 'malformed' ? { form: fault.form } : {}),
  });
}

/** What identifies a fault sequence across a reload: its rule's number, conditions and steps. */
export function faultSignature(rule: FaultRule): string {
  return JSON.stringify(['fault', rule.number, rule.when.map(describeCondition), rule.steps ?? []]);
}

/** `X-Mock-Fault`: `truncate; rule=2` or `malformed; form=bad-chunk; rule=3; step=1`. */
export function formatFaultHeader(trace: FaultTrace): string {
  let value: string = trace.kind;
  if (trace.form !== undefined) value += `; form=${trace.form}`;
  value += `; rule=${String(trace.rule)}`;
  if (trace.step !== undefined) value += `; step=${String(trace.step)}`;
  return value;
}

/**
 * The coding a response gets, and whether it is compressible at
 * all: compression on, a JSON or text body, a status with a body, and at
 * least `minBytes` bytes.
 */
export function chooseCoding(
  config: EngineConfig,
  request: HeaderMap,
  response: { readonly status: number; readonly contentType: string | null; readonly body: Uint8Array | null },
): { readonly compressible: boolean; readonly coding: CompressionCoding | null } {
  const { enabled, encodings, minBytes } = config.compression;
  const kind = response.contentType === null ? 'binary' : bodyKind(response.contentType);
  const compressible =
    enabled &&
    kind !== 'binary' &&
    !isBodylessStatus(response.status) &&
    response.body !== null &&
    response.body.length >= minBytes;
  return { compressible, coding: compressible ? chooseResponseCoding(request['accept-encoding'], encodings) : null };
}

/**
 * The headers of a compressible response: `Accept-Encoding` added to `Vary`
 * after the names already there and, when a coding applies,
 * `Content-Encoding` and a strong `ETag` made weak.
 */
export function codedHeaders(headers: HeaderMap, coding: CompressionCoding | null): HeaderMap {
  const out: Record<string, readonly string[]> = { ...headers };
  const vary = headers['vary'] ?? [];
  const tokens = new Set(vary.flatMap((value) => value.split(',')).map((token) => token.trim().toLowerCase()));
  if (!tokens.has('*') && !tokens.has('accept-encoding')) {
    out['vary'] =
      vary.length === 0 ? ['Accept-Encoding'] : [...vary.slice(0, -1), `${vary.at(-1) ?? ''}, Accept-Encoding`];
  }
  if (coding !== null) {
    out['content-encoding'] = [coding];
    const etag = headers['etag'];
    if (etag !== undefined)
      out['etag'] = etag.map((value) => (value.trim().startsWith('"') ? `W/${value.trim()}` : value));
  }
  return out;
}
