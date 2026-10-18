import { useEffect } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import type { EnvironmentDetail, RequestDetail, RequestTree, RunRecord, RunSummary } from '../../atlas/runner.js';
import { useAtlasSession } from '../../hooks/AtlasSession.js';
import { useSnapshotFeed } from '../../hooks/SnapshotFeed.js';

/**
 * The runner's documents. Request files and runs are read from the
 * server's current state, not a snapshot, so `requests` and `run` events
 * refetch them.
 */

export function useRequestTree(enabled: boolean): UseQueryResult<RequestTree> {
  const { client, generation } = useAtlasSession();
  const { requestsCount } = useSnapshotFeed();
  return useQuery({
    queryKey: ['atlas', generation, 'runner', 'tree', requestsCount],
    enabled,
    placeholderData: (previous) => previous,
    queryFn: ({ signal }) => client.runner.tree(signal),
  });
}

export function useRequestDetail(id: string | null): UseQueryResult<RequestDetail> {
  const { client, generation } = useAtlasSession();
  const { requestsCount } = useSnapshotFeed();
  return useQuery<RequestDetail>({
    queryKey: ['atlas', generation, 'runner', 'request', id, requestsCount],
    enabled: id !== null,
    placeholderData: (previous) => (previous?.id === id ? previous : undefined),
    queryFn: ({ signal }) => {
      if (id === null) throw new Error('no request selected');
      return client.runner.request(id, signal);
    },
  });
}

export function useEnvironmentDetail(name: string | null): UseQueryResult<EnvironmentDetail> {
  const { client, generation } = useAtlasSession();
  const { requestsCount } = useSnapshotFeed();
  return useQuery<EnvironmentDetail>({
    queryKey: ['atlas', generation, 'runner', 'environment', name, requestsCount],
    enabled: name !== null,
    placeholderData: (previous) => (previous?.id === name ? previous : undefined),
    queryFn: ({ signal }) => {
      if (name === null) throw new Error('no environment selected');
      return client.runner.environment(name, signal);
    },
  });
}

export function useRuns(): UseQueryResult<readonly RunSummary[]> {
  const { client, generation } = useAtlasSession();
  const { runCount } = useSnapshotFeed();
  const cache = useQueryClient();
  useEffect(() => {
    if (runCount > 0) void cache.invalidateQueries({ queryKey: ['atlas', generation, 'runner', 'runs'], exact: true });
  }, [cache, generation, runCount]);
  return useQuery({
    queryKey: ['atlas', generation, 'runner', 'runs'],
    placeholderData: (previous) => previous,
    queryFn: ({ signal }) => client.runner.runs(signal),
  });
}

/** One run, under a stable key; only its own events refetch it, with polling while it runs. */
export function useRun(id: string | null): UseQueryResult<RunRecord> {
  const { client, generation } = useAtlasSession();
  const { runCount, lastRun } = useSnapshotFeed();
  const cache = useQueryClient();
  useEffect(() => {
    if (id !== null && lastRun?.id === id) {
      void cache.invalidateQueries({ queryKey: ['atlas', generation, 'runner', 'run', id], exact: true });
    }
  }, [cache, generation, id, runCount, lastRun]);
  return useQuery<RunRecord>({
    queryKey: ['atlas', generation, 'runner', 'run', id],
    enabled: id !== null,
    placeholderData: (previous) => (previous?.id === id ? previous : undefined),
    // Without the event stream, a running run is polled.
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 1000 : false),
    queryFn: ({ signal }) => {
      if (id === null) throw new Error('no run selected');
      return client.runner.run(id, signal);
    },
  });
}

/** Refetches the runner's documents after the UI itself wrote a file. */
export function useRunnerRefresh(): () => Promise<void> {
  const { generation } = useAtlasSession();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['atlas', generation, 'runner'] });
}
