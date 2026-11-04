import { COUNT_LIMIT, type FindOptions } from './findBarParts.js';

/**
 * Finding in text shown on the page, such as a read-only body: the text nodes
 * under an element, searched as one string, with each match as a DOM range.
 * Text in a button or hidden from assistive technology (line numbers, icons)
 * is not searched.
 */

export interface FindSpec extends FindOptions {
  readonly search: string;
}

export interface FoundText {
  /** False for a regular expression that does not compile. */
  readonly valid: boolean;
  /** At most `COUNT_LIMIT`, in document order. */
  readonly ranges: readonly Range[];
}

const SKIP = 'button, [aria-hidden="true"], [data-find-skip]';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The search as a global regular expression, or null when it does not compile. */
export function findPattern(spec: FindSpec): RegExp | null {
  const source = spec.regexp ? spec.search : escapeRegExp(spec.search);
  const word = spec.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source;
  try {
    return new RegExp(word, `gmu${spec.caseSensitive ? '' : 'i'}`);
  } catch {
    // Without the u flag, as a code editor's search compiles it, before giving up.
    try {
      return spec.wholeWord ? null : new RegExp(source, `gm${spec.caseSensitive ? '' : 'i'}`);
    } catch {
      return null;
    }
  }
}

/** Every match of `spec` in the text under `root`, up to the limit. */
export function findInText(root: Element, spec: FindSpec): FoundText {
  if (spec.search === '') return { valid: true, ranges: [] };
  const pattern = findPattern(spec);
  if (pattern === null) return { valid: false, ranges: [] };

  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(SKIP) === null ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
    starts.push(text.length);
    text += node.nodeValue ?? '';
  }

  /** The text node holding offset `at`, and the offset within it; an end offset stays in the node it ends. */
  const locate = (at: number, end: boolean): [Text, number] => {
    let low = 0;
    let high = nodes.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const start = starts[middle] ?? 0;
      if (start < at || (!end && start === at)) low = middle;
      else high = middle - 1;
    }
    const node = nodes[low] as Text;
    return [node, at - (starts[low] ?? 0)];
  };

  const ranges: Range[] = [];
  for (const match of text.matchAll(pattern)) {
    if (ranges.length >= COUNT_LIMIT) break;
    if (match[0] === '') continue;
    const from = match.index;
    const range = document.createRange();
    range.setStart(...locate(from, false));
    range.setEnd(...locate(from + match[0].length, true));
    ranges.push(range);
  }
  return { valid: true, ranges };
}

const ALL = 'janus-find';
const CURRENT = 'janus-find-current';

/** Whether the browser paints highlights (the CSS Custom Highlight API). */
function highlights(): HighlightRegistry | null {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined' ? CSS.highlights : null;
}

/** Paints the matches, the current one apart; one find bar paints at a time. */
export function paintMatches(ranges: readonly Range[], current: Range | null): void {
  const registry = highlights();
  if (registry === null) return;
  registry.set(ALL, new Highlight(...ranges));
  if (current === null) registry.delete(CURRENT);
  else registry.set(CURRENT, new Highlight(current));
}

export function clearMatches(): void {
  const registry = highlights();
  registry?.delete(ALL);
  registry?.delete(CURRENT);
}
