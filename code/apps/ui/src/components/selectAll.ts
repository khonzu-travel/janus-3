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

/**
 * The box Ctrl/⌘ + A selects in: the one holding focus; else, when the caret
 * lies in the focused element (a click in the text leaves focus on whatever
 * focusable element holds it, such as a tab panel, or on the page), the one
 * holding the caret; else the only box inside the focused element.
 */
function boxFor(focused: Element | null, caret: Node | null): Element | null {
  const holder = focused ?? document.body;
  const own = boxOf(holder);
  if (own !== null) return own;
  if (caret !== null && holder.contains(caret)) {
    const atCaret = boxOf(caret);
    if (atCaret !== null) return atCaret;
  }
  const inside = holder === document.body ? [] : holder.querySelectorAll(BOX);
  return inside.length === 1 ? (inside[0] ?? null) : null;
}

/** Installs the Ctrl/⌘ + A handling for every body box on the page. */
export function useSelectAllInBoxes(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !isSelectAll(event) || typing(event.target)) return;
      const selection = window.getSelection();
      const box = boxFor(document.activeElement, selection?.anchorNode ?? null);
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
