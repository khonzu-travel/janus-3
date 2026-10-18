import { useOutletContext } from 'react-router';

import { EmptyState } from '../components/states/EmptyState.js';
import type { AtlasLayoutContext } from '../layouts/AtlasLayoutContext.js';

export function HomePage() {
  const { inventory } = useOutletContext<AtlasLayoutContext>();
  if (inventory === undefined || inventory.items.length === 0) return null;
  return (
    <EmptyState title="Select an endpoint" headingLevel={2}>
      Choose an endpoint from the list to see the responses Janus can replay for it.
    </EmptyState>
  );
}
