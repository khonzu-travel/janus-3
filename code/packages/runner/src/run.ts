import {
  parseMediaType,
  planCapture,
  previewBody,
  runnerRegistration,
  type AtlasExplanation,
  type AtlasPreview,
  type AtlasResponseHeader,
  type CaptureReservation,
  type CaptureSink,
  type GrammarContext,
  type HeaderLine,
  type UpstreamFailureKind,
  type UpstreamFailureReason,
  upstreamFailureText,
} from '@janus/core';

import { RunCookies } from './cookies.js';
import { evaluateExtract, firstHeader, type ReceivedResponse } from './extract.js';
import type { RequestDocument } from './model.js';
import { deriveRoute, headerScenario, planMockRequest, planRecordRequest, planUpstreamModeRequest } from './plan.js';
import { combineHeaders, renderRequest, StepFailure, type RequestDraft, type SendRequest } from './render.js';
import type { ConsoleLine, ScriptInput, ScriptOutcome, ScriptVariables, TestResult } from './sandbox/types.js';
import { substitutionText } from './template.js';
import {
  collectionOf,
  environmentValues,
  folderChain,
  parentOf,
  requestsBelow,
  type FolderNode,
  type RequestTree,
} from './tree.js';
import { RenderError, Renderer, type VariableScopes } from './variables.js';

/**
 * Runs: steps run one after another, each through `before`
 * scripts, rendering, the send, `extract` and `after` scripts. The runner
 * reaches the network, the captures directory and the clock only through
 * its ports.
 */

/** What a send returned: a response, or why none arrived. */
export type SendResponse =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly headers: readonly HeaderLine[];
      readonly body: Uint8Array;
      readonly timeMs: number;
      /** Mock mode: the response's `X-Janus-Request-Id`. */
      readonly requestId?: string;
      /** Mock mode: the decisions Janus made answering it. */
      readonly explanation?: AtlasExplanation;
    }
  | {
      readonly kind: 'failure';
      readonly failure: UpstreamFailureKind;
      /** Set for `connect` failures, from the fixed list; absent means `unknown`. */
      readonly reason?: UpstreamFailureReason;
    };

/** A mock-mode request: the target Janus resolves, and the request to hand it. */
export interface MockRequest {
  readonly target: string;
  readonly request: SendRequest;
}

/** An explain-mode request: a mock-mode request, and the instant to render at. */
export interface ExplainRequest extends MockRequest {
  /** Epoch milliseconds; absent renders at the server's clock. */
  readonly nowMs?: number;
}

export interface RecordingSlotsPort {
  acquire(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  release(): void;
}

export interface RunProgress {
  readonly id: string;
  readonly state: 'started' | 'step' | 'finished';
  /** For `step`: the 1-based step number. */
  readonly step?: number;
  readonly outcome?: StepOutcome | RunOutcome;
}

export interface RunnerPorts {
  /**
   * Upstream and record mode: sends to the rendered URL, follows no redirect, bounded by `recording.*` limits.
   * With `decode`, a compressed answer is decoded; record mode keeps the bytes as received.
   */
  send(request: SendRequest, signal: AbortSignal, options?: { readonly decode?: boolean }): Promise<SendResponse>;
  /** Mock mode: Janus's own request handling, in process. */
  mock(request: MockRequest, signal: AbortSignal): Promise<SendResponse>;
  /** Explain mode: what Janus would answer and why, changing nothing. */
  explain(request: ExplainRequest, signal: AbortSignal): Promise<AtlasExplanation>;
  readonly captures: CaptureSink;
  /** Wall clock, epoch milliseconds. */
  now(): number;
  progress(event: RunProgress): void;
  /** A body file below `runner.root`; null when missing or not allowed. */
  readFile(path: string): Promise<Uint8Array | null>;
  randomBytes(count: number): Uint8Array;
  /** The `recording.maxConcurrent` slots. */
  readonly slots: RecordingSlotsPort;
}

/** The script sandbox as the run uses it. */
export interface ScriptHost {
  run(input: ScriptInput): Promise<ScriptOutcome>;
}

export interface RunnerSettings {
  readonly grammar: GrammarContext;
  /** `dynamic.timezone`. */
  readonly timezone: string;
  readonly scriptTimeoutMs: number;
  readonly scriptMemoryBytes: number;
  readonly maxActiveRuns: number;
  readonly keepRuns: number;
  /** `recording.timeoutMs`: how long a record-mode step waits for a slot. */
  readonly recordingTimeoutMs: number;
  /** Janus's base path for mock-mode targets; "" for none. */
  readonly basePath: string;
  /** Record mode: the snapshot's scenarios, and `scenarios.default` for a request that names none. */
  readonly scenarios: { readonly names: readonly string[]; readonly default: string };
}

/**
 * Where a step's request goes: Janus (`mock`), the real API without a capture
 * (`upstream`) or with one (`record`), or nowhere: `explain` simulates the
 * mock's answer and skips `extract`, `after` scripts and tests.
 */
export type RunMode = 'mock' | 'upstream' | 'record' | 'explain';

export const RUN_MODES: readonly RunMode[] = Object.freeze(['mock', 'upstream', 'record', 'explain']);

/** What a run runs. */
export type RunTarget =
  | { readonly kind: 'node'; readonly id: string }
  /** An unsaved request, run with the folder settings of the ID it is edited as. */
  | { readonly kind: 'request'; readonly id: string; readonly document: RequestDocument };

export interface RunSpec {
  readonly target: RunTarget;
  readonly environment: string | null;
  readonly mode: RunMode;
  /**
   * The scenario picked for the run, or null for none. A request's own
   * `X-Mock-Scenario` wins over it; without either, Janus decides (a session
   * pin, else `scenarios.default`).
   */
  readonly scenario: string | null;
  readonly vars: Readonly<Record<string, unknown>>;
  /** Explain mode: the instant to render at, epoch milliseconds. */
  readonly nowMs?: number;
}

export type StepOutcome = 'passed' | 'failed' | 'not-run' | 'running' | 'pending';
export type RunOutcome = 'passed' | 'failed' | 'cancelled';

export interface StepSent {
  readonly method: string;
  readonly url: string;
  readonly headers: readonly AtlasResponseHeader[];
  readonly body: AtlasPreview;
}

export interface StepReceived {
  readonly status: number;
  readonly headers: readonly AtlasResponseHeader[];
  readonly body: AtlasPreview;
  readonly timeMs: number;
}

export interface StepResult {
  /** 1-based. */
  readonly step: number;
  readonly requestId: string;
  readonly name: string;
  readonly outcome: StepOutcome;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly request?: StepSent;
  readonly response?: StepReceived;
  readonly tests: readonly TestResult[];
  readonly console: readonly ConsoleLine[];
  /** Variables `extract` and scripts set in this step, in order; an unset variable is null. */
  readonly variables: Readonly<Record<string, unknown>>;
  /** Record mode: `<scenario>/<exchange>`. */
  readonly capture?: string;
  /**
   * Mock, explain and record mode: where the scenario came from, the request's
   * own `X-Mock-Scenario` or the run's; absent when neither named one.
   */
  readonly scenarioFrom?: 'request' | 'run';
  /** Mock mode: the response's `X-Janus-Request-Id`. */
  readonly janusRequestId?: string;
  /** Mock and explain mode: the decisions Janus made (or would make) answering the request. */
  readonly explanation?: AtlasExplanation;
}

export interface RunSummary {
  readonly id: string;
  readonly target: {
    readonly kind: 'request' | 'folder' | 'collection';
    readonly id: string;
    readonly unsaved: boolean;
  };
  readonly environment: string | null;
  readonly mode: RunMode;
  /** The scenario picked for the run, or null for none. */
  readonly scenario: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly state: 'running' | 'finished';
  readonly outcome: RunOutcome | null;
  readonly stepCount: number;
  readonly passed: number;
  readonly failed: number;
}

export interface RunRecord extends RunSummary {
  readonly steps: readonly StepResult[];
  /** The run variables when it ended, or so far. */
  readonly vars: Readonly<Record<string, unknown>>;
}

export type StartResult =
  | { readonly ok: true; readonly id: string; readonly done: Promise<RunRecord> }
  | {
      readonly ok: false;
      readonly code: 'runner-busy' | 'atlas-resource-not-found' | 'unknown-environment';
      readonly message: string;
    };

export interface Runner {
  start(spec: RunSpec, tree: RequestTree): StartResult;
  /** Kept runs and runs in progress, newest first. */
  list(): readonly RunSummary[];
  get(id: string): RunRecord | null;
  /** Cancels a run in progress; false when it is not running. */
  cancel(id: string): boolean;
  /** Runs in progress. */
  readonly active: number;
}

/** One step's plan: the document and the folders it inherits from, collection first. */
interface PlannedStep {
  readonly id: string;
  readonly document: RequestDocument;
  readonly chain: readonly FolderNode[];
}

interface RunState {
  readonly id: string;
  readonly spec: RunSpec;
  readonly targetKind: 'request' | 'folder' | 'collection';
  readonly startedAt: number;
  finishedAt: number | null;
  outcome: RunOutcome | null;
  readonly steps: StepResult[];
  readonly vars: Map<string, unknown>;
  readonly controller: AbortController;
}

export function createRunner(ports: RunnerPorts, settings: () => RunnerSettings, scripts: ScriptHost): Runner {
  const runs = new Map<string, RunState>();
  let counter = 0;
  let active = 0;

  const summary = (state: RunState): RunSummary => ({
    id: state.id,
    target: { kind: state.targetKind, id: state.spec.target.id, unsaved: state.spec.target.kind === 'request' },
    environment: state.spec.environment,
    mode: state.spec.mode,
    scenario: state.spec.scenario,
    startedAt: new Date(state.startedAt).toISOString(),
    finishedAt: state.finishedAt === null ? null : new Date(state.finishedAt).toISOString(),
    state: state.outcome === null ? 'running' : 'finished',
    outcome: state.outcome,
    stepCount: state.steps.length,
    passed: state.steps.filter((step) => step.outcome === 'passed').length,
    failed: state.steps.filter((step) => step.outcome === 'failed').length,
  });
  const record = (state: RunState): RunRecord => ({
    ...summary(state),
    steps: [...state.steps],
    vars: Object.fromEntries(state.vars),
  });

  const prune = (): void => {
    const keep = settings().keepRuns;
    const finished = [...runs.values()].filter((state) => state.outcome !== null);
    for (const state of finished.slice(0, Math.max(0, finished.length - keep))) runs.delete(state.id);
  };

  return {
    get active() {
      return active;
    },
    start(spec, tree) {
      const current = settings();
      if (active >= current.maxActiveRuns) {
        return {
          ok: false,
          code: 'runner-busy',
          message: `${String(current.maxActiveRuns)} runs are already in progress`,
        };
      }
      const planned = planSteps(spec.target, tree);
      if (planned === null) {
        return {
          ok: false,
          code: 'atlas-resource-not-found',
          message: `No request, folder or collection "${spec.target.id}"`,
        };
      }
      const collection = collectionOf(tree, spec.target.id);
      // Environments are shared by every collection.
      const environment =
        spec.environment === null ? null : (tree.environments.find((entry) => entry.id === spec.environment) ?? null);
      if (spec.environment !== null && environment === null) {
        return {
          ok: false,
          code: 'unknown-environment',
          message: `No environment "${spec.environment}" exists`,
        };
      }
      counter++;
      const id = `r-${String(counter).padStart(6, '0')}`;
      const state: RunState = {
        id,
        spec,
        targetKind: planned.kind,
        startedAt: ports.now(),
        finishedAt: null,
        outcome: null,
        steps: planned.steps.map((step, index) => ({
          step: index + 1,
          requestId: step.id,
          name: step.document.name,
          outcome: 'pending',
          tests: [],
          console: [],
          variables: {},
        })),
        vars: new Map(Object.entries(spec.vars)),
        controller: new AbortController(),
      };
      runs.set(id, state);
      active++;
      ports.progress({ id, state: 'started' });
      const environmentVars = environment === null ? {} : environmentValues(environment);
      const environmentName = environment === null ? null : (environment.document.name ?? environment.id);
      const cookies = collection?.document.cookies === false ? null : new RunCookies();
      const done = (async (): Promise<RunRecord> => {
        try {
          let failed = false;
          for (const [index, step] of planned.steps.entries()) {
            if (failed || state.controller.signal.aborted) {
              state.steps[index] = { ...(state.steps[index] as StepResult), outcome: 'not-run' };
              continue;
            }
            state.steps[index] = { ...(state.steps[index] as StepResult), outcome: 'running' };
            const result = await runStep({
              ports,
              settings: current,
              scripts,
              run: state,
              step,
              index,
              environment: environmentVars,
              environmentName,
              cookies,
            });
            const cancelled = isAborted(state.controller.signal);
            state.steps[index] = cancelled ? { ...result, outcome: 'not-run' } : result;
            if (!cancelled) ports.progress({ id, state: 'step', step: index + 1, outcome: result.outcome });
            if (result.outcome === 'failed') failed = true;
          }
          state.outcome = state.controller.signal.aborted ? 'cancelled' : failed ? 'failed' : 'passed';
        } catch {
          state.outcome = 'failed';
        } finally {
          state.finishedAt = ports.now();
          active--;
          prune();
          ports.progress({ id, state: 'finished', outcome: state.outcome ?? 'failed' });
        }
        return record(state);
      })();
      return { ok: true, id, done };
    },
    list() {
      return [...runs.values()].reverse().map(summary);
    },
    get(id) {
      const state = runs.get(id);
      return state === undefined ? null : record(state);
    },
    cancel(id) {
      const state = runs.get(id);
      if (state === undefined || state.outcome !== null) return false;
      state.controller.abort();
      return true;
    },
  };
}

function planSteps(
  target: RunTarget,
  tree: RequestTree,
): { kind: 'request' | 'folder' | 'collection'; steps: readonly PlannedStep[] } | null {
  if (target.kind === 'request') {
    return {
      kind: 'request',
      steps: [{ id: target.id, document: target.document, chain: folderChain(tree, target.id) }],
    };
  }
  const node = tree.nodes.get(target.id);
  if (node === undefined) return null;
  const steps = requestsBelow(node).map((request) => ({
    id: request.id,
    document: request.document,
    chain: folderChain(tree, request.id),
  }));
  return { kind: node.kind, steps };
}

interface StepContext {
  readonly ports: RunnerPorts;
  readonly settings: RunnerSettings;
  readonly scripts: ScriptHost;
  readonly run: RunState;
  readonly step: PlannedStep;
  /** 0-based. */
  readonly index: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentName: string | null;
  readonly cookies: RunCookies | null;
}

/** Runs one step; never rejects. */
async function runStep(context: StepContext): Promise<StepResult> {
  const { ports, settings, run, step } = context;
  const signal = run.controller.signal;
  const document = step.document;
  const tests: TestResult[] = [];
  const consoleLines: ConsoleLine[] = [];
  const variables: Record<string, unknown> = {};
  let sent: StepSent | undefined;
  let received: StepReceived | undefined;
  let capture: string | undefined;
  let janusRequestId: string | undefined;
  let explanation: AtlasExplanation | undefined;
  let scenarioFrom: 'request' | 'run' | undefined;
  const result = (outcome: 'passed' | 'failed', failure?: { code: string; message: string }): StepResult => ({
    step: context.index + 1,
    requestId: step.id,
    name: document.name,
    outcome,
    ...(failure === undefined ? {} : { failure }),
    ...(sent === undefined ? {} : { request: sent }),
    ...(received === undefined ? {} : { response: received }),
    tests,
    console: consoleLines,
    variables,
    ...(capture === undefined ? {} : { capture }),
    ...(scenarioFrom === undefined ? {} : { scenarioFrom }),
    ...(janusRequestId === undefined ? {} : { janusRequestId }),
    ...(explanation === undefined ? {} : { explanation }),
  });

  const nearestFirst = [...step.chain].reverse();
  const scopes: VariableScopes = {
    run: run.vars,
    request: document.vars ?? {},
    environment: context.environment,
    folders: nearestFirst.map((folder) => folder.document.vars ?? {}),
  };
  const tokens = {
    now: ports.now(),
    timezone: settings.timezone,
    randomBytes: (count: number) => ports.randomBytes(count),
  };
  const scriptVariables = makeScriptVariables(
    scopes,
    settings,
    tokens,
    context.environmentName,
    nearestFirst,
    variables,
  );
  const draft: RequestDraft = {
    method: document.method,
    url: document.url,
    headers: combineHeaders([...step.chain.map((folder) => folder.document.headers), document.headers]),
    body: document.body,
  };
  const info = { requestName: document.name, requestId: step.id };
  const limits = { timeoutMs: settings.scriptTimeoutMs, memoryBytes: settings.scriptMemoryBytes };

  const runScripts = async (
    sources: readonly (string | undefined)[],
    input: Omit<ScriptInput, 'source'>,
  ): Promise<{ code: string; message: string } | null> => {
    for (const source of sources) {
      if (source === undefined || source.trim() === '' || signal.aborted) continue;
      const outcome = await context.scripts.run({ ...input, source });
      tests.push(...outcome.tests);
      for (const line of outcome.console) if (consoleLines.length < 1000) consoleLines.push(line);
      if (outcome.failure !== null) {
        const where = outcome.failure.line === undefined ? '' : ` (line ${String(outcome.failure.line)})`;
        return { code: outcome.failure.code, message: `${outcome.failure.message}${where}` };
      }
    }
    return null;
  };

  try {
    // 1. `before` scripts: collection, folders outward in, the request.
    const beforeFailure = await runScripts(
      [...step.chain.map((folder) => folder.document.scripts?.before), document.scripts?.before],
      { phase: 'before', request: draft, variables: scriptVariables, info, limits },
    );
    if (beforeFailure !== null) return result('failed', beforeFailure);
    if (isAborted(signal)) throw new StepFailure('cancelled', 'The run was cancelled');

    // 2. Render and send.
    const renderer = new Renderer(scopes, settings.grammar, tokens);
    const rendered = await renderRequest(draft, document.pathParams ?? {}, parentOf(step.id), renderer, ports);
    let request = rendered.request;
    if (context.cookies !== null) {
      request = { ...request, headers: await context.cookies.apply(request.url, request.headers) };
    }
    const prefixes = nearestFirst.flatMap((folder) =>
      folder.document.stripPrefix === undefined ? [] : [folder.document.stripPrefix],
    );
    if (isAborted(signal)) throw new StepFailure('cancelled', 'The run was cancelled');

    if (run.spec.mode !== 'upstream') {
      scenarioFrom =
        headerScenario(request.headers) !== null ? 'request' : run.spec.scenario !== null ? 'run' : undefined;
    }

    let response: ReceivedResponse;
    if (run.spec.mode === 'explain') {
      const mock = planMockRequest(request, run.spec.scenario, settings.basePath, prefixes);
      sent = describeSent(mock.request);
      explanation = await ports.explain(
        { ...mock, ...(run.spec.nowMs === undefined ? {} : { nowMs: run.spec.nowMs }) },
        signal,
      );
      const answer = explanation.response;
      if (answer !== null) {
        received = {
          status: answer.status,
          headers: answer.headers.map(({ name, value }) => ({ name, value })),
          body: answer.body,
          timeMs: 0,
        };
      }
      // Nothing was answered, so nothing is extracted or tested.
      return result('passed');
    }
    if (run.spec.mode === 'upstream') {
      request = planUpstreamModeRequest(request);
      sent = describeSent(request);
      const answer = await ports.send(request, signal, { decode: true });
      if (answer.kind === 'failure') return result('failed', failureFor(answer.failure, answer.reason));
      response = { status: answer.status, headers: answer.headers, body: answer.body, timeMs: answer.timeMs };
    } else if (run.spec.mode === 'record') {
      const outcome = await sendRecorded(context, request, rendered.pathParams, prefixes);
      request = outcome.request;
      sent = describeSent(outcome.request);
      if (outcome.capture !== undefined) capture = outcome.capture;
      if (outcome.kind === 'failure') return result('failed', outcome.failure);
      response = outcome.response;
    } else {
      const mock = planMockRequest(request, run.spec.scenario, settings.basePath, prefixes);
      request = mock.request;
      sent = describeSent(mock.request);
      const answer = await ports.mock(mock, signal);
      if (answer.kind === 'failure') return result('failed', failureFor(answer.failure, answer.reason));
      if (answer.requestId !== undefined) janusRequestId = answer.requestId;
      if (answer.explanation !== undefined) explanation = answer.explanation;
      response = { status: answer.status, headers: answer.headers, body: answer.body, timeMs: answer.timeMs };
    }
    received = describeReceived(response);
    if (context.cookies !== null) await context.cookies.store(request.url, response.headers);

    // 3. `extract`.
    if (document.extract !== undefined) {
      const extracted = evaluateExtract(
        document.extract,
        { request, pathParams: rendered.pathParams, response },
        new Renderer(scopes, settings.grammar, tokens),
        settings.grammar,
      );
      for (const [name, value] of extracted.values) {
        run.vars.set(name, value);
        variables[name] = value;
      }
      if (extracted.missing.length > 0) {
        return result('failed', {
          code: 'extract-missing',
          message: `No value for ${extracted.missing.map((entry) => `${entry.name} (${entry.token})`).join(', ')}`,
        });
      }
    }

    // 4. `after` scripts: the request, folders inward out, the collection.
    const afterFailure = await runScripts(
      [document.scripts?.after, ...nearestFirst.map((folder) => folder.document.scripts?.after)],
      {
        phase: 'after',
        request: draft,
        response: {
          status: response.status,
          statusText: reasonPhrase(response.status),
          headers: response.headers,
          text: new TextDecoder().decode(response.body),
          timeMs: response.timeMs,
        },
        variables: scriptVariables,
        info,
        limits,
      },
    );
    if (afterFailure !== null) return result('failed', afterFailure);
    const failedTests = tests.filter((test) => !test.passed);
    if (failedTests.length > 0) {
      return result('failed', {
        code: 'test-failed',
        message: `${failedTests.length === 1 ? 'Test' : 'Tests'} failed: ${failedTests.map((test) => test.name).join(', ')}`,
      });
    }
    return result('passed');
  } catch (error) {
    if (error instanceof StepFailure || error instanceof RenderError) {
      return result('failed', { code: error.code, message: error.message });
    }
    return result('failed', { code: 'script-error', message: 'The step failed unexpectedly' });
  }
}

type RecordedOutcome =
  | { kind: 'response'; request: SendRequest; response: ReceivedResponse; capture?: string }
  | { kind: 'failure'; request: SendRequest; failure: { code: string; message: string }; capture?: string };

/** Record mode: route, slot, claim, send, capture. */
async function sendRecorded(
  context: StepContext,
  rendered: SendRequest,
  pathParams: Readonly<Record<string, string>>,
  prefixes: readonly string[],
): Promise<RecordedOutcome> {
  const { ports, settings, run, step } = context;
  const signal = run.controller.signal;
  // The request's own header, else the picked scenario, else the default; the header itself is not sent upstream.
  const scenario = headerScenario(rendered.headers) ?? run.spec.scenario ?? settings.scenarios.default;
  if (!settings.scenarios.names.includes(scenario)) {
    throw new StepFailure(
      'unknown-scenario',
      `No scenario named ${JSON.stringify(scenario)} exists in the current snapshot`,
    );
  }
  const request = planRecordRequest(rendered);
  const url = new URL(request.url);
  const derived = deriveRoute(step.document.url, request.url, step.document.route, prefixes);
  const registration = runnerRegistration({
    method: request.method,
    path: derived.route,
    upstream: `${url.origin}${derived.prefix ?? ''}`,
  });
  if (typeof registration === 'string')
    throw new StepFailure('route-invalid', `The capture route is not valid: ${registration}`);

  if (!(await ports.slots.acquire(settings.recordingTimeoutMs, signal))) {
    if (isAborted(signal)) throw new StepFailure('cancelled', 'The run was cancelled');
    throw new StepFailure('recording-busy', 'No recording slot came free within recording.timeoutMs');
  }
  try {
    if (isAborted(signal)) throw new StepFailure('cancelled', 'The run was cancelled');
    let reservation: CaptureReservation;
    try {
      reservation = await ports.captures.claim(scenario);
    } catch {
      throw new StepFailure('capture-failed', 'No exchange number could be claimed in the captures directory');
    }
    const capture = `${reservation.scenario}/${reservation.exchange}`;
    const startedAt = ports.now();
    const target = `${url.pathname}${url.search}`;
    if (isAborted(signal)) {
      // The exchange number is taken; log it as a send cancelled before it began, as a cancel mid-send is.
      await ports.captures
        .fail(reservation, {
          exchange: reservation.exchange,
          at: new Date(startedAt).toISOString(),
          method: request.method,
          target,
          registration: registration.endpoint.path,
          outcome: 'upstream-failed',
          durationMs: 0,
          source: 'runner',
          run: run.id,
          request: step.id,
        })
        .catch(() => undefined);
      throw new StepFailure('cancelled', 'The run was cancelled');
    }
    const answer = await ports.send(request, signal);
    const finishedAt = ports.now();
    const runInfo = { id: run.id, step: context.index + 1, request: step.id };
    if (answer.kind === 'failure') {
      const outcome =
        answer.failure === 'connect'
          ? 'upstream-failed'
          : answer.failure === 'timeout'
            ? 'upstream-timeout'
            : 'response-too-large';
      await ports.captures
        .fail(reservation, {
          exchange: reservation.exchange,
          at: new Date(finishedAt).toISOString(),
          method: request.method,
          target,
          registration: registration.endpoint.path,
          outcome,
          ...(answer.failure === 'connect' ? { reason: answer.reason ?? 'unknown' } : {}),
          durationMs: Math.max(0, Math.round(finishedAt - startedAt)),
          source: 'runner',
          run: run.id,
          request: step.id,
        })
        .catch(() => undefined);
      return { kind: 'failure', request, failure: failureFor(answer.failure, answer.reason), capture };
    }
    const headers: Record<string, string[]> = {};
    for (const [name, value] of request.headers) (headers[name.toLowerCase()] ??= []).push(value);
    const plan = planCapture({
      reservation,
      registration,
      request: { method: request.method, target, params: pathParams, headers, body: request.body },
      response: { status: answer.status, headers: answer.headers, body: answer.body },
      startedAt,
      finishedAt,
      runner: { url: request.url, run: runInfo },
    });
    const written = await ports.captures.write(reservation, plan).catch(() => ({ ok: false as const }));
    const response = { status: answer.status, headers: answer.headers, body: answer.body, timeMs: answer.timeMs };
    if (!written.ok) {
      return {
        kind: 'failure',
        request,
        failure: { code: 'capture-failed', message: 'The capture could not be written' },
        capture,
      };
    }
    return { kind: 'response', request, response, capture };
  } finally {
    ports.slots.release();
  }
}

function failureFor(kind: UpstreamFailureKind, reason?: UpstreamFailureReason): { code: string; message: string } {
  switch (kind) {
    case 'connect':
      return {
        code: 'send-failed',
        message: `The request could not be sent: ${upstreamFailureText(reason ?? 'unknown')}`,
      };
    case 'timeout':
      return { code: 'send-timeout', message: 'No complete response arrived within the time limit' };
    case 'too-large':
      return { code: 'response-too-large', message: 'The response body exceeds the size limit' };
  }
}

function headerList(headers: readonly HeaderLine[]): AtlasResponseHeader[] {
  return headers.map(([name, value]) => ({ name, value }));
}

function mediaTypeOf(headers: readonly HeaderLine[]): string | null {
  const type = firstHeader(headers, 'content-type');
  if (type === undefined) return null;
  const parsed = parseMediaType(type);
  return parsed === null ? null : type;
}

/**
 * Steps carry whole text bodies, already bounded by the send limits, so the
 * Requests tab can show and tree a large response; binary stays a preview.
 */
const WHOLE_TEXT = Number.POSITIVE_INFINITY;

function describeSent(request: SendRequest): StepSent {
  return {
    method: request.method,
    url: request.url,
    headers: headerList(request.headers),
    body: previewBody(request.body, mediaTypeOf(request.headers), WHOLE_TEXT),
  };
}

function describeReceived(response: ReceivedResponse): StepReceived {
  return {
    status: response.status,
    headers: headerList(response.headers),
    body: previewBody(response.body.length === 0 ? null : response.body, mediaTypeOf(response.headers), WHOLE_TEXT),
    timeMs: response.timeMs,
  };
}

/**
 * Variables as scripts see them: reads go through a
 * fresh renderer so a script's lookup of an undefined name never fails the
 * step; writes change run variables and are reported with the step.
 */
function makeScriptVariables(
  scopes: VariableScopes,
  settings: RunnerSettings,
  tokens: ConstructorParameters<typeof Renderer>[2],
  environmentName: string | null,
  nearestFirst: readonly FolderNode[],
  reported: Record<string, unknown>,
): ScriptVariables {
  const read = (name: string): unknown => {
    try {
      return new Renderer(scopes, settings.grammar, tokens).value(name);
    } catch {
      return undefined;
    }
  };
  const renderValue = (template: string | undefined): unknown => {
    if (template === undefined) return undefined;
    try {
      return new Renderer(scopes, settings.grammar, tokens).text(template);
    } catch {
      return template;
    }
  };
  return {
    environmentName,
    get: read,
    set(name, value) {
      scopes.run.set(name, value);
      reported[name] = value;
    },
    unset(name) {
      scopes.run.delete(name);
      reported[name] = null;
    },
    has(name) {
      return read(name) !== undefined;
    },
    scope(scope, name) {
      switch (scope) {
        case 'request':
          return Object.hasOwn(scopes.request, name) ? renderValue(scopes.request[name]) : undefined;
        case 'environment':
          // `bru.setEnvVar` writes a run variable, so a later `getEnvVar` reads it first.
          if (scopes.run.has(name)) return scopes.run.get(name);
          return Object.hasOwn(scopes.environment, name) ? scopes.environment[name] : undefined;
        case 'folder': {
          const folder = nearestFirst.find(
            (node) => node.kind === 'folder' && Object.hasOwn(node.document.vars ?? {}, name),
          );
          return folder === undefined ? undefined : renderValue(folder.document.vars?.[name]);
        }
        case 'collection': {
          const collection = nearestFirst.find((node) => node.kind === 'collection');
          const vars = collection?.document.vars ?? {};
          return Object.hasOwn(vars, name) ? renderValue(vars[name]) : undefined;
        }
      }
    },
    interpolate(text) {
      return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (whole, name: string) => {
        const value = read(name);
        return value === undefined ? whole : substitutionText(value);
      });
    },
  };
}

const REASONS: Readonly<Record<number, string>> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  421: 'Misdirected Request',
  422: 'Unprocessable Content',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
};

export function reasonPhrase(status: number): string {
  return REASONS[status] ?? '';
}

/** Read through a call, so a check made before an `await` does not narrow it. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
