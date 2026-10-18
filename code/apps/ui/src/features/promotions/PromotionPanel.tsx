import { useState } from 'react';
import { Link } from 'react-router';

import { AtlasError, type Fixture } from '../../atlas/client.js';
import type { WireFilePromotion } from '../../atlas/wire.js';
import { linkClass, primaryButtonClass } from '../../components/buttonClass.js';
import { useAtlasSession } from '../../hooks/AtlasSession.js';
import { useRefresh } from '../../hooks/useAtlas.js';
import { ReviewPill } from './PromotionsPage.js';
import { noteSentence, refusalSentence, rewriteSentence, suggestionSentence } from './sentences.js';

/**
 * Fixture detail's promotion panel: the capture the file came
 * from, when, its review state, whether it changed since, and every rewrite,
 * suggestion, refusal and note as a sentence. "Mark reviewed" sends the digest
 * of the content shown, so a file edited meanwhile is refused.
 */
export function PromotionPanel({ fixture }: { readonly fixture: Fixture }) {
  const { client } = useAtlasSession();
  const refresh = useRefresh();
  const [state, setState] = useState<
    { readonly kind: 'idle' | 'sending' } | { readonly kind: 'failed'; message: string }
  >({ kind: 'idle' });
  const response = fixture.promotion;
  const sidecar = fixture.sidecar?.promotion ?? null;
  if (response === null && sidecar === null) return null;

  const pending = [
    ...(response?.review === 'pending' && fixture.digest !== null
      ? [{ file: response.file, digest: fixture.digest }]
      : []),
    ...(sidecar?.review === 'pending' && fixture.sidecar !== null
      ? [{ file: sidecar.file, digest: fixture.sidecar.digest }]
      : []),
  ];
  const markReviewed = async (): Promise<void> => {
    setState({ kind: 'sending' });
    try {
      await client.review({ scenario: fixture.scenario, files: pending });
      refresh();
    } catch (error) {
      setState({ kind: 'failed', message: reviewFailure(error) });
    }
  };

  const main = response ?? sidecar;
  if (main === null) return null;
  return (
    <section aria-labelledby="promotion-title" className="mx-4 mt-2 rounded border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5">
        <h3 id="promotion-title" className="font-medium">
          Promoted
        </h3>
        <ReviewPill review={pending.length > 0 ? 'pending' : 'reviewed'} />
        <span className="text-muted">
          from capture{' '}
          <Link to={`/captures/${main.capture}`} className={`${linkClass} font-mono text-mono`}>
            {main.capture}
          </Link>{' '}
          at <span className="font-mono text-mono">{main.promotedAt}</span>
        </span>
        {pending.length > 0 ? (
          <button
            type="button"
            className={`${primaryButtonClass} ml-auto`}
            disabled={state.kind === 'sending'}
            onClick={() => {
              void markReviewed();
            }}
          >
            {state.kind === 'sending' ? 'Marking reviewed…' : 'Mark reviewed'}
          </button>
        ) : null}
      </div>
      {state.kind === 'failed' ? (
        <p role="alert" className="border-b border-line border-l-2 border-l-bad px-3 py-2 text-bad">
          {state.message}
        </p>
      ) : null}
      <table className="data-table">
        <caption className="sr-only">Promoted files and what a reviewer should know</caption>
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Findings</th>
          </tr>
        </thead>
        <tbody>
          {response === null ? null : <Findings title="Body" promotion={response} />}
          {sidecar === null ? null : <Findings title="Headers" promotion={sidecar} />}
        </tbody>
      </table>
    </section>
  );
}

function Findings({ title, promotion }: { readonly title: string; readonly promotion: WireFilePromotion }) {
  const sentences = [
    ...promotion.rewrites.map((rewrite) => ({
      text: rewriteSentence(rewrite),
      attention: rewrite.tier === 'inferred',
    })),
    ...promotion.suggestions.map((suggestion) => ({ text: suggestionSentence(suggestion), attention: true })),
    ...promotion.refusals.map((refusal) => ({ text: refusalSentence(refusal), attention: true })),
    ...promotion.notes.map((note) => ({ text: noteSentence(note), attention: true })),
  ];
  return (
    <tr>
      <th scope="row" className="font-normal">
        <span className="mr-2 whitespace-nowrap text-muted">{title}</span>
        <code className="font-mono text-mono break-all">{promotion.file}</code>
        {promotion.review === 'reviewed' && promotion.reviewedAt !== null ? (
          <span className="block text-label text-faint">reviewed {promotion.reviewedAt}</span>
        ) : null}
      </th>
      <td>
        {promotion.modified ? (
          <p className="text-warn">
            Modified since it was promoted: the file no longer matches the digest recorded then.
          </p>
        ) : null}
        {sentences.length === 0 ? (
          <p className="text-muted">Written as captured; no ID was rewritten.</p>
        ) : (
          <ul className="space-y-0.5">
            {sentences.map((sentence, index) => (
              <li key={index} className={sentence.attention ? 'text-warn' : undefined}>
                {sentence.text}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

function reviewFailure(error: unknown): string {
  if (error instanceof AtlasError && error.details.status === 409) {
    return 'The file changed since this view loaded. Reload it, check the content again, then mark it reviewed.';
  }
  if (error instanceof AtlasError && error.kind === 'origin-forbidden') return error.message;
  return error instanceof Error
    ? `Could not mark the file reviewed: ${error.message}`
    : 'Could not mark the file reviewed.';
}
