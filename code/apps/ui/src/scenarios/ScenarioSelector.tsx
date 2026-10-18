import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router';

import { AtlasError, type Endpoint, type Health, type Scenarios } from '../atlas/client.js';
import { SCENARIO_NAME } from '../atlas/wire.js';
import { CheckIcon, ChevronDownIcon, PlusIcon } from '../components/icons.js';
import { useAtlasSession } from '../hooks/AtlasSession.js';
import { withScenario, type ScenarioSelection } from './selection.js';

/** One entry of the picker: a listed scenario, or only a name while the list loads. */
interface Entry {
  readonly name: string;
  readonly extends: string | null;
  readonly description: string | null;
}

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/** The left half of the joined control: the trigger button, or the new name's input. */
const leftClass =
  'inline-flex min-h-7 min-w-0 items-center rounded-l rounded-r-none border border-line-strong bg-surface font-mono text-mono text-fg focus-visible:relative focus-visible:z-10';

/** The right half: a square button that overlaps the left half's border by 1 px. */
const rightClass =
  '-ml-px inline-flex size-7 shrink-0 items-center justify-center rounded-l-none rounded-r border focus-visible:relative focus-visible:z-10';

const popoverClass =
  'absolute top-full right-0 z-30 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded border border-line-strong bg-surface shadow-lg';

/**
 * The scenario picker in the app header:
 * the current scenario opens a filterable list, and "+" creates a new
 * scenario that extends one of the others. Changing scenario keeps the
 * endpoint on screen when the new scenario has the same route and method,
 * found through the endpoint's matrix; otherwise the endpoint page says the
 * endpoint does not exist there.
 */
export function ScenarioSelector({
  health,
  selection,
  scenarios,
}: {
  readonly health: Health;
  readonly selection: ScenarioSelection;
  readonly scenarios: Scenarios | undefined;
}) {
  const id = useId();
  const change = useChangeScenario(health);
  const [mode, setMode] = useState<'closed' | 'list' | 'create'>('closed');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useEffect(() => {
    if (mode !== 'closed' || !restoreFocus.current) return;
    restoreFocus.current = false;
    triggerRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (mode !== 'list') return undefined;
    const onPointer = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setMode('closed');
    };
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [mode]);

  if (!selection.supported) return null;

  const configured = health.configuredDefaultScenario;
  const listed: readonly Entry[] = scenarios?.items ?? [];
  const entries: readonly Entry[] = [
    listed.find((item) => item.name === configured) ?? { name: configured, extends: null, description: null },
    ...listed.filter((item) => item.name !== configured),
  ];
  const selected = entries.find((item) => item.name === selection.name);
  const close = (focusTrigger: boolean): void => {
    restoreFocus.current = focusTrigger;
    setMode('closed');
  };
  const descriptionId = `${id}-description`;

  return (
    <div ref={rootRef} className="relative flex max-w-full min-w-0 items-center gap-x-1.5">
      <span id={`${id}-label`} className="text-muted">
        Scenario
      </span>
      <div role="group" aria-labelledby={`${id}-label`} className="relative flex min-w-0 items-center">
        {mode === 'create' ? (
          <CreateScenario
            entries={entries}
            current={selection.name}
            onCancel={() => {
              close(true);
            }}
            onCreated={(name) => {
              close(true);
              change(name);
            }}
          />
        ) : (
          <>
            <button
              ref={triggerRef}
              type="button"
              id={`${id}-trigger`}
              aria-haspopup="listbox"
              aria-expanded={mode === 'list'}
              aria-controls={mode === 'list' ? `${id}-list` : undefined}
              aria-labelledby={`${id}-label ${id}-trigger`}
              aria-describedby={selected === undefined || selected.description === null ? undefined : descriptionId}
              title={selected?.description ?? undefined}
              onClick={() => {
                setMode((current) => (current === 'list' ? 'closed' : 'list'));
              }}
              className={`${leftClass} max-w-56 gap-1 pr-1 pl-2 hover:bg-hover ${focusRing}`}
            >
              <span className="truncate">{selection.name}</span>
              <ChevronDownIcon className="size-3.5 text-muted" />
            </button>
            <button
              type="button"
              aria-label="New scenario"
              title="New scenario"
              onClick={() => {
                setMode('create');
              }}
              className={`${rightClass} border-line-strong bg-surface text-muted hover:bg-hover hover:text-fg ${focusRing}`}
            >
              <PlusIcon className="size-3.5" />
            </button>
          </>
        )}
        {mode === 'list' ? (
          <ScenarioList
            id={`${id}-list`}
            entries={entries}
            current={selection.name}
            onPick={(name) => {
              close(true);
              if (name !== selection.name) change(name);
            }}
            onClose={() => {
              close(true);
            }}
          />
        ) : null}
      </div>
      {selected === undefined || selected.description === null ? null : (
        // The description is announced with the control and shown in its tooltip, keeping the bar on one line.
        <span id={descriptionId} className="sr-only">
          {selected.description}
        </span>
      )}
    </div>
  );
}

/** The popover list: a filter, the configured default always first, then the rest in the server's order. */
function ScenarioList({
  id,
  entries,
  current,
  onPick,
  onClose,
}: {
  readonly id: string;
  readonly entries: readonly Entry[];
  readonly current: string;
  readonly onPick: (name: string) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const [first, ...rest] = entries as [Entry, ...Entry[]];
  const matches = rest.filter((entry) => entry.name.toLowerCase().includes(needle));
  const visible = [first, ...matches];
  const matching = matches.length + (first.name.toLowerCase().includes(needle) ? 1 : 0);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      visible.findIndex((entry) => entry.name === current),
    ),
  );
  const activeIndex = Math.min(active, visible.length - 1);
  const optionId = (index: number): string => `${id}-option-${String(index)}`;

  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    // Keeps the active option in view as the arrow keys move past the list's edge.
    const list = listRef.current;
    const option = document.getElementById(optionId(activeIndex));
    if (list === null || option === null) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  });

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const last = visible.length - 1;
    const move = (index: number): void => {
      event.preventDefault();
      setActive(index);
    };
    if (event.key === 'ArrowDown') move(activeIndex >= last ? 0 : activeIndex + 1);
    else if (event.key === 'ArrowUp') move(activeIndex <= 0 ? last : activeIndex - 1);
    else if (event.key === 'Home' && event.altKey) move(0);
    else if (event.key === 'End' && event.altKey) move(last);
    else if (event.key === 'Enter') {
      event.preventDefault();
      const entry = visible[activeIndex];
      if (entry !== undefined) onPick(entry.name);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className={popoverClass}>
      <div className="border-b border-line p-1.5">
        <input
          type="text"
          role="combobox"
          aria-label="Filter scenarios"
          aria-controls={id}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={optionId(activeIndex)}
          autoComplete="off"
          spellCheck={false}
          // The list opens to be filtered: focus goes straight to the filter.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={query}
          placeholder="Filter"
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            const text = next.trim().toLowerCase();
            const filtered = rest.filter((entry) => entry.name.toLowerCase().includes(text));
            // Typing moves to the first match below the default; clearing goes back to the current scenario.
            if (text !== '' && filtered.length > 0) setActive(1);
            else
              setActive(
                Math.max(
                  0,
                  [first, ...filtered].findIndex((entry) => entry.name === current),
                ),
              );
          }}
          onKeyDown={onKeyDown}
          className={`w-full rounded border border-line-strong bg-surface px-2 py-0.5 font-mono text-mono text-fg placeholder:text-faint ${focusRing}`}
        />
      </div>
      <ul
        ref={listRef}
        id={id}
        role="listbox"
        aria-label="Scenarios"
        className="relative max-h-[50vh] overflow-auto py-1"
      >
        {visible.map((entry, index) => (
          <ScenarioOption
            key={entry.name}
            id={optionId(index)}
            entry={entry}
            selected={entry.name === current}
            active={index === activeIndex}
            divided={index === 0 && visible.length > 1}
            onPick={() => {
              onPick(entry.name);
            }}
          />
        ))}
      </ul>
      <p className="border-t border-line px-2.5 py-1 text-label text-muted" aria-live="polite">
        {needle === ''
          ? `${String(entries.length)} scenarios`
          : `${String(matching)} of ${String(entries.length)} match`}
      </p>
    </div>
  );
}

function ScenarioOption({
  id,
  entry,
  selected,
  active,
  divided,
  onPick,
}: {
  readonly id: string;
  readonly entry: Entry;
  readonly selected: boolean;
  readonly active: boolean;
  /** The configured default, set apart from the scenarios below it. */
  readonly divided: boolean;
  readonly onPick: () => void;
}) {
  return (
    // Options are picked with the pointer here and with the keyboard from the filter (aria-activedescendant).
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events
    <li
      id={id}
      role="option"
      aria-selected={selected}
      aria-labelledby={`${id}-name`}
      aria-describedby={entry.extends === null ? undefined : `${id}-extends`}
      title={entry.description ?? undefined}
      onClick={onPick}
      className={`flex min-h-6 cursor-default items-center gap-1.5 px-2 hover:bg-hover ${active ? 'bg-hover' : ''} ${divided ? 'mb-1 border-b border-line pb-1' : ''}`}
    >
      <span className="inline-flex size-3.5 shrink-0 text-accent">
        {selected ? <CheckIcon className="size-3.5" /> : null}
      </span>
      <span id={`${id}-name`} className={`truncate font-mono text-mono ${selected ? 'font-medium' : ''}`}>
        {entry.name}
      </span>
      {entry.extends === null ? null : (
        <span id={`${id}-extends`} className="ml-auto shrink-0 pl-2 text-label text-muted">
          extends {entry.extends}
        </span>
      )}
    </li>
  );
}

/** The new name in place of the trigger, a ✓ in place of "+", and the parent and hints in a popover. */
function CreateScenario({
  entries,
  current,
  onCancel,
  onCreated,
}: {
  readonly entries: readonly Entry[];
  readonly current: string;
  readonly onCancel: () => void;
  readonly onCreated: (name: string) => void;
}) {
  const id = useId();
  const { client, generation } = useAtlasSession();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [parent, setParent] = useState(current);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);

  const problem = invalidName(
    name,
    entries.map((entry) => entry.name),
  );
  const ready = name !== '' && problem === null && !pending;

  useEffect(() => {
    // A click elsewhere leaves only when nothing has been typed, so a name is never lost by accident.
    const onPointer = (event: PointerEvent): void => {
      if (name === '' && ref.current !== null && !ref.current.contains(event.target as Node)) onCancel();
    };
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
    };
  });

  const create = async (): Promise<void> => {
    if (!ready) return;
    setPending(true);
    setFailure(null);
    try {
      const created = await client.createScenario(name, parent);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['atlas', generation, 'health'] }),
        queryClient.invalidateQueries({ queryKey: ['atlas', generation, 'scenarios'] }),
      ]);
      onCreated(created.name);
    } catch (error) {
      setPending(false);
      setFailure(error instanceof AtlasError ? error.message : 'The scenario could not be created');
    }
  };

  const errorText = problem ?? failure;
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onCancel();
  };
  return (
    <form
      ref={ref}
      aria-labelledby={`${id}-title`}
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <span id={`${id}-title`} className="sr-only">
        New scenario
      </span>
      <input
        type="text"
        aria-label="New scenario name"
        aria-invalid={problem !== null}
        aria-describedby={`${errorText === null ? '' : `${id}-error `}${id}-hint`}
        // The "+" asked for a name: type it in place.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        autoComplete="off"
        spellCheck={false}
        placeholder="new-scenario"
        value={name}
        readOnly={pending}
        onKeyDown={onEscape}
        onChange={(event) => {
          setName(event.target.value);
          setFailure(null);
        }}
        className={`${leftClass} w-44 px-2 placeholder:text-faint aria-[invalid=true]:border-bad ${focusRing}`}
      />
      <button
        type="submit"
        aria-label="Create scenario"
        title="Create scenario"
        disabled={!ready}
        onKeyDown={onEscape}
        className={`${rightClass} border-fg bg-fg text-surface hover:opacity-90 disabled:opacity-50 ${focusRing}`}
      >
        <CheckIcon className="size-3.5" />
      </button>
      <div className={`${popoverClass} space-y-2 p-2.5`}>
        <label className="flex items-center gap-2">
          <span className="text-muted">Inherits from</span>
          <select
            value={parent}
            disabled={pending}
            onKeyDown={onEscape}
            onChange={(event) => {
              setParent(event.target.value);
            }}
            className={`min-w-0 flex-1 rounded border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-mono text-fg ${focusRing}`}
          >
            {entries.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        {errorText === null ? null : (
          <p id={`${id}-error`} role="alert" className="text-bad">
            {errorText}
          </p>
        )}
        <p id={`${id}-hint`} className="text-label text-muted">
          Lower-case letters, digits and dashes. Enter creates it and switches to it; Esc cancels.
        </p>
        {pending ? <p className="text-label text-muted">Creating…</p> : null}
      </div>
    </form>
  );
}

/** Why `name` cannot be a new scenario, or null when it can (an empty name is not yet a problem). */
export function invalidName(name: string, existing: readonly string[]): string | null {
  if (name === '') return null;
  if (!SCENARIO_NAME.test(name)) return 'Use lower-case letters and digits, with single dashes between them.';
  if (existing.includes(name)) return `Scenario ${name} already exists.`;
  return null;
}

/** Selects a scenario, carrying the endpoint (and response) on screen over when the new scenario has it. */
export function useChangeScenario(health: Health): (name: string) => void {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const { generation } = useAtlasSession();
  const endpointId = useMatch({ path: '/endpoints/:endpointId', end: false })?.params.endpointId;
  const fixtureId = useMatch('/endpoints/:endpointId/fixtures/:fixtureId')?.params.fixtureId;
  return (name: string) => {
    const next = withScenario(search, name, health.configuredDefaultScenario);
    let target = pathname;
    if (endpointId !== undefined) {
      const endpoint = queryClient
        .getQueryCache()
        .findAll({ queryKey: ['atlas', generation, 'endpoint'] })
        .map((query) => query.state.data as Endpoint | undefined)
        .find((data) => data?.id === endpointId);
      const row = endpoint?.matrix?.rows.find((entry) => entry.scenario === name);
      if (row !== undefined) {
        const keepsFixture =
          fixtureId !== undefined &&
          row.cells.some((cell) => cell?.representations.some((entry) => entry.fixtureId === fixtureId) === true);
        target = `/endpoints/${row.endpointId}${keepsFixture ? `/fixtures/${fixtureId}` : ''}`;
      }
    }
    const text = next.toString();
    void navigate({ pathname: target, search: text === '' ? '' : `?${text}` });
  };
}
