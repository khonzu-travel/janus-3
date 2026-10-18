import { useEffect, useRef, type ReactNode } from 'react';

export interface MenuItem {
  readonly label: string;
  readonly icon?: ReactNode;
  /** A line under the label, such as what a run will use. */
  readonly detail?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** A divider above this item. */
  readonly separated?: boolean;
  readonly onSelect: () => void;
}

/**
 * A menu at a point: opened by right-click, the
 * Menu key or Shift + F10, or a row's ⋯ button. Arrow keys move, Enter
 * chooses, Escape or a click elsewhere closes, and focus returns to where it
 * was.
 */
export function ContextMenu({
  label,
  x,
  y,
  items,
  onClose,
}: {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly items: readonly MenuItem[];
  readonly onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const previous = document.activeElement;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const onPointer = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || menu.current?.contains(event.target) !== true) close.current();
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const move = (step: number): void => {
    const all = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const at = all.findIndex((item) => item === document.activeElement);
    all[(at + step + all.length) % all.length]?.focus();
  };

  // Kept inside the window.
  const left = Math.max(4, Math.min(x, window.innerWidth - 248));
  const top = Math.max(4, Math.min(y, window.innerHeight - (items.length * 34 + 16)));

  return (
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left, top }}
      className="fixed z-50 w-60 rounded border border-line-strong bg-surface p-1 shadow-lg"
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {items.map((item) => (
        <div key={item.label}>
          {item.separated === true ? <div role="separator" className="my-1 h-px bg-line" /> : null}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-hover focus-visible:bg-accent-soft focus-visible:outline-none disabled:opacity-50 ${
              item.danger === true ? 'text-bad' : ''
            }`}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span className="mt-0.5 w-3.5 shrink-0">{item.icon}</span>
            <span className="min-w-0">
              {item.label}
              {item.detail === undefined ? null : <span className="block text-label text-muted">{item.detail}</span>}
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
