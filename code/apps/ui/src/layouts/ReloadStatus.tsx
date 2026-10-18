import { useId, useRef, useState } from 'react';

import type { ReloadResult } from '../atlas/client.js';
import type { WireReloadProblem } from '../atlas/wire.js';
import { AlertIcon } from '../components/icons.js';
import { LoadingState } from '../components/states/LoadingState.js';
import { useSnapshotFeed } from '../hooks/SnapshotFeed.js';
import { useReloadResult } from '../hooks/useAtlas.js';
import { popoverClass, useDismiss } from './ConnectionHeader.js';

/**
 * "Reload failed" in the connection header: shown while the
 * last reload failed. Opening it fetches the current result, and renders that
 * result even if a newer reload won the race, never the old count with
 * someone else's errors.
 */
export function ReloadStatus() {
  const { lastReload } = useSnapshotFeed();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const failed = lastReload?.outcome === 'failed' ? lastReload : null;
  // Keyed by the failure it explains, so a newer failure fetches again.
  const result = useReloadResult(open && failed !== null ? failed.finishedAt : null);
  useDismiss(open && failed !== null, ref, () => {
    setOpen(false);
  });
  if (failed === null) return null;
  const count = failed.errorCount;
  return (
    <div ref={ref}>
      <button
        type="button"
        className="inline-flex min-h-6 items-center gap-1.5 whitespace-nowrap rounded border border-bad/40 bg-bad-soft px-2 text-bad hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <AlertIcon className="size-3.5" />
        Reload failed ({count === 1 ? '1 error' : `${String(count)} errors`})
      </button>
      {open ? (
        <section id={panelId} aria-label="Reload errors" className={popoverClass}>
          {result.error !== null ? (
            <p>Could not load the reload result: {result.error.message}.</p>
          ) : result.data === undefined ? (
            <LoadingState label="Loading the reload result" />
          ) : (
            <ReloadDetails result={result.data} />
          )}
        </section>
      ) : null}
    </div>
  );
}

function ReloadDetails({ result }: { readonly result: ReloadResult }) {
  if (result.outcome === null) return <p>No reload has run yet.</p>;
  if (result.outcome !== 'failed') {
    return (
      <p>
        A newer reload finished at <time dateTime={result.finishedAt}>{result.finishedAt}</time> with outcome{' '}
        <strong>{result.outcome}</strong>; the earlier failure no longer applies.
      </p>
    );
  }
  return (
    <>
      <p>
        The reload at <time dateTime={result.finishedAt}>{result.finishedAt}</time> found{' '}
        {result.errors.length === 1 ? '1 error' : `${String(result.errors.length)} errors`}. Janus keeps serving
        snapshot <code>{result.activeSnapshotVersion}</code>.
      </p>
      <ul className="mt-2 space-y-2">
        {result.errors.map((error, index) => (
          <li key={`${error.code}-${String(index)}`} className="border-l-2 border-bad py-1 pl-2">
            <ProblemLocation problem={error} />
            <p className="mt-1">{error.message}</p>
            <p className="mt-1 text-label text-muted">
              Code: <code>{error.code}</code>
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

function ProblemLocation({ problem }: { readonly problem: WireReloadProblem }) {
  const { scenario, endpoint, file, line, column } = problem;
  return (
    <p className="font-mono text-mono">
      {scenario === null ? null : <>{scenario}: </>}
      {endpoint.method === null ? null : <span className="font-semibold">{endpoint.method} </span>}
      {endpoint.path}
      {file === null ? null : <> — {file}</>}
      {line === null ? null : (
        <>
          {' '}
          line {line}
          {column === null ? null : <>, column {column}</>}
        </>
      )}
    </p>
  );
}
