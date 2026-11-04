import type { ReactNode } from 'react';

import { iconButtonClass } from './buttonClass.js';
import { filterBoxClass } from './listRows.js';

/**
 * The pieces of a find bar, shared by the code editors' bar and the one over
 * a read-only body: the fields, the option toggles and the match count.
 */

/** Counting stops here, so a huge body with a one-letter search stays quick. */
export const COUNT_LIMIT = 1000;

export function countText(search: string, valid: boolean, total: number, current: number): string {
  if (search === '') return '';
  if (!valid) return 'Invalid regex';
  if (total === 0) return 'No results';
  const all = total >= COUNT_LIMIT ? `${String(COUNT_LIMIT)}+` : String(total);
  return current === 0 ? `${all} found` : `${String(current)} of ${all}`;
}

export const findInputClass = `${filterBoxClass} w-56 min-w-24 flex-1 font-mono text-mono text-fg aria-invalid:border-bad`;

export function Toggle({
  label,
  pressed,
  onToggle,
  children,
}: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onToggle}
      className={`inline-flex size-6 items-center justify-center rounded border font-mono text-label focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
        pressed
          ? 'border-fg bg-fg text-surface'
          : 'border-line-strong bg-surface text-muted hover:bg-hover hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

export function IconButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`${iconButtonClass} disabled:opacity-50 disabled:hover:bg-surface disabled:hover:text-muted`}
    >
      {children}
    </button>
  );
}

/** What a search matches: case, whole words, and whether the text is a regular expression. */
export interface FindOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regexp: boolean;
}

/** The three option toggles, in the code editors' order. */
export function FindToggles({
  options,
  onChange,
}: {
  readonly options: FindOptions;
  readonly onChange: (change: Partial<FindOptions>) => void;
}) {
  return (
    <>
      <Toggle
        label="Match case"
        pressed={options.caseSensitive}
        onToggle={() => {
          onChange({ caseSensitive: !options.caseSensitive });
        }}
      >
        Aa
      </Toggle>
      <Toggle
        label="Match whole word"
        pressed={options.wholeWord}
        onToggle={() => {
          onChange({ wholeWord: !options.wholeWord });
        }}
      >
        <span className="underline decoration-1 underline-offset-2">ab</span>
      </Toggle>
      <Toggle
        label="Use regular expression"
        pressed={options.regexp}
        onToggle={() => {
          onChange({ regexp: !options.regexp });
        }}
      >
        .*
      </Toggle>
    </>
  );
}
