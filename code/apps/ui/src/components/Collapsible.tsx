import { useId, useState, type ReactNode } from 'react';

import { ChevronRightIcon } from './icons.js';

const toggleClass =
  'flex min-h-6 min-w-0 items-center gap-1 rounded text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/**
 * A titled part of a page that folds to its title. The title is a button
 * that says whether it is open; `actions` sit at the end of the title row and
 * stay visible when folded.
 */
export function Collapsible({
  title,
  label = title,
  count,
  level = 3,
  framed = true,
  defaultOpen = true,
  detail,
  actions,
  className = 'mx-4 mt-2 rounded border border-line bg-surface',
  children,
}: {
  readonly title: string;
  /** The part's accessible name, when the title alone would repeat another part's. */
  readonly label?: string;
  /** Shown after the title, such as how many headers there are. */
  readonly count?: number;
  /** 3: a framed part of the page; 4: a part inside one. */
  readonly level?: 3 | 4;
  /** False for a part that is a band of the page, not a box: its title row has no padding or rule of its own. */
  readonly framed?: boolean;
  readonly defaultOpen?: boolean;
  /** Beside the title, outside its button, such as a file name. */
  readonly detail?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  const Heading = level === 3 ? 'h3' : 'h4';
  const sub = level === 4;
  return (
    // A part inside another is a group, so repeated titles such as Headers are not repeated landmarks.
    <section
      aria-label={label}
      {...(sub ? { role: 'group' } : {})}
      className={sub ? 'border-t border-line' : className}
    >
      <div
        className={
          framed
            ? `flex min-h-8 items-center gap-2 px-3 ${sub ? 'py-0.5' : 'py-1'} ${open && !sub ? 'border-b border-line' : ''}`
            : 'flex min-h-6 flex-wrap items-center gap-x-2'
        }
      >
        <Heading className="min-w-0">
          <button
            type="button"
            className={`${toggleClass} ${sub ? 'text-label font-medium tracking-[0.06em] text-faint uppercase hover:text-fg' : 'font-medium'}`}
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => {
              setOpen(!open);
            }}
          >
            <ChevronRightIcon
              className={`size-3.5 text-muted transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
            />
            {title}
            {/* The space keeps the count a separate word in the button's name. */}
            {count === undefined ? null : ' '}
            {count === undefined ? null : (
              <span className="font-normal tracking-normal text-faint normal-case">{count}</span>
            )}
          </button>
        </Heading>
        {detail === undefined ? null : <div className="min-w-0">{detail}</div>}
        {actions === undefined ? null : <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
      </div>
      <div id={contentId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
