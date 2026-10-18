import type { ReactNode } from 'react';

import { buttonClass } from '../buttonClass.js';
import { HistoryIcon } from '../icons.js';
import { panelClass } from './panelClass.js';

/** Shown in place of (or above) content from a snapshot that is no longer current. */
export function StaleState({
  loadedFrom,
  onRefresh,
  children,
  headingLevel = 3,
}: {
  readonly loadedFrom: string | undefined;
  readonly onRefresh: () => void;
  readonly children?: ReactNode;
  /** 2 when the state stands in for a whole view, so the heading hierarchy has no gap. */
  readonly headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    // Not a landmark: the inventory and the details can both show one at once.
    <div className={`${panelClass} border-warn`}>
      <Heading className="flex items-center gap-2 font-medium text-fg">
        <HistoryIcon className="size-4" />
        Snapshot changed
      </Heading>
      <p className="mt-1 text-muted">
        The fixtures changed on the server.
        {loadedFrom === undefined ? null : (
          <>
            {' '}
            This view was loaded from snapshot <code>{loadedFrom}</code>.
          </>
        )}
      </p>
      {children}
      <button type="button" className={`${buttonClass} mt-3`} onClick={onRefresh}>
        Refresh
      </button>
    </div>
  );
}
