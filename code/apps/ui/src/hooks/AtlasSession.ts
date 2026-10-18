import { createContext, useContext } from 'react';

import type { AtlasClient } from '../atlas/client.js';
import type { EventSourceFactory } from '../atlas/events.js';

/**
 * One coherent view of the server. Every query key carries the session
 * generation, so Retry and Refresh start again from a fresh health check
 * instead of mixing documents from two snapshots.
 */
export interface AtlasSession {
  readonly client: AtlasClient;
  /** Opens the snapshot event stream; null where the platform has no `EventSource`. */
  readonly eventSource: EventSourceFactory | null;
  readonly generation: number;
  readonly restart: () => void;
}

export const AtlasSessionContext = createContext<AtlasSession | null>(null);

export function useAtlasSession(): AtlasSession {
  const session = useContext(AtlasSessionContext);
  if (session === null) throw new Error('AtlasProvider is missing');
  return session;
}
