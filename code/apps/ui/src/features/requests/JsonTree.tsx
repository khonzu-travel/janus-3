import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';

import type { Preview } from '../../atlas/wire.js';
import { iconButtonClass } from '../../components/buttonClass.js';
import { ChevronRightIcon, LineNumbersIcon } from '../../components/icons.js';
import { BodyPreview, type Mark } from '../fixtures/Preview.js';
import { formatBytes } from '../fixtures/format.js';
import { VariableIcon } from './icons.js';
import { useBodyAsText, useLineNumbers } from './storedFlag.js';
import { childPath, variableNameFor } from './variables.js';

/**
 * The response body as a collapsible JSON tree, with "Save as variable" on
 * each value (section 7.4). Only a
 * complete UTF-8 body that parses as a JSON object or array gets the tree;
 * anything else keeps the text preview. A Tree | Text switch shows the raw
 * text.
 */

/** Saves `{{$response.body.<path>}}` under a suggested name. */
export type SaveValue = (name: string, template: string) => void;

type JsonContainer = readonly unknown[] | Readonly<Record<string, unknown>>;

/** The parsed body when it gets the tree, else null. */
export function parseJsonBody(preview: Preview): JsonContainer | null {
  if (preview.state !== 'available' || preview.encoding !== 'utf8' || preview.truncated) return null;
  if (preview.byteLength === 0) return null;
  try {
    const parsed: unknown = JSON.parse(preview.value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as JsonContainer) : null;
  } catch {
    return null;
  }
}

const segmentClass =
  'inline-flex min-h-6 items-center px-2 text-label text-muted hover:bg-hover hover:text-fg aria-pressed:bg-fg aria-pressed:font-medium aria-pressed:text-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

/**
 * A body as Janus shows it everywhere: the tree for a JSON body (Tree or
 * Text), the text preview otherwise, with line numbers that can be turned off.
 */
export function BodyView({
  preview,
  status,
  mediaType,
  onSave,
  marks,
  name,
}: {
  /** What the body is, such as "Request body", for its accessible names. */
  readonly name?: string;
  readonly preview: Preview;
  readonly status: number;
  readonly mediaType: string | null;
  readonly onSave?: SaveValue;
  /** Spans to highlight in the text, which then opens as Text. */
  readonly marks?: readonly Mark[];
}) {
  const json = useMemo(() => parseJsonBody(preview), [preview]);
  // The last choice made anywhere is how a body opens, except that highlighted spans open as Text.
  const [asText, setAsText] = useBodyAsText();
  const [chosen, setView] = useState<'tree' | 'text' | null>(null);
  const view = chosen ?? (asText || (marks !== undefined && marks.length > 0) ? 'text' : 'tree');
  const [lineNumbers, setLineNumbers] = useLineNumbers();
  const text = (
    <BodyPreview
      preview={preview}
      status={status}
      mediaType={mediaType}
      lineNumbers={lineNumbers}
      {...(marks === undefined ? {} : { marks })}
    />
  );
  // Nothing to number in a missing or empty body.
  if (preview.state !== 'available' || preview.byteLength === 0) return text;
  const numbers = (
    <button
      type="button"
      className={`${iconButtonClass} aria-pressed:text-accent`}
      aria-pressed={lineNumbers}
      aria-label="Line numbers"
      title="Line numbers"
      onClick={() => {
        setLineNumbers(!lineNumbers);
      }}
    >
      <LineNumbersIcon className="size-3.5" />
    </button>
  );
  return (
    <div className="relative">
      <div className="absolute top-1.5 right-4 z-10 flex items-center gap-1.5">
        {numbers}
        {json === null ? null : (
          <div
            role="group"
            aria-label="Body format"
            className="inline-flex overflow-hidden rounded border border-line-strong bg-surface"
          >
            {(['tree', 'text'] as const).map((option, index) => (
              <button
                key={option}
                type="button"
                className={`${segmentClass} ${index === 0 ? '' : 'border-l border-line-strong'}`}
                aria-pressed={view === option}
                onClick={() => {
                  setView(option);
                  setAsText(option === 'text');
                }}
              >
                {option === 'tree' ? 'Tree' : 'Text'}
              </button>
            ))}
          </div>
        )}
      </div>
      {json === null || view === 'text' ? (
        text
      ) : (
        <figure>
          <figcaption className="px-4 pt-2 pr-28 text-label text-faint">
            JSON · {formatBytes(preview.byteLength)}
          </figcaption>
          <JsonTree
            value={json}
            lineNumbers={lineNumbers}
            {...(name === undefined ? {} : { name })}
            {...(onSave === undefined ? {} : { onSave })}
          />
        </figure>
      )}
    </div>
  );
}

/** Below the first level, a container with more children than this starts collapsed. */
const LARGE = 50;
/** Containers open by default only while the open rows stay under this, breadth first. */
const ROW_BUDGET = 2000;
/** Every expanded container has a bounded page, including flat roots. */
const PAGE_SIZE = 200;

const isContainer = (value: unknown): value is JsonContainer => typeof value === 'object' && value !== null;

function entriesOf(value: JsonContainer): [string | number, unknown][] {
  return Array.isArray(value)
    ? value.map((item: unknown, index): [number, unknown] => [index, item])
    : Object.entries(value);
}

/**
 * The paths open by default: the top level and the first level, and deeper
 * containers of at most `LARGE` children, breadth first while the rows shown
 * stay within `ROW_BUDGET`. Only open containers are visited.
 */
function defaultOpen(root: JsonContainer): ReadonlySet<string> {
  const open = new Set<string>(['$']);
  let rows = Math.min(PAGE_SIZE, entriesOf(root).length);
  let level: [string, JsonContainer][] = [['$', root]];
  for (let depth = 1; level.length > 0; depth += 1) {
    const next: [string, JsonContainer][] = [];
    for (const [path, value] of level) {
      for (const [key, child] of entriesOf(value)) {
        if (!isContainer(child)) continue;
        const size = entriesOf(child).length;
        if (size === 0 || (depth > 1 && size > LARGE) || rows + Math.min(size, PAGE_SIZE) > ROW_BUDGET) continue;
        const childAt = childPath(path, key);
        open.add(childAt);
        rows += Math.min(size, PAGE_SIZE);
        next.push([childAt, child]);
      }
    }
    level = next;
  }
  return open;
}

/** github-light and github-dark's JSON colours, as the text preview's highlighting uses. */
const COLOURS = {
  key: { '--code-light': '#005cc5', '--code-dark': '#79b8ff' },
  string: { '--code-light': '#032f62', '--code-dark': '#9ecbff' },
  constant: { '--code-light': '#005cc5', '--code-dark': '#79b8ff' },
} as const;

function Token({ kind, children }: { readonly kind: keyof typeof COLOURS; readonly children: ReactNode }) {
  return (
    <span className="code-token" style={COLOURS[kind] as CSSProperties}>
      {children}
    </span>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

interface TreeContext {
  readonly isOpen: (path: string) => boolean;
  readonly setOpen: (path: string, open: boolean) => void;
  readonly onSave?: SaveValue;
  readonly lineNumbers: boolean;
}

const sizes = new WeakMap<object, number>();

/** How many lines the value takes in the JSON text indented by two spaces, as every line number counts. */
function lineCount(value: unknown): number {
  if (!isContainer(value)) return 1;
  const known = sizes.get(value);
  if (known !== undefined) return known;
  const entries = entriesOf(value);
  const size = entries.length === 0 ? 1 : 2 + entries.reduce((sum, [, child]) => sum + lineCount(child), 0);
  sizes.set(value, size);
  return size;
}

/** A row's number in the gutter; out of the text, so it is neither read out nor copied. */
function LineNumber({ line, context }: { readonly line: number; readonly context: TreeContext }) {
  if (!context.lineNumbers) return null;
  return (
    <span
      aria-hidden="true"
      data-line={line}
      className="absolute left-4 w-(--gutter) text-right text-faint select-none before:content-[attr(data-line)]"
    />
  );
}

export function JsonTree({
  value,
  onSave,
  lineNumbers = false,
  name = 'Response body',
}: {
  readonly value: JsonContainer;
  readonly onSave?: SaveValue;
  readonly lineNumbers?: boolean;
  /** What the body is, for its accessible name. */
  readonly name?: string;
}) {
  const defaults = useMemo(() => defaultOpen(value), [value]);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const context: TreeContext = {
    isOpen: (path) => overrides.get(path) ?? defaults.has(path),
    setOpen: (path, open) => {
      setOverrides((previous) => new Map(previous).set(path, open));
    },
    ...(onSave === undefined ? {} : { onSave }),
    lineNumbers,
  };
  const digits = String(lineCount(value)).length;
  return (
    <ul
      aria-label={`${name} (JSON tree)`}
      className="relative overflow-x-auto px-4 py-2 font-mono text-mono leading-6"
      style={
        lineNumbers
          ? ({ '--gutter': `${String(digits)}ch`, paddingLeft: `calc(1.75rem + ${String(digits)}ch)` } as CSSProperties)
          : undefined
      }
    >
      <JsonNode name={null} value={value} path="$" line={1} context={context} />
    </ul>
  );
}

function JsonNode({
  name,
  value,
  path,
  line,
  context,
}: {
  /** The key or index; null at the top. */
  readonly name: string | number | null;
  readonly value: unknown;
  readonly path: string;
  /** Its first line in the indented text. */
  readonly line: number;
  readonly context: TreeContext;
}) {
  const [pagination, setPagination] = useState({ value, page: 0 });
  const page = pagination.value === value ? pagination.page : 0;
  const label =
    name === null ? null : (
      <>
        {typeof name === 'number' ? (
          <span className="text-faint">{name}</span>
        ) : (
          <Token kind="key">{JSON.stringify(name)}</Token>
        )}
        <span className="text-muted">: </span>
      </>
    );
  const save = context.onSave === undefined || path === '$' ? null : <SaveButton path={path} onSave={context.onSave} />;
  if (!isContainer(value)) {
    return (
      <li>
        <div className="group/row flex min-w-0 items-start gap-1 rounded hover:bg-hover">
          <LineNumber line={line} context={context} />
          <span className="w-6 shrink-0" />
          <span className="min-w-0 break-all">
            {label}
            <Leaf value={value} />
          </span>
          {save}
        </div>
      </li>
    );
  }
  const array = Array.isArray(value);
  const entries = entriesOf(value);
  const [opening, closing] = array ? ['[', ']'] : ['{', '}'];
  if (entries.length === 0) {
    return (
      <li>
        <div className="group/row flex min-w-0 items-start gap-1 rounded hover:bg-hover">
          <LineNumber line={line} context={context} />
          <span className="w-6 shrink-0" />
          <span className="min-w-0 break-all">
            {label}
            <span className="text-muted">
              {opening}
              {closing}
            </span>
          </span>
          {save}
        </div>
      </li>
    );
  }
  const open = context.isOpen(path);
  const action = open ? 'Collapse' : 'Expand';
  return (
    <li>
      <div className="group/row flex min-w-0 items-start gap-1 rounded hover:bg-hover">
        <LineNumber line={line} context={context} />
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          aria-expanded={open}
          aria-label={`${action} ${path}`}
          title={`${action} ${path}`}
          onClick={() => {
            context.setOpen(path, !open);
          }}
        >
          <ChevronRightIcon
            className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
          />
        </button>
        <span className="min-w-0 break-all">
          {label}
          {open ? (
            <span className="text-muted">{opening}</span>
          ) : (
            <>
              <span className="text-muted">
                {opening}…{closing}
              </span>{' '}
              <span className="font-sans text-label text-faint">
                {array ? plural(entries.length, 'item', 'items') : plural(entries.length, 'key', 'keys')}
              </span>
            </>
          )}
        </span>
        {save}
      </div>
      {open ? (
        <>
          <ul className="ml-3 border-l border-line pl-3">
            {(() => {
              let next =
                line + 1 + entries.slice(0, page * PAGE_SIZE).reduce((sum, [, child]) => sum + lineCount(child), 0);
              return entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(([key, child]) => {
                const at = next;
                next += lineCount(child);
                return (
                  <JsonNode
                    key={key}
                    name={key}
                    value={child}
                    path={childPath(path, key)}
                    line={at}
                    context={context}
                  />
                );
              });
            })()}
          </ul>
          {entries.length > PAGE_SIZE ? (
            <div className="flex items-center gap-2 pl-7 font-sans text-label text-muted">
              <span>
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, entries.length)} of {entries.length}
              </span>
              <button
                type="button"
                className={iconButtonClass}
                aria-label={`Previous page ${path}`}
                title={`Previous ${String(PAGE_SIZE)}`}
                disabled={page === 0}
                onClick={() => {
                  setPagination({ value, page: page - 1 });
                }}
              >
                ‹
              </button>
              <button
                type="button"
                className={iconButtonClass}
                aria-label={`Next page ${path}`}
                title={`Next ${String(PAGE_SIZE)}`}
                disabled={(page + 1) * PAGE_SIZE >= entries.length}
                onClick={() => {
                  setPagination({ value, page: page + 1 });
                }}
              >
                ›
              </button>
            </div>
          ) : null}
          <div className="pl-7 text-muted">
            <LineNumber line={line + lineCount(value) - 1} context={context} />
            {closing}
          </div>
        </>
      ) : null}
    </li>
  );
}

function Leaf({ value }: { readonly value: unknown }) {
  if (typeof value === 'string') return <Token kind="string">{JSON.stringify(value)}</Token>;
  return <Token kind="constant">{(JSON.stringify(value) as string | undefined) ?? 'null'}</Token>;
}

/** Shown while its row is hovered or holds focus; always reachable with Tab. */
function SaveButton({ path, onSave }: { readonly path: string; readonly onSave: SaveValue }) {
  const label = `Save ${path} as variable`;
  return (
    <button
      type="button"
      className={`${iconButtonClass} ml-auto opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100`}
      aria-label={label}
      title={label}
      onClick={() => {
        onSave(variableNameFor(path), `{{$response.body.${path}}}`);
      }}
    >
      <VariableIcon className="size-3.5" />
    </button>
  );
}
