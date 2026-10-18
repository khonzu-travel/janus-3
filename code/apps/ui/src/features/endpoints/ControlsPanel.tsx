import { Link } from 'react-router';

import type { Endpoint } from '../../atlas/client.js';
import type { WireControls } from '../../atlas/wire.js';
import { linkClass } from '../../components/buttonClass.js';
import { Collapsible } from '../../components/Collapsible.js';
import { controlSentences, sentenceText, type Sentence } from './controlSentences.js';

const subheadingClass = 'text-label font-medium tracking-[0.06em] text-faint uppercase';
const headClass = 'border border-line bg-bg px-2.5 py-0.5 text-label font-normal text-muted';
const cellClass = 'border border-line px-2.5 py-1';

/**
 * The endpoint's control files as plain sentences, each with
 * the scenario that supplies it. Identities link to their first representation.
 */
export function ControlsPanel({
  endpoint,
  controls,
  search,
  idempotencyHeader = 'Idempotency-Key',
}: {
  readonly endpoint: Endpoint;
  readonly controls: WireControls;
  /** The inventory's part of the hash, kept so identity links stay in the same scenario. */
  readonly search: string;
  /** The configured `idempotency.header`. */
  readonly idempotencyHeader?: string;
}) {
  const sentences = controlSentences(controls, idempotencyHeader);
  const { rules, pages, sequence, expect, idempotent } = sentences;
  if (rules === null && pages === null && sequence === null && expect === null && idempotent === null) return null;

  const render = (sentence: Sentence) =>
    sentence.map((part, index) => {
      switch (part.kind) {
        case 'text':
          return <span key={index}>{part.text}</span>;
        case 'code':
          return (
            <code key={index} className="font-mono text-mono">
              {part.text}
            </code>
          );
        case 'identity': {
          const fixture = endpoint.fixtures.find((entry) => entry.identity === part.identity);
          return fixture === undefined ? (
            <strong key={index} className="font-mono text-mono font-medium">
              {part.identity}
            </strong>
          ) : (
            <Link
              key={index}
              to={`/endpoints/${endpoint.id}/fixtures/${fixture.id}${search}`}
              aria-label={`Response ${part.identity}`}
              className={`${linkClass} font-mono text-mono`}
            >
              {part.identity}
            </Link>
          );
        }
      }
    });

  const from = (file: string, scenario: string) => (
    <p className="text-label text-muted">
      From <code>{file}</code> in scenario {scenario}.
    </p>
  );

  return (
    <Collapsible
      title="Controls"
      framed={false}
      className="border-b border-line px-4 pt-2.5 pb-3"
      detail={<span className="text-faint">what decides which response a request gets, checked in this order</span>}
    >
      <div className="mt-1.5 space-y-3 text-body text-fg">
        {expect === null ? null : (
          <div>
            <h4 className={subheadingClass}>Checks</h4>
            {from('expect.yaml', expect.scenario)}
            <ul aria-label="Checks" className="mt-1 list-disc space-y-0.5 pl-5">
              {expect.items.map((item, index) => (
                <li key={index}>{render(item)}</li>
              ))}
            </ul>
          </div>
        )}
        {rules === null ? null : (
          <div>
            <h4 className={subheadingClass}>Rules</h4>
            {from('variants.yaml', rules.scenario)}
            <ol aria-label="Rules" className="mt-1 list-decimal space-y-0.5 pl-5">
              {rules.items.map((item, index) => (
                <li key={index}>{render(item)}</li>
              ))}
            </ol>
            <p className="mt-1">{render(rules.otherwise)}</p>
          </div>
        )}
        {pages === null ? null : (
          <div>
            <h4 className={subheadingClass}>Pages</h4>
            {from('pages.yaml', pages.scenario)}
            <table className="tabular mt-1 border-collapse text-left">
              <caption className="sr-only">Responses by {sentenceText(pages.by)}</caption>
              <thead>
                <tr>
                  <th scope="col" className={headClass}>
                    {render(pages.by)}
                  </th>
                  <th scope="col" className={headClass}>
                    Response
                  </th>
                </tr>
              </thead>
              <tbody>
                {pages.rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row" className={`${cellClass} bg-bg font-mono text-mono font-normal`}>
                      {row.key}
                    </th>
                    <td className={cellClass}>{render([{ kind: 'identity', identity: row.identity }])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pages.notes.map((note, index) => (
              <p key={index} className="mt-1">
                {render(note)}
              </p>
            ))}
          </div>
        )}
        {sequence === null ? null : (
          <div>
            <h4 className={subheadingClass}>Steps</h4>
            {from('sequence.yaml', sequence.scenario)}
            <ol aria-label="Steps" className="mt-1 list-decimal space-y-0.5 pl-5">
              {sequence.items.map((item, index) => (
                <li key={index}>{render(item)}</li>
              ))}
            </ol>
            <p className="mt-1 text-label text-muted">
              Each session keeps its own position; requests without a session always get the first step.
            </p>
          </div>
        )}
        {idempotent === null ? null : <p>{render(idempotent)}</p>}
      </div>
    </Collapsible>
  );
}
