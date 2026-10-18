import { useId, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import type { EnvironmentEntry, RunMode } from '../../atlas/runner.js';
import { CompassIcon } from '../../components/icons.js';
import { scenarioSearch, type ScenarioSelection } from '../../scenarios/selection.js';
import { selectClass } from './fields.js';
import { LiveIcon, PlayIcon } from './icons.js';
import { setBar, useTabState, type RequestsView, type SendTo } from './tabState.js';
import { CONFIG_PARAM } from '../../pages/ConfigPage.js';

/** `?mode=explore|live` in the hash: a link ("Try it", a shared explanation) opens in that mode. */
export const VIEW_PARAM = 'mode';

/** What links inside the tab keep: the header's scenario, the mode, and an open Configuration dialog. */
export function keptSearch(search: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(scenarioSearch(search));
  const view = search.get(VIEW_PARAM);
  if (view !== null) next.set(VIEW_PARAM, view);
  if (search.get(CONFIG_PARAM) === '1') next.set(CONFIG_PARAM, '1');
  return next;
}

/** What the tab can do on this server. */
export interface RequestsAbilities {
  /** The request runner: Live, and saved requests. */
  readonly runner: boolean;
  /** `atlas.resolve`: Explore. */
  readonly resolve: boolean;
}

/** Explore or Live: the link's choice, else this tab's last, else Live; only what the server allows. */
export function useRequestsView({ runner, resolve }: RequestsAbilities): RequestsView {
  const [search] = useSearchParams();
  const { bar } = useTabState();
  const linked = search.get(VIEW_PARAM);
  const wanted: RequestsView = linked === 'explore' || linked === 'live' ? linked : (bar.view ?? 'live');
  if (!runner) return 'explore';
  if (!resolve) return 'live';
  return wanted;
}

/** The bar's choices, resolved against what exists now. */
export interface BarSelection {
  readonly environment: string | null;
  readonly view: RequestsView;
  readonly sendTo: SendTo;
  /** The runner mode a send or explain uses. */
  readonly mode: RunMode;
  /**
   * The scenario picked in the top bar, or null when it shows the configured
   * default. A picked one fills in for requests without their own
   * `X-Mock-Scenario`; with none picked, Janus decides (a session pin, else
   * `scenarios.default`).
   */
  readonly scenario: string | null;
  /** The scenario the top bar shows: the picked one, else the configured default. */
  readonly scenarioName: string;
  /** Explore: the RFC 3339 instant to render at, or empty for the server's clock. */
  readonly renderAt: string;
}

export function useBarSelection(
  environments: readonly EnvironmentEntry[],
  topBar: ScenarioSelection,
  view: RequestsView,
): BarSelection {
  const { bar } = useTabState();
  const picked = bar.environment;
  // The default environment (else the first) until one is picked or a collection prefers one; "None" is a choice too.
  const environment =
    picked === undefined
      ? ((environments.find((entry) => entry.default === true) ?? environments[0])?.id ?? null)
      : picked !== null && environments.some((entry) => entry.id === picked)
        ? picked
        : null;
  return {
    environment,
    view,
    sendTo: bar.sendTo,
    mode: view === 'explore' ? 'explain' : bar.sendTo,
    scenario: topBar.requested,
    scenarioName: topBar.name,
    renderAt: bar.renderAt,
  };
}

const segmentClass =
  'inline-flex min-h-6 items-center px-2 text-body text-muted hover:bg-hover hover:text-fg aria-pressed:bg-fg aria-pressed:font-medium aria-pressed:text-surface disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

/**
 * The bar above the request: Explore or Live, the
 * environment, where a Live send goes, and in Explore the instant to render
 * at. Upstream and Record say which origin the request goes to, once known.
 * The scenario itself is picked in the top bar.
 */
export function RunBar({
  abilities,
  selection,
  origin,
  children,
}: {
  readonly abilities: RequestsAbilities;
  readonly selection: BarSelection;
  /** Upstream and Record: the origin the request goes to, or null when it cannot be told yet. */
  readonly origin?: string | null;
  readonly children?: ReactNode;
}) {
  const sendToId = useId();
  const renderAtId = useId();
  const [search, setSearch] = useSearchParams();
  const live = selection.view === 'live';
  const choose = (view: RequestsView): void => {
    setBar({ view });
    // The address carries the mode, so a shared link opens as it was left.
    const next = new URLSearchParams(search);
    next.set(VIEW_PARAM, view);
    setSearch(next, { replace: true });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2">
      <div
        role="group"
        aria-label="Request mode"
        className="inline-flex overflow-hidden rounded border border-line-strong"
      >
        <button
          type="button"
          className={segmentClass}
          aria-pressed={!live}
          disabled={!abilities.resolve}
          title={
            abilities.resolve
              ? 'Explore: ask what the mock would answer, and why. Nothing is sent.'
              : 'Explore is off (atlas.resolve)'
          }
          aria-label="Explore"
          onClick={() => {
            choose('explore');
          }}
        >
          <CompassIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className={`${segmentClass} border-l border-line-strong`}
          aria-pressed={live}
          disabled={!abilities.runner}
          title={abilities.runner ? 'Live: send the request.' : 'Live is off: the request runner is off on this server'}
          aria-label="Live"
          onClick={() => {
            choose('live');
          }}
        >
          <LiveIcon className="size-3.5" />
        </button>
      </div>
      {live ? (
        <div className="flex items-center gap-1.5" title="Send to">
          <PlayIcon className="size-3.5 text-muted" />
          <select
            id={sendToId}
            aria-label="Send to"
            className={selectClass}
            value={selection.sendTo}
            onChange={(event) => {
              setBar({ sendTo: event.target.value as SendTo });
            }}
          >
            <option value="mock">Mock</option>
            <option value="upstream">Upstream</option>
            <option value="record">Record</option>
          </select>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <label htmlFor={renderAtId} className="text-muted">
            Render at
          </label>
          <input
            id={renderAtId}
            className="w-52 rounded border border-line-strong bg-surface px-2 py-0.5 font-mono text-mono focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            value={selection.renderAt}
            placeholder="now"
            title="An RFC 3339 instant, such as 2026-01-01T00:00:00Z; empty for the server’s clock"
            spellCheck={false}
            onChange={(event) => {
              setBar({ renderAt: event.target.value });
            }}
          />
        </div>
      )}
      {live && selection.sendTo !== 'mock' && typeof origin === 'string' ? (
        <p className="text-muted">
          Sends to <code className="font-mono text-mono text-fg">{origin}</code>
        </p>
      ) : null}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}
