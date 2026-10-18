import { buttonClass } from '../components/buttonClass.js';
import { HistoryIcon } from '../components/icons.js';
import { feedChanged, useSnapshotFeed } from '../hooks/SnapshotFeed.js';

/**
 * Announces a snapshot the server swapped in while this view was open. The view stays as it is
 * until the user refreshes. The live region
 * is always mounted, so the change is announced once, politely.
 */
export function SnapshotBanner({ onRefresh }: { readonly onRefresh: () => void }) {
  const feed = useSnapshotFeed();
  const changed = feedChanged(feed);
  return (
    <div role="status" aria-live="polite" className={changed ? 'border-b border-warn/40 bg-warn-soft' : 'sr-only'}>
      {changed ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-1.5">
          <p className="flex items-center gap-2 text-fg">
            <HistoryIcon className="size-4 text-warn" />
            <span>
              <strong className="font-medium">The fixtures changed.</strong> The server now serves snapshot{' '}
              <code>{feed.currentVersion}</code>; this view shows <code>{feed.loadedVersion}</code>.
            </span>
          </p>
          <button type="button" className={buttonClass} onClick={onRefresh}>
            Refresh view
          </button>
        </div>
      ) : null}
    </div>
  );
}
