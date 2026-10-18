import { useCallback, useMemo, useState, type ReactNode } from 'react';

import type { AtlasClient } from '../atlas/client.js';
import type { EventSourceFactory } from '../atlas/events.js';
import { AtlasSessionContext } from './AtlasSession.js';
import { nativeEventSource } from './SnapshotFeed.js';

export function AtlasProvider({
  client,
  eventSource = nativeEventSource,
  children,
}: {
  client: AtlasClient;
  eventSource?: EventSourceFactory | null;
  children: ReactNode;
}) {
  const [generation, setGeneration] = useState(0);
  const restart = useCallback(() => {
    setGeneration((current) => current + 1);
  }, []);
  const session = useMemo(
    () => ({ client, eventSource, generation, restart }),
    [client, eventSource, generation, restart],
  );
  return <AtlasSessionContext.Provider value={session}>{children}</AtlasSessionContext.Provider>;
}
