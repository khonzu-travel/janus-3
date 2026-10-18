import { compareStrings } from '../canonical.js';
import type { RequestDescription, ResponseDescription } from '../types/index.js';
import { previewBody, type AtlasProjection } from './atlas.js';
import type { AtlasExplanation, AtlasResponseHeader } from './types.js';

/**
 * Caveats every simulation carries. Stable sentences: clients
 * may match on them.
 */
export const SIMULATION_NOTES: readonly string[] = Object.freeze([
  'transport limits (413, 414, 431) are not simulated',
]);

/** Added when a simulated request would be forwarded. */
export const WOULD_RECORD_NOTE = 'nothing was sent: a simulation never contacts the upstream or writes a capture';

/** Added when they apply. */
export const TRANSPORT_NOTE = 'faults and latency are described, not performed';
export const CODINGS_NOTE = 'content codings are not simulated';
export const EXPECT_NOTE = 'Expect is not simulated';

/**
 * Projects a resolved response for the explorer: headers as served, the body
 * as a preview, and the fixture's Atlas identity. A `reset` or `timeout`
 * has no response.
 */
export function explainResponse(
  response: ResponseDescription,
  atlas: AtlasProjection,
  request?: RequestDescription,
): AtlasExplanation {
  const transport = response.trace.transport;
  const extra = [
    ...(transport !== undefined && (transport.latency !== null || transport.fault !== null) ? [TRANSPORT_NOTE] : []),
    ...(request?.headers['content-encoding'] === undefined ? [] : [CODINGS_NOTE]),
    ...(request?.headers['expect'] === undefined ? [] : [EXPECT_NOTE]),
  ];
  const notes = extra.length === 0 ? SIMULATION_NOTES : Object.freeze([...SIMULATION_NOTES, ...extra]);
  if (response.trace.outcome.kind === 'fault') {
    return {
      snapshotVersion: response.trace.snapshotVersion,
      response: null,
      trace: response.trace,
      fixture: null,
      shadowed: [],
      notes,
    };
  }
  if (response.trace.outcome.kind === 'would-record') {
    return {
      snapshotVersion: response.trace.snapshotVersion,
      response: null,
      trace: response.trace,
      fixture: null,
      shadowed: [],
      notes: Object.freeze([...SIMULATION_NOTES, WOULD_RECORD_NOTE]),
    };
  }
  const headers: AtlasResponseHeader[] = [];
  for (const name of Object.keys(response.headers).sort(compareStrings)) {
    for (const value of response.headers[name] ?? []) headers.push({ name, value });
  }
  const contentType = response.headers['content-type']?.[0] ?? null;
  const { outcome } = response.trace;
  const fixtureId = outcome.kind === 'matched' ? response.trace.headers?.identity : undefined;
  const endpointId = fixtureId === undefined ? undefined : atlas.fixtureEndpoint(fixtureId);
  return {
    snapshotVersion: response.trace.snapshotVersion,
    response: {
      status: response.status,
      headers,
      body: previewBody(response.body, contentType),
    },
    trace: response.trace,
    fixture: fixtureId === undefined || endpointId === undefined ? null : { endpointId, fixtureId },
    shadowed: (response.trace.shadowed ?? []).flatMap((entry) => {
      const holder = atlas.fixtureEndpoint(entry.fixtureId);
      return holder === undefined ? [] : [{ endpointId: holder, fixtureId: entry.fixtureId }];
    }),
    notes,
  };
}
