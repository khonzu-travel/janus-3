import { useId, useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router';

import type { Health, PromotionList } from '../../atlas/client.js';
import type { ReviewState } from '../../atlas/wire.js';
import { linkClass } from '../../components/buttonClass.js';
import { HelpTip } from '../../components/HelpTip.js';
import { filterInputClass, onControl, openableRowClass, pageToolbarClass } from '../../components/listRows.js';
import { EmptyState } from '../../components/states/EmptyState.js';
import { Timestamp } from '../../components/Timestamp.js';
import { ErrorState } from '../../components/states/ErrorState.js';
import { LoadingState } from '../../components/states/LoadingState.js';
import { useClock, usePromotions, useRestart } from '../../hooks/useAtlas.js';
import type { AtlasLayoutContext } from '../../layouts/AtlasLayoutContext.js';
import { withScenario } from '../../scenarios/selection.js';

const selectClass =
  'rounded border border-line-strong bg-surface px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/**
 * `#/promotions`: promoted files, newest first, filtered by
 * review state and by the selected scenario, with the capture each came from
 * and what needs a reviewer's attention. Selecting a response file opens it
 * in endpoint detail, where it can be marked reviewed.
 */
export function PromotionsPage() {
  const { health, scenario } = useOutletContext<AtlasLayoutContext>();
  const restart = useRestart();
  const [allScenarios, setAllScenarios] = useState(!scenario.supported);
  const [review, setReview] = useState<ReviewState | null>('pending');
  const list = usePromotions(health, { review, scenario: allScenarios ? null : scenario.name });
  const reviewId = useId();
  const filterId = useId();
  const [text, setText] = useState('');

  if (!health.capabilities.promotion.available) {
    return (
      <EmptyState title="Promotion is off" headingLevel={2}>
        This server cannot promote captures: promotion needs recording.endpoints and a writable fixture root.
      </EmptyState>
    );
  }

  return (
    <section aria-labelledby="promotions-title" className="min-h-full bg-bg">
      <div className={pageToolbarClass}>
        <div className="flex items-center gap-1">
          <h2 id="promotions-title" className="font-medium">
            Promotions
          </h2>
          <HelpTip label="About promotions">
            <strong className="font-medium text-fg">Promoted files are served.</strong> Each was written from a capture
            into a scenario&rsquo;s fixtures. Review each one, then mark it reviewed in its response detail; a CI job
            can require that with <code className="font-mono text-mono">janus validate --require-reviewed</code>.
          </HelpTip>
        </div>
        {scenario.supported ? (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={allScenarios}
              onChange={(event) => {
                setAllScenarios(event.target.checked);
              }}
            />
            All scenarios
            {allScenarios ? null : (
              <span className="text-faint">
                only <code className="font-mono text-mono">{scenario.name}</code>
              </span>
            )}
          </label>
        ) : null}
        <div className="flex items-center gap-1.5">
          <label htmlFor={reviewId}>Review</label>
          <select
            id={reviewId}
            className={selectClass}
            value={review ?? ''}
            onChange={(event) => {
              setReview(event.target.value === '' ? null : (event.target.value as ReviewState));
            }}
          >
            <option value="pending">Pending</option>
            <option value="reviewed">Reviewed</option>
            <option value="">Any</option>
          </select>
        </div>
        <label htmlFor={filterId} className="sr-only">
          Filter promotions
        </label>
        <input
          id={filterId}
          type="search"
          className={filterInputClass}
          placeholder="Filter promotions"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <p className="ml-auto text-muted">
          Mode <code className="font-mono text-mono text-fg">{health.capabilities.promotion.mode}</code>
        </p>
      </div>
      {list.error !== null ? (
        <ErrorState title="Could not load the promotions" error={list.error} onRetry={restart} />
      ) : list.data === undefined ? (
        <LoadingState label="Loading promotions" />
      ) : list.data.items.length === 0 ? (
        review === 'pending' ? (
          <EmptyState title="Nothing awaits review">Every promoted file has been reviewed.</EmptyState>
        ) : (
          <EmptyState title="No promoted files">Promote a capture from its detail on the Captures page.</EmptyState>
        )
      ) : (
        <PromotionTable list={list.data} health={health} text={text} />
      )}
    </section>
  );
}

type PromotionItem = PromotionList['items'][number];

/** One promotion: the files a capture wrote into a scenario at once, response first. */
interface PromotionGroup {
  readonly key: string;
  readonly scenario: string;
  readonly capture: string;
  readonly promotedAt: string;
  readonly files: readonly PromotionItem[];
}

function grouped(items: readonly PromotionItem[]): PromotionGroup[] {
  const groups = new Map<string, { scenario: string; capture: string; promotedAt: string; files: PromotionItem[] }>();
  for (const item of items) {
    const key = `${item.scenario}\u0000${item.capture}\u0000${item.promotedAt}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { scenario: item.scenario, capture: item.capture, promotedAt: item.promotedAt, files: [item] });
    } else {
      group.files.push(item);
    }
  }
  const headersLast = (item: PromotionItem): number => Number(item.file.endsWith('.headers.json'));
  return [...groups].map(([key, group]) => ({
    key,
    ...group,
    files: [...group.files].sort((a, b) => headersLast(a) - headersLast(b)),
  }));
}

/** The groups whose scenario, capture, files, review or attention contain every word of the filter. */
function matching(groups: readonly PromotionGroup[], text: string): readonly PromotionGroup[] {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return groups;
  return groups.filter((group) => {
    const haystack = [
      group.scenario,
      group.capture,
      group.promotedAt,
      ...group.files.flatMap((file) => [
        file.file,
        file.review === 'pending' ? 'Pending review' : 'Reviewed',
        attentionText(file.attention) ?? 'Nothing flagged',
      ]),
    ]
      .join(' ')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The attention counts of several files, added up. */
function totalAttention(files: readonly PromotionItem[]): PromotionItem['attention'] {
  return files.reduce(
    (sum, file) => ({
      inferred: sum.inferred + file.attention.inferred,
      suggestions: sum.suggestions + file.attention.suggestions,
      refusals: sum.refusals + file.attention.refusals,
      notes: sum.notes + file.attention.notes,
    }),
    { inferred: 0, suggestions: 0, refusals: 0, notes: 0 },
  );
}

function PromotionTable({
  list,
  health,
  text,
}: {
  readonly list: PromotionList;
  readonly health: Health;
  readonly text: string;
}) {
  const navigate = useNavigate();
  const timeZone = useClock().data?.timezone;
  const groups = matching(grouped(list.items), text);
  if (groups.length === 0) return <EmptyState title="Nothing matches">No promotion matches this filter.</EmptyState>;
  const fileLink = (item: PromotionItem) => {
    if (item.fixtureId === null || item.endpointId === null) return null;
    const search = withScenario(new URLSearchParams(), item.scenario, health.configuredDefaultScenario).toString();
    return {
      pathname: `/endpoints/${item.endpointId}/fixtures/${item.fixtureId}`,
      search: search === '' ? '' : `?${search}`,
    };
  };
  return (
    <div className="border-b border-line bg-surface">
      <table className="stack-table data-table">
        <caption className="sr-only">Promotions, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Promoted</th>
            <th scope="col">Scenario</th>
            <th scope="col">Files</th>
            <th scope="col">Capture</th>
            <th scope="col">Review</th>
            <th scope="col">Attention</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const attention = attentionText(totalAttention(group.files));
            // The row, and a header file, open the response the promotion wrote, whose details show its headers.
            const response = group.files.map(fileLink).find((link) => link !== null) ?? null;
            return (
              <tr
                key={group.key}
                className={response === null ? undefined : openableRowClass}
                onClick={(event) => {
                  if (response === null || onControl(event.target)) return;
                  void navigate(response);
                }}
              >
                <td data-label="Promoted" className="font-mono text-mono whitespace-nowrap text-muted">
                  <Timestamp iso={group.promotedAt} timeZone={timeZone} />
                </td>
                <td data-label="Scenario" className="font-mono text-mono">
                  {group.scenario}
                </td>
                <td data-label="Files" className="font-mono text-mono break-all">
                  <ul>
                    {group.files.map((item) => {
                      const link = fileLink(item) ?? response;
                      return (
                        <li key={item.file}>
                          {link === null ? (
                            item.file
                          ) : (
                            <Link to={link} className={linkClass}>
                              {item.file}
                            </Link>
                          )}
                          {item.modified ? (
                            <span className="ml-2 font-sans text-warn">Modified since promoted</span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </td>
                <td data-label="Capture" className="font-mono text-mono">
                  <Link to={`/captures/${group.capture}`} className={linkClass}>
                    {group.capture}
                  </Link>
                </td>
                <td data-label="Review">
                  <ReviewPill review={group.files.some((file) => file.review === 'pending') ? 'pending' : 'reviewed'} />
                </td>
                <td data-label="Attention" className={attention === null ? 'text-faint' : 'text-warn'}>
                  {attention ?? 'Nothing flagged'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "1 inferred ID, 2 suggestions": what a reviewer should look at, or null when nothing is flagged. */
export function attentionText(attention: PromotionList['items'][number]['attention']): string | null {
  const parts = [
    [attention.inferred, 'inferred ID', 'inferred IDs'],
    [attention.suggestions, 'suggestion', 'suggestions'],
    [attention.refusals, 'refusal', 'refusals'],
    [attention.notes, 'note', 'notes'],
  ] as const;
  const text = parts
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${String(count)} ${count === 1 ? one : many}`);
  return text.length === 0 ? null : text.join(', ');
}

/** "Pending review" on `--warn-soft`, "Reviewed" outlined. */
export function ReviewPill({ review }: { readonly review: ReviewState }) {
  return review === 'pending' ? (
    <span className="rounded-[3px] bg-warn-soft px-1.5 text-label font-medium text-warn">Pending review</span>
  ) : (
    <span className="rounded-[3px] border border-line-strong px-1.5 text-label text-muted">Reviewed</span>
  );
}
