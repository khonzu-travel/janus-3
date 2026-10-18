/** Every filter box: the same height, border and placeholder; the caller sets its width. */
export const filterBoxClass =
  'h-7 min-w-0 rounded border border-line-strong bg-surface px-2 placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/** A list page's filter box, in its toolbar. */
export const filterInputClass = `${filterBoxClass} w-56 max-w-full`;

/** A row that opens its detail when clicked anywhere; its link stays the way in from the keyboard. */
export const openableRowClass = 'cursor-pointer hover:bg-hover';

/** Whether a click landed on a control of its own, which then handles it. */
export function onControl(target: EventTarget): boolean {
  return target instanceof Element && target.closest('a, button, input, select, textarea, label') !== null;
}

/** A page's title bar: the same height and spacing on every page, whether or not it holds controls. */
export const pageToolbarClass =
  'sticky top-0 z-10 flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2.5';
