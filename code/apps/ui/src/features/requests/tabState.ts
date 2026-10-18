import { useSyncExternalStore } from 'react';

import type { NameValue, RequestDocument } from '../../atlas/runner.js';
import { draftFromSearch, EMPTY_DRAFT, headerRow, type RequestDraft } from '../explorer/requestState.js';

/**
 * State kept per browser tab, in memory: the run variables a
 * send ends with, carried into the next send, the bar's choices, the open
 * editor tabs and the side panel. Nothing here is written to a file; only
 * which saved requests, folders, collections and environments are open (and
 * which is in front) is kept in browser storage, so they reopen at startup.
 */

/** Explore asks what the mock would answer; Live sends. */
export type RequestsView = 'explore' | 'live';

/** Where a Live send goes. */
export type SendTo = 'mock' | 'upstream' | 'record';

export interface BarChoices {
  /** The environment every collection uses; undefined until one is picked or a collection prefers one (then the default). */
  readonly environment: string | null | undefined;
  /** Null: Live until one is chosen. */
  readonly view: RequestsView | null;
  readonly sendTo: SendTo;
  /** Explore: the RFC 3339 instant to render at, or empty for the server's clock. */
  readonly renderAt: string;
}

/**
 * An editor tab: a saved request, folder or
 * collection, an environment, or a request not saved yet. `key` is unique
 * among the open tabs.
 */
export type EditorTab =
  | { readonly kind: 'node'; readonly key: string; readonly id: string }
  | { readonly kind: 'environment'; readonly key: string; readonly id: string }
  | UntitledTab;

/** A request not saved yet: Untitled-1, Untitled-2, and so on. */
export interface UntitledTab {
  readonly kind: 'untitled';
  readonly key: string;
  readonly number: number;
  /**
   * `request`: the full request editor, which saves to a collection and
   * sends Live. `explore`: the simulation form, which needs no runner; a
   * "Try it" or shared explanation link opens one.
   */
  readonly form: 'request' | 'explore';
  /** Where Save suggests, and whose folder settings a Live send uses. */
  readonly parent: string | null;
  /** `request`: the request as edited. */
  readonly document: RequestDocument;
  /** `explore`: the form as a link's query, so the tab reopens as it was left. */
  readonly explore: string;
  /** The complete in-memory Explore draft; its body never enters the address. */
  readonly exploreDraft: RequestDraft;
  /**
   * How a blank tab looked when it opened; null for one opened from a link.
   * While it still looks so, opening a saved item takes its place.
   */
  readonly blank: { readonly document: RequestDocument; readonly exploreDraft: RequestDraft } | null;
}

export const nodeKey = (id: string): string => `n:${id}`;
export const environmentKey = (id: string): string => `e:${id}`;
export const untitledName = (number: number): string => `Untitled-${String(number)}`;
/** `?tab=untitled-3` names an untitled tab in the address. */
export const untitledParam = (number: number): string => `untitled-${String(number)}`;

/** The side panel: which list it shows, and whether it is folded away. */
export interface PanelChoices {
  readonly list: 'collections' | 'environments';
  readonly collapsed: boolean;
  /** The inspector on the right is folded to a rail (`]`). */
  readonly inspector: boolean;
}

export interface SavedDraft {
  readonly base: { readonly id: string; readonly digest: string; readonly document: RequestDocument };
  readonly document: RequestDocument;
}

interface TabState {
  readonly vars: Readonly<Record<string, unknown>>;
  readonly bar: BarChoices;
  readonly tabs: readonly EditorTab[];
  /** The highest Untitled number used, so numbers are not reused while this tab lives. */
  readonly untitled: number;
  /** The headers of the request tab last in front, as edited: a new request starts with them. */
  readonly headers: readonly NameValue[];
  readonly panel: PanelChoices;
  /** Each request tab's name as edited (the tab is where a request is renamed), by tab key. */
  readonly names: Readonly<Record<string, string>>;
  /** Tabs whose editor holds unsaved changes, by tab key: the tab shows a dot. */
  readonly dirty: Readonly<Record<string, true>>;
  readonly drafts: Readonly<Record<string, SavedDraft>>;
}

const INITIAL: TabState = {
  vars: {},
  bar: { environment: undefined, view: null, sendTo: 'upstream', renderAt: '' },
  tabs: [],
  untitled: 0,
  headers: [],
  panel: { list: 'collections', collapsed: false, inspector: false },
  names: {},
  dirty: {},
  drafts: {},
};

let state: TabState = INITIAL;
const listeners = new Set<() => void>();

function set(next: TabState): void {
  const moved = next.tabs !== state.tabs;
  state = next;
  if (moved && restored) store();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTabState(): TabState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Runs started from this tab: only their variables carry over. */
const started = new Set<string>();

/**
 * The run variables a finished run started from this tab ended with; they
 * replace the carried ones (they started from them). Each run carries once.
 */
export function carryVariables(id: string, vars: Readonly<Record<string, unknown>>): void {
  if (!started.delete(id)) return;
  const next: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(vars)) if (value !== null) next[name] = value;
  set({ ...state, vars: next });
}

/** Sets one carried run variable, as the popup edits it. */
export function setVariable(name: string, value: unknown): void {
  set({ ...state, vars: { ...state.vars, [name]: value } });
}

export function resetVariables(): void {
  set({ ...state, vars: {} });
}

export function setBar(change: Partial<BarChoices>): void {
  set({ ...state, bar: { ...state.bar, ...change } });
}

export function pickEnvironment(environment: string | null): void {
  setBar({ environment });
}

export function setPanel(change: Partial<PanelChoices>): void {
  set({ ...state, panel: { ...state.panel, ...change } });
}

/** The headers a new request copies: those of the request tab in front, as edited. */
export function setCurrentHeaders(headers: readonly NameValue[]): void {
  if (sameHeaders(state.headers, headers)) return;
  set({ ...state, headers });
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** An untitled tab opened blank and not changed since: nothing is lost if it goes. */
function untouched(tab: EditorTab): boolean {
  return (
    tab.kind === 'untitled' &&
    tab.blank !== null &&
    (state.names[tab.key] ?? untitledName(tab.number)) === untitledName(tab.number) &&
    same(tab.document, tab.blank.document) &&
    same(tab.exploreDraft, tab.blank.exploreDraft)
  );
}

/**
 * Adds the tab after the others unless one with its key is open. A blank
 * untitled tab left untouched gives up its place to it.
 */
export function openTab(tab: EditorTab): void {
  if (state.tabs.some((open) => open.key === tab.key)) return;
  const spare = new Set(state.tabs.filter(untouched).map((open) => open.key));
  if (spare.size === 0) {
    set({ ...state, tabs: [...state.tabs, tab] });
    return;
  }
  const at = state.tabs.findIndex((open) => spare.has(open.key));
  const tabs = state.tabs.flatMap((open, index) => (index === at ? [tab] : spare.has(open.key) ? [] : [open]));
  const keep = <T>(record: Readonly<Record<string, T>>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !spare.has(key)));
  set({ ...state, tabs, names: keep(state.names), dirty: keep(state.dirty), drafts: keep(state.drafts) });
}

/** Where the open saved items are kept between visits. */
export const OPEN_TABS_KEY = 'janus-requests-open-tabs';

interface StoredTabs {
  readonly tabs: readonly { readonly kind: 'node' | 'environment'; readonly id: string }[];
  readonly front: string | null;
}

let front: string | null = null;
let restored = false;

function store(): void {
  const stored: StoredTabs = {
    tabs: state.tabs.flatMap((tab) => (tab.kind === 'untitled' ? [] : [{ kind: tab.kind, id: tab.id }])),
    front,
  };
  try {
    window.localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(stored));
  } catch {
    // Storage is off or full: the tabs just do not come back next time.
  }
}

/** Notes the tab in front, so it is in front again at startup. */
export function setFrontTab(key: string | null): void {
  if (front === key || key === null) return;
  front = key;
  store();
}

/**
 * Once per page load: reopens the saved items that were open last time, in
 * their order, skipping any gone since. Answers the one that was in front.
 */
export function restoreTabs(exists: (kind: 'node' | 'environment', id: string) => boolean): EditorTab | null {
  if (restored) return null;
  restored = true;
  let stored: unknown;
  try {
    stored = JSON.parse(window.localStorage.getItem(OPEN_TABS_KEY) ?? 'null');
  } catch {
    return null;
  }
  if (typeof stored !== 'object' || stored === null || !Array.isArray((stored as StoredTabs).tabs)) return null;
  const { tabs, front: wasFront } = stored as StoredTabs;
  const reopened = tabs.flatMap((entry): EditorTab[] => {
    if (typeof entry !== 'object' || typeof entry.id !== 'string') return [];
    if (entry.kind === 'node' && exists('node', entry.id))
      return [{ kind: 'node', key: nodeKey(entry.id), id: entry.id }];
    if (entry.kind === 'environment' && exists('environment', entry.id))
      return [{ kind: 'environment', key: environmentKey(entry.id), id: entry.id }];
    return [];
  });
  for (const tab of reopened) openTab(tab);
  return reopened.find((tab) => tab.key === wasFront) ?? reopened.at(-1) ?? null;
}

/** Opens a new untitled request after the others, with the headers of the request tab in front. */
export function openUntitled(form: UntitledTab['form'], parent: string | null, explore = ''): UntitledTab {
  const number = state.untitled + 1;
  let tab: UntitledTab = {
    kind: 'untitled',
    key: `u:${String(number)}`,
    number,
    form,
    parent,
    document: {
      name: untitledName(number),
      method: 'GET',
      url: '',
      ...(state.headers.length === 0 ? {} : { headers: state.headers }),
    },
    explore,
    exploreDraft: draftFromSearch(new URLSearchParams(explore)) ?? {
      ...EMPTY_DRAFT,
      headers: state.headers.map((entry) => headerRow(entry.name, entry.value, entry.disabled !== true)),
    },
    blank: null,
  };
  if (explore === '') tab = { ...tab, blank: { document: tab.document, exploreDraft: tab.exploreDraft } };
  set({ ...state, untitled: number, tabs: [...state.tabs, tab] });
  return tab;
}

export function updateUntitled(
  key: string,
  change: Partial<Pick<UntitledTab, 'document' | 'explore' | 'exploreDraft' | 'parent'>>,
): void {
  const tab = state.tabs.find((open) => open.key === key);
  if (tab?.kind !== 'untitled') return;
  if ((Object.keys(change) as (keyof typeof change)[]).every((name) => tab[name] === change[name])) return;
  set({
    ...state,
    tabs: state.tabs.map((tab) => (tab.key === key && tab.kind === 'untitled' ? { ...tab, ...change } : tab)),
  });
}

/** Puts `next` where the tab with `key` was (an untitled request once saved), or adds it. */
export function replaceTab(key: string, next: EditorTab): void {
  const without = state.tabs.filter((tab) => tab.key !== next.key);
  const at = without.findIndex((tab) => tab.key === key);
  if (at === -1) {
    set({ ...state, tabs: [...without, next] });
    return;
  }
  set({ ...state, tabs: without.map((tab, index) => (index === at ? next : tab)) });
}

/**
 * A saved request moved to `id`: its tab, name, unsaved changes and dot follow
 * it, the draft now based on the file at its new place.
 */
export function moveTab(key: string, id: string, base: SavedDraft['base']): void {
  const next = nodeKey(id);
  if (!state.tabs.some((tab) => tab.key === key)) return;
  const rekey = <T>(record: Readonly<Record<string, T>>, value?: T): Record<string, T> => {
    const { [key]: was, ...rest } = record;
    const kept = value ?? was;
    return kept === undefined ? rest : { ...rest, [next]: kept };
  };
  const draft = state.drafts[key];
  set({
    ...state,
    tabs: state.tabs.map((tab) => (tab.key === key ? { kind: 'node', key: next, id } : tab)),
    names: rekey(state.names),
    dirty: rekey(state.dirty),
    drafts: rekey(state.drafts, draft === undefined ? undefined : { base, document: draft.document }),
  });
}

/** Sets a request tab's name: its editor takes it up as an unsaved change. */
export function setTabName(key: string, name: string): void {
  if (state.names[key] === name) return;
  set({ ...state, names: { ...state.names, [key]: name } });
}

/** Keeps saved-request edits and the digest they were based on across route changes. */
export function rememberDraft(key: string, draft: SavedDraft): void {
  if (!state.tabs.some((tab) => tab.key === key)) return;
  const previous = state.drafts[key];
  if (previous?.base === draft.base && previous.document === draft.document) return;
  set({ ...state, drafts: { ...state.drafts, [key]: draft } });
}

/** Marks whether the tab's editor holds unsaved changes. */
export function setTabDirty(key: string, on: boolean): void {
  if ((state.dirty[key] === true) === on) return;
  const { [key]: _was, ...rest } = state.dirty;
  set({ ...state, dirty: on ? { ...rest, [key]: true } : rest });
}

/** Closes the tab; answers the tab to show instead (its right neighbour, else its left), or null. */
export function closeTab(key: string): EditorTab | null {
  const at = state.tabs.findIndex((tab) => tab.key === key);
  if (at === -1) return null;
  const tabs = state.tabs.filter((tab) => tab.key !== key);
  const { [key]: _closed, ...names } = state.names;
  const { [key]: _changed, ...dirty } = state.dirty;
  const { [key]: _draft, ...drafts } = state.drafts;
  set({ ...state, tabs, names, dirty, drafts });
  return tabs[at] ?? tabs[at - 1] ?? null;
}

/** Closes tabs whose request, folder, collection or environment no longer exists. */
export function closeMissing(exists: (tab: EditorTab) => boolean): void {
  const tabs = state.tabs.filter((tab) => tab.kind === 'untitled' || exists(tab));
  if (tabs.length !== state.tabs.length) {
    const keys = new Set(tabs.map((tab) => tab.key));
    set({
      ...state,
      tabs,
      drafts: Object.fromEntries(Object.entries(state.drafts).filter(([key]) => keys.has(key))),
      dirty: Object.fromEntries(Object.entries(state.dirty).filter(([key]) => keys.has(key))),
      names: Object.fromEntries(Object.entries(state.names).filter(([key]) => keys.has(key))),
    });
  }
}

function sameHeaders(a: readonly NameValue[], b: readonly NameValue[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, index) =>
        entry.name === b[index]?.name && entry.value === b[index].value && entry.disabled === b[index].disabled,
    )
  );
}

export function noteStarted(id: string): void {
  started.add(id);
}

/** For tests: forget everything. */
export function resetTabState(): void {
  started.clear();
  restored = false;
  front = null;
  set(INITIAL);
  try {
    window.localStorage.removeItem(OPEN_TABS_KEY);
  } catch {
    // Nothing stored.
  }
}
