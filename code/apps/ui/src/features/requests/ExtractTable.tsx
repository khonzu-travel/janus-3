import { Fragment, useId, useState } from 'react';

import type { ExtractEntry } from '../../atlas/runner.js';
import { iconButtonClass, removableRowClass, removeIconButtonClass } from '../../components/buttonClass.js';
import { ChevronRightIcon, CollapseAllIcon, ExpandAllIcon, PlusIcon, TrashIcon } from '../../components/icons.js';
import { inputClass, selectClass } from './fields.js';

/**
 * The `extract` list: one collapsible row per variable. A
 * collapsed row shows the name and a summary that wraps under itself; open,
 * it shows the source picker, the path or name, and the `match`, `optional`
 * and `default` options. It reads and writes section 7's short and long forms; a template
 * the picker cannot express is kept as a custom template.
 */

export type ExtractSource =
  | 'response.body'
  | 'response.header'
  | 'response.cookie'
  | 'response.status'
  | 'response.text'
  | 'response.timeMs'
  | 'request.header'
  | 'request.query'
  | 'request.path'
  | 'request.body'
  | 'request.url'
  | 'template';

export const SOURCE_TEXT: Readonly<Record<ExtractSource, string>> = {
  'response.body': 'Response body (JSONPath)',
  'response.header': 'Response header',
  'response.cookie': 'Response cookie',
  'response.status': 'Response status',
  'response.text': 'Response text',
  'response.timeMs': 'Response time',
  'request.header': 'Sent header',
  'request.query': 'Sent query parameter',
  'request.path': 'Sent path parameter',
  'request.body': 'Sent body (JSONPath)',
  'request.url': 'Sent URL',
  template: 'Custom template',
};

/** Sources that take a path or name after the dot. */
const TAKES_ARGUMENT = new Set<ExtractSource>([
  'response.body',
  'response.header',
  'response.cookie',
  'request.header',
  'request.query',
  'request.path',
  'request.body',
]);

export interface ExtractRow {
  readonly name: string;
  readonly source: ExtractSource;
  /** The path, name, or the whole template for `template`. */
  readonly argument: string;
  readonly match: string;
  readonly optional: boolean;
  /** JSON text; empty for none. */
  readonly defaultText: string;
}

const WHOLE = /^\{\{\s*\$(response|request)\.([A-Za-z]+)(?:\.([\s\S]*?))?\s*\}\}$/;

/** A row from an entry: the picker's source when the template is a single exchange token. */
export function rowOf(name: string, entry: ExtractEntry): ExtractRow {
  const value = typeof entry === 'string' ? entry : entry.value;
  const long = typeof entry === 'string' ? null : entry;
  const options = {
    match: long?.match ?? '',
    optional: long?.optional === true || (long !== null && 'default' in long),
    defaultText: long !== null && 'default' in long ? JSON.stringify(long.default) : '',
  };
  const found = WHOLE.exec(value);
  if (found !== null) {
    const source = `${found[1] ?? ''}.${found[2] ?? ''}` as ExtractSource;
    const argument = found[3] ?? '';
    if (source in SOURCE_TEXT && source !== 'template' && TAKES_ARGUMENT.has(source) === (found[3] !== undefined)) {
      return { name, source, argument, ...options };
    }
  }
  return { name, source: 'template', argument: value, ...options };
}

export function templateOf(row: ExtractRow): string {
  if (row.source === 'template') return row.argument;
  return TAKES_ARGUMENT.has(row.source) ? `{{$${row.source}.${row.argument}}}` : `{{$${row.source}}}`;
}

/** Section 7.2's short form when no option is set, the long form otherwise. */
export function entryOf(row: ExtractRow): ExtractEntry {
  const value = templateOf(row);
  if (row.match === '' && !row.optional && row.defaultText === '') return value;
  let fallback: unknown = undefined;
  if (row.defaultText !== '') {
    try {
      fallback = JSON.parse(row.defaultText);
    } catch {
      fallback = row.defaultText;
    }
  }
  return {
    value,
    ...(row.match === '' ? {} : { match: row.match }),
    ...(row.optional && fallback === undefined ? { optional: true } : {}),
    ...(fallback === undefined ? {} : { default: fallback }),
  };
}

function toRecord(rows: readonly ExtractRow[]): Record<string, ExtractEntry> {
  const out: Record<string, ExtractEntry> = {};
  for (const row of rows) if (row.name !== '' && !Object.hasOwn(out, row.name)) out[row.name] = entryOf(row);
  return out;
}

const toRows = (extract: Readonly<Record<string, ExtractEntry>>): ExtractRow[] =>
  Object.entries(extract).map(([name, entry]) => rowOf(name, entry));

/** The source as the collapsed row's summary names it. */
const SOURCE_SHORT: Readonly<Record<ExtractSource, string>> = {
  'response.body': 'body',
  'response.header': 'header',
  'response.cookie': 'cookie',
  'response.status': 'status',
  'response.text': 'text',
  'response.timeMs': 'time',
  'request.header': 'sent header',
  'request.query': 'sent query',
  'request.path': 'sent path',
  'request.body': 'sent body',
  'request.url': 'sent URL',
  template: 'template',
};

/** The collapsed row's summary: where the value comes from, then each option that is set. */
export function summaryOf(row: ExtractRow): string[] {
  const from =
    row.source === 'template' || TAKES_ARGUMENT.has(row.source)
      ? `${SOURCE_SHORT[row.source]} ${row.argument}`
      : SOURCE_SHORT[row.source];
  return [
    from,
    ...(row.match === '' ? [] : [`match ${row.match}`]),
    ...(row.optional && row.defaultText === '' ? ['optional'] : []),
    ...(row.defaultText === '' ? [] : [`default ${row.defaultText}`]),
  ];
}

const blankRow: ExtractRow = {
  name: '',
  source: 'response.body',
  argument: '$.',
  match: '',
  optional: false,
  defaultText: '',
};

export function ExtractTable({
  extract,
  onChange,
}: {
  readonly extract: Readonly<Record<string, ExtractEntry>>;
  readonly onChange: (extract: Record<string, ExtractEntry>) => void;
}) {
  const [rows, setRows] = useState<readonly ExtractRow[]>(() => toRows(extract));
  // The rows showing their fields, by index. A row added here or from the response opens.
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const id = useId();
  if (JSON.stringify(toRecord(rows)) !== JSON.stringify(extract)) {
    const next = toRows(extract);
    const known = new Set(rows.map((row) => row.name));
    setRows(next);
    setOpen(
      new Set([
        ...[...open].filter((at) => at < next.length),
        ...next.flatMap((row, at) => (known.has(row.name) ? [] : [at])),
      ]),
    );
  }
  const update = (next: readonly ExtractRow[]): void => {
    setRows(next);
    onChange(toRecord(next));
  };
  const change = (index: number, patch: Partial<ExtractRow>): void => {
    update(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };
  const toggle = (index: number): void => {
    const next = new Set(open);
    if (!next.delete(index)) next.add(index);
    setOpen(next);
  };
  const remove = (index: number): void => {
    setOpen(new Set([...open].flatMap((at) => (at === index ? [] : [at > index ? at - 1 : at]))));
    update(rows.filter((_row, at) => at !== index));
  };
  const allOpen = rows.length > 0 && rows.every((_row, at) => open.has(at));
  return (
    <div className="@container">
      <div className="mb-2 flex items-center justify-between">
        {rows.length === 0 ? (
          <span />
        ) : (
          <button
            type="button"
            className={iconButtonClass}
            aria-label={allOpen ? 'Collapse all extracts' : 'Expand all extracts'}
            title={allOpen ? 'Collapse all' : 'Expand all'}
            onClick={() => {
              setOpen(allOpen ? new Set() : new Set(rows.map((_row, at) => at)));
            }}
          >
            {allOpen ? <CollapseAllIcon className="size-3.5" /> : <ExpandAllIcon className="size-3.5" />}
          </button>
        )}
        <button
          type="button"
          className={iconButtonClass}
          aria-label="Add extract"
          title="Add extract"
          onClick={() => {
            setRows([...rows, blankRow]);
            setOpen(new Set([...open, rows.length]));
          }}
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted">
          Nothing is extracted. Add a row, or use Save as variable on a value in the response.
        </p>
      ) : (
        <ul aria-label="Extract" className="divide-y divide-line">
          {rows.map((row, index) => {
            const label = row.name === '' ? `row ${String(index + 1)}` : row.name;
            const expanded = open.has(index);
            const fields = `${id}-${String(index)}`;
            return (
              <li key={index} className={removableRowClass}>
                <div className="flex items-start gap-1.5 py-1">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-start gap-1.5 rounded px-0.5 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    aria-expanded={expanded}
                    aria-controls={fields}
                    onClick={() => {
                      toggle(index);
                    }}
                  >
                    <ChevronRightIcon
                      className={`mt-0.5 size-3.5 text-faint transition-transform motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
                    />
                    <span
                      className={`min-w-0 max-w-[50%] font-mono text-mono font-medium [overflow-wrap:anywhere] ${row.name === '' ? 'text-faint' : ''}`}
                    >
                      {row.name === '' ? 'unnamed' : row.name}
                    </span>{' '}
                    <span className="flex min-w-0 flex-1 flex-wrap gap-x-2 gap-y-0.5 font-mono text-mono text-muted">
                      {summaryOf(row).map((part, at) => (
                        <Fragment key={at}>
                          <span
                            className={`min-w-0 [overflow-wrap:anywhere] ${at === 0 ? '' : 'rounded bg-tok-bg px-1 text-tok-fg'}`}
                          >
                            {part}
                          </span>{' '}
                        </Fragment>
                      ))}
                    </span>
                  </button>
                  <button
                    type="button"
                    data-remove
                    className={removeIconButtonClass}
                    aria-label={`Remove ${label}`}
                    title="Remove"
                    onClick={() => {
                      remove(index);
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
                <div id={fields} hidden={!expanded} className="grid gap-2 pb-2 pl-5 @lg:grid-cols-2">
                  <label className="grid gap-0.5 text-label text-muted">
                    Variable
                    <input
                      aria-label={`Variable name, ${label}`}
                      className={inputClass}
                      value={row.name}
                      spellCheck={false}
                      onChange={(event) => {
                        change(index, { name: event.target.value });
                      }}
                    />
                  </label>
                  <label className="grid gap-0.5 text-label text-muted">
                    Source
                    <select
                      aria-label={`Source, ${label}`}
                      className={`${selectClass} text-body text-fg`}
                      value={row.source}
                      onChange={(event) => {
                        const source = event.target.value as ExtractSource;
                        change(index, {
                          source,
                          argument: source === 'template' ? templateOf(row) : source.endsWith('.body') ? '$.' : '',
                        });
                      }}
                    >
                      {(Object.keys(SOURCE_TEXT) as ExtractSource[]).map((source) => (
                        <option key={source} value={source}>
                          {SOURCE_TEXT[source]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {row.source === 'template' || TAKES_ARGUMENT.has(row.source) ? (
                    <label className="grid gap-0.5 text-label text-muted @lg:col-span-2">
                      {row.source === 'template' ? 'Template' : 'Path or name'}
                      <input
                        aria-label={`${row.source === 'template' ? 'Template' : 'Path or name'}, ${label}`}
                        className={inputClass}
                        value={row.argument}
                        spellCheck={false}
                        onChange={(event) => {
                          change(index, { argument: event.target.value });
                        }}
                      />
                    </label>
                  ) : (
                    <p className="self-end text-faint @lg:col-span-2">No path or name needed.</p>
                  )}
                  <label className="grid gap-0.5 text-label text-muted">
                    Match
                    <input
                      aria-label={`Match, ${label}`}
                      className={inputClass}
                      value={row.match}
                      placeholder="regular expression"
                      spellCheck={false}
                      onChange={(event) => {
                        change(index, { match: event.target.value });
                      }}
                    />
                  </label>
                  <label className="grid gap-0.5 text-label text-muted">
                    Default
                    <input
                      aria-label={`Default, ${label}`}
                      className={inputClass}
                      value={row.defaultText}
                      placeholder="JSON value"
                      spellCheck={false}
                      onChange={(event) => {
                        change(index, {
                          defaultText: event.target.value,
                          ...(event.target.value === '' ? {} : { optional: true }),
                        });
                      }}
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-body text-fg @lg:col-span-2">
                    <input
                      type="checkbox"
                      aria-label={`Optional, ${label}`}
                      checked={row.optional}
                      onChange={(event) => {
                        change(index, {
                          optional: event.target.checked,
                          ...(event.target.checked ? {} : { defaultText: '' }),
                        });
                      }}
                    />
                    Optional
                  </label>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
