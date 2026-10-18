import { useOutletContext, useParams, useSearchParams } from 'react-router';

import { EndpointDetail } from '../features/endpoints/EndpointDetail.js';
import { FixtureSection } from '../features/fixtures/FixtureSection.js';
import { hasSiblingRepresentations } from '../features/fixtures/format.js';
import { ErrorState } from '../components/states/ErrorState.js';
import { isNotFound, isStale } from '../components/states/errors.js';
import { LoadingState } from '../components/states/LoadingState.js';
import { StaleState } from '../components/states/StaleState.js';
import { useEndpoint, useRestart } from '../hooks/useAtlas.js';
import type { AtlasLayoutContext } from '../layouts/AtlasLayoutContext.js';
import { inventorySearch } from '../layouts/inventoryFilter.js';
import { EmptyState } from '../components/states/EmptyState.js';

/** `#/endpoints/:endpointId` and `#/endpoints/:endpointId/fixtures/:fixtureId`. */
export function EndpointPage() {
  const { endpointId = '', fixtureId } = useParams();
  const { health, inventory, inventoryError, scenario } = useOutletContext<AtlasLayoutContext>();
  const [search] = useSearchParams();
  const back = `/endpoints${inventorySearch(search)}`;
  const item = inventory?.items.find((entry) => entry.id === endpointId);
  const endpoint = useEndpoint(item);
  const restart = useRestart();

  if (inventoryError !== null) return null; // The inventory sidebar already shows the problem.
  if (inventory === undefined) return <LoadingState label="Loading endpoints" />;
  if (item === undefined) {
    return (
      <ErrorState
        title={scenario.supported ? 'Not in this scenario' : 'Endpoint not found'}
        message={
          scenario.supported
            ? `This endpoint does not exist in scenario ${scenario.name} of snapshot ${health.snapshotVersion}.`
            : `No endpoint with ID ${endpointId} exists in snapshot ${health.snapshotVersion}.`
        }
        backTo={back}
        headingLevel={2}
      />
    );
  }
  if (endpoint.error !== null) {
    if (isStale(endpoint.error))
      return <StaleState loadedFrom={health.snapshotVersion} onRefresh={restart} headingLevel={2} />;
    return (
      <ErrorState
        title={isNotFound(endpoint.error) ? 'Endpoint not found' : 'Could not load the endpoint'}
        error={endpoint.error}
        onRetry={restart}
        backTo={back}
        headingLevel={2}
      />
    );
  }
  if (endpoint.data === undefined) return <LoadingState label="Loading endpoint" />;

  const selected = fixtureId === undefined ? undefined : endpoint.data.fixtures.find((entry) => entry.id === fixtureId);
  return (
    <div className="flex min-h-full flex-col lg:h-full">
      <EndpointDetail endpoint={endpoint.data} selectedId={fixtureId} scenarios={scenario.supported} />
      {fixtureId === undefined ? (
        <EmptyState title="Select a response">
          Choose a response in the table to see its body, headers and dynamic values.
        </EmptyState>
      ) : selected === undefined ? (
        <ErrorState
          title="Response not found"
          message={`This endpoint has no response with ID ${fixtureId}.`}
          backTo={`/endpoints/${endpoint.data.id}${inventorySearch(search)}`}
        />
      ) : (
        <FixtureSection
          key={selected.id}
          item={selected}
          loadedFrom={health.snapshotVersion}
          withMediaType={hasSiblingRepresentations(endpoint.data, selected.id)}
        />
      )}
    </div>
  );
}
