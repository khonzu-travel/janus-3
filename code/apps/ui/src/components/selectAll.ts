import { useEffect } from 'react';

import { typing } from './foldKeys.js';

/**
 * Body boxes carry `data-select-all-box`, and the part of them that holds the
 * text `data-select-all-content`. Ctrl/⌘ + A with focus in a box (its copy
 * button, say), or the caret in its text, selects only that text, not the page.
 */
const BOX = '[data-select-all-box]';
const CONTENT = '[data-select-all-content]';

/** Ctrl/⌘ + A, on any keyboard layout. */
export function isSelectAll(event: KeyboardEvent): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  const key = event.key.toLowerCase();
  // On a layout without Latin letters, the key that is A on a US keyboard.
  return key === 'a' || (!/^[a-z]$/.test(key) && event.code === 'KeyA');
}

function boxOf(node: Node | null | undefined): Element | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest(BOX) ?? null;
}

/** Installs the Ctrl/⌘ + A handling for every body box on the page. */
export function useSelectAllInBoxes(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !isSelectAll(event) || typing(event.target)) return;
      const selection = window.getSelection();
      const focused = document.activeElement;
      // With nothing focused, a click in the text leaves only the caret to say where you are.
      const box = focused !== null && focused !== document.body ? boxOf(focused) : boxOf(selection?.anchorNode ?? null);
      if (box === null || selection === null) return;
      event.preventDefault();
      selection.selectAllChildren(box.querySelector(CONTENT) ?? box);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);
}
