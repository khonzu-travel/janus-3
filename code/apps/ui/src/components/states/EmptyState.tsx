import { useId, type ReactNode } from 'react';

import { EmptyIcon } from '../icons.js';
import { panelClass } from './panelClass.js';

export function EmptyState({
  title,
  headingLevel = 3,
  children,
}: {
  readonly title: string;
  /**
   * 2 when the state stands in for a whole view, so the heading hierarchy has
   * no gap; null in a pane with no heading of its own, where the title is plain text.
   */
  readonly headingLevel?: 2 | 3 | null;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  const Heading = headingLevel === null ? 'p' : headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section aria-labelledby={titleId} className={`${panelClass} border-line-strong text-muted`}>
      <Heading id={titleId} className="flex items-center gap-2 font-medium text-fg">
        <EmptyIcon className="size-4" />
        {title}
      </Heading>
      <div className="mt-1">{children}</div>
    </section>
  );
}
