import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, useSearchParams } from 'react-router';

import type { Clock, Health, Scenarios } from '../atlas/client.js';
import { AlertIcon, GearIcon, SpinnerIcon } from '../components/icons.js';
import { useClock, useSnapshotChanged } from '../hooks/useAtlas.js';
import { EnvironmentSelect, RunVariablesNote } from '../features/requests/HeaderControls.js';
import { CONFIG_PARAM } from '../pages/ConfigPage.js';
import { ScenarioSelector } from '../scenarios/ScenarioSelector.js';
import { scenarioSearch, type ScenarioSelection } from '../scenarios/selection.js';
import { ReloadStatus } from './ReloadStatus.js';
import { ThemeLogo } from './ThemeLogo.js';

type Status = 'unavailable' | 'connecting' | 'changed' | 'ready';

const STATUS_LABEL: Readonly<Record<Status, string>> = {
  unavailable: 'Unavailable',
  connecting: 'Connecting',
  changed: 'Snapshot changed',
  ready: 'Ready',
};

const DOT_CLASS: Readonly<Record<Exclude<Status, 'connecting'>, string>> = {
  unavailable: 'bg-bad ring-bad-soft',
  changed: 'bg-warn ring-warn-soft',
  ready: 'bg-ok ring-ok-soft',
};

/** The top bar: logo, status light, view tabs, server facts and alerts. */
export function ConnectionHeader({
  health,
  error,
  pending,
  target,
  scenario,
  scenarios,
}: {
  readonly health: Health | undefined;
  readonly error: Error | null;
  readonly pending: boolean;
  readonly target: string;
  readonly scenario: ScenarioSelection;
  readonly scenarios: Scenarios | undefined;
}) {
  const changed = useSnapshotChanged();
  const clock = useClock();
  // The clock's date and time, worked out when the pointer or focus arrives, for the Clock's tooltip.
  const [clockTitle, setClockTitle] = useState<string | undefined>(undefined);
  const showClockTime = (): void => {
    setClockTitle(clock.data === undefined ? undefined : clockTime(clock.data, clock.dataUpdatedAt, Date.now()));
  };
  const status: Status = error !== null ? 'unavailable' : pending ? 'connecting' : changed ? 'changed' : 'ready';
  return (
    <header className="relative border-b border-line bg-surface">
      <div className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1 px-4">
        <div className="flex items-center gap-2">
          <ThemeLogo />
          <h1 className="text-body font-semibold">Janus</h1>
          <StatusLight status={status} server={target} />
        </div>
        {health === undefined ? null : (
          <ViewTabs
            scenarios={scenario.supported}
            captures={health.capabilities.recording.endpoints > 0 || health.capabilities.runner.available}
            promotions={health.capabilities.promotion.available ? health.capabilities.promotion.pending : null}
          />
        )}
        <RunVariablesNote />
        {health === undefined ? null : (
          <dl
            className="ml-auto flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-muted"
            onPointerEnter={showClockTime}
            onFocus={showClockTime}
          >
            <Fact label="Clock" optional title={clockTitle}>
              {clock.data === undefined ? (
                <span className="font-sans">{clock.error === null ? 'Loading' : 'Not reported'}</span>
              ) : (
                describeClock(clock.data)
              )}
            </Fact>
          </dl>
        )}
        {health === undefined ? null : (
          <div className="flex items-center gap-2">
            <StartupWarnings health={health} />
            <ReloadStatus />
          </div>
        )}
        {health === undefined ? null : (
          <div className="flex items-center gap-x-4">
            <ScenarioSelector health={health} selection={scenario} scenarios={scenarios} />
            <EnvironmentSelect runner={health.capabilities.runner.available} />
          </div>
        )}
        {health === undefined || DESKTOP ? null : <ConfigurationButton />}
      </div>
    </header>
  );
}

/**
 * A 7 px light after the wordmark; its label and the server's address show on
 * hover and focus, and the label is always announced.
 */
function StatusLight({ status, server }: { readonly status: Status; readonly server: string }) {
  const label = STATUS_LABEL[status];
  return (
    <span
      // Focusable so keyboard users can reveal the label, like a pointer hover does.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="group relative inline-grid size-4 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      {status === 'connecting' ? (
        <SpinnerIcon className="size-3.5 text-muted motion-safe:animate-spin" />
      ) : (
        <span
          aria-hidden="true"
          className={`block size-[7px] rounded-full ring-[3px] forced-colors:border forced-colors:border-[CanvasText] ${DOT_CLASS[status]}`}
        />
      )}
      <span role="status" className="sr-only">
        {label}
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-[calc(100%+8px)] left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded bg-fg px-2 py-0.5 text-label font-medium text-surface opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {label} · {server}
      </span>
    </span>
  );
}

const tabClass =
  'flex min-h-10 shrink-0 items-center border-b-2 border-transparent px-2.5 text-muted max-sm:px-1.5 hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent aria-[current=page]:border-fg aria-[current=page]:font-medium aria-[current=page]:text-fg';

/**
 * Requests (Explore and Live), Endpoints, Scenarios, Captures and Promotions.
 * A new top-level view adds a tab here; Configuration is a dialog.
 */
function ViewTabs({
  scenarios,
  captures,
  promotions,
}: {
  readonly scenarios: boolean;
  readonly captures: boolean;
  /** The count of promoted files awaiting review, or null when the server cannot promote. */
  readonly promotions: number | null;
}) {
  const [search] = useSearchParams();
  // Moving between views keeps the selected scenario.
  const keep = scenarioSearch(search);
  return (
    // Scrolls sideways rather than widening the page on the narrowest screens.
    <nav aria-label="Views" className="-mb-px flex max-w-full min-w-0 self-stretch overflow-x-auto">
      <NavLink to={{ pathname: '/requests', search: keep }} className={tabClass}>
        Requests
      </NavLink>
      <NavLink to={{ pathname: '/endpoints', search: keep }} className={tabClass}>
        Endpoints
      </NavLink>
      {scenarios ? (
        <NavLink to={{ pathname: '/scenarios', search: keep }} className={tabClass}>
          Scenarios
        </NavLink>
      ) : null}
      {captures ? (
        <NavLink to={{ pathname: '/captures', search: keep }} className={tabClass}>
          Captures
        </NavLink>
      ) : null}
      {promotions === null ? null : (
        <NavLink to={{ pathname: '/promotions', search: keep }} className={tabClass}>
          Promotions
          {promotions > 0 ? (
            <span className="ml-1.5 font-mono text-mono text-faint">
              {promotions}
              <span className="sr-only"> pending review</span>
            </span>
          ) : null}
        </NavLink>
      )}
    </nav>
  );
}

/** The desktop app opens Configuration from its Server menu; a browser has this button instead. */
const DESKTOP = typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent);

/** Opens the Configuration dialog over the view. */
function ConfigurationButton() {
  const [search, setSearch] = useSearchParams();
  return (
    <button
      type="button"
      className="inline-flex size-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      aria-label="Configuration"
      title="Configuration"
      aria-haspopup="dialog"
      onClick={() => {
        const next = new URLSearchParams(search);
        next.set(CONFIG_PARAM, '1');
        setSearch(next);
      }}
    >
      <GearIcon className="size-4" />
    </button>
  );
}

function Fact({
  label,
  optional = false,
  title,
  children,
}: {
  readonly label: string;
  /** Dropped first when the bar is narrow; the inspector repeats it. */
  readonly optional?: boolean;
  readonly title?: string | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    // The label and the monospaced value share a baseline.
    <div className={`flex min-w-0 items-baseline gap-1.5 ${optional ? 'max-xl:hidden' : ''}`} title={title}>
      <dt>{label}</dt>
      <dd className="min-w-0 font-mono text-mono text-fg">{children}</dd>
    </div>
  );
}

/** "N startup warnings": a chip that opens the list below the top bar. */
function StartupWarnings({ health }: { readonly health: Health }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const warnings = health.warnings ?? [];
  useDismiss(open, ref, () => {
    setOpen(false);
  });
  if (warnings.length === 0) return null;
  return (
    <div ref={ref}>
      <button
        type="button"
        className="inline-flex min-h-6 items-center gap-1.5 whitespace-nowrap rounded border border-warn/40 bg-warn-soft px-2 text-warn hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <AlertIcon className="size-3.5" />
        {warnings.length === 1 ? '1 startup warning' : `${String(warnings.length)} startup warnings`}
      </button>
      {open ? (
        <section id={panelId} aria-label="Startup warnings" className={popoverClass}>
          <ul className="divide-y divide-line">
            {warnings.map((warning, index) => (
              <li key={`${warning.code}-${String(index)}`} className="py-1.5 first:pt-0 last:pb-0">
                <code className="font-medium text-warn">{warning.code}</code>
                <span className="sr-only">: </span>
                <p className="text-muted">{warning.message}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Popovers hang from the right of the top bar. */
export const popoverClass =
  'absolute top-full right-4 z-30 mt-1 max-h-[60vh] w-[min(36rem,calc(100vw-2rem))] overflow-auto rounded border border-line-strong bg-surface p-3 shadow-lg';

/** Escape closes an open popover and returns focus to its toggle; so does a click outside it. */
export function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      close();
      ref.current?.querySelector('button')?.focus();
    };
    const onPointer = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, ref, close]);
}

/** "frozen at 2026-01-01T00:00:00Z, UTC" or "live, Europe/Paris": the server default, since the UI sends no X-Mock-Now. */
/**
 * The clock's date and time `at` (ms) in its timezone: the wall clock when
 * live; when frozen, its instant; when offset, its instant moved on by the
 * time since it was read at `readAt`.
 */
export function clockTime(clock: Clock, readAt: number, at: number): string {
  const instant =
    clock.mode === 'live' || clock.now === null
      ? at
      : Date.parse(clock.now) + (clock.mode === 'offset' ? Math.max(0, at - readAt) : 0);
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'full', timeStyle: 'long' };
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: clock.timezone }).format(instant);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(instant);
  }
}

export function describeClock(clock: Clock) {
  const when = clock.mode === 'live' ? null : clock.now;
  return (
    <>
      {clock.mode}
      {when === null ? null : (
        <>
          {' at '}
          {when}
        </>
      )}
      , {clock.timezone}
    </>
  );
}
