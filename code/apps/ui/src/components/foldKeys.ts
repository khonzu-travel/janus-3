import { useEffect } from 'react';

/** Whether a key press lands in a field. */
export function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

/**
 * Ctrl/⌘ + [ folds or shows the side panel on the left and Ctrl/⌘ + ] the one
 * on the right, on every page with side panels. With the
 * modifier the keys work from inside a field too, where [ and ] are typed. A
 * page passes null for a side it does not have.
 */
export function useFoldKeys(left: (() => void) | null, right: (() => void) | null): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.defaultPrevented) return;
      // The code, not the key: on some layouts [ and ] need AltGr or another key.
      const run = event.code === 'BracketLeft' ? left : event.code === 'BracketRight' ? right : null;
      if (run === null) return;
      event.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [left, right]);
}
