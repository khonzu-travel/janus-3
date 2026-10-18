/**
 * Performance entries the browser budgets read. They are plain
 * User Timing entries: harmless in production and visible in DevTools.
 */
export const FILTER_MEASURE = 'janus:inventory-filter';
export const HIGHLIGHT_MEASURE = 'janus:highlight';

const FILTER_START = `${FILTER_MEASURE}:start`;
const timing = typeof performance === 'undefined' ? undefined : performance;

/** A keystroke in the inventory search: the filter work starts here. */
export function markFilterInput(): void {
  timing?.mark(FILTER_START);
}

/** After the inventory commits: the time since the last unmeasured keystroke. */
export function measureFilterCommit(): void {
  if (timing === undefined || timing.getEntriesByName(FILTER_START, 'mark').length === 0) return;
  timing.measure(FILTER_MEASURE, FILTER_START);
  timing.clearMarks(FILTER_START);
}

/** Tokenizing time of one preview, excluding loading shiki and its grammars. */
export function measureHighlight(
  spentMs: number,
  detail: { readonly chars: number; readonly complete: boolean },
): void {
  if (timing === undefined) return;
  const end = timing.now();
  timing.measure(HIGHLIGHT_MEASURE, { start: Math.max(0, end - spentMs), end, detail });
}
