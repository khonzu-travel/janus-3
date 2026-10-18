import { useCallback, useState, type KeyboardEvent, type PointerEvent } from 'react';

/** One resizable side pane: its default, limits and storage key. */
export interface PaneSpec {
  readonly key: string;
  readonly label: string;
  readonly initial: number;
  readonly min: number;
  readonly max: number;
}

export const TREE_PANE: PaneSpec = { key: 'tree', label: 'Resize endpoint tree', initial: 320, min: 160, max: 480 };
/** The side panel on Requests and Scenarios: the endpoint tree's width, shared with it. */
export const SIDE_PANE: PaneSpec = { ...TREE_PANE, label: 'Resize side panel' };
export const INSPECTOR_PANE: PaneSpec = {
  key: 'inspector',
  label: 'Resize details panel',
  initial: 280,
  min: 200,
  max: 560,
};
export const REQUEST_PANE: PaneSpec = {
  key: 'request',
  label: 'Resize request form',
  initial: 480,
  min: 280,
  max: 640,
};

const STORAGE_PREFIX = 'janus-atlas-pane-';
const STEP = 16;
const BIG_STEP = 64;

const clamp = (spec: PaneSpec, width: number): number => Math.round(Math.min(spec.max, Math.max(spec.min, width)));

function readWidth(spec: PaneSpec): number {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_PREFIX + spec.key));
    return Number.isFinite(stored) && stored > 0 ? clamp(spec, stored) : spec.initial;
  } catch {
    return spec.initial;
  }
}

function writeWidth(spec: PaneSpec, width: number): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + spec.key, String(width));
  } catch {
    // The width then lasts for this page only.
  }
}

/** A pane's width in px, remembered per browser, and a setter that keeps it within the pane's limits. */
export function usePaneWidth(spec: PaneSpec): readonly [number, (width: number) => void] {
  const [width, setWidth] = useState(() => readWidth(spec));
  const set = useCallback(
    (next: number) => {
      const value = clamp(spec, next);
      setWidth(value);
      writeWidth(spec, value);
    },
    [spec],
  );
  return [width, set] as const;
}

/**
 * The divider between two panes: drag it, move it with the arrow keys (Shift
 * for bigger steps), or reset it with Home or a double-click. `side` says
 * which neighbour it sizes, so dragging towards that pane shrinks it.
 */
export function ResizeHandle({
  spec,
  width,
  onResize,
  side,
  room,
}: {
  readonly spec: PaneSpec;
  readonly width: number;
  readonly onResize: (width: number) => void;
  /** The pane this handle sizes: on its left (`start`) or its right (`end`). */
  readonly side: 'start' | 'end';
  /** The most the pane may take so the pane beside it keeps its minimum. */
  readonly room?: number | undefined;
}) {
  const [dragging, setDragging] = useState(false);
  const limit = Math.max(spec.min, Math.min(spec.max, room ?? spec.max));
  const resize = (next: number): void => {
    onResize(Math.min(limit, next));
  };
  const sign = side === 'start' ? 1 : -1;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    const move = (moveEvent: globalThis.PointerEvent): void => {
      resize(startWidth + sign * (moveEvent.clientX - startX));
    };
    const end = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      setDragging(false);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      resize(width + sign * (event.key === 'ArrowRight' ? step : -step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      resize(spec.initial);
    }
  };

  return (
    // A focusable separator is the ARIA window-splitter pattern; it is interactive.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={spec.label}
      aria-valuenow={width}
      aria-valuemin={spec.min}
      aria-valuemax={limit}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      data-dragging={dragging || undefined}
      className="group relative z-10 w-[5px] shrink-0 cursor-col-resize touch-none focus-visible:outline-2 focus-visible:outline-accent"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        resize(spec.initial);
      }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-[2px] w-px bg-line group-hover:left-[1px] group-hover:w-[3px] group-hover:bg-accent group-focus-visible:left-[1px] group-focus-visible:w-[3px] group-focus-visible:bg-accent group-data-[dragging]:left-[1px] group-data-[dragging]:w-[3px] group-data-[dragging]:bg-accent"
      />
      <span
        aria-hidden="true"
        className="absolute top-1/2 left-1/2 h-7 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-sm bg-line-strong group-hover:bg-accent group-data-[dragging]:bg-accent"
      />
      {/* A wider hit area than the visible line. */}
      <span aria-hidden="true" className="absolute inset-y-0 -left-[3px] -right-[3px]" />
    </div>
  );
}
