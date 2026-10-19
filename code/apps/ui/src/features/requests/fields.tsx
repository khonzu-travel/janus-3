import { Fragment, useId, useState, type ClipboardEvent, type ReactNode } from 'react';

import type { NameValue } from '../../atlas/runner.js';
import {
  errorRowClass,
  iconButtonClass,
  linkClass,
  removableRowClass,
  removeIconButtonClass,
} from '../../components/buttonClass.js';
import { ClearListIcon, PlusIcon, TrashIcon } from '../../components/icons.js';
import { resolve, templateParts, type Scopes } from './variables.js';

export const inputClass =
  'w-full min-w-0 rounded border border-line-strong bg-surface px-2 py-0.5 font-mono text-mono focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

export const selectClass =
  'rounded border border-line-strong bg-surface px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/**
 * The variables a template reads, each marked defined or undefined; hovering
 * or focusing one shows its value and the scope it comes from.
 */
export function VariableLine({ text, scopes }: { readonly text: string; readonly scopes: Scopes | null }) {
  if (scopes === null) return null;
  const seen = new Set<string>();
  const names = templateParts(text).flatMap((part) => {
    if (part.kind !== 'variable' || seen.has(part.name)) return [];
    seen.add(part.name);
    return [part.name];
  });
  if (names.length === 0) return null;
  return (
    <ul aria-label="Variables used" className="mt-0.5 flex flex-wrap gap-1">
      {names.map((name) => {
        const found = resolve(name, scopes);
        const extracted = !found.defined && scopes.extracted.includes(name);
        const description = found.defined
          ? `${found.value} (${found.scope})`
          : extracted
            ? 'set by this request’s extract when it runs'
            : 'undefined in every scope';
        return (
          <li key={name}>
            <span
              // Focusable so keyboard users can read the value, as a pointer hover shows it.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              title={description}
              className={`group relative inline-flex items-center rounded px-1 font-mono text-label focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                found.defined || extracted ? 'bg-tok-bg text-tok-fg' : 'bg-bad-soft text-bad'
              }`}
            >
              {`{{${name}}}`}
              <span className="sr-only">: {description}</span>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-[calc(100%+4px)] left-0 z-30 max-w-80 truncate rounded bg-fg px-2 py-0.5 font-sans text-label text-surface opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
              >
                {description}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function TemplateInput({
  label,
  value,
  onChange,
  scopes,
  hideLabel = false,
  placeholder,
  labelEnd,
  onPaste,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly scopes: Scopes | null;
  readonly hideLabel?: boolean;
  readonly placeholder?: string;
  /** Beside the label, flush right; the line is then as tall as an icon button. */
  readonly labelEnd?: ReactNode;
  /** Sees pasted text first; true when it took the paste, so the text is not inserted. */
  readonly onPaste?: (text: string) => boolean;
}) {
  const id = useId();
  const labelElement = (
    <label htmlFor={id} className={hideLabel ? 'sr-only' : 'block text-muted'}>
      {label}
    </label>
  );
  return (
    <div className="min-w-0">
      {labelEnd === undefined ? (
        labelElement
      ) : (
        <div className="mb-0.5 flex min-h-6 items-end justify-between gap-2">
          {labelElement}
          {labelEnd}
        </div>
      )}
      <input
        id={id}
        className={inputClass}
        value={value}
        spellCheck={false}
        autoComplete="off"
        {...(placeholder === undefined ? {} : { placeholder })}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        {...(onPaste === undefined
          ? {}
          : {
              onPaste: (event: ClipboardEvent<HTMLInputElement>) => {
                if (onPaste(event.clipboardData.getData('text/plain'))) event.preventDefault();
              },
            })}
      />
      <VariableLine text={value} scopes={scopes} />
    </div>
  );
}

/** The header that picks a scenario. The UI picks it in the top bar instead, so a request never sends it. */
export const SCENARIO_HEADER = 'X-Mock-Scenario';

export const isScenarioHeader = (name: string): boolean => name.trim().toLowerCase() === SCENARIO_HEADER.toLowerCase();

/**
 * Whether any row is an `X-Mock-Scenario` header, checked or not: each shows
 * as an error until removed, and the request is not sent meanwhile.
 */
export function hasScenarioHeader(rows: readonly { name: string; disabled?: boolean }[]): boolean {
  return rows.some((row) => isScenarioHeader(row.name));
}

/** The error under an `X-Mock-Scenario` row, with the way out: pick its value in the top bar instead. */
export function ScenarioHeaderError({
  id,
  value,
  onUse,
}: {
  readonly id: string;
  readonly value: string;
  readonly onUse: () => void;
}) {
  const name = value.trim();
  return (
    <p id={id} className="text-bad">
      The scenario is not set with a header here.{' '}
      <button type="button" className={`${linkClass} underline`} onClick={onUse}>
        {name === '' ? 'Pick one in the scenario list' : `Pick “${name}” in the scenario list`}
      </button>
    </p>
  );
}

/** Add, and Clear all when named and there are rows, as icon buttons right-aligned above a table. */
export function TableActions({
  addLabel,
  onAdd,
  clearLabel,
  onClear,
}: {
  readonly addLabel?: string | undefined;
  readonly onAdd: () => void;
  readonly clearLabel?: string | undefined;
  /** Absent when there is nothing to clear. */
  readonly onClear?: (() => void) | undefined;
}) {
  const clear = clearLabel !== undefined && onClear !== undefined;
  if (addLabel === undefined && !clear) return null;
  return (
    <div className="mb-1 flex justify-end gap-1">
      {clear ? (
        <button type="button" className={iconButtonClass} aria-label={clearLabel} title={clearLabel} onClick={onClear}>
          <ClearListIcon className="size-3.5" />
        </button>
      ) : null}
      {addLabel === undefined ? null : (
        <button type="button" className={iconButtonClass} aria-label={addLabel} title={addLabel} onClick={onAdd}>
          <PlusIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** A row's Remove button; hovering or focusing it lights its `removableRowClass` row in the danger colour. */
export function RemoveButton({
  label,
  title = 'Remove',
  onClick,
}: {
  readonly label: string;
  readonly title?: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-remove=""
      className={removeIconButtonClass}
      aria-label={label}
      title={title}
      onClick={onClick}
    >
      <TrashIcon className="size-3.5" />
    </button>
  );
}

/** Headers, form fields and the like: name, value and whether the row is sent. */
export function NameValueTable({
  caption,
  rows,
  onChange,
  scopes,
  addLabel,
  clearLabel,
  scenarioHeader,
}: {
  readonly caption: string;
  readonly rows: readonly NameValue[];
  readonly onChange: (rows: NameValue[]) => void;
  readonly scopes: Scopes | null;
  readonly addLabel: string;
  /** Names a Clear all button that removes every row at once; without it there is none. */
  readonly clearLabel?: string;
  /**
   * Headers: an `X-Mock-Scenario` row is an error, never sent, whose link
   * calls `onUse` with its value and index to pick that scenario instead.
   */
  readonly scenarioHeader?: { readonly onUse: (value: string, index: number) => void };
}) {
  const id = useId();
  const change = (index: number, row: NameValue): void => {
    onChange(rows.map((entry, at) => (at === index ? row : entry)));
  };
  return (
    <div>
      <TableActions
        addLabel={addLabel}
        onAdd={() => {
          onChange([...rows, { name: '', value: '' }]);
        }}
        clearLabel={clearLabel}
        onClear={
          rows.length === 0
            ? undefined
            : () => {
                onChange([]);
              }
        }
      />
      {rows.length === 0 ? null : (
        <table className="data-table w-full">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className="w-8">
                <span className="sr-only">Sent</span>
              </th>
              <th scope="col">Name</th>
              <th scope="col">Value</th>
              <th scope="col" className="w-8">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const refused = scenarioHeader !== undefined && isScenarioHeader(row.name);
              const errorId = `${id}-scenario-${String(index)}`;
              return (
                // Rows have no identity of their own; names repeat and change while typed.
                <Fragment key={index}>
                  <tr className={refused ? errorRowClass : removableRowClass}>
                    <td className="align-top">
                      <input
                        type="checkbox"
                        aria-label={`Send ${row.name === '' ? `row ${String(index + 1)}` : row.name}`}
                        checked={!refused && row.disabled !== true}
                        disabled={refused}
                        onChange={(event) => {
                          const { disabled: _disabled, ...rest } = row;
                          change(index, event.target.checked ? rest : { ...rest, disabled: true });
                        }}
                      />
                    </td>
                    <td className="align-top">
                      <input
                        aria-label={`${caption} name ${String(index + 1)}`}
                        className={inputClass}
                        value={row.name}
                        spellCheck={false}
                        {...(refused ? { 'aria-invalid': true, 'aria-describedby': errorId } : {})}
                        onChange={(event) => {
                          change(index, { ...row, name: event.target.value });
                        }}
                      />
                    </td>
                    <td className="align-top">
                      <TemplateInput
                        label={`${caption} value ${String(index + 1)}`}
                        hideLabel
                        value={row.value}
                        scopes={scopes}
                        onChange={(value) => {
                          change(index, { ...row, value });
                        }}
                      />
                    </td>
                    <td className="align-top">
                      <RemoveButton
                        label={`Remove ${row.name === '' ? `row ${String(index + 1)}` : row.name}`}
                        onClick={() => {
                          onChange(rows.filter((_row, at) => at !== index));
                        }}
                      />
                    </td>
                  </tr>
                  {refused ? (
                    <tr className="bg-bad-soft">
                      <td />
                      <td colSpan={3}>
                        <ScenarioHeaderError
                          id={errorId}
                          value={row.value}
                          onUse={() => {
                            scenarioHeader.onUse(row.value.trim(), index);
                          }}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface MapRow {
  readonly name: string;
  readonly value: string;
}

const toRows = (entries: Readonly<Record<string, string>>): MapRow[] =>
  Object.entries(entries).map(([name, value]) => ({ name, value }));

const fromRows = (rows: readonly MapRow[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const row of rows) if (row.name !== '' && !Object.hasOwn(out, row.name)) out[row.name] = row.value;
  return out;
};

const sameRecord = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean =>
  JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));

/** Variables and path parameters: a name and a template per row. Rows with no name are kept while typed. */
export function MapTable({
  caption,
  entries,
  onChange,
  scopes,
  addLabel,
  clearLabel,
  fixedNames = false,
  extra,
}: {
  readonly caption: string;
  readonly entries: Readonly<Record<string, string>>;
  readonly onChange: (entries: Record<string, string>) => void;
  readonly scopes: Scopes | null;
  readonly addLabel?: string;
  /** Names a Clear all button that removes every row at once; without it, or with fixed names, there is none. */
  readonly clearLabel?: string;
  /** Path parameters: names come from the URL. */
  readonly fixedNames?: boolean;
  /** Something to add to each row, after the value. */
  readonly extra?: (name: string) => ReactNode;
}) {
  const [rows, setRows] = useState<readonly MapRow[]>(() => toRows(entries));
  if (!sameRecord(fromRows(rows), entries)) setRows(toRows(entries));
  const update = (next: readonly MapRow[]): void => {
    setRows(next);
    onChange(fromRows(next));
  };
  return (
    <div>
      {fixedNames ? null : (
        <TableActions
          addLabel={addLabel}
          onAdd={() => {
            setRows([...rows, { name: '', value: '' }]);
          }}
          clearLabel={clearLabel}
          onClear={
            rows.length === 0
              ? undefined
              : () => {
                  update([]);
                }
          }
        />
      )}
      {rows.length === 0 ? null : (
        <table className="data-table w-full">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Value</th>
              {fixedNames ? null : (
                <th scope="col" className="w-8">
                  <span className="sr-only">Remove</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className={fixedNames ? undefined : removableRowClass}>
                <td className="align-top">
                  {fixedNames ? (
                    <code className="font-mono text-mono">{row.name}</code>
                  ) : (
                    <input
                      aria-label={`${caption} name ${String(index + 1)}`}
                      className={inputClass}
                      value={row.name}
                      spellCheck={false}
                      onChange={(event) => {
                        update(
                          rows.map((entry, at) => (at === index ? { ...entry, name: event.target.value } : entry)),
                        );
                      }}
                    />
                  )}
                </td>
                <td className="align-top">
                  <TemplateInput
                    label={fixedNames ? row.name : `${caption} value ${String(index + 1)}`}
                    hideLabel
                    value={row.value}
                    scopes={scopes}
                    onChange={(value) => {
                      update(rows.map((entry, at) => (at === index ? { ...entry, value } : entry)));
                    }}
                  />
                  {extra?.(row.name)}
                </td>
                {fixedNames ? null : (
                  <td className="align-top">
                    <RemoveButton
                      label={`Remove ${row.name === '' ? `row ${String(index + 1)}` : row.name}`}
                      onClick={() => {
                        update(rows.filter((_row, at) => at !== index));
                      }}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** A labelled text area for plain text: docs, bodies. */
export function TextArea({
  label,
  value,
  onChange,
  rows = 6,
  scopes = null,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly rows?: number;
  readonly scopes?: Scopes | null;
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-muted">
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        spellCheck={false}
        className={`${inputClass} block resize-y`}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <VariableLine text={value} scopes={scopes} />
    </div>
  );
}
