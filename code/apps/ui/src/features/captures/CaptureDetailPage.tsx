import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useOutletContext, useParams, useSearchParams } from 'react-router';

import type { CaptureDetail, Health, PromotionResult } from '../../atlas/client.js';
import { linkClass, primaryButtonClass } from '../../components/buttonClass.js';
import { AlertIcon } from '../../components/icons.js';
import { MethodBadge } from '../../components/MethodBadge.js';
import { ErrorState } from '../../components/states/ErrorState.js';
import { isNotFound } from '../../components/states/errors.js';
import { LoadingState } from '../../components/states/LoadingState.js';
import { useAtlasSession } from '../../hooks/AtlasSession.js';
import { useCapture, usePromotions, useRefresh, useRestart } from '../../hooks/useAtlas.js';
import type { AtlasLayoutContext } from '../../layouts/AtlasLayoutContext.js';
import { scenarioSearch, withScenario } from '../../scenarios/selection.js';
import { Collapsible } from '../../components/Collapsible.js';
import { HeaderList } from '../fixtures/Preview.js';
import { PromoteDialog } from '../promotions/PromoteDialog.js';
import { ReviewPill } from '../promotions/PromotionsPage.js';
import { BodyView } from '../requests/JsonTree.js';

const NOTE_TEXT: Readonly<Record<string, string>> = {
  'body-encoded': 'The upstream sent an encoded body; it was relayed as sent but not stored.',
  'bodyless-status-body-discarded': 'The upstream sent a body with a bodyless status; it was not stored.',
  'invalid-content-type': 'The upstream’s Content-Type is not a usable media type, so it was not kept.',
};

/**
 * `#/captures/:scenario/:exchange`: one recorded exchange,
 * as captured. The request, the response and the provenance each read on
 * their own, so a missing or edited file affects only its part.
 */
export function CaptureDetailPage() {
  const { scenario = '', exchange = '' } = useParams();
  const [search] = useSearchParams();
  const { client } = useAtlasSession();
  const { health, scenarios } = useOutletContext<AtlasLayoutContext>();
  const restart = useRestart();
  const refresh = useRefresh();
  const id = `${scenario}/${exchange}`;
  const url = client.captureUrl(id);
  const capture = useCapture(url);
  // Kept here, not in the detail, so they survive the refetch a promotion starts.
  const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState<PromotionResult | null>(null);
  const note = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (promoted !== null) note.current?.focus();
  }, [promoted]);
  const back = (
    <Link
      to={{ pathname: '/captures', search: scenarioSearch(search) }}
      className={`${linkClass} mx-4 mt-2 inline-flex min-h-6 items-center`}
    >
      ← All captures
    </Link>
  );

  let body: ReactNode;
  if (url === null || (capture.error !== null && isNotFound(capture.error))) {
    body = (
      <ErrorState
        title="No such capture"
        message={`There is no captured exchange ${id}. It may have failed, or never existed.`}
        headingLevel={2}
      />
    );
  } else if (capture.error !== null) {
    body = <ErrorState title="Could not load the capture" error={capture.error} onRetry={restart} headingLevel={2} />;
  } else if (capture.data === undefined) {
    body = <LoadingState label="Loading capture" />;
  } else {
    body = (
      <Detail
        capture={capture.data}
        health={health}
        onPromote={
          health.capabilities.promotion.available && capture.data.response.state === 'available'
            ? () => {
                setPromoted(null);
                setPromoting(true);
              }
            : null
        }
      />
    );
  }
  return (
    <div className="min-h-full bg-bg pb-4">
      {back}
      {promoted === null ? null : (
        <p
          ref={note}
          tabIndex={-1}
          role="status"
          className="mx-4 mt-3 border-l-2 border-ok bg-surface p-3 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <strong className="font-medium">Promoted</strong> into{' '}
          <code className="font-mono text-mono">{promoted.scenario}</code>:{' '}
          {promoted.files
            .filter((file) => file.role !== 'provenance')
            .map((file) => file.file)
            .join(', ')}
          . It is pending review; open it under Promoted to.
        </p>
      )}
      {body}
      {promoting && capture.data !== undefined ? (
        <PromoteDialog
          capture={capture.data}
          scenarios={scenarios}
          onClose={() => {
            setPromoting(false);
          }}
          onPromoted={(result) => {
            setPromoting(false);
            setPromoted(result);
            // The tree changed: refetch in the background, so every view moves to the new snapshot.
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function Detail({
  capture,
  health,
  onPromote,
}: {
  readonly capture: CaptureDetail;
  readonly health: Health;
  /** Opens the Promote dialog; null when this capture cannot be promoted here. */
  readonly onPromote: (() => void) | null;
}) {
  const { request, response, provenance } = capture;
  const promotions = usePromotions(health, { review: null, scenario: null });
  return (
    <section aria-labelledby="capture-title">
      <div className="flex flex-wrap items-start gap-3 border-b border-line px-4 pt-1 pb-2">
        <div className="min-w-0 flex-1">
          <h2 id="capture-title" className="flex flex-wrap items-baseline gap-2 font-medium">
            {request.state === 'available' ? <MethodBadge method={request.method} /> : null}
            <span className="font-mono break-all">
              {request.state === 'available' ? request.target : `Capture ${capture.id}`}
            </span>
          </h2>
          <p className="text-muted">
            Capture <code className="font-mono text-mono text-fg">{capture.id}</code>
            {capture.source === 'runner' ? (
              <>
                {' '}
                · sent by the request runner
                {capture.requestId === null ? null : (
                  <>
                    {' '}
                    from{' '}
                    <Link
                      className={`${linkClass} underline`}
                      to={`/requests?id=${encodeURIComponent(capture.requestId)}`}
                    >
                      {capture.requestId}
                    </Link>
                  </>
                )}
                {capture.run === null ? null : (
                  <>
                    {' '}
                    in{' '}
                    <Link className={`${linkClass} underline`} to={`/requests/runs/${encodeURIComponent(capture.run)}`}>
                      run {capture.run}
                    </Link>
                  </>
                )}
              </>
            ) : (
              ' · recorded through a registered upstream'
            )}
          </p>
        </div>
        {onPromote === null ? null : (
          <button type="button" className={primaryButtonClass} onClick={onPromote}>
            Promote
          </button>
        )}
      </div>
      {capture.promotedTo.length === 0 ? null : (
        <Part title="Promoted to">
          <table className="data-table">
            <caption className="sr-only">Files promoted from this capture</caption>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th scope="col">Scenario</th>
                <th scope="col">Review</th>
              </tr>
            </thead>
            <tbody>
              {capture.promotedTo.map((file) => {
                const review = promotions.data?.items.find(
                  (item) => item.capture === capture.id && item.scenario === file.scenario && item.file === file.file,
                )?.review;
                return (
                  <tr key={`${file.scenario}:${file.file}`}>
                    <th scope="row" className="font-normal">
                      {file.endpointId === null || file.fixtureId === null ? (
                        <code className="font-mono text-mono break-all">{file.file}</code>
                      ) : (
                        <Link
                          to={{
                            pathname: `/endpoints/${file.endpointId}/fixtures/${file.fixtureId}`,
                            search: linkSearch(file.scenario, health),
                          }}
                          className={`${linkClass} font-mono text-mono break-all`}
                        >
                          {file.file}
                        </Link>
                      )}
                    </th>
                    <td className="font-mono text-mono">{file.scenario}</td>
                    <td>
                      {review === undefined ? (
                        <span className="text-faint">Not reported</span>
                      ) : (
                        <ReviewPill review={review} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Part>
      )}

      <Part title="Request">
        {request.state === 'unreadable' ? (
          <Unreadable file="request.json" />
        ) : (
          <>
            <Facts
              rows={[
                ['Method', request.method],
                ['Target', request.target],
                ['Registration', `${request.registration.method} ${request.registration.path}`],
                ...request.params.map(({ name, value }): [string, string] => [`{${name}}`, value]),
              ]}
            />
            <Sub title="Headers" count={request.headers.length}>
              <HeaderList headers={request.headers} label="Request headers" empty="The request carried no headers." />
            </Sub>
            <Sub title="Body">
              {request.body.state === 'unavailable' ? (
                <p className="px-3 py-1.5 text-muted">The request had no body.</p>
              ) : (
                <BodyView
                  name="Request body"
                  preview={request.body}
                  status={200}
                  mediaType={mediaTypeOf(request.headers)}
                />
              )}
            </Sub>
          </>
        )}
      </Part>

      <Part title="Response">
        {response.state === 'unreadable' ? (
          <Unreadable file="the response files" />
        ) : (
          <>
            {response.modified ? (
              <p
                role="note"
                className="mx-3 my-1.5 flex items-center gap-2 border-l-2 border-warn bg-warn-soft px-3 py-1.5"
              >
                <AlertIcon className="size-4 text-warn" />
                Modified since capture: the response file no longer matches the digest recorded with it.
              </p>
            ) : null}
            <Facts
              rows={[
                ['Status', String(response.status)],
                ['File', response.fileName],
              ]}
            />
            <Sub title="Headers" count={response.headers.length}>
              <HeaderList
                headers={response.headers}
                label="Captured response headers"
                empty="No headers were kept beside the response file."
              />
            </Sub>
            <Sub title="Body">
              <BodyView
                preview={response.body}
                status={response.status}
                mediaType={mediaTypeOf(response.headers) ?? mediaTypeOfFile(response.fileName)}
              />
            </Sub>
          </>
        )}
      </Part>

      <Part title="Provenance">
        {provenance.state === 'unreadable' ? (
          <Unreadable file="the meta file" />
        ) : (
          <>
            <Facts
              rows={[
                ['Captured at', provenance.capturedAt ?? 'Not reported'],
                ['Duration', provenance.durationMs === null ? 'Not reported' : `${String(provenance.durationMs)} ms`],
                [
                  'Registration',
                  provenance.registration === null
                    ? 'Not reported'
                    : `${provenance.registration.method} ${provenance.registration.path}`,
                ],
                ['Upstream', provenance.registration?.upstream ?? 'Not reported'],
                [
                  'Removed headers',
                  provenance.removedHeaders.length === 0 ? 'None' : provenance.removedHeaders.join(', '),
                ],
              ]}
            />
            <Sub title="Notes">
              {provenance.notes.length === 0 ? (
                <p className="px-3 py-1.5 text-muted">The stored response is what the upstream sent.</p>
              ) : (
                <ul className="space-y-1 px-3 py-1.5">
                  {provenance.notes.map((note) => (
                    <li key={note.code}>
                      <code className="font-mono text-mono text-warn">{note.code}</code>
                      <span className="sr-only">: </span>
                      <p className="text-muted">{NOTE_TEXT[note.code] ?? note.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Sub>
          </>
        )}
      </Part>
    </section>
  );
}

function Part({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <Collapsible title={title}>{children}</Collapsible>;
}

function Sub({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly children: ReactNode;
}) {
  return (
    <Collapsible title={title} level={4} {...(count === undefined ? {} : { count })}>
      {children}
    </Collapsible>
  );
}

/** Label and value pairs in one wrapping line. */
function Facts({ rows }: { readonly rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-0.5 px-3 py-1.5">
      {rows.map(([term, value]) => (
        <div key={term} className="flex min-w-0 items-baseline gap-2">
          <dt className="shrink-0 text-muted">{term}</dt>
          <dd className="min-w-0 font-mono text-mono break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Unreadable({ file }: { readonly file: string }) {
  return (
    <p className="flex items-center gap-2 px-3 py-1.5 text-muted">
      <AlertIcon className="size-4 text-bad" />
      Unreadable: {file} is missing or no longer parses.
    </p>
  );
}

function mediaTypeOf(headers: readonly { readonly name: string; readonly value: string }[]): string | null {
  const value = headers.find((header) => header.name.toLowerCase() === 'content-type')?.value;
  return value === undefined ? null : (value.split(';')[0]?.trim() ?? null);
}

/** The short extensions a capture file name uses when the sidecar leaves out a redundant Content-Type. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain',
  html: 'text/html',
  csv: 'text/csv',
};

function mediaTypeOfFile(fileName: string): string | null {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1);
  return fileName.includes('.') ? (EXTENSIONS[extension] ?? null) : null;
}

/** `?scenario=…` selecting the scenario that holds a promoted file, or nothing for the configured default. */
function linkSearch(scenario: string, health: Health): string {
  const search = withScenario(new URLSearchParams(), scenario, health.configuredDefaultScenario).toString();
  return search === '' ? '' : `?${search}`;
}
