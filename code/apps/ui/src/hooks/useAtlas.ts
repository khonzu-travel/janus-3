import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import {
  AtlasError,
  type CaptureDetail,
  type CaptureList,
  type CaptureQuery,
  type Clock,
  type EffectiveConfig,
  type Endpoint,
  type EndpointItem,
  type Fixture,
  type FixtureItem,
  type Health,
  type Inventory,
  type PromotionList,
  type PromotionQuery,
  type Recording,
  type ReloadResult,
  type RenderedFixture,
  type RenderInput,
  type Scenarios,
} from '../atlas/client.js';
import { useAtlasSession } from './AtlasSession.js';
import { feedChanged, useSnapshotFeed } from './SnapshotFeed.js';

export function useRestart(): () => void {
  return useAtlasSession().restart;
}

/**
 * Refetches every document of this session in the background, keeping what is
 * shown until the new documents arrive. Used after the UI itself changed the
 * tree (a promotion or a review), so the view stays mounted.
 */
export function useRefresh(): () => void {
  const { generation } = useAtlasSession();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['atlas', generation] });
  };
}

export function useServerTarget(): string {
  return useAtlasSession().client.atlasRoot.href;
}

export function useHealth(): UseQueryResult<Health> {
  const { client, generation } = useAtlasSession();
  return useQuery({
    queryKey: ['atlas', generation, 'health'],
    queryFn: ({ signal }) => client.health(signal),
  });
}

/** The effective configuration. Not snapshot-bound, so it only depends on the session. */
export function useConfig(): UseQueryResult<EffectiveConfig> {
  const { client, generation } = useAtlasSession();
  return useQuery({
    queryKey: ['atlas', generation, 'config'],
    queryFn: ({ signal }) => client.config(signal),
  });
}

/**
 * The header a retried request repeats to be replayed:
 * `idempotency.header` from `/_janus/config`, as people write it
 * (`x-retry-token` → `X-Retry-Token`). `Idempotency-Key` until the
 * configuration loads, or on a server that does not report the setting.
 */
export function useIdempotencyHeader(): string {
  const value = useConfig().data?.settings.find((setting) => setting.key === 'idempotency.header')?.value;
  if (typeof value !== 'string' || value === '') return 'Idempotency-Key';
  return value
    .toLowerCase()
    .replace(/(^|-)([a-z])/g, (_match, dash: string, letter: string) => dash + letter.toUpperCase());
}

/** One scenario's inventory; `scenario` is null for the configured default, or on a server without scenarios. */
export function useInventory(health: Health | undefined, scenario: string | null): UseQueryResult<Inventory> {
  const { client, generation } = useAtlasSession();
  return useQuery({
    queryKey: ['atlas', generation, 'inventory', health?.snapshotVersion, scenario],
    enabled: health !== undefined,
    queryFn: async ({ signal }) => {
      const inventory = await client.inventory(scenario, signal);
      if (inventory.snapshotVersion !== health?.snapshotVersion) {
        throw new AtlasError('stale', 'The fixture snapshot changed');
      }
      return inventory;
    },
  });
}

/** Every scenario; disabled on a server without them. */
export function useScenarios(health: Health | undefined): UseQueryResult<Scenarios> {
  const { client, generation } = useAtlasSession();
  return useQuery({
    queryKey: ['atlas', generation, 'scenarios', health?.snapshotVersion],
    enabled: health?.capabilities.scenarios === true,
    queryFn: async ({ signal }) => {
      const scenarios = await client.scenarios(signal);
      if (scenarios.snapshotVersion !== health?.snapshotVersion) {
        throw new AtlasError('stale', 'The fixture snapshot changed');
      }
      return scenarios;
    },
  });
}

export function useEndpoint(item: EndpointItem | undefined): UseQueryResult<Endpoint> {
  const { client, generation } = useAtlasSession();
  return useQuery({
    queryKey: ['atlas', generation, 'endpoint', item?.detailUrl],
    enabled: item !== undefined,
    queryFn: ({ signal }) => {
      if (item === undefined) throw new Error('no endpoint selected');
      return client.endpoint(item, signal);
    },
  });
}

export function useFixture(item: FixtureItem | undefined): UseQueryResult<Fixture> {
  const { client, generation } = useAtlasSession();
  return useQuery({
    queryKey: ['atlas', generation, 'fixture', item?.detailUrl],
    enabled: item !== undefined,
    queryFn: ({ signal }) => {
      if (item === undefined) throw new Error('no fixture selected');
      return client.fixture(item, signal);
    },
  });
}

/** The fixture rendered with the given inputs; disabled until `input` is set. */
export function useRenderedFixture(
  item: FixtureItem | undefined,
  input: RenderInput | null,
): UseQueryResult<RenderedFixture> {
  const { client, generation } = useAtlasSession();
  return useQuery({
    queryKey: ['atlas', generation, 'rendered', item?.detailUrl, input],
    enabled: item !== undefined && input !== null,
    // Previews against the live clock differ each time; never serve a cached one as current.
    gcTime: 0,
    queryFn: ({ signal }) => {
      if (item === undefined || input === null) throw new Error('no fixture selected');
      return client.renderedFixture(item, input, signal);
    },
  });
}

/** The server clock and seed. Not snapshot-bound. */
export function useClock(): UseQueryResult<Clock> {
  const { client, generation } = useAtlasSession();
  return useQuery({
    queryKey: ['atlas', generation, 'clock'],
    queryFn: ({ signal }) => client.clock(signal),
    retry: false,
  });
}

/**
 * True once any request in this session learned that the snapshot changed, or
 * the event stream announced another snapshot.
 */
export function useSnapshotChanged(): boolean {
  const { generation } = useAtlasSession();
  const cache = useQueryClient().getQueryCache();
  const announced = feedChanged(useSnapshotFeed());
  const learned = useSyncExternalStore(
    (notify) => cache.subscribe(notify),
    () =>
      cache
        .findAll({ queryKey: ['atlas', generation] })
        .some((query) => query.state.error instanceof AtlasError && query.state.error.kind === 'stale'),
  );
  return announced || learned;
}

/** The current reload result, fetched when the user asks to see why a reload failed. */
export function useReloadResult(key: string | null): UseQueryResult<ReloadResult> {
  const { client, generation } = useAtlasSession();
  return useQuery({
    queryKey: ['atlas', generation, 'reload', key],
    enabled: key !== null,
    gcTime: 0,
    queryFn: ({ signal }) => client.reloadResult(signal),
  });
}

/** The recording registrations and limits; disabled unless the server reports recording. */
export function useRecording(health: Health | undefined): UseQueryResult<Recording> {
  const { client, generation } = useAtlasSession();
  return useQuery({
    queryKey: ['atlas', generation, 'recording'],
    enabled: health !== undefined && health.capabilities.recording.endpoints > 0,
    queryFn: ({ signal }) => client.recording(signal),
  });
}

/**
 * One page of captures. Captures are read from disk, not the snapshot,
 * so `revision` (the number of capture events seen) refetches the list.
 */
export function useCaptures(query: CaptureQuery, revision: number): UseQueryResult<CaptureList> {
  const { client, generation } = useAtlasSession();
  return useQuery({
    queryKey: ['atlas', generation, 'captures', query, revision],
    placeholderData: (previous) => previous,
    queryFn: ({ signal }) => client.captures(query, signal),
  });
}

/** One capture's detail, from the list's link. */
export function useCapture(detailUrl: string | null): UseQueryResult<CaptureDetail> {
  const { client, generation } = useAtlasSession();
  return useQuery({
    queryKey: ['atlas', generation, 'capture', detailUrl],
    enabled: detailUrl !== null,
    queryFn: ({ signal }) => {
      if (detailUrl === null) throw new Error('no capture selected');
      return client.capture(detailUrl, signal);
    },
  });
}

/** Refetches every capture list and detail, after a capture was deleted. */
export function useCapturesChanged(): () => Promise<void> {
  const { generation } = useAtlasSession();
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      predicate: (query) =>
        query.queryKey[1] === generation && (query.queryKey[2] === 'captures' || query.queryKey[2] === 'capture'),
    });
}

/** Promoted files, from the snapshot `health` reports; disabled unless the server can promote. */
export function usePromotions(health: Health | undefined, query: PromotionQuery): UseQueryResult<PromotionList> {
  const { client, generation } = useAtlasSession();
  return useQuery({
    queryKey: ['atlas', generation, 'promotions', health?.snapshotVersion, query],
    enabled: health?.capabilities.promotion.available === true,
    queryFn: async ({ signal }) => {
      const list = await client.promotions(query, signal);
      if (list.at !== health?.snapshotVersion) throw new AtlasError('stale', 'The fixture snapshot changed');
      return list;
    },
  });
}
