import type { ReactNode } from 'react';
import { useMatch } from 'react-router';

import type { Endpoint, Fixture, Health, Inventory } from '../../atlas/client.js';
import { ChevronRightIcon } from '../../components/icons.js';
import { useSnapshotFeed } from '../../hooks/SnapshotFeed.js';
import { useClock, useEndpoint, useFixture, useServerTarget } from '../../hooks/useAtlas.js';
import { describeClock } from '../../layouts/ConnectionHeader.js';
import { formatBytes } from '../fixtures/format.js';

/**
 * The inspector pane: collapsible facts about the
 * selected response and endpoint, then the server, its reloads and its
 * startup warnings.
 */
export function Inspector({
  health,
  inventory,
  foldButton,
}: {
  readonly health: Health;
  readonly inventory: Inventory | undefined;
  /** The pane's fold button, at the end of the first section's header row. */
  readonly foldButton?: ReactNode;
}) {
  const match = useMatch({ path: '/endpoints/:endpointId/*', end: false });
  const endpointId = match?.params.endpointId;
  const fixtureId = useMatch('/endpoints/:endpointId/fixtures/:fixtureId')?.params.fixtureId;
  const item = endpointId === undefined ? undefined : inventory?.items.find((entry) => entry.id === endpointId);
  const endpoint = useEndpoint(item);
  const fixtureItem =
    fixtureId === undefined ? undefined : endpoint.data?.fixtures.find((entry) => entry.id === fixtureId);
  const fixture = useFixture(fixtureItem);
  // Each section takes the header's trailing control; only the first gets the fold button.
  const sections: ((trailing: ReactNode) => ReactNode)[] = [];
  const fixtureData = fixture.data;
  if (fixtureData !== undefined)
    sections.push((trailing) => (
      <ResponseSection key="response" fixture={fixtureData} holder={fixtureItem?.holder} trailing={trailing} />
    ));
  const accepts = endpoint.data?.accepts;
  if (accepts !== undefined)
    sections.push((trailing) => <AcceptsSection key="accepts" accepts={accepts} trailing={trailing} />);
  sections.push((trailing) => <ServerSection key="server" health={health} trailing={trailing} />);
  sections.push((trailing) => <ReloadSection key="reloads" health={health} trailing={trailing} />);
  if ((health.warnings ?? []).length > 0)
    sections.push((trailing) => <WarningsSection key="warnings" health={health} trailing={trailing} />);
  return (
    <div className="divide-y divide-line border-b border-line">
      {sections.map((section, index) => section(index === 0 ? foldButton : undefined))}
    </div>
  );
}

export function Section({
  title,
  aside,
  asideClass = 'text-faint',
  open = true,
  trailing,
  children,
}: {
  readonly title: string;
  readonly aside?: ReactNode;
  readonly asideClass?: string;
  readonly open?: boolean;
  /**
   * A control at the right end of the header row, such as the pane's fold
   * button. It sits beside the summary, not in it, so it never toggles the
   * section and is not nested in its disclosure button.
   */
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}) {
  const details = (
    <details open={open} className="group">
      <summary
        className={`flex cursor-pointer list-none items-center gap-1.5 px-3.5 py-2 font-medium hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden ${
          trailing === undefined || trailing === null ? '' : 'pr-10'
        }`}
      >
        <ChevronRightIcon className="size-3 text-faint transition-transform group-open:rotate-90" />
        <span>{title}</span>
        {aside === undefined ? null : <span className={`min-w-0 truncate font-normal ${asideClass}`}>{aside}</span>}
      </summary>
      <div className="px-3.5 pt-0.5 pb-3 pl-8">{children}</div>
    </details>
  );
  if (trailing === undefined || trailing === null) return details;
  return (
    <div className="relative">
      <div className="absolute top-1.5 right-2 z-10 flex">{trailing}</div>
      {details}
    </div>
  );
}

export function Facts({ children }: { readonly children: ReactNode }) {
  return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">{children}</dl>;
}

export function Fact({
  term,
  mono = false,
  children,
}: {
  readonly term: string;
  readonly mono?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <>
      <dt className="text-muted">{term}</dt>
      <dd className={`min-w-0 break-words ${mono ? 'font-mono text-mono' : ''}`}>{children}</dd>
    </>
  );
}

function ResponseSection({
  fixture,
  holder,
  trailing,
}: {
  readonly fixture: Fixture;
  /** The scenario whose file this is, when the server reports it. */
  readonly holder: string | null | undefined;
  readonly trailing: ReactNode;
}) {
  const overridden = fixture.wireContentType !== null && fixture.wireContentType !== fixture.mediaType;
  const sameEssence =
    overridden &&
    (fixture.wireContentType.split(';')[0] ?? '').trim().toLowerCase() === fixture.mediaType?.toLowerCase();
  return (
    <Section title="Response" aside={<span className="font-mono text-label">{fixture.id}</span>} trailing={trailing}>
      <Facts>
        <Fact term="Status" mono>
          {fixture.status}
        </Fact>
        <Fact term="Media type" mono>
          {fixture.mediaType ?? 'None (bodyless)'}
        </Fact>
        {overridden ? (
          <Fact term="Sent Content-Type">
            <span className="font-mono text-mono text-warn">{fixture.wireContentType}</span>{' '}
            <span className="rounded bg-warn-soft px-1.5 text-label text-warn">
              {sameEssence ? 'Parameters added by the header sidecar' : 'Overridden by the header sidecar'}
            </span>
            {sameEssence ? null : (
              <p className="mt-1 text-muted">
                Accept still selects this response as <span className="font-mono">{fixture.mediaType}</span>; the client
                receives <span className="font-mono">{fixture.wireContentType}</span> and an{' '}
                <span className="font-mono">X-Mock-Representation</span> header naming the original.
              </p>
            )}
          </Fact>
        ) : null}
        <Fact term="Locale">{fixture.locale ?? 'Any (neutral)'}</Fact>
        <Fact term="Body size">{formatBytes(fixture.byteLength)}</Fact>
        <Fact term="Response ID" mono>
          {fixture.id}
        </Fact>
        {holder === undefined || holder === null ? null : <Fact term="File held by">scenario {fixture.scenario}</Fact>}
        {fixture.dynamic ? (
          <Fact term="Dynamic values">
            {fixture.tokens.length === 1 ? '1 token' : `${String(fixture.tokens.length)} tokens`}, rendered when served
          </Fact>
        ) : null}
      </Facts>
    </Section>
  );
}

/** `accepts.yaml`, when the server reports it. */
function AcceptsSection({
  accepts,
  trailing,
}: {
  readonly accepts: NonNullable<Endpoint['accepts']> | null;
  readonly trailing: ReactNode;
}) {
  return (
    <Section title="Accepted request bodies" trailing={trailing}>
      {accepts === null ? (
        <p>Any media type</p>
      ) : (
        <>
          <ul aria-label="Accepted request media types" className="flex flex-wrap gap-1">
            {accepts.mediaTypes.map((mediaType) => (
              <li key={mediaType} className="rounded bg-hover px-1.5 font-mono text-mono">
                {mediaType}
              </li>
            ))}
          </ul>
          {accepts.scenario === null ? null : (
            <p className="mt-1 text-muted">
              From <code>accepts.yaml</code> in scenario {accepts.scenario}.
            </p>
          )}
          <p className="mt-1 text-muted">
            {accepts.allowMissingContentType === null ? (
              'A body without Content-Type is refused with 415.'
            ) : (
              <>
                A body without Content-Type is treated as{' '}
                <span className="font-mono">{accepts.allowMissingContentType}</span>.
              </>
            )}
          </p>
        </>
      )}
    </Section>
  );
}

function ServerSection({ health, trailing }: { readonly health: Health; readonly trailing: ReactNode }) {
  const target = useServerTarget();
  const clock = useClock();
  return (
    <Section title="Server" trailing={trailing}>
      <Facts>
        <Fact term="Address" mono>
          {target}
        </Fact>
        <Fact term="Snapshot" mono>
          {health.snapshotVersion}
        </Fact>
        <Fact term="Endpoints">
          {health.fixtureCount} on {health.routeCount} {health.routeCount === 1 ? 'path' : 'paths'}
        </Fact>
        <Fact term="Config" mono>
          {health.configDigest === undefined ? (
            <span className="font-sans">Not reported</span>
          ) : (
            <>
              <span aria-hidden="true" title={health.configDigest}>
                {abbreviate(health.configDigest)}
              </span>
              <span className="sr-only">{health.configDigest}</span>
            </>
          )}
        </Fact>
        <Fact term="Clock">
          {clock.data === undefined ? (clock.error === null ? 'Loading' : 'Not reported') : describeClock(clock.data)}
        </Fact>
        {clock.data === undefined ? null : (
          <Fact term="Seed">
            <span className="font-mono text-mono">{clock.data.seed}</span>{' '}
            <span className="text-muted">({clock.data.seedSource})</span>
          </Fact>
        )}
      </Facts>
    </Section>
  );
}

function abbreviate(digest: string): string {
  return digest.length > 12 ? `${digest.slice(0, 12)}…` : digest;
}

const OUTCOME_TEXT = { swapped: 'Reloaded', unchanged: 'Unchanged', failed: 'Failed' } as const;

function ReloadSection({ health, trailing }: { readonly health: Health; readonly trailing: ReactNode }) {
  const { lastReload } = useSnapshotFeed();
  const last = lastReload ?? health.lastReload;
  return (
    <Section
      title="Reloads"
      aside={health.capabilities.watch ? 'watching' : undefined}
      open={false}
      trailing={trailing}
    >
      {last === null ? (
        <p className="text-muted">No reload since startup.</p>
      ) : (
        <Facts>
          <Fact term="Last">
            <span className={last.outcome === 'failed' ? 'text-bad' : 'text-ok'}>{OUTCOME_TEXT[last.outcome]}</span>
            {last.outcome === 'failed'
              ? `, ${last.errorCount === 1 ? '1 error' : `${String(last.errorCount)} errors`}`
              : null}
          </Fact>
          <Fact term="At" mono>
            <time dateTime={last.finishedAt}>{last.finishedAt}</time>
          </Fact>
        </Facts>
      )}
    </Section>
  );
}

function WarningsSection({ health, trailing }: { readonly health: Health; readonly trailing: ReactNode }) {
  const warnings = health.warnings ?? [];
  return (
    <Section title="Startup warnings" aside={warnings.length} asideClass="text-warn" open={false} trailing={trailing}>
      <ul className="divide-y divide-line">
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${String(index)}`} className="py-1.5 first:pt-0">
            <code className="text-warn">{warning.code}</code>
            <p className="text-muted">{warning.message}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}
