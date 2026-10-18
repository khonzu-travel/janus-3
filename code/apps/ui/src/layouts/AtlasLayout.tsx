import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, Outlet, useLocation, useMatch, useSearchParams } from 'react-router';

import { LoadingState } from '../components/states/LoadingState.js';
import { UnavailableState } from '../components/states/UnavailableState.js';
import { useAtlasSession } from '../hooks/AtlasSession.js';
import { SnapshotFeedContext, useSnapshotFeedState } from '../hooks/SnapshotFeed.js';
import { useHealth, useInventory, useRestart, useScenarios, useServerTarget } from '../hooks/useAtlas.js';
import { useScenarioSelection } from '../scenarios/selection.js';
import type { AtlasLayoutContext } from './AtlasLayoutContext.js';
import { ConnectionHeader } from './ConnectionHeader.js';
import { useFoldKeys } from '../components/foldKeys.js';
import { CollapseIcon, ExpandIcon } from '../features/requests/icons.js';
import { InventorySidebar } from './InventorySidebar.js';
import { inventorySearch } from './inventoryFilter.js';
import { Inspector } from '../features/inspector/Inspector.js';
import { ConfigDialog } from '../pages/ConfigPage.js';
import { INSPECTOR_PANE, ResizeHandle, TREE_PANE, usePaneWidth } from './ResizeHandle.js';
import { SnapshotBanner } from './SnapshotBanner.js';
import { useViewport } from './useViewport.js';

const MAIN_ID = 'main-content';

export function AtlasLayout() {
  const health = useHealth();
  const scenario = useScenarioSelection(health.data);
  const inventory = useInventory(health.data, scenario.requested);
  const scenarios = useScenarios(health.data);
  const { client, eventSource } = useAtlasSession();
  const feed = useSnapshotFeedState(client, health.data, eventSource);
  const restart = useRestart();
  const target = useServerTarget();
  const mainRef = useRef<HTMLElement>(null);
  const viewport = useViewport();
  const endpointId = useMatch({ path: '/endpoints/:endpointId', end: false })?.params.endpointId;

  useFocusOnNavigation(mainRef);

  // A new endpoint's details start at the top of <main>. In the wide layout
  // <main> scrolls on its own, so rewind it; otherwise the page scrolls, so
  // bring <main> into view when it is off screen.
  useEffect(() => {
    const main = mainRef.current;
    if (endpointId === undefined || main === null) return;
    main.scrollTop = 0;
    const { top } = main.getBoundingClientRect();
    if (top < 0 || top >= window.innerHeight) main.scrollIntoView({ block: 'start' });
  }, [endpointId]);

  const onEndpoints = useMatch({ path: '/endpoints', end: true }) !== null || endpointId !== undefined;

  let body: ReactNode;
  if (health.error !== null) {
    body = (
      <Main mainRef={mainRef} className="mx-auto w-full max-w-3xl p-4">
        <UnavailableState error={health.error} target={target} onRetry={restart} />
      </Main>
    );
  } else if (health.data === undefined) {
    body = (
      <Main mainRef={mainRef} className="p-4">
        <LoadingState label="Connecting to Janus" />
      </Main>
    );
  } else {
    const healthData = health.data;
    // Each pane's fold button sits in its first row: the search row, the first inspector section.
    const inventoryView = (fold?: ReactNode) => (
      <InventorySidebar
        inventory={inventory.data}
        error={inventory.error}
        loadedFrom={healthData.snapshotVersion}
        scenario={scenario.name}
        scenarios={scenario.supported}
        onRestart={restart}
        foldButton={fold}
      />
    );
    const outlet = (
      <Outlet
        context={
          {
            health: health.data,
            inventory: inventory.data,
            inventoryError: inventory.error,
            scenario,
            scenarios: scenarios.data,
          } satisfies AtlasLayoutContext
        }
      />
    );
    const details = onEndpoints
      ? (fold?: ReactNode) => <Inspector health={healthData} inventory={inventory.data} foldButton={fold} />
      : null;
    const inspector =
      details === null ? null : (
        <aside aria-label={DETAILS_LABEL} className="min-w-0 bg-bg">
          {details()}
        </aside>
      );
    body =
      viewport === 'narrow' ? (
        <NarrowLayout mainRef={mainRef} inventoryView={inventoryView()} inspector={inspector}>
          {outlet}
        </NarrowLayout>
      ) : onEndpoints ? (
        <PaneLayout
          mainRef={mainRef}
          inventoryView={inventoryView}
          details={details}
          inspectorBeside={viewport === 'xwide'}
        >
          {outlet}
        </PaneLayout>
      ) : (
        // Requests, configuration and the rest fill the width and lay out their own panes.
        <Main mainRef={mainRef} scrolls className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {outlet}
        </Main>
      );
  }

  const fixed = viewport !== 'narrow';
  return (
    <SnapshotFeedContext.Provider value={feed}>
      {/* Relative, so absolutely positioned descendants such as sr-only text are clipped too. */}
      <div className={`flex min-h-screen flex-col bg-bg text-fg ${fixed ? 'relative h-dvh overflow-hidden' : ''}`}>
        <a
          href={`#${MAIN_ID}`}
          className="sr-only z-30 rounded bg-surface p-2 font-medium text-accent underline focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:outline-2 focus:outline-accent"
          onClick={(event) => {
            // The hash holds the route, so move focus without navigating.
            event.preventDefault();
            focusHeading(mainRef.current);
          }}
        >
          Skip to main content
        </a>
        <ConnectionHeader
          health={health.data}
          error={health.error}
          pending={health.isPending}
          target={target}
          scenario={scenario}
          scenarios={scenarios.data}
        />
        <SnapshotBanner onRefresh={restart} />
        {body}
        {health.data === undefined ? null : <ConfigDialog health={health.data} />}
      </div>
    </SnapshotFeedContext.Provider>
  );
}

/**
 * From 1024 px: the tree, the detail pane and, from 1280 px,
 * the inspector side by side, with resize handles between them. The window
 * never scrolls; each pane scrolls on its own.
 */
function PaneLayout({
  mainRef,
  inventoryView,
  details,
  inspectorBeside,
  children,
}: {
  readonly mainRef: RefObject<HTMLElement | null>;
  /** The inventory, given its fold button. */
  readonly inventoryView: (fold: ReactNode) => ReactNode;
  /** The inspector, given its fold button; null on views without one. */
  readonly details: ((fold: ReactNode) => ReactNode) | null;
  readonly inspectorBeside: boolean;
  readonly children: ReactNode;
}) {
  const [treeWidth, setTreeWidth] = usePaneWidth(TREE_PANE);
  const [inspectorWidth, setInspectorWidth] = usePaneWidth(INSPECTOR_PANE);
  const [treeFolded, setTreeFolded] = useStoredFlag('janus.fold.endpoints');
  const [detailsFolded, setDetailsFolded] = useStoredFlag('janus.fold.details');
  // Ctrl/⌘ + [ folds the endpoint list, Ctrl/⌘ + ] the details.
  useFoldKeys(
    () => {
      setTreeFolded(!treeFolded);
    },
    details === null
      ? null
      : () => {
          setDetailsFolded(!detailsFolded);
        },
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(containerRef);
  const treeShown = treeFolded ? RAIL : treeWidth;
  const inspectorShown = detailsFolded ? RAIL : inspectorWidth;
  // The detail pane keeps its minimum; each handle may only take what is left.
  // Pane widths include their handles.
  const treeRoom = width === 0 ? undefined : width - MIN_DETAIL - (inspectorBeside ? inspectorShown : 0);
  const inspectorRoom = width === 0 ? undefined : width - MIN_DETAIL - treeShown;
  return (
    <div ref={containerRef} className="flex min-h-0 flex-1">
      {/* Each handle sits inside the landmark it sizes, so every part of the page belongs to one. */}
      {treeFolded ? (
        <nav
          aria-labelledby="inventory-title"
          style={{ width: RAIL }}
          className="flex min-h-0 shrink-0 flex-col items-center border-r border-line bg-bg py-1.5"
        >
          <h2 id="inventory-title" className="sr-only">
            Endpoints
          </h2>
          <FoldButton
            expanded={false}
            label="Show the endpoint list"
            shortcut="["
            onClick={() => {
              setTreeFolded(false);
            }}
          >
            <ExpandIcon className="size-4" />
          </FoldButton>
        </nav>
      ) : (
        <nav aria-labelledby="inventory-title" style={{ width: treeWidth }} className="flex min-h-0 shrink-0 bg-bg">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {inventoryView(
              <FoldButton
                expanded
                label="Fold the endpoint list"
                shortcut="["
                onClick={() => {
                  setTreeFolded(true);
                }}
              >
                <CollapseIcon className="size-4" />
              </FoldButton>,
            )}
          </div>
          <ResizeHandle spec={TREE_PANE} width={treeWidth} onResize={setTreeWidth} side="start" room={treeRoom} />
        </nav>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
        <Main mainRef={mainRef} scrolls className="min-h-0 min-w-0 flex-1 scroll-mt-4 overflow-y-auto">
          {children}
        </Main>
        {inspectorBeside || details === null ? null : detailsFolded ? (
          <aside
            aria-label={DETAILS_LABEL}
            className="flex shrink-0 justify-end border-t border-line bg-bg px-1.5 py-1"
          >
            <FoldButton
              expanded={false}
              label="Show the details"
              shortcut="]"
              onClick={() => {
                setDetailsFolded(false);
              }}
            >
              <ExpandIcon className="size-4 -rotate-90" />
            </FoldButton>
          </aside>
        ) : (
          <aside
            aria-label={DETAILS_LABEL}
            className="max-h-[40%] min-h-0 shrink-0 overflow-y-auto border-t border-line bg-bg"
          >
            {details(
              <FoldButton
                expanded
                label="Fold the details"
                shortcut="]"
                onClick={() => {
                  setDetailsFolded(true);
                }}
              >
                <CollapseIcon className="size-4 -rotate-90" />
              </FoldButton>,
            )}
          </aside>
        )}
      </div>
      {inspectorBeside && details !== null ? (
        detailsFolded ? (
          <aside
            aria-label={DETAILS_LABEL}
            style={{ width: RAIL }}
            className="flex min-h-0 shrink-0 flex-col items-center border-l border-line bg-bg py-1.5"
          >
            <FoldButton
              expanded={false}
              label="Show the details"
              shortcut="]"
              onClick={() => {
                setDetailsFolded(false);
              }}
            >
              <ExpandIcon className="size-4 -scale-x-100" />
            </FoldButton>
          </aside>
        ) : (
          <aside aria-label={DETAILS_LABEL} style={{ width: inspectorWidth }} className="flex min-h-0 shrink-0 bg-bg">
            <ResizeHandle
              spec={INSPECTOR_PANE}
              width={inspectorWidth}
              onResize={setInspectorWidth}
              side="end"
              room={inspectorRoom}
            />
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
              {details(
                <FoldButton
                  expanded
                  label="Fold the details"
                  shortcut="]"
                  onClick={() => {
                    setDetailsFolded(true);
                  }}
                >
                  <CollapseIcon className="size-4 -scale-x-100" />
                </FoldButton>,
              )}
            </div>
          </aside>
        )
      ) : null}
    </div>
  );
}

const DETAILS_LABEL = 'Details';

/** A folded pane's width: a rail with the button that shows it again. */
const RAIL = 40;

function FoldButton({
  label,
  shortcut,
  expanded,
  onClick,
  children,
}: {
  /** Whether the pane it folds is shown. */
  readonly expanded: boolean;
  readonly label: string;
  readonly shortcut: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="inline-flex size-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      aria-label={label}
      aria-expanded={expanded}
      aria-keyshortcuts={`Control+${shortcut} Meta+${shortcut}`}
      title={`${label} (Ctrl + ${shortcut})`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A yes/no choice kept in this browser (like the pane widths); false when storage is unavailable. */
function useStoredFlag(key: string): readonly [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next ? '1' : '0');
      } catch {
        // Kept for this page only.
      }
    },
    [key],
  );
  return [value, set] as const;
}

/** The detail pane's minimum width while panes are resized. */
const MIN_DETAIL = 360;

/** An element's width, kept current as it resizes; 0 until measured. */
function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return width;
}

function Main({
  mainRef,
  scrolls = false,
  className,
  children,
}: {
  readonly mainRef: RefObject<HTMLElement | null>;
  /** True when <main> scrolls on its own: it then takes keyboard focus so the keys can scroll it (WCAG 2.1.1). */
  readonly scrolls?: boolean;
  readonly className: string;
  readonly children: ReactNode;
}) {
  return (
    <main
      id={MAIN_ID}
      ref={mainRef}
      // A scrolling region must be reachable by keyboard (WCAG 2.1.1), as with the body previews.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={scrolls ? 0 : -1}
      className={`${className} focus:outline-none ${
        scrolls ? 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent' : ''
      }`}
    >
      {children}
    </main>
  );
}

/** Under 640 px: the inventory is its own view, and detail views link back to it. */
function NarrowLayout({
  mainRef,
  inventoryView,
  inspector,
  children,
}: {
  readonly mainRef: RefObject<HTMLElement | null>;
  readonly inventoryView: ReactNode;
  readonly inspector: ReactNode;
  readonly children: ReactNode;
}) {
  const home = useMatch({ path: '/endpoints', end: true }) !== null;
  const onEndpoint = useMatch({ path: '/endpoints/:endpointId', end: false }) !== null;
  const [search] = useSearchParams();
  if (home) {
    return (
      <>
        <Main mainRef={mainRef} className="min-w-0 bg-bg">
          <nav aria-labelledby="inventory-title" className="flex min-w-0 flex-col">
            {inventoryView}
          </nav>
        </Main>
        {inspector}
      </>
    );
  }
  return (
    <>
      <Main mainRef={mainRef} className="min-w-0 bg-surface">
        {onEndpoint ? (
          <Link
            to={{ pathname: '/endpoints', search: inventorySearch(search) }}
            className="m-4 mb-0 inline-flex min-h-6 items-center text-accent underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            ← All endpoints
          </Link>
        ) : null}
        {children}
      </Main>
      {inspector}
    </>
  );
}

/**
 * After a route change, focus moves to the new view's main heading,
 * which a screen reader then announces once. The heading may
 * render after its data loads, so this waits for it briefly.
 */
function useFocusOnNavigation(mainRef: RefObject<HTMLElement | null>): void {
  const { pathname } = useLocation();
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return undefined;
    previous.current = pathname;
    const main = mainRef.current;
    if (main === null) return undefined;
    // A view that placed focus itself (the explorer's "Try it") keeps it.
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body && main.contains(focused)) return undefined;
    // An open dialog (Configuration over the view) keeps focus too, even once the heading renders.
    const settle = (): boolean =>
      document.activeElement?.closest('[role="dialog"]') != null || focusHeading(main, false);
    if (settle()) return undefined;
    const observer = new MutationObserver(() => {
      if (settle()) observer.disconnect();
    });
    observer.observe(main, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
    }, 3000);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [pathname, mainRef]);
}

/** Focuses the first `h2` inside `main`, or `main` itself when asked to fall back. True when focus moved. */
function focusHeading(main: HTMLElement | null, fallback = true): boolean {
  if (main === null) return false;
  const heading = main.querySelector('h2');
  if (heading instanceof HTMLElement) {
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus();
    return true;
  }
  if (fallback) main.focus();
  return fallback;
}
