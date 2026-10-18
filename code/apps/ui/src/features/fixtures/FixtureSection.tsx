import type { FixtureItem } from '../../atlas/client.js';
import { ErrorState } from '../../components/states/ErrorState.js';
import { isNotFound, isStale } from '../../components/states/errors.js';
import { LoadingState } from '../../components/states/LoadingState.js';
import { StaleState } from '../../components/states/StaleState.js';
import { useFixture, useRestart } from '../../hooks/useAtlas.js';
import { FixtureDetail } from './FixtureDetail.js';

export function FixtureSection({
  item,
  loadedFrom,
  withMediaType = false,
}: {
  readonly item: FixtureItem;
  readonly loadedFrom: string;
  /** The response has several media types, so its heading names this one. */
  readonly withMediaType?: boolean;
}) {
  const fixture = useFixture(item);
  const restart = useRestart();
  if (fixture.error !== null) {
    if (isStale(fixture.error)) return <StaleState loadedFrom={loadedFrom} onRefresh={restart} />;
    return (
      <ErrorState
        title={isNotFound(fixture.error) ? 'Response not found' : 'Could not load the response'}
        error={fixture.error}
        onRetry={restart}
      />
    );
  }
  if (fixture.data === undefined) return <LoadingState label="Loading response" />;
  return <FixtureDetail fixture={fixture.data} item={item} withMediaType={withMediaType} />;
}
