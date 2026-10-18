import { useState } from 'react';
import { Link } from 'react-router';

import type { RunMode, StepResult } from '../../atlas/runner.js';
import type { ResponseHeader } from '../../atlas/wire.js';
import { buttonClass, linkClass } from '../../components/buttonClass.js';
import { MethodBadge } from '../../components/MethodBadge.js';
import { Tabs } from '../../components/Tabs.js';
import { PARAMS } from '../explorer/requestState.js';
import { BodyView } from './JsonTree.js';
import { VIEW_PARAM } from './RunBar.js';
import { display, variableNameFor } from './variables.js';

export const OUTCOME_TEXT: Readonly<Record<StepResult['outcome'], string>> = {
  passed: 'Passed',
  failed: 'Failed',
  'not-run': 'Not run',
  running: 'Running',
  pending: 'Waiting',
};

export const OUTCOME_CLASS: Readonly<Record<StepResult['outcome'], string>> = {
  passed: 'text-ok',
  failed: 'text-bad',
  'not-run': 'text-faint',
  running: 'text-muted',
  pending: 'text-faint',
};

type ResultTab = 'body' | 'headers' | 'tests' | 'console' | 'variables' | 'request';

/** Where a variable can be read from a response, for "Save as variable". */
export type SaveVariable = (name: string, template: string) => void;

/**
 * One step's result in the response panel's layout: status
 * and time, the response, tests, console lines, the variables set, and the
 * capture, or the link that explains a mock answer.
 */
export function StepDetails({
  step,
  mode,
  onSaveVariable,
}: {
  readonly step: StepResult;
  readonly mode: RunMode;
  /** Present when the step's request is open in the editor, whose inspector says why. */
  readonly onSaveVariable?: SaveVariable;
}) {
  const [tab, setTab] = useState<ResultTab>('body');
  const simulated = mode === 'explain';
  const response = step.response;
  const failedTests = step.tests.filter((test) => !test.passed).length;
  const variableCount = Object.keys(step.variables).length;
  const all = [
    { key: 'body', label: 'Body' },
    { key: 'headers', label: 'Headers', count: response?.headers.length },
    {
      key: 'tests',
      label: failedTests > 0 ? `Tests, ${String(failedTests)} failed` : 'Tests',
      count: step.tests.length,
    },
    { key: 'console', label: 'Console', count: step.console.length },
    { key: 'variables', label: 'Variables', count: variableCount },
    { key: 'request', label: simulated ? 'Request simulated' : 'Request sent' },
  ] as const;
  // A simulation runs no scripts or tests and sets no variables.
  const tabs = simulated ? all.filter((entry) => ['body', 'headers', 'request'].includes(entry.key)) : all;
  const mediaType = response?.headers.find((header) => header.name.toLowerCase() === 'content-type')?.value ?? null;
  return (
    <section aria-label={`Result of ${step.name}`} className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-2">
        {simulated && step.outcome === 'passed' ? (
          <span className="font-medium">
            {response === null ? 'No response would be sent' : 'What the mock would answer'}
          </span>
        ) : (
          <span className={`font-medium ${OUTCOME_CLASS[step.outcome]}`}>{OUTCOME_TEXT[step.outcome]}</span>
        )}
        {response === null ? null : (
          <>
            <span>
              Status <code className="font-mono text-mono">{response.status}</code>
            </span>
            {simulated ? (
              <span className="text-muted">Not sent</span>
            ) : (
              <span>
                Time <code className="font-mono text-mono">{response.timeMs} ms</code>
              </span>
            )}
          </>
        )}
        {step.capture !== null && mode === 'record' ? (
          <Link className={linkClass} to={`/captures/${step.capture}`}>
            Capture {step.capture}
          </Link>
        ) : null}
        {mode === 'mock' && onSaveVariable === undefined && step.request !== null ? (
          <Link className={linkClass} to={explainLink(step.request.method, step.request.url, step.request.headers)}>
            Explain
          </Link>
        ) : null}
      </div>
      {step.failure === null ? null : (
        <p role="alert" className="mx-4 mt-2 border-l-2 border-bad bg-bad-soft px-3 py-2">
          <code className="font-mono text-mono">{step.failure.code}</code>: {step.failure.message}
        </p>
      )}
      <Tabs label="Result" tabs={tabs} selected={tab} onSelect={setTab}>
        {tab === 'body' ? (
          response === null ? (
            <p className="px-4 py-3 text-muted">{simulated ? 'No response would be sent.' : 'Nothing was received.'}</p>
          ) : (
            <BodyView
              preview={response.body}
              status={response.status}
              mediaType={mediaType}
              {...(onSaveVariable === undefined ? {} : { onSave: onSaveVariable })}
            />
          )
        ) : null}
        {tab === 'headers' ? (
          response === null ? (
            <p className="px-4 py-3 text-muted">Nothing was received.</p>
          ) : (
            <HeaderList
              headers={response.headers}
              caption="Response headers"
              {...(onSaveVariable === undefined
                ? {}
                : {
                    onSave: (name: string) => {
                      onSaveVariable(variableNameFor(name), `{{$response.header.${name.toLowerCase()}}}`);
                    },
                  })}
            />
          )
        ) : null}
        {tab === 'tests' ? <TestList tests={step.tests} /> : null}
        {tab === 'console' ? <ConsoleList lines={step.console} /> : null}
        {tab === 'variables' ? <VariableList variables={step.variables} /> : null}
        {tab === 'request' ? (
          step.request === null ? (
            <p className="px-4 py-3 text-muted">Nothing was sent.</p>
          ) : (
            <>
              <p className="flex min-w-0 items-center gap-2 px-4 pt-3 font-mono text-mono">
                <MethodBadge method={step.request.method} />
                <span className="break-all">{step.request.url}</span>
              </p>
              <HeaderList headers={step.request.headers} caption="Request headers" />
              <BodyView name="Request body" preview={step.request.body} status={200} mediaType={null} />
            </>
          )
        ) : null}
      </Tabs>
    </section>
  );
}

/** The unsaved request in Explore, opened on the request as sent: its path and query, method and headers. */
function explainLink(method: string, url: string, headers: readonly ResponseHeader[]): string {
  const search = new URLSearchParams();
  search.set(PARAMS.method, method);
  try {
    const parsed = new URL(url);
    search.set(PARAMS.target, `${parsed.pathname}${parsed.search}`);
  } catch {
    search.set(PARAMS.target, '/');
  }
  for (const header of headers) search.append(PARAMS.header, `${header.name}: ${header.value}`);
  search.set(VIEW_PARAM, 'explore');
  return `/requests?${search.toString()}`;
}

function HeaderList({
  headers,
  caption,
  onSave,
}: {
  readonly headers: readonly ResponseHeader[];
  readonly caption: string;
  readonly onSave?: (name: string) => void;
}) {
  if (headers.length === 0) return <p className="px-4 py-3 text-muted">No headers.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="stack-table data-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Value</th>
            {onSave === undefined ? null : (
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="font-mono">
          {headers.map((header, index) => (
            <tr key={`${header.name}:${String(index)}`}>
              <td data-label="Name" className="align-top">
                {header.name}
              </td>
              <td data-label="Value" className="break-all">
                {header.value}
              </td>
              {onSave === undefined ? null : (
                <td className="font-sans">
                  <button
                    type="button"
                    className={buttonClass}
                    aria-label={`Save ${header.name} as variable`}
                    onClick={() => {
                      onSave(header.name);
                    }}
                  >
                    Save as variable
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TestList({ tests }: { readonly tests: StepResult['tests'] }) {
  if (tests.length === 0) return <p className="px-4 py-3 text-muted">No tests ran.</p>;
  return (
    <ul className="divide-y divide-line">
      {tests.map((test, index) => (
        <li key={index} className="px-4 py-1.5">
          <span className={test.passed ? 'text-ok' : 'text-bad'}>{test.passed ? '✓ Passed' : '✗ Failed'}</span>{' '}
          {test.name}
          {test.passed || test.message === undefined ? null : (
            <span className="block font-mono text-mono text-muted">{test.message}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function ConsoleList({ lines }: { readonly lines: StepResult['console'] }) {
  if (lines.length === 0) return <p className="px-4 py-3 text-muted">Scripts logged nothing.</p>;
  return (
    <ol className="divide-y divide-line font-mono text-mono">
      {lines.map((line, index) => (
        <li
          key={index}
          className={`px-4 py-1 whitespace-pre-wrap break-all ${line.level === 'error' ? 'text-bad' : line.level === 'warn' ? 'text-warn' : ''}`}
        >
          <span className="mr-2 font-sans text-label text-faint">{line.level}</span>
          {line.text}
        </li>
      ))}
    </ol>
  );
}

function VariableList({ variables }: { readonly variables: Readonly<Record<string, unknown>> }) {
  const entries = Object.entries(variables);
  if (entries.length === 0) return <p className="px-4 py-3 text-muted">This step set no variables.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="stack-table data-table">
        <caption className="sr-only">Variables set</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {entries.map(([name, value]) => (
            <tr key={name}>
              <td data-label="Name">{name}</td>
              <td data-label="Value" className="break-all">
                {value === null ? <span className="font-sans text-muted">unset</span> : display(value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
