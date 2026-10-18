import { useEffect, useState } from 'react';

import type { ProjectState } from '../shared/bridge.js';
import { bridge, mount } from './common.js';

/** The status page: one state per outcome, with its actions. */
function StatusPage() {
  const [state, setState] = useState<ProjectState | null>(null);
  useEffect(() => {
    const unsubscribe = bridge.onProjectState(setState);
    void bridge.projectState().then((initial) => {
      setState((current) => current ?? initial);
    });
    return unsubscribe;
  }, []);
  useEffect(() => {
    document.title = state === null ? 'Janus' : `Janus — ${state.name}`;
  }, [state]);

  return (
    <main className="page" aria-labelledby="title">
      <header>
        <h1 id="title">{state?.name ?? 'Janus'}</h1>
        {state === null ? null : <p className="mono muted">{state.folder}</p>}
      </header>
      <div role="status" aria-live="polite">
        {state === null ? null : <StateBlock state={state} />}
      </div>
    </main>
  );
}

function StateBlock({ state }: { readonly state: ProjectState }) {
  switch (state.kind) {
    case 'starting':
      return (
        <section className="state">
          <h2>Starting</h2>
          <p className="muted">Validating the configuration and fixtures, then starting the server.</p>
        </section>
      );
    case 'stopping':
      return (
        <section className="state">
          <h2>Stopped</h2>
          <p className="muted">The server is not running.</p>
        </section>
      );
    case 'invalid':
      return <Invalid state={state} />;
    case 'port-in-use':
      return (
        <section className="state error">
          <h2>Port in use</h2>
          <p>
            Something else is listening on <code>{address(state.host, state.port)}</code>, so the server cannot start
            there. Stop it and retry, or start on a free port for this run only.
          </p>
          <div className="row">
            <button type="button" className="primary" onClick={() => void bridge.retry()}>
              Retry
            </button>
            <button type="button" onClick={() => void bridge.startOnFreePort()}>
              Start on a Free Port
            </button>
          </div>
        </section>
      );
    case 'bind-failed':
      return (
        <section className="state error">
          <h2>The server could not listen</h2>
          <p>
            Binding <code>{address(state.host, state.port)}</code> failed with <code>{state.code}</code>. Check the
            address and port in janus.config.yaml, then retry.
          </p>
          <div className="row">
            <button type="button" className="primary" onClick={() => void bridge.retry()}>
              Retry
            </button>
          </div>
        </section>
      );
    case 'exited':
      return (
        <section className="state error">
          <h2>The server stopped unexpectedly</h2>
          <p>
            It exited with code <code>{String(state.exitCode)}</code>. The last lines it logged:
          </p>
          <pre className="tail mono" tabIndex={0} aria-label="Last log lines">
            {state.lastLines.length === 0 ? '(nothing logged)' : state.lastLines.join('\n')}
          </pre>
          <div className="row">
            <button type="button" className="primary" onClick={() => void bridge.retry()}>
              Restart
            </button>
            <button type="button" onClick={() => void bridge.showServerLog()}>
              Show Server Log
            </button>
          </div>
        </section>
      );
    case 'running':
      return (
        <section className="state warning">
          <h2>Running without the Atlas</h2>
          <p>
            Mocks are served at <code>{state.mockUrl}</code>.{' '}
            {state.withoutUi === 'disabled'
              ? 'The Atlas UI is off because janus.config.yaml sets ui.enabled: false.'
              : state.withoutUi === 'not-built'
                ? 'The Atlas UI build is missing from this copy of Janus.'
                : null}
          </p>
          <div className="row">
            <button type="button" className="primary" onClick={() => void bridge.copyMockUrl()}>
              Copy Mock URL
            </button>
            <button type="button" onClick={() => void bridge.showServerLog()}>
              Show Server Log
            </button>
          </div>
        </section>
      );
  }
}

function Invalid({ state }: { readonly state: Extract<ProjectState, { kind: 'invalid' }> }) {
  const errors = state.problems.filter((problem) => problem.severity === 'error').length;
  const warnings = state.problems.length - errors;
  return (
    <section className="state error">
      <h2>
        The project has problems{' '}
        <span className="faint">
          {plural(errors, 'error')}
          {warnings > 0 ? `, ${plural(warnings, 'warning')}` : ''}
        </span>
      </h2>
      <p className="muted">Fix them, save, and retry. Nothing was started.</p>
      <ul className="list" aria-label="Problems">
        {state.problems.map((problem, index) => (
          <li key={`${String(index)}-${problem.code}`} className="problem">
            <span className={`chip ${problem.severity}`}>{problem.severity === 'error' ? 'Error' : 'Warning'}</span>
            <div>
              <div className="mono location">{problem.location}</div>
              <div>
                {problem.message} <span className="mono faint">[{problem.code}]</span>
              </div>
              {problem.token === undefined ? null : (
                <div className="mono muted">
                  token: <code>{problem.token}</code>
                </div>
              )}
            </div>
            {problem.canOpen ? (
              <button
                type="button"
                aria-label={`Open File ${problem.location}`}
                onClick={() => void bridge.openProblemFile(index)}
              >
                Open File
              </button>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ul>
      {state.notes.map((note) => (
        <p key={note} className="muted">
          Note: {note}
        </p>
      ))}
      <div className="row">
        <button type="button" className="primary" onClick={() => void bridge.retry()}>
          Retry
        </button>
      </div>
    </section>
  );
}

function address(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${String(port)}`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

mount(<StatusPage />);
