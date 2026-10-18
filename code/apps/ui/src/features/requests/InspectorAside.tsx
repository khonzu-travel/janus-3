import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { ResizeHandle, usePaneWidth, type PaneSpec } from '../../layouts/ResizeHandle.js';
import { useViewport } from '../../layouts/useViewport.js';
import { CollapseIcon, ExpandIcon } from './icons.js';
import { setPanel, useTabState } from './tabState.js';

/** The inspector on the right of a request or a run step: resizable, its width remembered per browser. */
export const REQUEST_INSPECTOR_PANE: PaneSpec = {
  key: 'request-inspector',
  label: 'Resize inspector',
  initial: 352,
  min: 256,
  max: 960,
};

/** The least the request or step beside the inspector keeps. */
const MAIN_MIN = 360;

/**
 * Where the inspector goes from 1024 px: a column at the page's right edge, as
 * tall as the side panel on the left, so it does not start below the editor
 * tabs and the run bar. Null where the page has none: the inspector stays
 * beside its request.
 */
export const InspectorSlot = createContext<HTMLElement | null>(null);
/** False for a tab that is not in front: its inspector waits, hidden, in the column. */
export const InspectorShown = createContext(true);

const foldButtonClass =
  'inline-flex size-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/**
 * A request or run step with the inspector on its right,
 * from 1024 px (in the page's inspector column, when it has one); below, the inspector follows underneath. Its divider
 * resizes it; Ctrl/⌘ + ] or its button folds it to a rail and shows it again,
 * a choice that holds for every tab. `tools` sit beside the fold button.
 */
export function InspectorSplit({
  children,
  aside,
  tools,
  className = '',
}: {
  readonly children: ReactNode;
  readonly aside: ReactNode;
  readonly tools?: ReactNode;
  readonly className?: string;
}) {
  const { panel } = useTabState();
  const viewport = useViewport();
  const beside = viewport === 'wide' || viewport === 'xwide';
  const [width, setWidth] = usePaneWidth(REQUEST_INSPECTOR_PANE);
  const [own, measure] = useOwnWidth();
  const slot = useContext(InspectorSlot);
  const shown = useContext(InspectorShown);
  const column = beside && slot !== null;
  const sized = beside && !panel.inspector;
  const columnWidth = useWidth(column ? slot : null);
  // In the column, the request's own width leaves out the inspector's: add the column's back.
  const room = own === null ? undefined : own + (column ? (columnWidth ?? 0) : 0) - MAIN_MIN;
  const side = (
    <>
      {sized ? (
        <ResizeHandle spec={REQUEST_INSPECTOR_PANE} width={width} onResize={setWidth} side="end" room={room} />
      ) : null}
      {panel.inspector ? (
        <aside
          aria-label="Inspector"
          className="hidden w-10 shrink-0 border-l border-line bg-surface lg:flex lg:flex-col lg:items-center lg:py-1.5"
        >
          <button
            type="button"
            className={foldButtonClass}
            aria-label="Show the inspector"
            aria-expanded={false}
            aria-keyshortcuts="Control+] Meta+]"
            title="Show the inspector (Ctrl + ])"
            onClick={() => {
              setPanel({ inspector: false });
            }}
          >
            {/* The side panel's icons, mirrored: the inspector sits on the right. */}
            <ExpandIcon className="size-4 -scale-x-100" />
          </button>
        </aside>
      ) : (
        <aside
          aria-label="Inspector"
          style={sized ? { width: Math.min(width, Math.max(REQUEST_INSPECTOR_PANE.min, room ?? Infinity)) } : undefined}
          className="min-w-0 shrink-0 overflow-x-clip border-t border-line bg-surface lg:border-t-0"
        >
          <div className="flex items-center justify-end gap-1 px-1.5 pt-1.5">
            {tools}
            <button
              type="button"
              className={`${foldButtonClass} hidden lg:inline-flex`}
              aria-label="Fold the inspector"
              aria-expanded
              aria-keyshortcuts="Control+] Meta+]"
              title="Fold the inspector (Ctrl + ])"
              onClick={() => {
                setPanel({ inspector: true });
              }}
            >
              <CollapseIcon className="size-4 -scale-x-100" />
            </button>
          </div>
          {aside}
        </aside>
      )}
    </>
  );
  return (
    <div ref={measure} className={`flex min-h-0 flex-col lg:flex-row ${className}`}>
      <div className="flex min-w-0 flex-1 flex-col overflow-x-clip">{children}</div>
      {column
        ? createPortal(
            <div hidden={!shown} className={shown ? 'flex min-h-full' : undefined}>
              {side}
            </div>,
            slot,
          )
        : side}
    </div>
  );
}

/** The split's own width, so the inspector never squeezes the request below its minimum. */
function useOwnWidth(): readonly [number | null, (element: HTMLDivElement | null) => void] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  return [useWidth(element), setElement] as const;
}

function useWidth(element: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (element === null || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return element === null ? null : width;
}

export { foldButtonClass as inspectorToolClass };
