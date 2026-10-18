import { Link, useSearchParams } from 'react-router';

import type { Endpoint, FixtureItem, Matrix } from '../../atlas/client.js';
import { Collapsible } from '../../components/Collapsible.js';
import { MethodBadge } from '../../components/MethodBadge.js';
import { OriginBadge } from '../../components/OriginBadge.js';
import { PathTemplate } from '../../components/PathTemplate.js';
import { iconButtonClass } from '../../components/buttonClass.js';
import { CompassIcon } from '../../components/icons.js';
import { useIdempotencyHeader } from '../../hooks/useAtlas.js';
import { SCENARIO_PARAM, scenarioSearch } from '../../scenarios/selection.js';
import { tryItSearch } from '../explorer/requestState.js';
import { describeFixture, formatBytes } from '../fixtures/format.js';
import { ControlsPanel } from './ControlsPanel.js';
import { FaultsPanel } from './FaultsPanel.js';

/**
 * The endpoint header and its response matrix.
 * The accepted request bodies are in the inspector.
 */
export function EndpointDetail({
  endpoint,
  selectedId,
  scenarios = false,
}: {
  readonly endpoint: Endpoint;
  readonly selectedId: string | undefined;
  /** The server has scenarios: show origins and the matrix across scenarios. */
  readonly scenarios?: boolean;
}) {
  const [search] = useSearchParams();
  // Links keep the selected scenario.
  const keep = scenarioSearch(search);
  // Columns of the representation matrix: every media type offered, in first-seen order ("No body" is null).
  const columns = [
    ...new Set(endpoint.representationGroups.flatMap((group) => group.representations.map((entry) => entry.mediaType))),
  ];
  const count = endpoint.fixtures.length;
  return (
    <section aria-labelledby="endpoint-title" className="shrink-0">
      <div className="grid gap-1 border-b border-line px-4 pt-3 pb-2.5">
        <h2 id="endpoint-title" className="flex min-w-0 flex-wrap items-baseline gap-2.5">
          <span className="text-mono">
            <MethodBadge method={endpoint.method} />
          </span>{' '}
          <span className="break-all font-mono text-title font-medium">
            <PathTemplate path={endpoint.path} parameters={endpoint.pathParameters} />
          </span>
        </h2>
        <dl className="flex flex-wrap items-center gap-x-3.5 gap-y-0.5 text-muted">
          <div className="flex gap-1">
            <dt>Scenario</dt>
            <dd className="flex items-center gap-1.5 text-fg">
              {endpoint.scenario}
              {scenarios ? <OriginBadge origin={endpoint.origin} /> : null}
            </dd>
          </div>
          <div className="flex items-center gap-1">
            <dt>Endpoint ID</dt>
            <dd className="flex items-center gap-1.5">
              <span className="font-mono text-mono text-fg">{endpoint.id}</span>
              <Link
                to={{
                  pathname: '/requests',
                  search: `?${tryItSearch(endpoint.method, endpoint.path, search).toString()}`,
                }}
                className={iconButtonClass}
                aria-label={`Try it: simulate ${endpoint.method} ${endpoint.path} in Explore`}
                title="Try it in Explore"
              >
                <CompassIcon className="size-3.5" />
              </Link>
            </dd>
          </div>
          {endpoint.pathParameters.length === 0 ? null : (
            <div className="flex gap-1">
              <dt>Path parameters</dt>
              <dd className="font-mono text-mono text-fg">{endpoint.pathParameters.join(', ')}</dd>
            </div>
          )}
        </dl>
      </div>

      {/* The two tables sit side by side when both fit, each with a line on the side that meets the other. */}
      <div className="flex flex-wrap overflow-hidden border-b border-line">
        <Collapsible
          title="Responses"
          count={count}
          framed={false}
          className={tablePartClass}
          detail={
            <span className="text-faint">
              rows by <code>Accept-Language</code>, columns by <code>Accept</code>
            </span>
          }
        >
          <div className="mt-1.5 overflow-x-auto">
            <table className="stack-table tabular border-collapse text-left">
              <caption className="sr-only">Configured responses for this endpoint</caption>
              <thead>
                <tr>
                  <th scope="col" className={headClass}>
                    Locale
                  </th>
                  <th scope="col" className={headClass}>
                    Response
                  </th>
                  {columns.map((mediaType) => (
                    <th key={mediaType ?? ''} scope="col" className={`${headClass} font-mono`}>
                      {mediaType ?? 'No body'}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {endpoint.representationGroups.map((group) => (
                  <tr key={`${String(group.status)}.${group.variant ?? ''}:${group.locale ?? ''}`}>
                    <th scope="row" data-label="Locale" className={`${cellClass} bg-bg font-normal whitespace-nowrap`}>
                      {group.locale ?? 'Any (neutral)'}
                    </th>
                    <td data-label="Response" className={`${cellClass} bg-bg font-mono text-mono`}>
                      {group.variant === null ? group.status : `${String(group.status)}.${group.variant}`}
                    </td>
                    {columns.map((mediaType) => {
                      const fixture = group.representations.find((entry) => entry.mediaType === mediaType);
                      return (
                        <td
                          key={mediaType ?? ''}
                          data-label={mediaType ?? 'No body'}
                          className="border border-line p-0"
                        >
                          {fixture === undefined ? (
                            <span className="block px-2.5 py-1 text-faint">
                              <span aria-hidden="true">—</span>
                              <span className="sr-only">Not offered</span>
                            </span>
                          ) : (
                            <RepresentationLink
                              endpoint={endpoint}
                              fixture={fixture}
                              selected={fixture.id === selectedId}
                              ambiguous={group.representations.length > 1}
                              search={keep}
                              scenarios={scenarios}
                            />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Collapsible>
        {scenarios && endpoint.matrix !== null && endpoint.matrix.rows.length > 1 ? (
          <ScenarioMatrix matrix={endpoint.matrix} current={endpoint.scenario} selectedId={selectedId} />
        ) : null}
      </div>
      {endpoint.controls === null ? null : (
        <ConfiguredControlsPanel endpoint={endpoint} controls={endpoint.controls} search={keep} />
      )}
      {endpoint.faults === null ? null : <FaultsPanel faults={endpoint.faults} scenario={endpoint.scenario} />}
    </section>
  );
}

/** One of the side-by-side tables; the container clips the lines that would fall on its edges. */
const tablePartClass = 'min-w-0 flex-[1_1_auto] px-4 pt-2.5 pb-3 shadow-[-1px_0_0_var(--line),0_-1px_0_var(--line)]';

const headClass = 'border border-line bg-bg px-2.5 py-0.5 text-label font-normal text-muted';
const cellClass = 'border border-line px-2.5 py-1';

function RepresentationLink({
  endpoint,
  fixture,
  selected,
  ambiguous,
  search,
  scenarios,
}: {
  readonly endpoint: Endpoint;
  readonly fixture: FixtureItem;
  readonly selected: boolean;
  readonly ambiguous: boolean;
  /** The selected scenario's part of the hash, kept so the link stays in it. */
  readonly search: string;
  readonly scenarios: boolean;
}) {
  return (
    <Link
      to={`/endpoints/${endpoint.id}/fixtures/${fixture.id}${search}`}
      aria-current={selected ? 'page' : undefined}
      aria-label={`View response ${describeFixture(fixture, ambiguous)}`}
      className="flex min-w-32 items-center gap-2 whitespace-nowrap px-2.5 py-1 hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent aria-[current=page]:bg-accent-soft aria-[current=page]:shadow-[inset_0_0_0_1px_var(--accent)]"
    >
      <span className="text-accent">View response</span>{' '}
      <span className="font-mono text-label text-muted">{formatBytes(fixture.byteLength)}</span>
      {fixture.wireContentType !== null && fixture.wireContentType !== fixture.mediaType ? (
        <>
          {' '}
          <span className="rounded bg-warn-soft px-1 text-label text-warn">sent as {fixture.wireContentType}</span>
        </>
      ) : null}
      {scenarios ? (
        <>
          {' '}
          <OriginBadge origin={fixture.origin} from={fixture.holder} />
        </>
      ) : null}
    </Link>
  );
}

/**
 * This route and method in every scenario that has it: one row
 * per scenario, one column per response identity. Each representation links to its fixture
 * in that row's scenario.
 */
function ScenarioMatrix({
  matrix,
  current,
  selectedId,
}: {
  readonly matrix: Matrix;
  readonly current: string;
  readonly selectedId: string | undefined;
}) {
  const inScenario = (scenario: string): string => `?${new URLSearchParams([[SCENARIO_PARAM, scenario]]).toString()}`;
  // Fault.yaml is listed beside the responses as own, inherited or absent.
  const withFaults = matrix.rows.some((row) => row.fault !== null);
  return (
    <Collapsible
      title="Across scenarios"
      framed={false}
      className={tablePartClass}
      detail={<span className="text-faint">the file each scenario serves per response</span>}
    >
      <div className="mt-1.5 overflow-x-auto">
        <table className="stack-table tabular border-collapse text-left">
          <caption className="sr-only">Responses of this endpoint in each scenario</caption>
          <thead>
            <tr>
              <th scope="col" className={headClass}>
                Scenario
              </th>
              {matrix.identities.map((identity) => (
                <th key={identity.identity} scope="col" className={`${headClass} font-mono`}>
                  {identity.identity}
                </th>
              ))}
              {withFaults ? (
                <th scope="col" className={`${headClass} font-mono`}>
                  fault.yaml
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => {
              const isCurrent = row.scenario === current;
              return (
                <tr key={row.scenario} aria-current={isCurrent ? 'true' : undefined}>
                  <th
                    scope="row"
                    data-label="Scenario"
                    className={`${cellClass} font-normal whitespace-nowrap ${isCurrent ? 'bg-accent-soft' : 'bg-bg'}`}
                  >
                    <span className={isCurrent ? 'font-medium' : undefined}>{row.scenario}</span>
                    {isCurrent ? <span className="ml-1 text-label text-muted">(selected)</span> : null}
                  </th>
                  {row.cells.map((cell, index) => {
                    const identity = matrix.identities[index]?.identity ?? '';
                    return (
                      <td key={identity} data-label={identity} className={`${cellClass} align-top`}>
                        {cell === null ? (
                          <span className="text-faint">
                            <span aria-hidden="true">—</span>
                            <span className="sr-only">Not in this scenario</span>
                          </span>
                        ) : (
                          <ul className="space-y-0.5">
                            {cell.representations.map((entry) => {
                              const label = [entry.locale ?? null, entry.mediaType ?? 'no body']
                                .filter((part) => part !== null)
                                .join(', ');
                              return (
                                <li key={entry.fixtureId} className="flex flex-wrap items-center gap-x-2">
                                  <Link
                                    to={`/endpoints/${row.endpointId}/fixtures/${entry.fixtureId}${inScenario(row.scenario)}`}
                                    aria-current={isCurrent && entry.fixtureId === selectedId ? 'page' : undefined}
                                    aria-label={`${row.scenario}: ${identity} ${label}, ${
                                      entry.origin === 'own' ? 'own' : `from ${entry.scenario}`
                                    }`}
                                    className="font-mono text-mono text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-[current=page]:font-medium"
                                  >
                                    {label}
                                  </Link>
                                  <OriginBadge origin={entry.origin} from={entry.scenario} />
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </td>
                    );
                  })}
                  {withFaults ? (
                    <td data-label="fault.yaml" className={`${cellClass} align-top whitespace-nowrap`}>
                      {row.fault === null ? (
                        <span className="text-faint">
                          <span aria-hidden="true">—</span>
                          <span className="sr-only">No fault.yaml</span>
                        </span>
                      ) : row.fault.origin === 'own' ? (
                        'own'
                      ) : (
                        `from ${row.fault.scenario}`
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Collapsible>
  );
}

/** The Controls panel, naming the configured `idempotency.header`; it reads the configuration only when it must. */
function ConfiguredControlsPanel(props: Omit<Parameters<typeof ControlsPanel>[0], 'idempotencyHeader'>) {
  return props.controls.idempotent ? <IdempotentControlsPanel {...props} /> : <ControlsPanel {...props} />;
}

function IdempotentControlsPanel(props: Omit<Parameters<typeof ControlsPanel>[0], 'idempotencyHeader'>) {
  return <ControlsPanel {...props} idempotencyHeader={useIdempotencyHeader()} />;
}
