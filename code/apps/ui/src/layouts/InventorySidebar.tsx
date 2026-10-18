import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useHref, useMatch, useNavigate, useSearchParams } from 'react-router';

import type { EndpointItem, Inventory } from '../atlas/client.js';
import { buttonClass } from '../components/buttonClass.js';
import { ChevronRightIcon } from '../components/icons.js';
import { MethodBadge } from '../components/MethodBadge.js';
import { OriginBadge } from '../components/OriginBadge.js';
import { describePath, PathTemplate } from '../components/PathTemplate.js';
import { EmptyState } from '../components/states/EmptyState.js';
import { ErrorState } from '../components/states/ErrorState.js';
import { isNotFound, isStale } from '../components/states/errors.js';
import { LoadingState } from '../components/states/LoadingState.js';
import { StaleState } from '../components/states/StaleState.js';
import { filterBoxClass } from '../components/listRows.js';
import { useSnapshotChanged } from '../hooks/useAtlas.js';
import {
  buildEndpointTree,
  DEFAULT_EXPANDED_DEPTH,
  folderPathsTo,
  layoutTree,
  pruneTree,
  treeRows,
  type EndpointTreeNode,
  type TreeRow,
} from './endpointTree.js';
import {
  describeFilter,
  filterEndpoints,
  filterFromSearch,
  filterToSearch,
  inventorySearch,
  isFiltering,
  methodsIn,
  prepareSearch,
  type InventoryFilter,
} from './inventoryFilter.js';
import { markFilterInput, measureFilterCommit } from '../perf.js';

export function InventorySidebar({
  inventory,
  error,
  loadedFrom,
  scenario,
  scenarios,
  onRestart,
  foldButton,
}: {
  readonly inventory: Inventory | undefined;
  readonly error: Error | null;
  readonly loadedFrom: string;
  /** The selected scenario. */
  readonly scenario: string;
  /** The server has scenarios: rows show their origin and "Own only" filters by it. */
  readonly scenarios: boolean;
  readonly onRestart: () => void;
  /** The pane's fold button, at the end of the search row. */
  readonly foldButton?: ReactNode;
}) {
  const changed = useSnapshotChanged();
  const searching = error === null && inventory !== undefined && inventory.items.length > 0;
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <h2 id="inventory-title" className="sr-only">
        Endpoints
      </h2>
      {/* Without a search row (loading, errors, no endpoints) the button keeps a row of its own. */}
      {foldButton === undefined || searching ? null : (
        <div className="flex justify-end px-1.5 pt-1.5">{foldButton}</div>
      )}
      {error !== null ? (
        isStale(error) ? (
          <StaleState loadedFrom={loadedFrom} onRefresh={onRestart} />
        ) : scenarios && isNotFound(error) ? (
          <ErrorState
            title="Scenario not found"
            message={`Snapshot ${loadedFrom} has no scenario named ${scenario}.`}
            backTo="/endpoints"
          />
        ) : (
          <ErrorState title="Could not load endpoints" error={error} onRetry={onRestart} />
        )
      ) : inventory === undefined ? (
        <LoadingState label="Loading endpoints" />
      ) : inventory.items.length === 0 ? (
        <EmptyState title="No endpoints yet">
          {scenario === 'default' ? (
            <>
              This snapshot has no fixtures. Add response files under <code>default/</code> in the data directory and
              restart Janus, then retry.
            </>
          ) : (
            <>
              Scenario <code>{scenario}</code> has no endpoints: it removes everything it inherits and adds none of its
              own.
            </>
          )}
        </EmptyState>
      ) : (
        <>
          {changed ? <StaleState loadedFrom={loadedFrom} onRefresh={onRestart} /> : null}
          <FilteredInventory items={inventory.items} scenarios={scenarios} foldButton={foldButton} />
        </>
      )}
    </section>
  );
}

/** Search, method filters and the path tree over the loaded inventory. */
function FilteredInventory({
  items,
  scenarios,
  foldButton,
}: {
  readonly items: readonly EndpointItem[];
  readonly scenarios: boolean;
  readonly foldButton: ReactNode;
}) {
  const [search, setSearch] = useSearchParams();
  const hashFilter = useMemo(() => filterFromSearch(search), [search]);
  // The query as typed, until the hash catches up. A keystroke filters at once,
  // from this; the hash is written after that render, since a navigation per
  // keystroke would delay it, and a field bound to the hash
  // alone drops keys typed while the router applies it.
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null && draft === hashFilter.query) setDraft(null);
  const filter = useStableFilter(draft === null ? hashFilter : { ...hashFilter, query: draft });
  const visible = useStableList(useMemo(() => filterEndpoints(items, filter), [items, filter]));
  const tree = useMemo(() => buildEndpointTree(items), [items]);
  const visibleTree = useMemo(() => (visible === items ? tree : pruneTree(tree, visible)), [items, visible, tree]);
  const methods = useMemo(() => methodsIn(items), [items]);
  const linkSearch = useMemo(() => inventorySearch(filterToSearch(filter, new URLSearchParams())), [filter]);
  const searchId = useId();
  useEffect(() => {
    // While the browser is idle, so the first keystroke does not lower-case 2 000 paths.
    const idle =
      typeof requestIdleCallback === 'function' ? requestIdleCallback : (run: () => void) => setTimeout(run, 0);
    const cancel = typeof cancelIdleCallback === 'function' ? cancelIdleCallback : clearTimeout;
    const handle = idle(() => {
      prepareSearch(items);
    });
    return () => {
      cancel(handle);
    };
  }, [items]);
  // After the commit that applies a new filter, so the measure covers the whole tree below.
  useLayoutEffect(measureFilterCommit, [filter]);

  // The hash as last written: the router's functional updates all see the rendered value, so
  // several changes queued before a render would otherwise overwrite one another.
  const latest = useRef(search);
  useEffect(() => {
    latest.current = search;
  }, [search]);
  const updateSearch = useCallback(
    (change: (current: URLSearchParams) => URLSearchParams) => {
      const next = change(latest.current);
      latest.current = next;
      setSearch(next, { replace: true });
    },
    [setSearch],
  );

  const pendingQuery = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(pendingQuery.current);
    },
    [],
  );
  const setFilter = useCallback(
    (patch: Partial<InventoryFilter>) => {
      if (patch.query !== undefined) {
        // This change wins over a keystroke not yet in the hash.
        clearTimeout(pendingQuery.current);
        setDraft(patch.query);
      }
      updateSearch((current) => filterToSearch({ ...filterFromSearch(current), ...patch }, current));
    },
    [updateSearch],
  );
  const typeQuery = (query: string) => {
    markFilterInput();
    setDraft(query);
    clearTimeout(pendingQuery.current);
    pendingQuery.current = setTimeout(() => {
      updateSearch((current) => filterToSearch({ ...filterFromSearch(current), query }, current));
    }, 0);
  };

  // Computed from the hash as it is when applied, so toggles queued before a render are not lost.
  const toggleFolder = useCallback(
    (path: string, openByDefault: boolean) => {
      updateSearch((current) => {
        const now = filterFromSearch(current);
        const open = now.collapsed.includes(path) ? false : now.expanded.includes(path) ? true : openByDefault;
        const collapsed = now.collapsed.filter((entry) => entry !== path);
        const expanded = now.expanded.filter((entry) => entry !== path);
        // Record only departures from the default, so links stay short.
        if (open && openByDefault) collapsed.push(path);
        if (!open && !openByDefault) expanded.push(path);
        return filterToSearch({ ...now, collapsed, expanded }, current);
      });
    },
    [updateSearch],
  );

  const toggleMethod = (method: string) => {
    const selected = filter.methods.includes(method);
    setFilter({ methods: selected ? filter.methods.filter((entry) => entry !== method) : [...filter.methods, method] });
  };

  return (
    <>
      <div className="space-y-1.5 border-b border-line p-2.5">
        <div className="flex items-center gap-1.5">
          <label htmlFor={searchId} className="sr-only">
            Filter endpoints
          </label>
          <input
            id={searchId}
            type="search"
            value={filter.query}
            placeholder="Filter endpoints"
            spellCheck={false}
            className={`${filterBoxClass} flex-1`}
            onChange={(event) => {
              typeQuery(event.target.value);
            }}
          />
          {foldButton}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <div role="group" aria-label="Filter by method" className="flex flex-wrap gap-1">
            {methods.map((method) => {
              const pressed = filter.methods.includes(method);
              return (
                <button
                  key={method}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => {
                    toggleMethod(method);
                  }}
                  className={`rounded border px-1.5 font-mono text-label font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                    pressed ? 'border-fg bg-fg text-surface' : 'border-line-strong text-muted hover:bg-hover'
                  }`}
                >
                  {method}
                </button>
              );
            })}
            {scenarios ? (
              <button
                type="button"
                aria-pressed={filter.ownOnly}
                onClick={() => {
                  setFilter({ ownOnly: !filter.ownOnly });
                }}
                className={`rounded border px-1.5 text-label font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                  filter.ownOnly ? 'border-fg bg-fg text-surface' : 'border-line-strong text-muted hover:bg-hover'
                }`}
              >
                Own only
              </button>
            ) : null}
          </div>
          <p role="status" aria-live="polite" className="ml-auto text-label text-faint">
            {isFiltering(filter)
              ? `Showing ${String(visible.length)} of ${String(items.length)} endpoints`
              : `${String(items.length)} ${items.length === 1 ? 'endpoint' : 'endpoints'}`}
          </p>
        </div>
      </div>
      {visible.length === 0 ? (
        <EmptyState title="No matching endpoints">
          <p>No endpoint matches {describeFilter(filter)}.</p>
          <button
            type="button"
            className={`${buttonClass} mt-2`}
            onClick={() => {
              setFilter({ query: '', methods: [], ownOnly: false });
            }}
          >
            Clear filters
          </button>
        </EmptyState>
      ) : (
        <EndpointTree
          items={visible}
          tree={visibleTree}
          filter={filter}
          onToggle={toggleFolder}
          linkSearch={linkSearch}
          scenarios={scenarios}
        />
      )}
    </>
  );
}

/** The same filter object while its value is unchanged, so memoized rows below are kept. */
function useStableFilter(filter: InventoryFilter): InventoryFilter {
  const [stable, setStable] = useState(filter);
  if (stable !== filter && !sameFilter(stable, filter)) {
    setStable(filter);
    return filter;
  }
  return stable;
}

/**
 * The previous list while it holds the same endpoints: most keystrokes leave
 * the matches as they were, and the tree and rows below are then reused.
 */
function useStableList(list: readonly EndpointItem[]): readonly EndpointItem[] {
  const [stable, setStable] = useState(list);
  if (stable !== list && !(stable.length === list.length && stable.every((item, index) => item === list[index]))) {
    setStable(list);
    return list;
  }
  return stable;
}

function sameFilter(a: InventoryFilter, b: InventoryFilter): boolean {
  const same = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((entry, index) => entry === y[index]);
  return (
    a.query === b.query &&
    same(a.methods, b.methods) &&
    same(a.collapsed, b.collapsed) &&
    same(a.expanded, b.expanded) &&
    a.scenario === b.scenario &&
    a.ownOnly === b.ownOnly
  );
}

/** Above this many rows only the rows near the viewport are rendered. */
export const WINDOW_THRESHOLD = 100;
/** Fixed height of a windowed row, in pixels (`h-6`). */
export const ROW_HEIGHT = 24;
const OVERSCAN = 3;
/** Rows assumed visible before the list has been measured (e.g. without layout, as in tests). */
const UNMEASURED_ROWS = 40;

/**
 * The endpoints as an expandable tree of path segments. Folders down to
 * `DEFAULT_EXPANDED_DEPTH` start open, deeper ones closed, except the folders
 * leading to the endpoint on screen; while filtering, every folder starts open
 * so matches are never hidden. Toggles are kept in the hash.
 */
// Memoized, with the rows below it: typing in the search re-renders the field
// before the filter applies, and that render must not touch 2 000 rows.
const EndpointTree = memo(function EndpointTree({
  items,
  tree,
  filter,
  onToggle,
  linkSearch,
  scenarios,
}: {
  readonly items: readonly EndpointItem[];
  /** The tree of `items`. */
  readonly tree: EndpointTreeNode;
  readonly filter: InventoryFilter;
  readonly onToggle: (path: string, openByDefault: boolean) => void;
  readonly linkSearch: string;
  readonly scenarios: boolean;
}) {
  // Rows are plain links that navigate through the router: a router <NavLink>
  // per row resolves its path and matches the location on every render.
  const endpointsHref = useHref('/endpoints/');
  const navigate = useNavigate();
  const open = useCallback(
    (to: string) => {
      void navigate(to);
    },
    [navigate],
  );
  const currentId = useMatch({ path: '/endpoints/:endpointId', end: false })?.params.endpointId;
  const currentPath = currentId === undefined ? undefined : items.find((item) => item.id === currentId)?.path;
  const revealed = useMemo(() => new Set(currentPath === undefined ? [] : folderPathsTo(currentPath)), [currentPath]);
  const filtering = isFiltering(filter);

  const defaultExpanded = useCallback(
    (node: EndpointTreeNode) => filtering || node.depth <= DEFAULT_EXPANDED_DEPTH || revealed.has(node.path),
    [filtering, revealed],
  );
  // Only the rows on screen are built: the layout counts the rest.
  const layout = useMemo(() => {
    const collapsed = new Set(filter.collapsed);
    const expanded = new Set(filter.expanded);
    // While filtering every folder is open but those collapsed, so a folder with none
    // collapsed at or below it is counted from its totals, not visited.
    const holdsCollapsed = new Set(filter.collapsed.flatMap(folderPathsTo));
    return layoutTree(
      tree,
      (node) => (collapsed.has(node.path) ? false : expanded.has(node.path) ? true : defaultExpanded(node)),
      filtering ? (node) => !holdsCollapsed.has(node.path) : undefined,
    );
  }, [tree, filter.collapsed, filter.expanded, defaultExpanded, filtering]);

  const windowed = layout.total > WINDOW_THRESHOLD;
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  useEffect(() => {
    const element = scroller.current;
    if (!windowed || element === null) return undefined;
    const measure = () => {
      setViewport({ top: element.scrollTop, height: element.clientHeight });
    };
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      element.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [windowed]);

  let first = 0;
  let last = layout.total;
  if (windowed) {
    const visibleRows = viewport.height > 0 ? Math.ceil(viewport.height / ROW_HEIGHT) : UNMEASURED_ROWS;
    first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN);
    last = Math.min(layout.total, first + visibleRows + 2 * OVERSCAN);
  }
  const rows = useMemo(() => treeRows(tree, layout, first, last), [tree, layout, first, last]);

  return (
    // The list scrolls on its own, so a long inventory never pushes the details away.
    <div ref={scroller} className="max-h-[50vh] min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 lg:max-h-none">
      <ul
        style={
          windowed
            ? { paddingTop: first * ROW_HEIGHT, paddingBottom: Math.max(0, layout.total - last) * ROW_HEIGHT }
            : undefined
        }
      >
        {rows.map((row, at) => (
          <TreeLine
            // Keyed by position, so a new filter updates the lines on screen in
            // place instead of replacing them. A row keeps its
            // position while scrolling and when it is toggled itself.
            key={first + at}
            row={row}
            windowed={windowed}
            current={row.kind === 'endpoint' && row.item.id === currentId}
            openByDefault={row.kind === 'folder' && defaultExpanded(row.node)}
            endpointsHref={endpointsHref}
            linkSearch={linkSearch}
            scenarios={scenarios}
            onOpen={open}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </div>
  );
});

interface TreeLineProps {
  readonly row: TreeRow;
  readonly windowed: boolean;
  readonly current: boolean;
  /** For a folder: whether it is open when the hash does not say. */
  readonly openByDefault: boolean;
  readonly endpointsHref: string;
  readonly linkSearch: string;
  /** Show each endpoint's origin instead of its scenario. */
  readonly scenarios: boolean;
  readonly onOpen: (to: string) => void;
  readonly onToggle: (path: string, openByDefault: boolean) => void;
}

const TreeLine = memo(function TreeLine({
  row,
  windowed,
  current,
  openByDefault,
  endpointsHref,
  linkSearch,
  scenarios,
  onOpen,
  onToggle,
}: TreeLineProps) {
  const fixed = windowed ? 'h-6 overflow-hidden whitespace-nowrap' : '';
  if (row.kind === 'endpoint') {
    const { item } = row;
    // The folders above already show the rest of the path; the label announces all of it.
    const leaf = item.path === '/' ? '/' : (item.path.split('/').pop() ?? item.path);
    // Children indent one step past their folder's chevron.
    const indent = { paddingLeft: `${String(0.5 + row.depth * 0.875)}rem` };
    return (
      <li>
        <a
          href={`${endpointsHref}${item.id}${linkSearch}`}
          aria-current={current ? 'page' : undefined}
          onClick={(event) => {
            if (isPlainClick(event)) {
              event.preventDefault();
              onOpen(`/endpoints/${item.id}${linkSearch}`);
            }
          }}
          aria-label={`${item.method} ${describePath(item.path, item.pathParameters)}, scenario ${item.scenario}${
            scenarios && item.origin !== 'own' ? `, ${item.origin}` : ''
          }${item.review === 'pending' ? ', pending review' : ''}${item.hasFaults ? ', faults' : ''}`}
          title={item.path}
          style={indent}
          className={`flex min-h-6 items-center gap-1.5 py-0.5 pr-2.5 hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent aria-[current=page]:bg-accent-soft aria-[current=page]:shadow-[inset_2px_0_0_var(--accent)] ${fixed}`}
        >
          <span className="w-[34px] shrink-0">
            <MethodBadge method={item.method} short />
          </span>
          <span className={`min-w-0 flex-1 font-mono text-mono ${windowed ? 'truncate' : 'break-all'}`}>
            <PathTemplate path={leaf} parameters={parametersIn(leaf)} />
          </span>
          {/* A promoted response awaiting review. */}
          {item.review === 'pending' ? (
            <span
              aria-hidden="true"
              className="shrink-0 rounded-[3px] bg-warn-soft px-1.5 text-label font-medium text-warn"
            >
              Pending review
            </span>
          ) : null}
          {/* The method has a fault.yaml in the selected scenario. */}
          {item.hasFaults ? (
            <span
              aria-hidden="true"
              className="shrink-0 rounded-[3px] bg-bad-soft px-1.5 text-label font-medium text-bad"
            >
              Faults
            </span>
          ) : null}
          {/* The header names the scenario; a row marks only what it does not hold itself. */}
          {scenarios ? (
            item.origin === 'own' ? null : (
              <OriginBadge origin={item.origin} />
            )
          ) : item.scenario === 'default' ? null : (
            <span className="text-label text-faint">{item.scenario}</span>
          )}
        </a>
      </li>
    );
  }
  const { node, expanded, collapsible, count } = row;
  const indent = { paddingLeft: `${String(0.5 + (node.depth - 1) * 0.875)}rem` };
  // The label announces every parameter on the way here; the segment shows only its own.
  const label = describePath(node.path, parametersIn(node.path));
  const segment = (
    <span className={`min-w-0 flex-1 font-mono text-mono text-muted ${windowed ? 'truncate' : 'break-all'}`}>
      <PathTemplate path={node.segment} parameters={parametersIn(node.segment)} />
    </span>
  );
  // A top-level group is counted even when open; a deeper folder only when closed.
  const counted =
    node.depth === 1 || !expanded ? (
      <span className="font-mono text-label text-faint" aria-hidden="true">
        {count}
      </span>
    ) : null;
  if (!collapsible) {
    return (
      <li>
        <div style={indent} className={`flex min-h-6 items-center gap-1.5 py-0.5 pr-2.5 ${fixed}`} aria-label={label}>
          <span className="size-3" aria-hidden="true" />
          {segment}
          {counted}
        </div>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={label}
        onClick={() => {
          onToggle(node.path, openByDefault);
        }}
        style={indent}
        className={`flex min-h-6 w-full items-center gap-1.5 py-0.5 pr-2.5 text-left hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${fixed}`}
      >
        <ChevronRightIcon className={`size-3 text-faint transition-transform ${expanded ? 'rotate-90' : ''}`} />
        {segment}
        {counted}
      </button>
    </li>
  );
}, sameLine);

/**
 * Whether a line shows the same as before. Rows are new objects after every
 * filter change, and a pruned tree has new nodes, so they compare by content;
 * folder lines do not use the search in their links.
 */
function sameLine(before: TreeLineProps, after: TreeLineProps): boolean {
  if (
    before.windowed !== after.windowed ||
    before.scenarios !== after.scenarios ||
    before.current !== after.current ||
    before.endpointsHref !== after.endpointsHref ||
    before.onOpen !== after.onOpen ||
    before.onToggle !== after.onToggle
  ) {
    return false;
  }
  const [was, is] = [before.row, after.row];
  if (was.kind === 'endpoint') {
    return (
      is.kind === 'endpoint' && is.item === was.item && is.depth === was.depth && after.linkSearch === before.linkSearch
    );
  }
  return (
    is.kind === 'folder' &&
    is.node.path === was.node.path &&
    is.node.depth === was.node.depth &&
    is.expanded === was.expanded &&
    is.collapsible === was.collapsible &&
    is.count === was.count &&
    after.openByDefault === before.openByDefault
  );
}

/** A left click without modifier keys: the router navigates; anything else is left to the browser. */
function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey;
}

/** Each folder's parameters, found once: folder rows render on every keystroke. */
const parametersOf = new Map<string, readonly string[]>();

function parametersIn(path: string): readonly string[] {
  let parameters = parametersOf.get(path);
  if (parameters === undefined) {
    parameters = [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1] ?? '');
    parametersOf.set(path, parameters);
  }
  return parameters;
}
