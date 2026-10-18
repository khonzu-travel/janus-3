import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router';

import type { AtlasClient } from '../atlas/client.js';
import type { EventSourceFactory } from '../atlas/events.js';
import { AtlasProvider } from '../hooks/AtlasProvider.js';
import { nativeEventSource } from '../hooks/SnapshotFeed.js';
import { createQueryClient } from './createQueryClient.js';
import { createRouter } from './routes.js';

export function App({
  client,
  eventSource = nativeEventSource,
}: {
  readonly client: AtlasClient;
  /** Opens `GET /_janus/events`; tests substitute a fake. */
  readonly eventSource?: EventSourceFactory | null;
}) {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(createRouter);
  return (
    <QueryClientProvider client={queryClient}>
      <AtlasProvider client={client} eventSource={eventSource}>
        <RouterProvider router={router} />
      </AtlasProvider>
    </QueryClientProvider>
  );
}
