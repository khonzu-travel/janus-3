import { useId, useState } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router';

import type { CaptureItem, CaptureQuery } from '../../atlas/client.js';
import { CAPTURE_OUTCOMES, type CaptureOutcome } from '../../atlas/wire.js';
import { buttonClass, linkClass, removableRowClass, removeIconButtonClass } from '../../components/buttonClass.js';
import { HelpTip } from '../../components/HelpTip.js';
import { TrashIcon } from '../../components/icons.js';
import { MethodBadge } from '../../components/MethodBadge.js';
import { filterInputClass, onControl, openableRowClass, pageToolbarClass } from '../../components/listRows.js';
import { EmptyState } from '../../components/states/EmptyState.js';
import { Timestamp } from '../../components/Timestamp.js';
import { ErrorState } from '../../components/states/ErrorState.js';
import { isUnsupported } from '../../components/states/errors.js';
import { LoadingState } from '../../components/states/LoadingState.js';
import { useAtlasSession } from '../../hooks/AtlasSession.js';
import { useSnapshotFeed } from '../../hooks/SnapshotFeed.js';
import { useCaptures, useCapturesChanged, useClock, useRestart } from '../../hooks/useAtlas.js';
import type { AtlasLayoutContext } from '../../layouts/AtlasLayoutContext.js';
import { scenarioSearch } from '../../scenarios/selection.js';
import { ConfirmDialog } from '../requests/RequestWorkspace.js';

type OutcomeFilter = CaptureOutcome | 'unreadable';

export const OUTCOME_TEXT: Readonly<Record<OutcomeFilter, string>> = {
  captured: 'Captured',
  'capture-failed': 'Capture failed',
  'upstream-failed': 'Upstream failed',
  'upstream-timeout': 'Upstream timed out',
  'response-too-large': 'Response too large',
  unreadable: 'Unreadable log line',
};

/** Why an upstream could not be reached, as the server names it. */
export const REASON_TEXT: Readonly<Record<string, string>> = {
  dns: 'host name not resolved',
  refused: 'connection refused',
  unreachable: 'host or network unreachable',
  'connect-timeout': 'connection timed out',
  reset: 'connection closed early',
  certificate: 'TLS certificate not trusted',
  tls: 'TLS handshake failed',
  'invalid-response': 'invalid HTTP response',
  'invalid-request': 'request could not be sent',
  unknown: 'reason unknown',
};

const selectClass =
  'rounded border border-line-strong bg-surface px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/**
 * `#/captures`: recorded exchanges, newest first, filtered by
 * the selected scenario and an outcome, paged with the list's `next`. New
 * captures arrive as `capture` events and are announced politely; focus stays
 * where it is. Each capture can be deleted, after a confirmation.
 */
export function CapturesPage() {
  const { health, scenario } = useOutletContext<AtlasLayoutContext>();
  const feed = useSnapshotFeed();
  const restart = useRestart();
  const [search] = useSearchParams();
  const [allScenarios, setAllScenarios] = useState(!scenario.supported);
  const [outcome, setOutcome] = useState<OutcomeFilter | null>(null);
  const [text, setText] = useState('');
  // `before` values of the pages above the current one; empty on the newest page.
  const [pages, setPages] = useState<readonly string[]>([]);
  const before = pages.at(-1) ?? null;
  const query: CaptureQuery = { scenario: allScenarios ? null : scenario.name, outcome, before };

  // The list refetches on a capture event only on the newest page, so an older page stays put.
  const arrived = feed.captureCount;
  const [seen, setSeen] = useState(arrived);
  const [waiting, setWaiting] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  if (arrived !== seen) {
    const latest = feed.captures.at(-1);
    setSeen(arrived);
    if (latest !== undefined) {
      const fresh = Math.max(1, arrived - seen);
      const text = (OUTCOME_TEXT as Readonly<Record<string, string | undefined>>)[latest.outcome] ?? latest.outcome;
      setAnnouncement(
        before === null
          ? `New capture ${latest.id}: ${text}.`
          : `${String(waiting + fresh)} new ${waiting + fresh === 1 ? 'capture' : 'captures'}; go to Newest to see them.`,
      );
      if (before !== null) setWaiting(waiting + fresh);
    }
  }
  const revision = before === null ? seen : 0;
  const list = useCaptures(query, revision);

  const outcomeId = useId();
  const filterId = useId();
  const reset = (): void => {
    setPages([]);
    setWaiting(0);
  };

  if (health.capabilities.recording.endpoints === 0 && !health.capabilities.runner.available) {
    return (
      <EmptyState title="Recording is off" headingLevel={2}>
        No endpoints are registered in recording.endpoints, so this server records nothing.
      </EmptyState>
    );
  }

  return (
    <section aria-labelledby="captures-title" className="min-h-full bg-bg">
      <div className={pageToolbarClass}>
        <div className="flex items-center gap-1">
          <h2 id="captures-title" className="font-medium">
            Captures
          </h2>
          <HelpTip label="About captures">
            <strong className="font-medium text-fg">Captures are not served.</strong> They are exchanges recorded from
            registered upstreams, kept for review only. Janus never answers a request from them. Deleting one removes
            its files and its log line; files promoted from it stay.
          </HelpTip>
        </div>
        {scenario.supported ? (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={allScenarios}
              onChange={(event) => {
                setAllScenarios(event.target.checked);
                reset();
              }}
            />
            All scenarios
            {allScenarios ? null : (
              <span className="text-faint">
                only <code className="font-mono text-mono">{scenario.name}</code>
              </span>
            )}
          </label>
        ) : null}
        <div className="flex items-center gap-1.5">
          <label htmlFor={outcomeId}>Outcome</label>
          <select
            id={outcomeId}
            className={selectClass}
            value={outcome ?? ''}
            onChange={(event) => {
              setOutcome(event.target.value === '' ? null : (event.target.value as OutcomeFilter));
              reset();
            }}
          >
            <option value="">Any</option>
            {[...CAPTURE_OUTCOMES, 'unreadable' as const].map((value) => (
              <option key={value} value={value}>
                {OUTCOME_TEXT[value]}
              </option>
            ))}
          </select>
        </div>
        <label htmlFor={filterId} className="sr-only">
          Filter captures
        </label>
        <input
          id={filterId}
          type="search"
          className={filterInputClass}
          placeholder="Filter captures"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </div>
      {/* Always rendered, so a screen reader hears each announcement once. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {list.error !== null ? (
        isUnsupported(list.error) ? (
          <EmptyState title="Captures not reported">This Janus server does not report captures.</EmptyState>
        ) : (
          <ErrorState title="Could not load the captures" error={list.error} onRetry={restart} />
        )
      ) : list.data === undefined ? (
        <LoadingState label="Loading captures" />
      ) : (
        <>
          {list.data.items.length === 0 ? (
            before === null ? (
              <EmptyState title="No captures yet">
                Send a request with X-Mock-Record: true to a registered endpoint, or send one from Requests in Record
                mode.
              </EmptyState>
            ) : (
              <EmptyState title="No older captures">This is the oldest page.</EmptyState>
            )
          ) : matching(list.data.items, text).length === 0 ? (
            <EmptyState title="Nothing matches">
              No capture on this page matches this filter.{list.data.next === null ? '' : ' Older ones may.'}
            </EmptyState>
          ) : (
            <CaptureTable items={matching(list.data.items, text)} keep={scenarioSearch(search)} />
          )}
          <nav aria-label="Capture pages" className="flex flex-wrap items-center gap-2 px-4 py-3">
            {before === null ? null : (
              <button type="button" className={buttonClass} onClick={reset}>
                Newest{waiting === 0 ? '' : ` · ${String(waiting)} new`}
              </button>
            )}
            {list.data.next === null ? null : (
              <button
                type="button"
                className={buttonClass}
                onClick={() => {
                  const next = list.data.next;
                  if (next !== null) setPages([...pages, next]);
                }}
              >
                Older
              </button>
            )}
          </nav>
        </>
      )}
    </section>
  );
}

/** The captures whose ID, scenario, method, target, status, outcome or source contain every word of the filter. */
function matching(items: readonly CaptureItem[], text: string): readonly CaptureItem[] {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return items;
  return items.filter((item) => {
    const haystack = (
      item.outcome === 'unreadable'
        ? [item.scenario, OUTCOME_TEXT.unreadable]
        : [
            item.id,
            item.scenario,
            item.method,
            item.target,
            item.status === null ? '' : String(item.status),
            OUTCOME_TEXT[item.outcome],
            item.reason === null ? '' : (REASON_TEXT[item.reason] ?? item.reason),
            item.source === 'runner' ? 'Request runner' : 'Recording',
          ]
    )
      .join(' ')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

function CaptureTable({ items, keep }: { readonly items: readonly CaptureItem[]; readonly keep: string }) {
  const timeZone = useClock().data?.timezone;
  const navigate = useNavigate();
  const { client } = useAtlasSession();
  const changed = useCapturesChanged();
  // The capture whose Delete is being confirmed.
  const [deleting, setDeleting] = useState<string | null>(null);
  return (
    <div className="border-b border-line bg-surface">
      <table className="stack-table data-table">
        <caption className="sr-only">Recorded exchanges, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Scenario</th>
            <th scope="col">Method</th>
            <th scope="col">Target</th>
            <th scope="col">Status</th>
            <th scope="col">Outcome</th>
            <th scope="col">Duration</th>
            <th scope="col">Source</th>
            <th scope="col">
              <span className="sr-only">Delete</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) =>
            item.outcome === 'unreadable' ? (
              <tr key={`${item.scenario}:line:${String(item.line)}`}>
                <td data-label="Time" className="text-faint">
                  —
                </td>
                <td data-label="Scenario" className="font-mono text-mono">
                  {item.scenario}
                </td>
                <td colSpan={7} data-label="Outcome" className="text-bad">
                  {OUTCOME_TEXT.unreadable}: line {item.line} of log.jsonl does not parse.
                </td>
              </tr>
            ) : (
              <tr
                key={item.id}
                className={`${removableRowClass} ${item.detailUrl === null ? '' : openableRowClass}`}
                onClick={(event) => {
                  if (item.detailUrl === null || onControl(event.target)) return;
                  void navigate({ pathname: `/captures/${item.id}`, search: keep });
                }}
              >
                <td data-label="Time" className="font-mono text-mono whitespace-nowrap text-muted">
                  <Timestamp iso={item.at} timeZone={timeZone} />
                </td>
                <td data-label="Scenario" className="font-mono text-mono">
                  {item.scenario}
                </td>
                <td data-label="Method">
                  <MethodBadge method={item.method} />
                </td>
                <td data-label="Target" className="font-mono text-mono break-all">
                  {item.detailUrl === null ? (
                    item.target
                  ) : (
                    <Link to={{ pathname: `/captures/${item.id}`, search: keep }} className={linkClass}>
                      {item.target}
                    </Link>
                  )}
                </td>
                <td data-label="Status" className="font-mono text-mono">
                  {item.status === null ? <span className="text-faint">—</span> : item.status}
                </td>
                <td data-label="Outcome" className={item.outcome === 'captured' ? 'text-ok' : 'text-bad'}>
                  {OUTCOME_TEXT[item.outcome]}
                  {item.reason === null ? null : `: ${REASON_TEXT[item.reason] ?? item.reason}`}
                </td>
                <td data-label="Duration" className="font-mono text-mono whitespace-nowrap text-muted">
                  {item.durationMs} ms
                </td>
                <td data-label="Source">{item.source === 'runner' ? 'Request runner' : 'Recording'}</td>
                <td className="w-0">
                  <button
                    type="button"
                    data-remove=""
                    className={removeIconButtonClass}
                    aria-label={`Delete capture ${item.id}`}
                    title="Delete"
                    onClick={() => {
                      setDeleting(item.id);
                    }}
                  >
                    <TrashIcon className="size-3.5" />
                  </button>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {deleting === null ? null : (
        <ConfirmDialog
          title={`Delete capture ${deleting}?`}
          confirm="Delete"
          onClose={() => {
            setDeleting(null);
          }}
          onConfirm={async () => {
            await client.deleteCapture(deleting);
            await changed();
            setDeleting(null);
          }}
        >
          <DeleteCaptureText />
        </ConfirmDialog>
      )}
    </div>
  );
}

/** What deleting a capture removes, and what it leaves. */
export function DeleteCaptureText() {
  return (
    <p>
      This deletes the capture&rsquo;s files and its line in <code className="font-mono text-mono">log.jsonl</code>.
      Files promoted from it stay. This cannot be undone.
    </p>
  );
}
