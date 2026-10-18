import { useState } from 'react';

import type { Fixture, FixtureItem } from '../../atlas/client.js';
import { Tabs } from '../../components/Tabs.js';
import { PromotionPanel } from '../promotions/PromotionPanel.js';
import { describeFixture, formatBytes } from './format.js';
import { BodyView } from '../requests/JsonTree.js';
import { HeadersTable } from './Preview.js';
import { RenderedView, TokenTable, ViewToggle, type View } from './RenderedView.js';

type Tab = 'body' | 'headers' | 'tokens';

/**
 * The selected response: Body, Headers and, for a
 * dynamic response, Tokens, with the Raw / Rendered control. Its facts are in
 * the inspector.
 */
export function FixtureDetail({
  fixture,
  item,
  withMediaType = false,
}: {
  readonly fixture: Fixture;
  /** The endpoint's link to this fixture, for rendered previews. */
  readonly item?: FixtureItem;
  /** Name the media type in the heading, because the response has several. */
  readonly withMediaType?: boolean;
}) {
  const [view, setView] = useState<View>('raw');
  const [tab, setTab] = useState<Tab>('body');
  const rendered = fixture.dynamic && item !== undefined && view === 'rendered';
  const tabs = [
    { key: 'body' as const, label: 'Body' },
    { key: 'headers' as const, label: 'Headers', count: fixture.headers.length },
    ...(fixture.dynamic ? [{ key: 'tokens' as const, label: 'Tokens', count: fixture.tokens.length }] : []),
  ];
  const shown = tabs.some((entry) => entry.key === tab) ? tab : 'body';
  return (
    <section aria-labelledby="fixture-title" className="flex min-h-64 flex-1 flex-col">
      <div className="flex flex-wrap items-baseline gap-x-3 px-4 pt-3">
        <h2 id="fixture-title" className="font-medium">
          Response {describeFixture(fixture, withMediaType)}
        </h2>
        <span className="font-mono text-mono text-faint">
          {fixture.mediaType ?? 'no body'} · {formatBytes(fixture.byteLength)}
        </span>
      </div>
      <PromotionPanel fixture={fixture} />
      {rendered ? (
        <>
          <div className="flex justify-end border-b border-line px-4 py-1">
            <ViewToggle view={view} onChange={setView} />
          </div>
          <div className="min-h-0 flex-1 overflow-auto pb-4">
            <RenderedView fixture={fixture} item={item} />
          </div>
        </>
      ) : (
        <Tabs
          label="Response parts"
          tabs={tabs}
          selected={shown}
          onSelect={setTab}
          extra={fixture.dynamic && item !== undefined ? <ViewToggle view={view} onChange={setView} /> : undefined}
          panelClassName="min-h-0 flex-1 overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          {shown === 'body' ? (
            <BodyView
              preview={fixture.preview}
              status={fixture.status}
              mediaType={fixture.mediaType}
              marks={fixture.tokens
                .filter((token) => token.location === 'body')
                .map((token) => ({ span: token.span, label: `Token ${token.expression}` }))}
            />
          ) : shown === 'headers' ? (
            <HeadersTable headers={fixture.headers} />
          ) : (
            <TokenTable tokens={fixture.tokens} unresolved={[]} heading={false} />
          )}
        </Tabs>
      )}
    </section>
  );
}
