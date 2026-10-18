import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import type { RunMode, RunRecord, RunSummary } from '../../atlas/runner.js';
import { buttonClass, linkClass } from '../../components/buttonClass.js';
import { EmptyState } from '../../components/states/EmptyState.js';
import { ErrorState } from '../../components/states/ErrorState.js';
import { LoadingState } from '../../components/states/LoadingState.js';
import { useAtlasSession } from '../../hooks/AtlasSession.js';
import { useRun, useRuns } from './hooks.js';
import { InspectorSplit } from './InspectorAside.js';
import { RequestInspector } from './RequestInspector.js';
import { OUTCOME_CLASS, OUTCOME_TEXT, StepDetails } from './StepDetails.js';
import { carryVariables } from './tabState.js';

const RUN_MODE_TEXT: Readonly<Record<RunMode, string>> = {
  mock: 'Mock',
  upstream: 'Upstream',
  record: 'Record',
  explain: 'Explore',
};

const RUN_OUTCOME_TEXT: Readonly<Record<NonNullable<RunSummary['outcome']>, string>> = {
  passed: 'Passed',
  failed: 'Failed',
  cancelled: 'Stopped',
};

function runState(run: RunSummary): string {
  return run.outcome === null ? 'Running' : RUN_OUTCOME_TEXT[run.outcome];
}

function runClass(run: RunSummary): string {
  return run.outcome === 'passed' ? 'text-ok' : run.outcome === null ? 'text-muted' : 'text-bad';
}

/**
 * A run: one row per step with its outcome, status and time,
 * updated from `run` events, Stop while it runs, and the selected step in the
 * response panel's layout.
 */
export function RunView({ id }: { readonly id: string }) {
  const { client } = useAtlasSession();
  const run = useRun(id);
  const [selected, setSelected] = useState<number | null>(null);
  const [stopFailure, setStopFailure] = useState<Error | null>(null);

  const record: RunRecord | undefined = run.data;
  useEffect(() => {
    if (record?.state === 'finished') carryVariables(record.id, record.vars);
  }, [record]);

  if (run.error !== null && record === undefined) {
    return (
      <ErrorState
        title="Could not open the run"
        error={run.error}
        message="Runs are kept in memory, so a run started before Janus restarted is gone."
        backTo="/requests/runs"
      />
    );
  }
  if (record === undefined) return <LoadingState label="Opening the run" />;

  // The latest step that has a result, until one is picked.
  const shown =
    selected ??
    [...record.steps].reverse().find((step) => step.outcome === 'failed' || step.outcome === 'passed')?.step ??
    1;
  const step = record.steps.find((entry) => entry.step === shown);

  return (
    <section aria-labelledby="run-title" className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-4 py-2">
        <h2 id="run-title" className="font-medium">
          Run {record.id}
        </h2>
        <span className={`font-medium ${runClass(record)}`} aria-live="polite">
          {runState(record)}
        </span>
        <span className="text-muted">
          <Link className={`${linkClass} underline`} to={`/requests?id=${encodeURIComponent(record.target.id)}`}>
            {record.target.id}
          </Link>
          {record.target.unsaved ? ' (unsaved edit)' : ''} · {RUN_MODE_TEXT[record.mode]}
          {record.scenario === null ? '' : ` · ${record.scenario}`}
          {record.environment === null ? '' : ` · ${record.environment}`}
        </span>
        <span className="text-muted">
          {record.passed} passed, {record.failed} failed of {record.stepCount}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {record.state === 'running' ? (
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setStopFailure(null);
                client.runner.cancelRun(record.id).catch((error: unknown) => {
                  setStopFailure(error instanceof Error ? error : new Error(String(error)));
                });
              }}
            >
              Stop
            </button>
          ) : null}
          <Link className={linkClass} to="/requests/runs">
            All runs
          </Link>
        </div>
      </div>
      {stopFailure === null ? null : <ErrorState title="The run did not stop" error={stopFailure} />}
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <ol aria-label="Steps" className="border-b border-line lg:border-r lg:border-b-0">
          {record.steps.map((entry) => (
            <li key={entry.step}>
              <button
                type="button"
                aria-current={entry.step === shown ? 'true' : undefined}
                className={`flex w-full items-baseline gap-2 border-b border-line px-4 py-1.5 text-left hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                  entry.step === shown ? 'bg-accent-soft' : ''
                }`}
                onClick={() => {
                  setSelected(entry.step);
                }}
              >
                <span className="w-6 shrink-0 text-right font-mono text-mono text-faint">{entry.step}</span>
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span className={`shrink-0 ${OUTCOME_CLASS[entry.outcome]}`}>{OUTCOME_TEXT[entry.outcome]}</span>
                <span className="w-10 shrink-0 text-right font-mono text-mono">{entry.response?.status ?? ''}</span>
                <span className="w-16 shrink-0 text-right font-mono text-mono text-muted">
                  {entry.response === null ? '' : `${String(entry.response.timeMs)} ms`}
                </span>
              </button>
            </li>
          ))}
        </ol>
        <div className="min-w-0">
          {step === undefined ? null : step.outcome === 'pending' || step.outcome === 'running' ? (
            <p className="px-4 py-3 text-muted">{OUTCOME_TEXT[step.outcome]}.</p>
          ) : (
            <InspectorSplit
              className="min-h-full"
              aside={<RequestInspector key={step.step} mode={record.mode} runId={record.id} step={step} />}
            >
              <StepDetails key={step.step} step={step} mode={record.mode} />
            </InspectorSplit>
          )}
        </div>
      </div>
    </section>
  );
}

/** The runs Janus keeps in memory, newest first. */
export function RunList() {
  const runs = useRuns();
  if (runs.error !== null) return <ErrorState title="Could not list the runs" error={runs.error} />;
  if (runs.data === undefined) return <LoadingState label="Listing the runs" />;
  return (
    <section aria-labelledby="runs-title">
      <div className="border-b border-line bg-surface px-4 py-2.5">
        <h2 id="runs-title" className="font-medium">
          Runs
        </h2>
      </div>
      {runs.data.length === 0 ? (
        <EmptyState title="No runs yet">Runs started since Janus started are kept here.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="stack-table data-table">
            <caption className="sr-only">Runs, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Target</th>
                <th scope="col">Mode</th>
                <th scope="col">Outcome</th>
                <th scope="col">Steps</th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((run) => (
                <tr key={run.id}>
                  <td data-label="Run">
                    <Link className={`${linkClass} font-mono text-mono`} to={`/requests/runs/${run.id}`}>
                      {run.id}
                    </Link>
                  </td>
                  <td data-label="Target" className="font-mono text-mono">
                    {run.target.id}
                    {run.target.unsaved ? <span className="ml-1 font-sans text-muted">(unsaved edit)</span> : null}
                  </td>
                  <td data-label="Mode">{RUN_MODE_TEXT[run.mode]}</td>
                  <td data-label="Outcome" className={runClass(run)}>
                    {runState(run)}
                  </td>
                  <td data-label="Steps">
                    {run.passed}/{run.stepCount} passed
                  </td>
                  <td data-label="Started" className="font-mono text-mono">
                    {run.startedAt}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
