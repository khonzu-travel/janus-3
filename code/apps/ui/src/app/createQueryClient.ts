import { QueryClient } from '@tanstack/react-query';

/**
 * Snapshot-bound documents never change for a given link, and staleness is
 * learned only on the next navigation, so nothing refetches
 * on its own and failures surface at once for an explicit retry.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false },
    },
  });
}
