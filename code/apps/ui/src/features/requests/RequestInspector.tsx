import { Link } from 'react-router';

import type { Explanation } from '../../atlas/client.js';
import type { RunMode, StepResult } from '../../atlas/runner.js';
import { linkClass } from '../../components/buttonClass.js';
import { explain, ExplanationSteps, type Step } from '../explorer/Explanation.js';
import { fixtureLink } from '../explorer/ExplorerPage.js';
import { Fact, Facts, Section } from '../inspector/Inspector.js';
import { OUTCOME_TEXT } from './StepDetails.js';
import { display } from './variables.js';

/**
 * The inspector beside a request: the response's
 * facts, the run (Live), and why the response is what it is. Explore and a
 * mock send show the mock's decisions; a backend answer is noted, one word a
 * decision, since Janus decided none of it.
 */
export function RequestInspector({
  mode,
  runId,
  step,
}: {
  /** The mode the shown result was got in. */
  readonly mode: RunMode;
  readonly runId: string;
  readonly step: StepResult;
}) {
  const { response, explanation } = step;
  const backend = mode === 'upstream' || mode === 'record';
  const header = (name: string): string | null =>
    response?.headers.find((entry) => entry.name.toLowerCase() === name)?.value ?? null;
  const contentType = header('content-type');
  const failedTests = step.tests.filter((test) => !test.passed).length;
  const variables = Object.keys(step.variables);
  return (
    <div className="divide-y divide-line">
      <Section
        title="Response"
        {...(response === null ? {} : { aside: <span className="font-mono text-label">{response.status}</span> })}
      >
        {response === null ? (
          <p className="text-muted">{mode === 'explain' ? 'No response would be sent.' : 'Nothing was received.'}</p>
        ) : (
          <Facts>
            {backend ? (
              <Fact term="From">{mode === 'record' ? 'The upstream, recorded' : 'The upstream'}</Fact>
            ) : explanation?.fixture === null || explanation === null ? (
              <Fact term="Served by">Janus, no fixture</Fact>
            ) : (
              <Fact term="Served by" mono>
                <Link
                  className={linkClass}
                  to={fixtureLink(
                    explanation.fixture.endpointId,
                    explanation.fixture.fixtureId,
                    explanation.trace.resolvedFrom,
                  )}
                >
                  {explanation.fixture.fixtureId}
                </Link>
              </Fact>
            )}
            <Fact term="Media type" mono>
              {contentType === null ? 'None' : essence(contentType)}
            </Fact>
            {mode === 'explain' ? null : (
              <Fact term="Time" mono>
                {response.timeMs} ms
              </Fact>
            )}
            {explanation === null ? null : (
              <Fact term="Snapshot" mono>
                {explanation.snapshotVersion}
              </Fact>
            )}
            {step.capture === null || mode !== 'record' ? null : (
              <Fact term="Capture">
                <Link className={linkClass} to={`/captures/${step.capture}`}>
                  {step.capture}
                </Link>
              </Fact>
            )}
          </Facts>
        )}
      </Section>
      {mode === 'explain' ? null : (
        <Section title="Run" aside={<span className="font-mono text-label">{runId}</span>}>
          <Facts>
            <Fact term="Outcome">{OUTCOME_TEXT[step.outcome]}</Fact>
            <Fact term="Tests">
              {step.tests.length === 0
                ? 'None'
                : failedTests === 0
                  ? `${String(step.tests.length)} passed`
                  : `${String(failedTests)} of ${String(step.tests.length)} failed`}
            </Fact>
            <Fact term="Variables">
              {variables.length === 0 ? (
                'None set'
              ) : (
                <span title={variables.map((name) => `${name} = ${display(step.variables[name])}`).join('\n')}>
                  {variables.join(', ')}
                </span>
              )}
            </Fact>
          </Facts>
          <p className="mt-1.5">
            <Link className={linkClass} to={`/requests/runs/${runId}`}>
              Open run {runId}
            </Link>
          </p>
        </Section>
      )}
      <Section
        title="Why this response"
        aside={mode === 'explain' ? 'Simulated' : backend ? 'Backend' : 'Mock'}
        asideClass="text-label text-faint"
      >
        {backend ? (
          response === null ? (
            <p className="text-muted">Nothing was received.</p>
          ) : (
            <ExplanationSteps compact steps={backendSteps(response.status, header('content-language'), contentType)} />
          )
        ) : explanation === null ? (
          <p className="text-muted">Janus reported no decisions for this response.</p>
        ) : (
          <ExplanationSteps compact steps={decisionsOf(explanation, step.scenarioFrom === 'run')} />
        )}
      </Section>
    </div>
  );
}

function decisionsOf(explanation: Explanation, scenarioFromTopBar: boolean): Step[] {
  const holders = new Map(explanation.shadowed.map((entry) => [entry.fixtureId, entry.endpointId]));
  return explain(explanation.trace, explanation.response?.status ?? null, holders, scenarioFromTopBar);
}

/** A backend's answer, noted: Janus made none of these decisions. */
export function backendSteps(status: number, language: string | null, contentType: string | null): Step[] {
  const noted = (title: string, detail: string): Step => ({ title, state: 'info', detail });
  return [
    noted('Session', 'Unused'),
    noted('Scenario', 'Unused'),
    noted('Route', 'Proxied'),
    noted('Path parameters', 'Forwarded'),
    noted('Method', 'Forwarded'),
    noted('Response choice', String(status)),
    noted('Language', language === null || language.trim() === '' ? 'Unknown' : language.trim()),
    noted('Media type', contentType === null ? 'None' : shortMediaType(contentType)),
    noted('Rendering', 'Verbatim'),
  ];
}

function essence(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/** One word for a media type: `application/problem+json` is JSON, `text/plain` is Text. */
export function shortMediaType(contentType: string): string {
  const type = essence(contentType);
  if (type === 'text/plain') return 'Text';
  const subtype = type.slice(type.indexOf('/') + 1);
  const word = subtype.includes('+') ? subtype.slice(subtype.lastIndexOf('+') + 1) : subtype;
  if (word === '') return 'Unknown';
  return word.length <= 4 ? word.toUpperCase() : word;
}
