export const buttonClass =
  'inline-flex min-h-6 items-center gap-1.5 whitespace-nowrap rounded border border-line-strong bg-surface px-2.5 py-0.5 text-body text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/** The one primary action of a form: filled, with the same shape and focus ring as `buttonClass`. */
export const primaryButtonClass =
  'inline-flex min-h-6 items-center gap-1.5 whitespace-nowrap rounded border border-fg bg-fg px-2.5 py-0.5 text-body font-medium text-surface hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/** A link in running text or a link-like button. */
export const linkClass =
  'text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/** A square button showing only an icon; it needs an `aria-label` and a matching `title`. */
export const iconButtonClass =
  'inline-flex size-6 items-center justify-center rounded border border-line-strong bg-surface text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/** The primary action as an icon only: `iconButtonClass`'s shape with `primaryButtonClass`'s fill. */
export const primaryIconButtonClass =
  'inline-flex size-6 items-center justify-center rounded border border-fg bg-fg text-surface hover:opacity-90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/**
 * A row's Remove button: `iconButtonClass`'s shape, solid danger with a light
 * icon while hovered or focused. Mark it `data-remove` so its row
 * (`removableRowClass`) lights up with it.
 */
export const removeIconButtonClass =
  'inline-flex size-6 items-center justify-center rounded border border-line-strong bg-surface text-muted hover:border-bad hover:bg-bad hover:text-surface focus-visible:border-bad focus-visible:bg-bad focus-visible:text-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/** A row that turns danger-coloured while its `data-remove` button is hovered or keyboard-focused. */
export const removableRowClass =
  'has-[[data-remove]:hover]:bg-bad-soft has-[[data-remove]:hover]:outline-1 has-[[data-remove]:hover]:-outline-offset-1 has-[[data-remove]:hover]:outline-bad has-[[data-remove]:focus-visible]:bg-bad-soft has-[[data-remove]:focus-visible]:outline-1 has-[[data-remove]:focus-visible]:-outline-offset-1 has-[[data-remove]:focus-visible]:outline-bad';

/** A row in error: danger-tinted and outlined. */
export const errorRowClass = 'bg-bad-soft outline-1 -outline-offset-1 outline-bad';
