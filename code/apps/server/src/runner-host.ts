import { performance } from 'node:perf_hooks';
import { randomFillSync } from 'node:crypto';

import { decodeBody, type createHttpAdapter } from '@janus/adapter-http';
import type {
  AtlasExplanation,
  CaptureSink,
  Engine,
  HeaderLine,
  RequestDescription,
  ResolvedConfig,
  ResponseDescription,
} from '@janus/core';
import {
  createRunner,
  type MockRequest,
  type Runner,
  type RunnerPorts,
  type Sandbox,
  type SendResponse,
  type ValidationContext,
} from '@janus/runner';

import type { RequestStore } from './requests.js';

type FastifyInstance = ReturnType<typeof createHttpAdapter>;
import { createRunnerService, type RunnerService } from './runner-service.js';
import { createUpstream, type ClosableUpstream } from './upstream.js';

/**
 * The runner's composition: `@janus/runner` decides what each
 * step sends and whether it passed; this file gives it the network
 * (`undici`), Janus's own request handling (Fastify's in-process inject),
 * the captures directory, the clock and the recording slots.
 */

export interface RunnerHostOptions {
  readonly store: RequestStore;
  readonly context: ValidationContext;
  readonly sandbox: Sandbox;
  readonly values: ResolvedConfig;
  /** PEM text of `runner.extraCaCerts`. */
  readonly extraCaCerts: readonly string[];
  readonly captures: CaptureSink;
  readonly engine: Engine;
  readonly available: boolean;
  /** `atlas.resolve`: false refuses explain mode. */
  readonly explain?: boolean;
  readonly logger: {
    info(event: string, fields?: Readonly<Record<string, string | number>>): void;
    error(event: string, fields?: Readonly<Record<string, string | number>>): void;
  };
}

export interface RunnerHost {
  readonly service: RunnerService;
  readonly runner: Runner;
  /** Mock mode answers through this adapter, which need not be listening. */
  attach(app: FastifyInstance): void;
  /**
   * The adapter's `onResolved`: while a mock-mode send is in flight, keeps
   * each resolved request's decisions so the step can report them.
   */
  readonly onResolved: (requestId: string, request: RequestDescription, response: ResponseDescription) => void;
  close(): Promise<void>;
}

export function createRunnerHost(options: RunnerHostOptions): RunnerHost {
  const { values, engine, logger } = options;
  let upstream: ClosableUpstream | null = null;
  let app: FastifyInstance | null = null;
  /** Mock-mode sends in flight; resolved requests are kept only while there are any. */
  let mocking = 0;
  const resolved = new Map<string, () => AtlasExplanation>();
  const ports: RunnerPorts = {
    async send(request, signal, sendOptions) {
      upstream ??= createUpstream({
        timeoutMs: values.recording.timeoutMs,
        maxResponseBytes: values.recording.maxResponseBytes,
        extraCaCerts: options.extraCaCerts,
        skipTlsVerify: values.runner.skipTlsVerify,
        logger,
      });
      const started = performance.now();
      const answer = await upstream.send(request, signal);
      if (answer.kind === 'failure') return answer;
      const timeMs = Math.round(performance.now() - started);
      if (sendOptions?.decode !== true) return { ...answer, timeMs };
      const decoded = await decodeAnswer(answer.headers, answer.body, values.limits.maxDecodedBodyBytes);
      return { ...answer, ...decoded, timeMs };
    },
    async mock(request, signal) {
      if (app === null) return { kind: 'failure', failure: 'connect' } as const;
      mocking++;
      try {
        const answer = await mockThrough(app, request, signal, values.limits.maxDecodedBodyBytes);
        if (answer.kind !== 'response' || answer.requestId === undefined) return answer;
        const explain = resolved.get(answer.requestId);
        resolved.delete(answer.requestId);
        return explain === undefined ? answer : { ...answer, explanation: explain() };
      } finally {
        mocking--;
        if (mocking === 0) resolved.clear();
      }
    },
    explain({ target, request, nowMs }, signal) {
      const headers: Record<string, string[]> = {};
      for (const [name, value] of request.headers) (headers[name.toLowerCase()] ??= []).push(value);
      headers['host'] ??= ['localhost'];
      const description: RequestDescription = {
        method: request.method,
        target,
        headers,
        ...(request.body === null ? {} : { body: request.body }),
        ...(nowMs === undefined ? {} : { nowMs }),
      };
      return engine.atlas.explain(description, { signal });
    },
    captures: options.captures,
    now: () => Date.now(),
    progress(event) {
      service.publish({
        type: 'run',
        id: event.id,
        state: event.state,
        ...(event.step === undefined ? {} : { step: event.step }),
        ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
      });
      if (event.state === 'step') {
        logger.info('run-step', { run: event.id, step: event.step ?? 0, outcome: event.outcome ?? '-' });
      } else if (event.state === 'finished') {
        logger.info('run-finished', { run: event.id, outcome: event.outcome ?? '-' });
      }
    },
    readFile: (path) => options.store.readFile(path),
    randomBytes: (count) => randomFillSync(new Uint8Array(count)),
    slots: engine.recordingSlots,
  };
  const scenarioList = (): { names: string[]; default: string } => {
    const scenarios = engine.atlas.scenarios();
    return { names: scenarios.items.map((item) => item.name), default: scenarios.configuredDefault };
  };
  const runner = createRunner(
    ports,
    () => ({
      grammar: options.context.grammar,
      timezone: values.dynamic.timezone,
      scriptTimeoutMs: values.runner.scriptTimeoutMs,
      scriptMemoryBytes: values.runner.scriptMemoryBytes,
      maxActiveRuns: values.runner.maxActiveRuns,
      keepRuns: values.runner.keepRuns,
      recordingTimeoutMs: values.recording.timeoutMs,
      basePath: '',
      scenarios: scenarioList(),
    }),
    options.sandbox,
  );
  const service = createRunnerService({
    store: options.store,
    runner,
    context: options.context,
    available: options.available,
    maxImportBytes: values.runner.maxImportBytes,
    ...(options.explain === undefined ? {} : { explain: options.explain }),
    scenarios: scenarioList,
    logger,
  });
  return {
    service,
    runner,
    attach(instance) {
      app = instance;
    },
    onResolved(requestId, request, response) {
      if (mocking === 0) return;
      // Bounded: a request another client sent meanwhile is kept until the sends in flight finish.
      if (resolved.size >= MAX_KEPT_DECISIONS) resolved.delete(resolved.keys().next().value as string);
      resolved.set(requestId, () => engine.atlas.explainServed(request, response));
    },
    async close() {
      for (const run of runner.list()) if (run.state === 'running') runner.cancel(run.id);
      await upstream?.close();
    },
  };
}

const MAX_KEPT_DECISIONS = 64;

/**
 * A compressed answer's body decoded, without its `Content-Encoding` and
 * `Content-Length`, so tests and `extract` read it as plain text. An unknown
 * coding, or a body that decodes past `maxDecodedBytes`, is kept as received.
 */
async function decodeAnswer(
  lines: readonly HeaderLine[],
  body: Uint8Array,
  maxDecodedBytes: number,
): Promise<{ readonly headers: readonly HeaderLine[]; readonly body: Uint8Array }> {
  const codings = lines
    .filter(([name]) => name.toLowerCase() === 'content-encoding')
    .flatMap(([, value]) => value.split(','))
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== '');
  if (body.length === 0 || !codings.some((coding) => coding !== 'identity')) return { headers: lines, body };
  const decoded = await decodeBody(body, codings, maxDecodedBytes);
  if (decoded.kind !== 'decoded') return { headers: lines, body };
  return {
    headers: lines.filter(([name]) => {
      const lower = name.toLowerCase();
      return lower !== 'content-encoding' && lower !== 'content-length';
    }),
    body: decoded.body,
  };
}

/**
 * Mock mode: the request goes through the HTTP adapter's
 * handler in process, so it meets the same limits, controls and resolution
 * as one over the network. A compressed answer is decoded, so tests and
 * `extract` read the body as the fixture wrote it.
 */
async function mockThrough(
  app: FastifyInstance,
  { target, request }: MockRequest,
  signal: AbortSignal,
  maxDecodedBytes: number,
): Promise<SendResponse> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of request.headers) {
    const key = name.toLowerCase();
    const existing = headers[key];
    headers[key] = existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
  }
  headers['host'] ??= 'localhost';
  if (signal.aborted) return { kind: 'failure', failure: 'connect' };
  const started = performance.now();
  const response = await app.inject({
    method: request.method as 'GET',
    url: target,
    headers,
    ...(request.body === null ? {} : { payload: Buffer.from(request.body) }),
  });
  const timeMs = Math.round(performance.now() - started);
  const body = new Uint8Array(response.rawPayload);
  const lines: HeaderLine[] = [];
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [String(value)]) lines.push([name, item]);
  }
  const decoded = await decodeAnswer(lines, body, maxDecodedBytes);
  const requestId = response.headers['x-janus-request-id'];
  return {
    kind: 'response',
    status: response.statusCode,
    headers: decoded.headers,
    body: decoded.body,
    timeMs,
    ...(typeof requestId === 'string' ? { requestId } : {}),
  };
}
