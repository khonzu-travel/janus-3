import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { HelpIcon } from './icons.js';

/**
 * A small "?" that shows help while hovered or focused, and keeps it open
 * when clicked until clicked again, Escape or a click elsewhere.
 */
export function HelpTip({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const tipId = useId();
  const open = pinned || hovered || focused;
  useEffect(() => {
    if (!pinned) return;
    const onPointer = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || root.current?.contains(event.target) !== true) setPinned(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [pinned]);
  return (
    <span
      ref={root}
      className="relative inline-flex"
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
    >
      <button
        type="button"
        className="inline-flex size-5 items-center justify-center rounded-full text-faint hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-expanded:text-fg"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onClick={() => {
          setPinned(!pinned);
        }}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation();
            setPinned(false);
            setHovered(false);
            setFocused(false);
          }
        }}
      >
        <HelpIcon className="size-4" />
      </button>
      <span
        id={tipId}
        role="tooltip"
        hidden={!open}
        className="absolute top-full left-0 z-30 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded border border-line bg-surface px-3 py-2 font-normal text-muted shadow-md"
      >
        {children}
      </span>
    </span>
  );
}
