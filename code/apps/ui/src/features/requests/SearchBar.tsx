import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import type { EditorState } from '@codemirror/state';
import {
  EditorView,
  runScopeHandlers,
  type Command,
  type KeyBinding,
  type Panel,
  type ViewUpdate,
} from '@codemirror/view';
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { iconButtonClass } from '../../components/buttonClass.js';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  CloseIcon,
  ReplaceAllIcon,
  ReplaceIcon,
} from '../../components/icons.js';
import { filterBoxClass } from '../../components/listRows.js';

/**
 * The find bar of a code editor, at its top. Ctrl/⌘ + F opens it and Ctrl + H
 * opens it with the replace row (⌘ + H hides the app on macOS, so there
 * ⌘ + Option + F too). Matches follow the typing; Enter goes to the next,
 * Shift + Enter to the previous, and Escape closes the bar and returns to the text.
 */

/** Counting stops here, so a huge body with a one-letter search stays quick. */
const COUNT_LIMIT = 1000;

type Focus = 'search' | 'replace';

/** Each editor's open find bar. */
const bars = new WeakMap<EditorView, SearchBarPanel>();

class SearchBarPanel implements Panel {
  readonly dom = document.createElement('div');
  readonly top = true;
  private readonly root: Root;
  private replace = false;
  /** Bumped to ask the bar to move focus; the bar focuses whatever it names. */
  private focus: { readonly field: Focus; readonly turn: number } = { field: 'search', turn: 0 };

  constructor(private readonly view: EditorView) {
    this.root = createRoot(this.dom);
    bars.set(view, this);
  }

  mount(): void {
    this.render(this.view.state);
  }

  update(update: ViewUpdate): void {
    this.render(update.state);
  }

  destroy(): void {
    if (bars.get(this.view) === this) bars.delete(this.view);
    // Not while React renders: an editor is destroyed as its component unmounts.
    queueMicrotask(() => {
      this.root.unmount();
    });
  }

  /** Shows the replace row, and focuses it once there is something to replace. */
  showReplace(): void {
    this.replace = true;
    const field = getSearchQuery(this.view.state).search === '' ? 'search' : 'replace';
    this.focus = { field, turn: this.focus.turn + 1 };
    this.render(this.view.state);
  }

  private render(state: EditorState): void {
    this.root.render(
      <SearchBar
        view={this.view}
        state={state}
        replace={this.replace}
        focus={this.focus}
        onToggleReplace={() => {
          this.replace = !this.replace;
          this.focus = { field: this.replace ? 'replace' : 'search', turn: this.focus.turn + 1 };
          this.render(this.view.state);
        }}
      />,
    );
  }
}

/** The `createPanel` of the editor's `search()`. */
export function createSearchBar(view: EditorView): Panel {
  return new SearchBarPanel(view);
}

/** Ctrl + H: the find bar with its replace row. */
const openReplace: Command = (view) => {
  openSearchPanel(view);
  bars.get(view)?.showReplace();
  return true;
};

/** The find bar's keys, in the text and in the bar itself. */
export const searchBarKeymap: readonly KeyBinding[] = [
  { key: 'Mod-f', run: openSearchPanel, scope: 'editor search-panel' },
  { key: 'Ctrl-h', run: openReplace, scope: 'editor search-panel' },
  { mac: 'Mod-Alt-f', run: openReplace, scope: 'editor search-panel' },
  { key: 'F3', run: findNext, shift: findPrevious, scope: 'editor search-panel', preventDefault: true },
  { key: 'Mod-g', run: findNext, shift: findPrevious, scope: 'editor search-panel', preventDefault: true },
  { key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' },
];

/** The first match at or after `from`, else the first of all. */
function matchFrom(state: EditorState, query: SearchQuery, from: number): { from: number; to: number } | null {
  const after = query.getCursor(state, from).next();
  if (!after.done) return after.value;
  const first = query.getCursor(state).next();
  return first.done ? null : first.value;
}

/** How many matches there are, up to the limit, and which one is selected (from 1, or 0 for none). */
function countMatches(state: EditorState, query: SearchQuery): { readonly total: number; readonly current: number } {
  if (!query.valid) return { total: 0, current: 0 };
  const { from, to } = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let current = 0;
  for (let match = cursor.next(); !match.done && total < COUNT_LIMIT; match = cursor.next()) {
    total += 1;
    if (match.value.from === from && match.value.to === to) current = total;
  }
  return { total, current };
}

function countText(query: SearchQuery, total: number, current: number): string {
  if (query.search === '') return '';
  if (!query.valid) return 'Invalid regex';
  if (total === 0) return 'No results';
  const all = total >= COUNT_LIMIT ? `${String(COUNT_LIMIT)}+` : String(total);
  return current === 0 ? `${all} found` : `${String(current)} of ${all}`;
}

const inputClass = `${filterBoxClass} w-56 min-w-24 flex-1 font-mono text-mono text-fg aria-invalid:border-bad`;

function Toggle({
  label,
  pressed,
  onToggle,
  children,
}: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onToggle}
      className={`inline-flex size-6 items-center justify-center rounded border font-mono text-label focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
        pressed
          ? 'border-fg bg-fg text-surface'
          : 'border-line-strong bg-surface text-muted hover:bg-hover hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`${iconButtonClass} disabled:opacity-50 disabled:hover:bg-surface disabled:hover:text-muted`}
    >
      {children}
    </button>
  );
}

function SearchBar({
  view,
  state,
  replace,
  focus,
  onToggleReplace,
}: {
  readonly view: EditorView;
  readonly state: EditorState;
  readonly replace: boolean;
  readonly focus: { readonly field: Focus; readonly turn: number };
  readonly onToggleReplace: () => void;
}) {
  const query = getSearchQuery(state);
  // The fields keep what was typed; a query set from outside (Ctrl + F on a selection) replaces it.
  const [spec, setSpec] = useState(() => query);
  const [seen, setSeen] = useState(() => query);
  if (seen !== query) {
    setSeen(query);
    if (!query.eq(spec)) setSpec(query);
  }

  const searchField = useRef<HTMLInputElement>(null);
  const replaceField = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const field = focus.field === 'replace' ? replaceField.current : searchField.current;
    field?.focus();
    field?.select();
  }, [focus]);

  const { total, current } = useMemo(() => countMatches(state, query), [state, query]);

  const commit = (change: Partial<ConstructorParameters<typeof SearchQuery>[0]>): void => {
    const next = new SearchQuery({
      search: spec.search,
      caseSensitive: spec.caseSensitive,
      regexp: spec.regexp,
      wholeWord: spec.wholeWord,
      replace: spec.replace,
      ...change,
    });
    setSpec(next);
    if (next.eq(getSearchQuery(view.state))) return;
    // Searching as you type: the first match from where the selection starts.
    const found =
      next.valid && next.search !== '' && change.replace === undefined
        ? matchFrom(view.state, next, view.state.selection.main.from)
        : null;
    view.dispatch({
      effects: [
        setSearchQuery.of(next),
        ...(found === null ? [] : [EditorView.scrollIntoView(found.from, { y: 'nearest' })]),
      ],
      ...(found === null ? {} : { selection: { anchor: found.from, head: found.to } }),
    });
  };

  const empty = spec.search === '' || !spec.valid;
  return (
    // The keys of the bar, Enter, Escape and the editor's own; its controls are all buttons and fields.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="flex items-start gap-1 px-1 py-1 font-sans text-body"
      onKeyDown={(event) => {
        if (runScopeHandlers(view, event.nativeEvent, 'search-panel')) {
          event.preventDefault();
        } else if (event.key === 'Enter' && event.target === searchField.current) {
          event.preventDefault();
          (event.shiftKey ? findPrevious : findNext)(view);
        } else if (event.key === 'Enter' && event.target === replaceField.current) {
          event.preventDefault();
          replaceNext(view);
        }
      }}
    >
      <button
        type="button"
        aria-label="Show replace"
        title="Show replace"
        aria-expanded={replace}
        onClick={onToggleReplace}
        className="inline-flex h-7 w-5 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        <ChevronRightIcon className={`size-4 transition-transform ${replace ? 'rotate-90' : ''}`} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1">
          <input
            ref={searchField}
            type="text"
            className={inputClass}
            aria-label="Find"
            placeholder="Find"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={spec.search !== '' && !spec.valid}
            value={spec.search}
            // CodeMirror's openSearchPanel focuses the field marked main-field.
            {...{ 'main-field': 'true' }}
            onChange={(event) => {
              commit({ search: event.target.value });
            }}
          />
          <Toggle
            label="Match case"
            pressed={spec.caseSensitive}
            onToggle={() => {
              commit({ caseSensitive: !spec.caseSensitive });
            }}
          >
            Aa
          </Toggle>
          <Toggle
            label="Match whole word"
            pressed={spec.wholeWord}
            onToggle={() => {
              commit({ wholeWord: !spec.wholeWord });
            }}
          >
            <span className="underline decoration-1 underline-offset-2">ab</span>
          </Toggle>
          <Toggle
            label="Use regular expression"
            pressed={spec.regexp}
            onToggle={() => {
              commit({ regexp: !spec.regexp });
            }}
          >
            .*
          </Toggle>
          <span className="min-w-20 px-1 text-label whitespace-nowrap text-muted" aria-live="polite">
            {countText(query, total, current)}
          </span>
          <IconButton label="Previous match (Shift + Enter)" disabled={total === 0} onClick={() => findPrevious(view)}>
            <ArrowUpIcon />
          </IconButton>
          <IconButton label="Next match (Enter)" disabled={total === 0} onClick={() => findNext(view)}>
            <ArrowDownIcon />
          </IconButton>
          <IconButton label="Close (Escape)" onClick={() => closeSearchPanel(view)}>
            <CloseIcon />
          </IconButton>
        </div>
        {replace ? (
          <div className="flex flex-wrap items-center gap-1">
            <input
              ref={replaceField}
              type="text"
              className={inputClass}
              aria-label="Replace"
              placeholder="Replace"
              spellCheck={false}
              autoComplete="off"
              value={spec.replace}
              onChange={(event) => {
                commit({ replace: event.target.value });
              }}
            />
            <IconButton label="Replace all" disabled={empty || total === 0} onClick={() => replaceAll(view)}>
              <ReplaceAllIcon />
            </IconButton>
            <IconButton label="Replace (Enter)" disabled={empty || total === 0} onClick={() => replaceNext(view)}>
              <ReplaceIcon />
            </IconButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}
