import { useId, useState, type SyntheticEvent } from 'react';

import { AtlasError, type Fixture, type FixtureItem, type RenderInput } from '../../atlas/client.js';
import type { Token, WireRendered } from '../../atlas/wire.js';
import { buttonClass } from '../../components/buttonClass.js';
import { LoadingState } from '../../components/states/LoadingState.js';
import { useRenderedFixture } from '../../hooks/useAtlas.js';
import { BodyView } from '../requests/JsonTree.js';
import { HeadersTable } from './Preview.js';

export type View = 'raw' | 'rendered';

/** Raw / Rendered, as a pair of toggle buttons. */
export function ViewToggle({ view, onChange }: { readonly view: View; readonly onChange: (view: View) => void }) {
  const option = (value: View, label: string) => (
    <button
      type="button"
      aria-pressed={view === value}
      className={`min-h-6 px-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
        view === value ? 'bg-fg text-surface' : 'text-muted hover:bg-hover'
      }`}
      onClick={() => {
        onChange(value);
      }}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Body view" className="inline-flex overflow-hidden rounded border border-line-strong">
      {option('raw', 'Raw')}
      {option('rendered', 'Rendered')}
    </div>
  );
}

const subheadingClass = 'mt-4 mb-1 px-4 text-label font-medium tracking-[0.06em] text-faint uppercase';
const inputClass =
  'rounded border border-line-strong bg-surface px-2 py-0.5 font-mono text-mono focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

const CATEGORY_LABEL: Readonly<Record<Token['category'], string>> = {
  clock: 'Clock',
  request: 'Request value',
  generator: 'Generated',
  context: 'Scenario or sequence',
};

/** Every token, with where it is and what it reads; uniqueness and unresolved values are stated in text. */
export function TokenTable({
  tokens,
  unresolved,
  heading = true,
}: {
  readonly tokens: readonly Token[];
  readonly unresolved: readonly string[];
  /** False inside the Tokens tab, whose label already names it. */
  readonly heading?: boolean;
}) {
  return (
    <>
      {heading ? <h3 className={subheadingClass}>Tokens</h3> : null}
      {/* The enclosing pane scrolls; a nested scroller would need its own focus stop. */}
      <div>
        <table className="stack-table data-table">
          <caption className="sr-only">Tokens</caption>
          <thead>
            <tr>
              <th scope="col">Where</th>
              <th scope="col">Token</th>
              <th scope="col">Kind</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((token, index) => {
              const notes = [
                ...(token.unique ? ['Unique: differs on every request'] : []),
                ...(unresolved.includes(token.expression)
                  ? ['Unresolved: the preview request has no value for it']
                  : []),
              ];
              return (
                // Tokens repeat (e.g. two {{$uuid}}), so position is part of the key.
                <tr key={`${token.pointer}:${String(index)}`}>
                  <td data-label="Where" className="font-mono">
                    {token.location === 'header'
                      ? `header ${token.header ?? ''}`
                      : `body ${token.pointer === '' ? '/' : token.pointer}`}
                  </td>
                  <td data-label="Token" className="font-mono">{`{{$${token.expression}}}`}</td>
                  <td data-label="Kind">{CATEGORY_LABEL[token.category]}</td>
                  <td data-label="Notes">{notes.length === 0 ? '—' : notes.join('; ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * The fixture rendered by the server against an instant and sample path
 * parameters. The UI never evaluates tokens itself.
 */
export function RenderedView({ fixture, item }: { readonly fixture: Fixture; readonly item: FixtureItem }) {
  const [now, setNow] = useState('');
  const [params, setParams] = useState<Readonly<Record<string, string>>>({});
  const [input, setInput] = useState<RenderInput>({ params: {} });
  const rendered = useRenderedFixture(item, input);
  const formId = useId();

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const filled = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== ''));
    setInput({ ...(now.trim() === '' ? {} : { now: now.trim() }), params: filled });
  };

  return (
    <>
      <form aria-labelledby={`${formId}-title`} className="mx-4 mt-3 border-b border-line pb-3" onSubmit={submit}>
        <h3 id={`${formId}-title`} className="font-medium">
          Render inputs
        </h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-[auto_1fr] sm:items-center">
          <label htmlFor={`${formId}-now`} className="text-muted">
            Render at
          </label>
          <input
            id={`${formId}-now`}
            value={now}
            onChange={(event) => {
              setNow(event.target.value);
            }}
            placeholder="2026-01-01T00:00:00Z (empty: the server clock)"
            aria-describedby={`${formId}-now-help`}
            className={inputClass}
          />
          <p id={`${formId}-now-help`} className="text-label text-faint sm:col-start-2">
            RFC 3339 with an offset, like the X-Mock-Now request header.
          </p>
          {fixture.pathParameters.map((name) => (
            <ParameterInput
              key={name}
              id={`${formId}-param-${name}`}
              name={name}
              value={params[name] ?? ''}
              onChange={(value) => {
                setParams((current) => ({ ...current, [name]: value }));
              }}
            />
          ))}
        </div>
        <button type="submit" className={`${buttonClass} mt-3`}>
          Render
        </button>
      </form>
      {rendered.error !== null ? (
        <p role="alert" className="mx-4 mt-3 border-l-2 border-bad bg-bad-soft p-3">
          Could not render:{' '}
          {rendered.error instanceof AtlasError ? rendered.error.message : 'an unexpected error occurred'}.
        </p>
      ) : rendered.data === undefined ? (
        <LoadingState label="Rendering response" />
      ) : (
        <RenderedResult fixture={fixture} rendered={rendered.data.rendered} />
      )}
    </>
  );
}

function ParameterInput({
  id,
  name,
  value,
  onChange,
}: {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <>
      <label htmlFor={id} className="text-muted">
        Path parameter <span className="font-mono">{`{${name}}`}</span>
      </label>
      <input
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={inputClass}
      />
    </>
  );
}

const SOURCE_LABEL: Readonly<Record<NonNullable<WireRendered['clockSource']>, string>> = {
  caller: 'set here',
  'server-default': 'server default',
  'wall-clock': 'live server clock',
};

function RenderedResult({ fixture, rendered }: { readonly fixture: Fixture; readonly rendered: WireRendered }) {
  const bodyTokens = fixture.tokens.filter((token) => token.location === 'body');
  return (
    <div aria-live="polite">
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 px-4">
        <dt className="text-muted">Instant</dt>
        <dd>
          {rendered.instant === null ? (
            'Not used'
          ) : (
            <>
              <span className="font-mono">{rendered.instant}</span>
              {rendered.clockSource === null ? null : ` (${SOURCE_LABEL[rendered.clockSource]})`}
            </>
          )}
        </dd>
        <dt className="text-muted">Seed</dt>
        <dd className="font-mono">{rendered.seed}</dd>
        <dt className="text-muted">Reproducible</dt>
        <dd>
          {rendered.nondeterministic
            ? 'No: a :unique value or the moving server clock changes these bytes'
            : 'Yes: the same inputs give the same bytes'}
        </dd>
      </dl>
      {rendered.error === null ? null : (
        <p role="alert" className="mx-4 mt-3 border-l-2 border-bad bg-bad-soft p-3">
          Rendering failed: {rendered.error}
        </p>
      )}
      {rendered.unresolved.length === 0 ? null : (
        <p className="mx-4 mt-3 border-l-2 border-warn bg-warn-soft p-3">
          Unresolved: the preview request has no value for{' '}
          {rendered.unresolved.map((expression, index) => (
            <span key={expression}>
              {index === 0 ? '' : ', '}
              <code>{`{{$${expression}}}`}</code>
            </span>
          ))}
          ; they render as null, or as empty text inside a string.
        </p>
      )}
      <h3 className={subheadingClass}>Headers</h3>
      <HeadersTable headers={rendered.headers} />
      <h3 className={subheadingClass}>Body</h3>
      <BodyView
        preview={rendered.preview}
        status={fixture.status}
        mediaType={fixture.mediaType}
        marks={rendered.spans.map((span, index) => ({
          span,
          label: `Rendered from ${bodyTokens[index] === undefined ? 'a token' : `{{$${bodyTokens[index].expression}}}`}`,
        }))}
      />
      <TokenTable tokens={fixture.tokens} unresolved={rendered.unresolved} />
    </div>
  );
}
