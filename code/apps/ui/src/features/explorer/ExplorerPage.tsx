import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router';

import { AtlasError, type Explanation, type ResolveEnvelope } from '../../atlas/client.js';
import { SCENARIO_NAME } from '../../atlas/wire.js';
import {
  buttonClass,
  errorRowClass,
  iconButtonClass,
  linkClass,
  primaryIconButtonClass,
  removableRowClass,
} from '../../components/buttonClass.js';
import { Tabs } from '../../components/Tabs.js';
import { REQUEST_PANE, ResizeHandle, usePaneWidth } from '../../layouts/ResizeHandle.js';
import { AlertIcon, ExplainIcon, HistoryIcon, SaveIcon } from '../../components/icons.js';
import { EmptyState } from '../../components/states/EmptyState.js';
import { describeOriginFailure, useConnectionContext } from '../../components/states/connection.js';
import { ErrorState } from '../../components/states/ErrorState.js';
import { LoadingState } from '../../components/states/LoadingState.js';
import { useAtlasSession } from '../../hooks/AtlasSession.js';
import { useSnapshotFeed } from '../../hooks/SnapshotFeed.js';
import { useIdempotencyHeader } from '../../hooks/useAtlas.js';
import type { RequestDocument } from '../../atlas/runner.js';
import {
  hasScenarioHeader,
  isScenarioHeader,
  RemoveButton,
  ScenarioHeaderError,
  TableActions,
} from '../requests/fields.js';
import { setCurrentHeaders } from '../requests/tabState.js';
import type { AtlasLayoutContext } from '../../layouts/AtlasLayoutContext.js';
import { useChangeScenario } from '../../scenarios/ScenarioSelector.js';
import { HeadersTable } from '../fixtures/Preview.js';
import { BodyView } from '../requests/JsonTree.js';
import { explain, ExplanationSteps } from './Explanation.js';
import {
  COMMON_METHODS,
  draftFromSearch,
  documentOf,
  draftToSearch,
  EMPTY_DRAFT,
  envelopeOf,
  explorerKey,
  firstPlaceholder,
  headerRow,
  PARAMS,
  savedHeaders,
  simulatedScenario,
  type HeaderRow,
  type RequestDraft,
} from './requestState.js';

const inputClass =
  'w-full min-w-0 rounded border border-line-strong bg-surface px-2 py-0.5 font-mono text-mono focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';
const labelClass = 'block text-muted';

export const SIMULATION_NOTICE = 'Simulation only — nothing is served, stored or sent.';

/**
 * The unsaved request in the Requests tab's Explore mode: describe any
 * request, unsaved, to see the response
 * Janus would send and every decision behind it. It works without the
 * request runner, through `POST /_janus/resolve`.
 */
export function ScratchRequest({
  title = 'Unsaved request',
  renderAt,
  onRequestScenario,
  onSaveToCollection,
  onDraftSearch,
  initialDraft,
  onDraftChange,
}: {
  /** The heading: the untitled tab's name. */
  readonly title?: string;
  readonly renderAt: string;
  /** Told the request as a link's query as it changes, so its tab reopens as it was left. */
  readonly onDraftSearch?: (search: string) => void;
  readonly initialDraft?: RequestDraft;
  readonly onDraftChange?: (draft: RequestDraft) => void;
  /**
   * Told the request's own scenario: always null, as the top bar picks the
   * scenario and an `X-Mock-Scenario` row is never sent.
   */
  readonly onRequestScenario?: (name: string | null) => void;
  /** Saves the request as edited to a collection; absent without the request runner. */
  readonly onSaveToCollection?: (document: RequestDocument) => void;
}) {
  const { health } = useOutletContext<AtlasLayoutContext>();
  if (!health.capabilities.resolve) {
    return (
      <EmptyState title="Explore is off" headingLevel={2}>
        This server does not simulate requests (<code>atlas.resolve: false</code>, or a Janus version without it).
      </EmptyState>
    );
  }
  return (
    <Explorer
      title={title}
      renderAt={renderAt}
      {...(initialDraft === undefined ? {} : { initialDraft })}
      {...(onDraftChange === undefined ? {} : { onDraftChange })}
      {...(onDraftSearch === undefined ? {} : { onDraftSearch })}
      {...(onRequestScenario === undefined ? {} : { onRequestScenario })}
      {...(onSaveToCollection === undefined ? {} : { onSaveToCollection })}
    />
  );
}

interface RunResult {
  readonly envelope: ResolveEnvelope;
  readonly explanation: Explanation;
}

function Explorer({
  title,
  renderAt,
  onRequestScenario,
  onSaveToCollection,
  onDraftSearch,
  initialDraft,
  onDraftChange,
}: {
  readonly title: string;
  readonly renderAt: string;
  readonly onDraftSearch?: (search: string) => void;
  readonly initialDraft?: RequestDraft;
  readonly onDraftChange?: (draft: RequestDraft) => void;
  readonly onRequestScenario?: (name: string | null) => void;
  readonly onSaveToCollection?: (document: RequestDocument) => void;
}) {
  const { client } = useAtlasSession();
  const { scenario: selectedScenario, health } = useOutletContext<AtlasLayoutContext>();
  const changeScenario = useChangeScenario(health);
  const feed = useSnapshotFeed();
  const idempotencyHeader = useIdempotencyHeader();
  const [search, setSearch] = useSearchParams();
  const [draft, setDraft] = useState<RequestDraft>(() => initialDraft ?? draftFromSearch(search) ?? EMPTY_DRAFT);
  const restored = useRef({ key: explorerKey(search), draft: initialDraft });
  // The scenario picked in the top bar applies, as does the bar's instant. An X-Mock-Scenario row is an
  // error until removed, and the request is not simulated meanwhile.
  const picked = selectedScenario.requested;
  const blocked = hasScenarioHeader(draft.headers);
  const cannotSave = draft.includeBody && draft.bodyEncoding === 'base64';
  /** For a link's arrival: only a new link runs it, not the scenario or instant changing later. */
  const settings = useRef({ picked, renderAt });
  useEffect(() => {
    settings.current = { picked, renderAt };
  });
  useEffect(() => {
    onRequestScenario?.(null);
  }, [onRequestScenario]);
  // A new request starts with this one's headers; the tab keeps the request as a link's query.
  useEffect(() => {
    setCurrentHeaders(savedHeaders(draft));
    onDraftChange?.(draft);
    onDraftSearch?.(explorerKey(draftToSearch(draft, new URLSearchParams())));
  }, [draft, onDraftSearch, onDraftChange]);
  /** The explorer part of the hash this view last wrote, so its own writes are not read back as navigation. */
  const [written, setWritten] = useState<string | null>(null);
  const targetRef = useRef<HTMLInputElement>(null);
  const [requestWidth, setRequestWidth] = usePaneWidth(REQUEST_PANE);
  const formId = useId();

  const connection = useConnectionContext();
  const run = useMutation({
    mutationFn: async (envelope: ResolveEnvelope): Promise<RunResult> => ({
      envelope,
      explanation: await client.resolve(envelope),
    }),
  });
  const { mutate } = run;

  // A link (shared, or "Try it") describes a request: load it into the editor when it changes…
  const key = explorerKey(search);
  const [loadedKey, setLoadedKey] = useState(key);
  /** The link just arrived, to act on once rendered; null after this view's own write. */
  const [arrived, setArrived] = useState<string | null>(key);
  if (key !== loadedKey) {
    setLoadedKey(key);
    const own = key === written;
    const loaded = own ? null : draftFromSearch(search);
    if (loaded !== null) setDraft(loaded);
    setArrived(own ? null : key);
  }
  // …then select its first placeholder ("Try it") or run it (a shared explanation). Keyed on the arrival
  // alone: Explain records its write a render before the hash changes, and must not re-run the old link.
  useEffect(() => {
    if (arrived === null || arrived === '') return;
    const loaded =
      (restored.current.key === arrived ? restored.current.draft : undefined) ??
      draftFromSearch(new URLSearchParams(arrived));
    if (loaded === null) return;
    if (new URLSearchParams(arrived).get(PARAMS.tryIt) === '1') {
      const input = targetRef.current;
      const range = firstPlaceholder(loaded.target);
      if (input !== null) {
        input.focus();
        if (range !== null) input.setSelectionRange(range.start, range.end);
      }
      return;
    }
    const scenario = simulatedScenario(loaded, settings.current.picked);
    if (scenario === null) return;
    mutate(envelopeOf({ ...loaded, scenario, now: settings.current.renderAt }));
  }, [arrived, mutate]);

  const submit = (event?: { preventDefault(): void }) => {
    event?.preventDefault();
    const scenario = simulatedScenario(draft, picked);
    if (scenario === null) return;
    const next = draftToSearch(draft, search);
    setWritten(explorerKey(next));
    setSearch(next, { replace: true });
    mutate(envelopeOf({ ...draft, scenario, now: renderAt }));
  };

  const update = (patch: Partial<RequestDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const setRow = (id: number, patch: Partial<HeaderRow>) => {
    update({ headers: draft.headers.map((row) => (row.id === id ? { ...row, ...patch } : row)) });
  };

  const result = run.data;
  // The server's version as last announced, else the one this view loaded: a result from another is stale.
  const current = feed.currentVersion ?? feed.loadedVersion;
  const stale = result !== undefined && current !== null && result.explanation.snapshotVersion !== current;

  return (
    <div
      style={{ '--request-width': `${String(requestWidth)}px` } as CSSProperties}
      className="flex min-h-full flex-col lg:h-full lg:flex-row"
    >
      <section
        aria-labelledby={`${formId}-title`}
        className="shrink-0 bg-bg p-4 lg:w-[var(--request-width)] lg:overflow-y-auto"
      >
        <h2 id={`${formId}-title`} className="font-medium">
          {title}
        </h2>
        <p className="mt-0.5 text-muted">
          Describe a request to see the response Janus would send and every decision behind it.
        </p>
        {/* Ctrl/Cmd + Enter submits from any field; the form is not itself interactive. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <form
          className="mt-3 space-y-3"
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit(event);
          }}
          aria-label="Request to simulate"
        >
          <div
            className={`grid gap-1.5 sm:items-end ${
              onSaveToCollection === undefined
                ? 'sm:grid-cols-[6rem_minmax(0,1fr)_auto]'
                : 'sm:grid-cols-[6rem_minmax(0,1fr)_auto_auto]'
            }`}
          >
            <div>
              <label htmlFor={`${formId}-method`} className={labelClass}>
                Method
              </label>
              <input
                id={`${formId}-method`}
                className={inputClass}
                list={`${formId}-methods`}
                value={draft.method}
                autoCapitalize="characters"
                spellCheck={false}
                onChange={(event) => {
                  update({ method: event.target.value });
                }}
              />
              <datalist id={`${formId}-methods`}>
                {COMMON_METHODS.map((method) => (
                  <option key={method} value={method} />
                ))}
              </datalist>
            </div>
            <div>
              <label htmlFor={`${formId}-target`} className={labelClass}>
                Target (path and query)
              </label>
              <input
                id={`${formId}-target`}
                ref={targetRef}
                className={inputClass}
                value={draft.target}
                spellCheck={false}
                onChange={(event) => {
                  update({ target: event.target.value });
                }}
              />
            </div>
            <button
              type="submit"
              aria-describedby={`${formId}-notice`}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              aria-label="Explain"
              title="Explain (Ctrl + Enter)"
              disabled={blocked}
              className={`${primaryIconButtonClass} justify-self-start sm:mb-px`}
            >
              <ExplainIcon className="size-3.5" />
            </button>
            {onSaveToCollection === undefined ? null : (
              <button
                type="button"
                aria-label="Save to collection"
                title={cannotSave ? 'Base64 bodies cannot be saved to a collection' : 'Save to collection'}
                disabled={cannotSave}
                className={`${iconButtonClass} justify-self-start sm:mb-px`}
                onClick={() => {
                  onSaveToCollection(documentOf(draft));
                }}
              >
                <SaveIcon className="size-3.5" />
              </button>
            )}
          </div>
          {cannotSave && onSaveToCollection !== undefined ? (
            <p role="status" className="text-warn">
              Base64 bodies cannot be saved to a collection. Use Text for a UTF-8 body, or a file body in the request
              editor.
            </p>
          ) : null}
          <p id={`${formId}-notice`} className="border-l-2 border-line-strong pl-2 text-muted">
            {SIMULATION_NOTICE} <span className="text-label text-faint">Ctrl + Enter explains from any field.</span>
          </p>

          <fieldset>
            {/* Floated, so the actions share its line and the legend still names the fieldset. */}
            <legend className={`${labelClass} float-left mt-1`}>Headers</legend>
            <TableActions
              addLabel="Add header"
              onAdd={() => {
                update({ headers: [...draft.headers, headerRow()] });
              }}
              clearLabel="Clear all headers"
              onClear={
                draft.headers.length === 0
                  ? undefined
                  : () => {
                      update({ headers: [] });
                    }
              }
            />
            {draft.headers.length === 0 ? <p className="clear-left mt-1 text-faint">No headers.</p> : null}
            <ul className="clear-left mt-1 space-y-1">
              {draft.headers.map((row, index) => {
                const refused = isScenarioHeader(row.name);
                const sent = row.enabled && !refused;
                const errorId = `${formId}-scenario-${String(row.id)}`;
                return (
                  <li
                    key={row.id}
                    className={`grid grid-cols-[auto_minmax(0,8rem)_minmax(0,1fr)_auto] items-center gap-1 rounded p-0.5 ${
                      refused ? errorRowClass : removableRowClass
                    }`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Send header ${String(index + 1)}${row.name === '' ? '' : ` (${row.name})`}`}
                      title={
                        refused
                          ? 'Never sent; pick the scenario in the scenario list'
                          : row.enabled
                            ? 'Sent; uncheck to leave it out'
                            : 'Not sent; check to send it'
                      }
                      checked={sent}
                      disabled={refused}
                      onChange={(event) => {
                        setRow(row.id, { enabled: event.target.checked });
                      }}
                    />
                    <input
                      aria-label={`Header ${String(index + 1)} name`}
                      className={`${inputClass} ${sent ? '' : 'text-faint line-through'}`}
                      value={row.name}
                      spellCheck={false}
                      {...(refused ? { 'aria-invalid': true, 'aria-describedby': errorId } : {})}
                      onChange={(event) => {
                        setRow(row.id, { name: event.target.value });
                      }}
                    />
                    <input
                      aria-label={`Header ${String(index + 1)} value`}
                      className={`${inputClass} ${sent ? '' : 'text-faint line-through'}`}
                      value={row.value}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(event) => {
                        setRow(row.id, { value: event.target.value });
                      }}
                    />
                    <RemoveButton
                      label={`Remove header ${String(index + 1)}${row.name === '' ? '' : ` (${row.name})`}`}
                      title="Remove header"
                      onClick={() => {
                        update({ headers: draft.headers.filter((entry) => entry.id !== row.id) });
                      }}
                    />
                    {refused ? (
                      <div className="col-span-full">
                        <ScenarioHeaderError
                          id={errorId}
                          value={row.value}
                          onUse={() => {
                            // The top bar picks the scenario: drop the header, and pick its value there when it names one.
                            const value = row.value.trim();
                            update({ headers: draft.headers.filter((entry) => entry.id !== row.id) });
                            if (SCENARIO_NAME.test(value)) changeScenario(value);
                          }}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <div className="mt-1 flex flex-wrap gap-3">
              {draft.headers.some((row) => row.name.trim().toLowerCase() === idempotencyHeader.toLowerCase()) ? null : (
                <button
                  type="button"
                  className={linkClass}
                  onClick={() => {
                    update({ headers: [...draft.headers, headerRow(idempotencyHeader)] });
                  }}
                >
                  Add idempotency key
                </button>
              )}
            </div>
            <p className="mt-1 text-label text-muted">
              With X-Mock-Session and an idempotency key, the explanation says whether a real request would be replayed.
              With X-Mock-Record: true, it says whether the request would be forwarded and recorded.
            </p>
          </fieldset>

          <fieldset>
            <legend className={labelClass}>Body</legend>
            <label className="mt-1 flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.includeBody}
                onChange={(event) => {
                  update({ includeBody: event.target.checked });
                }}
              />
              Send a body
            </label>
            {draft.includeBody ? (
              <div className="mt-2 space-y-2">
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <div>
                    <label htmlFor={`${formId}-content-type`} className={labelClass}>
                      Body Content-Type
                    </label>
                    <input
                      id={`${formId}-content-type`}
                      className={inputClass}
                      value={draft.bodyContentType}
                      placeholder="application/json"
                      spellCheck={false}
                      onChange={(event) => {
                        update({ bodyContentType: event.target.value });
                      }}
                    />
                  </div>
                  <fieldset>
                    <legend className={labelClass}>Encoding</legend>
                    <label className="mr-3 inline-flex items-center gap-1">
                      <input
                        type="radio"
                        name={`${formId}-encoding`}
                        checked={draft.bodyEncoding === 'utf8'}
                        onChange={() => {
                          update({ bodyEncoding: 'utf8' });
                        }}
                      />
                      Text
                    </label>
                    <label className="inline-flex items-center gap-1">
                      <input
                        type="radio"
                        name={`${formId}-encoding`}
                        checked={draft.bodyEncoding === 'base64'}
                        onChange={() => {
                          update({ bodyEncoding: 'base64' });
                        }}
                      />
                      Base64
                    </label>
                  </fieldset>
                </div>
                <div>
                  <label htmlFor={`${formId}-body`} className={labelClass}>
                    Body {draft.bodyEncoding === 'base64' ? '(base64)' : '(text)'}
                  </label>
                  <textarea
                    id={`${formId}-body`}
                    className={`${inputClass} min-h-24`}
                    value={draft.body}
                    spellCheck={false}
                    onChange={(event) => {
                      update({ body: event.target.value });
                    }}
                  />
                </div>
              </div>
            ) : null}
          </fieldset>

          <p className="text-label text-faint">
            The page address shares the method, the target and the header values shown, so treat it like the request
            itself. The body is never part of it.
          </p>
        </form>
      </section>
      <div className="hidden lg:flex">
        <ResizeHandle spec={REQUEST_PANE} width={requestWidth} onResize={setRequestWidth} side="start" />
      </div>
      <div className="min-w-0 flex-1 bg-surface lg:flex lg:min-h-0 lg:flex-col">
        {run.isPending ? <LoadingState label="Simulating the request" /> : null}
        {run.error !== null ? (
          <ErrorState
            title="Could not simulate the request"
            error={run.error}
            {...(run.error instanceof AtlasError
              ? withMessage(describeOriginFailure(run.error, connection))
              : { message: 'An unexpected error occurred.' })}
          />
        ) : null}
        {result !== undefined ? (
          <ExplorerResult
            result={result}
            stale={stale}
            onRerun={() => {
              mutate(result.envelope);
            }}
          />
        ) : null}
        {result === undefined && !run.isPending && run.error === null ? (
          <EmptyState title="Nothing explained yet" headingLevel={null}>
            Describe a request and choose Explain to see the answer and why.
          </EmptyState>
        ) : null}
      </div>
    </div>
  );
}

function ExplorerResult({
  result,
  stale,
  onRerun,
}: {
  readonly result: RunResult;
  readonly stale: boolean;
  readonly onRerun: () => void;
}) {
  const { explanation } = result;
  const { response, fixture } = explanation;
  const contentType = response?.headers.find((header) => header.name === 'content-type');
  const [tab, setTab] = useState<'decisions' | 'headers' | 'body'>('decisions');
  const holders = new Map(explanation.shadowed.map((entry) => [entry.fixtureId, entry.endpointId]));
  const steps = explain(explanation.trace, response?.status ?? null, holders);
  const status = response?.status ?? 0;
  const statusClass = status >= 500 ? 'text-bad' : status >= 400 ? 'text-warn' : 'text-ok';
  const { outcome } = explanation.trace;
  return (
    <section aria-label="Simulated response" className="flex min-h-0 flex-1 flex-col">
      {stale ? (
        <div role="status" className="m-3 border-l-2 border-warn bg-warn-soft p-3">
          <p className="flex items-center gap-2 font-medium">
            <HistoryIcon className="size-4 text-warn" />
            Stale result
          </p>
          <p className="mt-1">
            This explanation is from snapshot <code>{explanation.snapshotVersion}</code>; the fixtures have changed
            since.
          </p>
          <button type="button" className={`${buttonClass} mt-2`} onClick={onRerun}>
            Re-run
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        {response === null && outcome.kind === 'fault' ? (
          <>
            <h3 className="font-medium">No response</h3>
            <span>
              A real request would get no response: the connection would be{' '}
              {outcome.fault === 'timeout' ? 'held open without an answer, then closed' : 'reset'}. Nothing was
              performed.
            </span>
          </>
        ) : response === null ? (
          <>
            <h3 className="font-medium">Would record</h3>
            <span>
              A real request would be forwarded to <code className="font-mono break-all">{outcome.upstream ?? ''}</code>
              . Nothing was sent.
            </span>
          </>
        ) : (
          <>
            <h3 className="font-medium">
              <span className="sr-only">Status</span>{' '}
              <span className={`font-mono text-status ${statusClass}`}>{response.status}</span>
            </h3>
            {fixture === null ? (
              <span>Janus generated this response; no fixture answered.</span>
            ) : (
              <Link
                to={fixtureLink(fixture.endpointId, fixture.fixtureId, explanation.trace.resolvedFrom)}
                className={linkClass}
              >
                Open the fixture that answered
              </Link>
            )}
          </>
        )}
        <span className="ml-auto text-faint">
          From snapshot <code>{explanation.snapshotVersion}</code>
        </span>
        {explanation.notes.length === 0 ? null : (
          <ul aria-label="Simulation notes" className="w-full space-y-0.5 text-muted">
            {explanation.notes.map((note) => (
              <li key={note} className="flex items-center gap-1">
                <AlertIcon className="size-3.5 text-warn" /> Note: {note}.
              </li>
            ))}
          </ul>
        )}
      </div>
      <Tabs
        label="Simulation result"
        tabs={
          response === null
            ? [{ key: 'decisions', label: 'Decisions', count: steps.length }]
            : [
                { key: 'decisions', label: 'Decisions', count: steps.length },
                { key: 'headers', label: 'Headers', count: response.headers.length },
                { key: 'body', label: 'Body' },
              ]
        }
        selected={response === null ? 'decisions' : tab}
        onSelect={setTab}
        panelClassName="min-h-0 flex-1 overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        {tab === 'decisions' || response === null ? (
          <ExplanationSteps steps={steps} />
        ) : tab === 'headers' ? (
          <HeadersTable headers={response.headers.map((header) => ({ ...header, treatment: 'replayed' as const }))} />
        ) : (
          <BodyView
            preview={response.body}
            status={response.status}
            mediaType={contentType === undefined ? null : (contentType.value.split(';')[0] ?? null)}
          />
        )}
      </Tabs>
    </section>
  );
}

/** A fixture in the scenario holding it, so the endpoint page finds it in that scenario's inventory. */
export function fixtureLink(endpointId: string, fixtureId: string, scenario: string | null): string {
  return `/endpoints/${endpointId}/fixtures/${fixtureId}${scenario === null ? '' : `?scenario=${scenario}`}`;
}

function withMessage(message: string | null): { message?: string } {
  return message === null ? {} : { message };
}
