import type { ReactNode } from 'react';
import { Link } from 'react-router';

import type {
  ChoiceBy,
  FaultKind,
  NotAdvancedReason,
  ReplayOutcome,
  SelectionSource,
  WireShadowed,
  WireTrace,
  WireTransportTrace,
} from '../../atlas/wire.js';

export type StepState = 'passed' | 'failed' | 'skipped' | 'info';

export interface Step {
  readonly title: string;
  readonly state: StepState;
  readonly detail: ReactNode;
}

const STATE_TEXT: Readonly<Record<StepState, string>> = {
  passed: 'Decided',
  failed: 'Stopped here',
  skipped: 'Not reached',
  info: 'Noted',
};

const STATE_CLASS: Readonly<Record<StepState, string>> = {
  passed: 'text-ok',
  failed: 'text-bad',
  skipped: 'text-faint',
  info: 'text-accent',
};

/**
 * The trace as an ordered list of decisions, one line per
 * step. Every step states its result in text first;
 * colour only reinforces it.
 */
export function ExplanationSteps({
  steps,
  compact = false,
}: {
  readonly steps: readonly Step[];
  /** A narrow pane (the Requests inspector): the detail goes under the title and state. */
  readonly compact?: boolean;
}) {
  return (
    <ol aria-label="Decisions" className="py-1.5">
      {steps.map((step, index) => (
        <li
          key={step.title}
          className={
            compact
              ? 'grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-baseline gap-x-2 border-b border-line py-1.5 last:border-b-0'
              : 'grid grid-cols-[1.5rem_minmax(0,1fr)] items-baseline gap-x-2 border-b border-line px-4 py-1.5 sm:grid-cols-[1.5rem_8rem_6.5rem_minmax(0,1fr)]'
          }
        >
          <span className="text-right font-mono text-label text-faint">{index + 1}.</span>
          {/* The inspector's sections are not headings, so its steps sit one level up. */}
          {compact ? (
            <h3 className={step.state === 'skipped' ? 'text-faint' : 'font-medium'}>{step.title}</h3>
          ) : (
            <h4 className={step.state === 'skipped' ? 'text-faint' : 'font-medium'}>{step.title}</h4>
          )}
          <span className={`text-label ${compact ? '' : 'max-sm:col-start-2'} ${STATE_CLASS[step.state]}`}>
            {STATE_TEXT[step.state]}
          </span>
          <div className={`text-muted [&_code]:text-fg ${compact ? 'col-span-2 col-start-2' : 'max-sm:col-start-2'}`}>
            {step.detail}
          </div>
        </li>
      ))}
    </ol>
  );
}

const code = (text: string) => <code className="font-mono">{text}</code>;
const list = (items: readonly string[]) =>
  items.length === 0 ? <em>none</em> : items.map((item, index) => [index > 0 ? ', ' : null, code(item)]);

/** Why a scenario was selected. */
const SELECTED_BECAUSE: Readonly<Record<SelectionSource, string>> = {
  caller: 'the top bar picked it, and the request names none',
  'request-header': 'X-Mock-Scenario named it',
  session: 'the session is pinned to it',
  config: 'it is the configured default (scenarios.default)',
  default: 'nothing else chose a scenario',
};

const SOURCE_TEXT: Readonly<Record<string, string>> = {
  caller: 'the top bar',
  'request-header': 'X-Mock-Scenario',
  session: 'the session’s pin',
  config: 'scenarios.default',
};

const REPLAY_TEXT: Readonly<Record<ReplayOutcome, string>> = {
  stored: 'No response is stored for this key yet; this one would be stored for the session’s retries.',
  replayed: 'The stored response for this key was replayed (X-Mock-Replayed).',
  'would-replay': 'The session has a stored response for this key and this request, so a real request would replay it.',
  'key-reused': 'The session used this key for a different request, so the key is refused.',
  'no-session': 'Nothing is stored or replayed without a session.',
  'not-stored': 'This outcome is not stored: only fixture responses are replayed.',
};

const CHOSEN_BY: Readonly<Record<ChoiceBy, string>> = {
  expect: 'onMismatch in expect.yaml',
  rule: 'a rule in variants.yaml',
  page: 'pages.yaml',
  sequence: 'sequence.yaml',
  plain: 'no control, so the plain responses',
};

const NOT_ADVANCED: Readonly<Record<NotAdvancedReason, string>> = {
  head: 'a HEAD request never advances a sequence',
  'no-session': 'requests without a session always get step 1',
  'not-chosen': 'this sequence did not choose the response',
  'not-served': 'the request did not end in a fixture response',
  simulation: 'a simulation changes no session',
};

const HIDDEN_BY: Readonly<Record<WireShadowed['by'], string>> = {
  replaced: 'replaced by a file with the same status, locale and media type',
  overrides: 'taken out by overrides',
  removes: 'taken out by removes',
};

/** Outcomes the request was meant to get: a fixture, a recording, an authored fault or an `OPTIONS` answer. */
const PASSED_OUTCOMES: ReadonlySet<string> = new Set([
  'matched',
  'would-record',
  'fault',
  'automatic-options',
  'preflight',
]);

const FAULT_TEXT: Readonly<Record<FaultKind, string>> = {
  reset: 'the connection would be reset without a byte of response',
  timeout: 'the connection would be held open without an answer, then closed',
  truncate: 'the response would be cut off part-way through its body',
  malformed: 'the response would break HTTP/1.1 framing',
  none: 'no fault: the request is answered normally',
};

const LATENCY_FROM: Readonly<Record<NonNullable<WireTransportTrace['latency']>['source'], string>> = {
  'fault-file': 'the method’s fault.yaml',
  scenario: 'the scenario’s flow.yaml',
  config: 'faults.latency',
};

/** The delay and where it comes from, the fault rule and step, and the codings. */
function transportStep(transport: WireTransportTrace, kind: string): Step {
  const { latency, fault, faultSequence } = transport;
  const faultState: StepState =
    kind === 'fault' ? 'failed' : fault !== null && fault.kind !== 'none' ? 'passed' : 'info';
  return {
    title: 'Transport',
    state: faultState,
    detail: (
      <>
        {latency === null || latency.ms === 0 ? (
          'No delay.'
        ) : (
          <>
            A real request would wait {code(`${String(latency.ms)} ms`)} before the first byte, from{' '}
            {LATENCY_FROM[latency.source]}
            {latency.source === 'scenario' && latency.scenario !== null ? <> of {code(latency.scenario)}</> : null}.
          </>
        )}{' '}
        {fault === null ? (
          transport.rulesTried > 0 ? (
            'No fault rule matched.'
          ) : null
        ) : (
          <>
            Fault rule {fault.rule}
            {fault.step === null || faultSequence === null ? null : (
              <>
                , step {fault.step} of {faultSequence.steps}
              </>
            )}
            : {FAULT_TEXT[fault.kind]}
            {fault.kind === 'malformed' && fault.form !== null ? <> ({code(fault.form)})</> : null}.
          </>
        )}{' '}
        {transport.requestCodings.length === 0 ? null : (
          <>Request codings removed: {list(transport.requestCodings)}. </>
        )}
        {transport.responseCoding === null ? null : <>Response coding: {code(transport.responseCoding)}. </>}
        {transport.performed ? null : 'Described, not performed.'}
      </>
    ),
  };
}

/**
 * Turns a trace into steps in resolution order: session, scenario, recording, route,
 * parameters, method, body, language, media type, headers, the supplying
 * scenario, hidden files, rendering. `holders` maps a hidden file to the
 * endpoint holding it, for links. `status` is null when the request would be
 * recorded: there is no response. `scenarioFromTopBar` says the
 * request's `X-Mock-Scenario` was the top bar's, added because the request
 * named none.
 */
export function explain(
  trace: WireTrace,
  status: number | null,
  holders: ReadonlyMap<string, string> = new Map(),
  scenarioFromTopBar = false,
): Step[] {
  const { outcome, route, negotiation, headers, render, session, selection } = trace;
  const kind = outcome.kind;
  const steps: Step[] = [];
  const stopped = (reached: boolean): StepState => (reached ? 'failed' : 'skipped');

  if (session !== null) {
    steps.push({
      title: 'Session',
      state: 'info',
      detail:
        session.source === 'default' || session.id === null ? (
          'No session key: the default session, which holds nothing.'
        ) : (
          <>
            Session {code(session.id)}, from{' '}
            {session.source === 'header' ? 'X-Mock-Session' : 'a credential named in sessions.keyFrom'}.{' '}
            {session.exists ? 'It exists.' : 'It names no session, so it was served as an empty one.'}
          </>
        ),
    });
  }
  if (kind === 'unknown-scenario') {
    steps.push({
      title: 'Scenario',
      state: 'failed',
      detail: (
        <>
          <p>
            No such scenario, named by{' '}
            {scenarioFromTopBar && outcome.source === 'request-header'
              ? SOURCE_TEXT.caller
              : (SOURCE_TEXT[outcome.source ?? ''] ?? 'the request')}
            ; Janus does not fall back to another.
          </p>
          <p>Known scenarios: {list(outcome.known ?? [])}.</p>
        </>
      ),
    });
  } else if (selection !== null) {
    steps.push({
      title: 'Scenario',
      state: 'passed',
      detail: (
        <>
          <p>
            Selected {code(selection.chain[0] ?? trace.scenario ?? 'default')} because{' '}
            {scenarioFromTopBar && selection.source === 'request-header'
              ? SELECTED_BECAUSE.caller
              : SELECTED_BECAUSE[selection.source]}
            .
          </p>
          {selection.chain.length > 1 ? <p>Inherits: {list(selection.chain.slice(1))}.</p> : null}
        </>
      ),
    });
  }

  if (kind === 'would-record') {
    steps.push({
      title: 'Recording',
      state: 'passed',
      detail: (
        <>
          <p>
            X-Mock-Record: true, and {code(`${outcome.registration?.method ?? ''} ${outcome.registration?.path ?? ''}`)}{' '}
            is listed in recording.endpoints.
          </p>
          <p>
            A real request would be forwarded to {code(outcome.upstream ?? '')}, with the headers{' '}
            {list(outcome.forwardedHeaders ?? [])}. Its answer would be relayed and captured.
          </p>
          <p>Nothing was sent: a simulation never reaches an upstream.</p>
        </>
      ),
    });
  } else if (kind === 'recording-not-allowed') {
    steps.push({
      title: 'Recording',
      state: 'failed',
      detail: (
        <>
          X-Mock-Record: true, but no entry of recording.endpoints allows this method and path, or it is a HEAD request.
          Nothing would be sent.
        </>
      ),
    });
  }

  if (kind === 'invalid-request' && route === null) {
    steps.push({
      title: 'Request',
      state: 'failed',
      detail: <>The request was rejected before routing: {outcome.reason ?? 'it is malformed'}.</>,
    });
  }

  const considered = route?.considered ?? [];
  const abandoned =
    considered.length === 0 ? null : <p className="mt-1">Templates considered and abandoned: {list(considered)}.</p>;
  if (route !== null && route.template !== null) {
    steps.push({
      title: 'Route',
      state: 'passed',
      detail: (
        <>
          <p>
            Matched {code(route.template)} for path {code(trace.normalizedPath)}.
          </p>
          {abandoned}
        </>
      ),
    });
    const params = Object.entries(route.params);
    steps.push({
      title: 'Path parameters',
      state: params.length === 0 ? 'info' : 'passed',
      detail:
        params.length === 0 ? (
          'The template has no parameters.'
        ) : (
          <ul>
            {params.map(([name, value]) => (
              <li key={name}>
                {code(`{${name}}`)} = {code(value)}
              </li>
            ))}
          </ul>
        ),
    });
  } else if (kind === 'route-not-found') {
    steps.push({
      title: 'Route',
      state: 'failed',
      detail: (
        <>
          <p>No template matches path {code(trace.normalizedPath)}.</p>
          {abandoned ?? <p className="mt-1">No template matched any prefix of the path.</p>}
        </>
      ),
    });
  }

  const routed = route !== null && route.template !== null;
  if (routed) {
    steps.push(
      kind === 'method-not-allowed'
        ? {
            title: 'Method',
            state: 'failed',
            detail: <>This route does not offer the method. Allowed: {list(outcome.allowed ?? [])}.</>,
          }
        : { title: 'Method', state: 'passed', detail: 'The route offers this method.' },
    );
  }

  const pastMethod = routed && kind !== 'method-not-allowed';
  if (kind === 'unsupported-media-type') {
    steps.push({
      title: 'Request media type',
      state: 'failed',
      detail: <>The request body's media type is not accepted. Accepted: {list(outcome.accepted ?? [])}.</>,
    });
  } else if (pastMethod) {
    steps.push({
      title: 'Request media type',
      state: 'passed',
      detail: 'The request body (if any) is acceptable for this method.',
    });
  }

  const { replay, expect, choice, sequence, transport } = trace;
  if (transport !== null) steps.push(transportStep(transport, kind));
  if (replay !== null) {
    steps.push({
      title: 'Replay',
      state: replay.outcome === 'key-reused' ? 'failed' : replay.outcome === 'replayed' ? 'passed' : 'info',
      detail: REPLAY_TEXT[replay.outcome],
    });
  }
  if (expect !== null) {
    steps.push({
      title: 'Expectations',
      state: expect.passed ? 'passed' : kind === 'expectation-failed' ? 'failed' : 'info',
      detail: expect.passed ? (
        'The request meets every condition in expect.yaml.'
      ) : (
        <>
          <p>Failing conditions: {list(expect.failed)}.</p>
          {kind === 'expectation-failed' ? null : <p>onMismatch chose the response.</p>}
        </>
      ),
    });
  }
  if (choice !== null) {
    steps.push({
      title: 'Response choice',
      state: 'passed',
      detail: (
        <>
          <p>
            Chose {code(choice.identity)} by {CHOSEN_BY[choice.by]}
            {choice.rule === null ? '' : <> (rule {String(choice.rule)})</>}
            {choice.step === null ? '' : <>, step {String(choice.step)}</>}.
          </p>
          {choice.rulesTried === 0 ? null : (
            <p>
              Rules tried: {String(choice.rulesTried)}
              {choice.by === 'rule' ? `, the last of them matched` : ', none matched'}.
            </p>
          )}
          {choice.page === null ? null : (
            <p>
              {choice.page.via === 'value' ? (
                <>The request's value found page {code(choice.page.key ?? '')}.</>
              ) : choice.page.via === 'whenAbsent' ? (
                <>The value was missing, so whenAbsent used page {code(choice.page.key ?? '')}.</>
              ) : (
                'The value is not a page key, so otherwise answered.'
              )}
            </p>
          )}
        </>
      ),
    });
  }
  if (sequence !== null) {
    steps.push({
      title: 'Sequence',
      state: 'info',
      detail: (
        <>
          {sequence.rule === null ? 'sequence.yaml' : `Rule ${String(sequence.rule)}'s sequence`} is at step{' '}
          {String(sequence.position)} of {String(sequence.steps)}.{' '}
          {sequence.advanced
            ? 'This request advanced it.'
            : `It did not advance: ${NOT_ADVANCED[sequence.notAdvancedBecause ?? 'not-chosen']}.`}
        </>
      ),
    });
  }

  const language = negotiation?.language ?? null;
  const languageFailed = kind === 'not-acceptable' && outcome.axis === 'language';
  if (language !== null || languageFailed) {
    steps.push({
      title: 'Language',
      state: languageFailed ? 'failed' : 'passed',
      detail: languageFailed ? (
        <>No localized response matches Accept-Language. Available: {list(outcome.available ?? [])}.</>
      ) : (
        <>
          Selected{' '}
          {language?.selected === null || language === null ? 'the language-neutral response' : code(language.selected)}
          {language?.requested === null || language === null ? (
            ' (no language range decided)'
          ) : (
            <> by {code(language.requested)}</>
          )}
          .
        </>
      ),
    });
  } else if (pastMethod && kind !== 'unsupported-media-type') {
    steps.push({ title: 'Language', state: 'info', detail: 'This endpoint has no localized responses.' });
  }

  const mediaType = negotiation?.mediaType ?? null;
  if (mediaType !== null) {
    const failed = kind === 'not-acceptable' && outcome.axis === 'media-type';
    const unusable = kind === 'invalid-request' && mediaType.selected === null;
    steps.push({
      title: 'Media type',
      state: failed || unusable ? 'failed' : 'passed',
      detail: (
        <>
          <p>Available: {list(mediaType.available)}.</p>
          <p>
            Selected: {mediaType.selected === null ? <em>none</em> : code(mediaType.selected)}
            {mediaType.requested === null ? ' (no Accept range decided)' : <> by {code(mediaType.requested)}</>}.
          </p>
          {mediaType.droppedRanges.length === 0 ? null : (
            <p>Unusable Accept ranges dropped at positions {list(mediaType.droppedRanges)}.</p>
          )}
        </>
      ),
    });
  } else if (pastMethod && kind === 'matched') {
    steps.push({ title: 'Media type', state: 'info', detail: 'The response is bodyless; no media type applies.' });
  }

  if (headers !== null) {
    steps.push({
      title: 'Header policy',
      state: 'passed',
      detail: (
        <>
          <p>Fixture {code(headers.identity)} answered (sent as X-Mock-Identity).</p>
          <p>Dropped Janus-computed headers: {list(headers.dropped)}.</p>
          {headers.contentTypeOverride === null ? null : (
            <p>
              Content-Type overridden: selected as {code(headers.contentTypeOverride.representation)}, sent as{' '}
              {code(headers.contentTypeOverride.wire)}.
            </p>
          )}
        </>
      ),
    });
  }

  if (trace.resolvedFrom !== null) {
    const own = trace.resolvedFrom === trace.scenario;
    steps.push({
      title: 'Supplying scenario',
      state: 'info',
      detail: own ? (
        <>The file belongs to the selected scenario, {code(trace.resolvedFrom)}.</>
      ) : (
        <>The file is inherited from {code(trace.resolvedFrom)} (sent as X-Mock-Resolved-From).</>
      ),
    });
  }
  if (trace.shadowed.length > 0) {
    const more = trace.shadowedCount === null ? 0 : trace.shadowedCount - trace.shadowed.length;
    steps.push({
      title: 'Hidden files',
      state: 'info',
      detail: (
        <>
          <p>Files of ancestor scenarios at this route and method that the selected scenario does not serve:</p>
          <ul className="mt-1 space-y-0.5">
            {trace.shadowed.map((entry) => {
              const endpointId = holders.get(entry.fixtureId);
              return (
                <li key={entry.fixtureId}>
                  {endpointId === undefined ? (
                    code(entry.fixtureId)
                  ) : (
                    <Link
                      to={`/endpoints/${endpointId}/fixtures/${entry.fixtureId}?scenario=${entry.scenario}`}
                      className="font-mono text-accent underline"
                    >
                      {entry.fixtureId}
                    </Link>
                  )}{' '}
                  in {code(entry.scenario)}, {HIDDEN_BY[entry.by]}
                </li>
              );
            })}
          </ul>
          {more > 0 ? <p className="mt-1">…and {more} more.</p> : null}
        </>
      ),
    });
  }

  if (render !== null) {
    steps.push({
      title: 'Rendering',
      state: kind === 'render-failed' ? 'failed' : 'passed',
      detail: (
        <>
          <p>
            Rendered {render.tokens === 1 ? '1 token' : `${String(render.tokens)} tokens`} at {code(render.instant)}{' '}
            (clock: {render.clockSource}).
          </p>
          <p>
            {render.nondeterministic
              ? 'Nondeterministic: the same request can get different bytes.'
              : 'Deterministic for this seed and instant.'}
          </p>
        </>
      ),
    });
  } else if (kind === 'render-failed') {
    steps.push({
      title: 'Rendering',
      state: 'failed',
      detail: (
        <>
          Rendering failed at {code(`{{$${outcome.token ?? ''}}}`)}
          {outcome.reason === null ? '' : `: ${outcome.reason}`}.
        </>
      ),
    });
  } else if (kind === 'invalid-request' && route !== null) {
    steps.push({ title: 'Request', state: stopped(true), detail: <>Rejected: {outcome.reason ?? 'invalid'}.</> });
  }

  steps.push({
    title: 'Outcome',
    state: PASSED_OUTCOMES.has(kind) ? 'passed' : 'failed',
    detail:
      kind === 'fault' ? (
        <>
          {code(kind)}: a real request would get no response; the connection would be{' '}
          {outcome.fault === 'timeout' ? 'held open, then closed' : 'reset'}.
        </>
      ) : status === null ? (
        <>{code(kind)}: the upstream would answer; Janus sends no response of its own.</>
      ) : (
        <>
          {code(kind)}, answered with status {code(String(status))}.
        </>
      ),
  });
  return steps;
}
