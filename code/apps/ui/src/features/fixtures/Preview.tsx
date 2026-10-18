import type { CSSProperties, ReactNode } from 'react';

import type { Header, Preview, Span } from '../../atlas/wire.js';
import { buttonClass } from '../../components/buttonClass.js';
import { NoBodyIcon } from '../../components/icons.js';
import { formatBytes } from './format.js';
import { highlightLanguage, useHighlightedTokens, type HighlightToken } from './highlight.js';

/** Fixture headers, one row per value, with each header's treatment. */
export function HeadersTable({
  headers,
  caption = 'Response headers',
  empty = 'This response sends no fixture headers.',
}: {
  readonly headers: readonly Header[];
  readonly caption?: string;
  /** What to say when there are none. */
  readonly empty?: string;
}) {
  if (headers.length === 0) return <p className="px-4 py-3 text-muted">{empty}</p>;
  // The enclosing pane scrolls; a nested scroller would need its own focus stop.
  return (
    <div>
      <table className="stack-table data-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {headers.map((header, index) => (
            // Header names repeat (e.g. set-cookie), so position is part of the key.
            <tr key={`${header.name}:${String(index)}`}>
              <td data-label="Name" className="align-top">
                {header.name}
              </td>
              <td data-label="Value" className="break-all">
                {header.value}
                {header.treatment === 'dropped' ? <ComputedByJanus /> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Headers as a tight two-column list, for views that show many at once. */
export function HeaderList({
  headers,
  label,
  empty,
}: {
  readonly headers: readonly { readonly name: string; readonly value: string }[];
  /** The list's accessible name, such as "Request headers". */
  readonly label: string;
  /** What to say when there are none. */
  readonly empty: string;
}) {
  if (headers.length === 0) return <p className="px-3 py-1.5 text-muted">{empty}</p>;
  return (
    <dl aria-label={label} className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 px-3 py-1 font-mono text-mono">
      {headers.map((header, index) => (
        // Header names repeat (e.g. set-cookie), so position is part of the key.
        <div key={`${header.name}:${String(index)}`} className="contents">
          <dt className="py-px text-muted">{header.name}</dt>
          <dd className="py-px break-all">{header.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A fixture header Janus drops and computes itself: stated in text, not colour alone. */
function ComputedByJanus() {
  return (
    <span className="ml-2 inline-block rounded bg-warn-soft px-1.5 font-sans text-label font-medium text-warn">
      Computed by Janus: this value is not sent
    </span>
  );
}

/** Highlights a span of a preview, e.g. a dynamic value. */
export interface Mark {
  readonly span: Span;
  readonly label: string;
}

export function BodyPreview({
  preview,
  status,
  mediaType,
  marks = [],
  lineNumbers = false,
}: {
  readonly preview: Preview;
  readonly status: number;
  readonly mediaType: string | null;
  readonly marks?: readonly Mark[];
  /** Numbers each line of the text in a gutter. */
  readonly lineNumbers?: boolean;
}) {
  if (preview.state === 'unavailable') {
    if (preview.reason === 'render-failed') {
      return <p className="px-4 py-3 text-muted">No body: rendering failed.</p>;
    }
    return (
      <p className="flex items-center gap-2 px-4 py-3 text-muted">
        <NoBodyIcon />
        No body: status {status} is bodyless.
      </p>
    );
  }
  if (preview.byteLength === 0) {
    return <p className="px-4 py-3 text-muted">Empty body (0 bytes).</p>;
  }
  const label = preview.encoding === 'utf8' ? 'Body preview (text)' : 'Body preview (binary, base64)';
  return (
    <figure>
      <figcaption className="px-4 pt-2 text-label text-faint">
        {preview.encoding === 'utf8' ? 'Text' : 'Binary data shown as base64'}
        {preview.truncated
          ? ` · showing the first 64 KiB of ${formatBytes(preview.byteLength)}`
          : ` · ${formatBytes(preview.byteLength)}`}
      </figcaption>
      {preview.encoding === 'utf8' && marks.length > 0 ? (
        lineNumbers ? (
          <NumberedText label={label} lines={markedLines(preview.value, marks)} />
        ) : (
          <PreviewText label={label}>
            <MarkedText value={preview.value} marks={marks} />
          </PreviewText>
        )
      ) : preview.encoding === 'utf8' ? (
        <HighlightedText value={preview.value} label={label} mediaType={mediaType} lineNumbers={lineNumbers} />
      ) : lineNumbers ? (
        <NumberedText label={label} lines={preview.value.split('\n')} />
      ) : (
        <PreviewText label={label}>{preview.value}</PreviewText>
      )}
    </figure>
  );
}

/**
 * Syntax-highlighted when shiki has a grammar for the media type; plain text
 * until it loads, or otherwise. Past the time budget it stays plain and offers
 * a "Highlight" action. Each token carries both themes' colours.
 */
function HighlightedText({
  value,
  label,
  mediaType,
  lineNumbers,
}: {
  readonly value: string;
  readonly label: string;
  readonly mediaType: string | null;
  readonly lineNumbers: boolean;
}) {
  const { tokens, timedOut, highlight } = useHighlightedTokens(value, highlightLanguage(mediaType));
  if (tokens === null) {
    return (
      <>
        {timedOut ? (
          <p className="flex flex-wrap items-center gap-2 px-4 pt-2 text-muted">
            This preview is shown as plain text because highlighting it took too long.
            <button type="button" className={buttonClass} onClick={highlight}>
              Highlight
            </button>
          </p>
        ) : null}
        {lineNumbers ? (
          <NumberedText label={label} lines={value.split('\n')} />
        ) : (
          <PreviewText label={label}>{value}</PreviewText>
        )}
      </>
    );
  }
  if (lineNumbers) {
    return (
      <NumberedText
        label={label}
        lines={tokens.map((line) =>
          line.map((token, tokenIndex) => (
            <span key={tokenIndex} className="code-token" style={tokenStyle(token)}>
              {token.content}
            </span>
          )),
        )}
      />
    );
  }
  return (
    <PreviewText label={label}>
      {tokens.map((line, lineIndex) => (
        // Lines and tokens have no identity beyond their position.
        <span key={lineIndex}>
          {lineIndex === 0 ? null : '\n'}
          {line.map((token, tokenIndex) => (
            <span key={tokenIndex} className="code-token" style={tokenStyle(token)}>
              {token.content}
            </span>
          ))}
        </span>
      ))}
    </PreviewText>
  );
}

/** The colours as custom properties; the stylesheet picks the one for the current theme. */
function tokenStyle(token: HighlightToken): CSSProperties | undefined {
  if (token.light === undefined && token.dark === undefined) return undefined;
  return {
    ...(token.light === undefined ? {} : { '--code-light': token.light }),
    ...(token.dark === undefined ? {} : { '--code-dark': token.dark }),
  } as CSSProperties;
}

/** Text with each mark wrapped in `<mark>`; marks beyond a truncated preview are skipped. */
function MarkedText({ value, marks }: { readonly value: string; readonly marks: readonly Mark[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  const sorted = [...marks].sort((a, b) => a.span.start - b.span.start);
  sorted.forEach((mark, index) => {
    const { start, end } = mark.span;
    if (start < at || end > value.length) return;
    if (start > at) parts.push(value.slice(at, start));
    parts.push(
      <mark
        key={index}
        title={mark.label}
        className="rounded-sm bg-tok-bg px-px text-tok-fg outline outline-1 outline-tok-fg/30"
      >
        {value.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  parts.push(value.slice(at));
  return <>{parts}</>;
}

/** The text split into lines, each mark kept on the lines it covers. */
function markedLines(value: string, marks: readonly Mark[]): ReactNode[][] {
  const lines: ReactNode[][] = [[]];
  const push = (text: string, mark: Mark | null, key: number): void => {
    text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part === '') return;
      lines.at(-1)?.push(
        mark === null ? (
          part
        ) : (
          <mark
            key={`${String(key)}:${String(index)}`}
            title={mark.label}
            className="rounded-sm bg-tok-bg px-px text-tok-fg outline outline-1 outline-tok-fg/30"
          >
            {part}
          </mark>
        ),
      );
    });
  };
  let at = 0;
  [...marks]
    .sort((a, b) => a.span.start - b.span.start)
    .forEach((mark, index) => {
      const { start, end } = mark.span;
      if (start < at || end > value.length) return;
      if (start > at) push(value.slice(at, start), null, index);
      push(value.slice(start, end), mark, index);
      at = end;
    });
  push(value.slice(at), null, -1);
  return lines;
}

/** Text with a gutter of line numbers; the numbers are not read out or selected. */
function NumberedText({ label, lines }: { readonly label: string; readonly lines: readonly ReactNode[] }) {
  return (
    <pre
      tabIndex={0}
      aria-label={label}
      className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 overflow-auto px-4 py-2.5 font-mono text-mono focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
    >
      {lines.map((line, index) => (
        // Lines have no identity beyond their position.
        <span key={index} className="contents">
          <span
            aria-hidden="true"
            data-line={index + 1}
            className="text-right text-faint select-none before:content-[attr(data-line)]"
          />
          <span className="break-all whitespace-pre-wrap">
            {line}
            {index === lines.length - 1 ? null : '\n'}
          </span>
        </span>
      ))}
    </pre>
  );
}

function PreviewText({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    // Text nodes only: fixture HTML is never interpreted. Focusable so it scrolls without a mouse.
    <pre
      tabIndex={0}
      aria-label={label}
      className="overflow-auto whitespace-pre-wrap break-all px-4 py-2.5 font-mono text-mono focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
    >
      {children}
    </pre>
  );
}
