import { useEffect, useId, useRef, useState } from 'react';

import { buttonClass, iconButtonClass } from '../../components/buttonClass.js';
import { inputClass, selectClass } from './fields.js';
import { useRequestTree } from './hooks.js';
import { EnvironmentIcon, VariableIcon } from './icons.js';
import { pickEnvironment, resetVariables, setVariable, useTabState } from './tabState.js';
import { display } from './variables.js';

/**
 * The Requests tab's two choices that live in the top bar:
 * the environment every collection uses, and the run variables a send
 * carries into the next.
 */

/** The environment picker, flush right in the top bar; hidden while the runner is off or no environment exists. */
export function EnvironmentSelect({ runner }: { readonly runner: boolean }) {
  const id = useId();
  const tree = useRequestTree(runner);
  const { bar } = useTabState();
  const environments = tree.data?.environments ?? [];
  if (!runner || tree.data === undefined) return null;
  const picked = bar.environment;
  // The default environment (else the first) until one is picked or a collection prefers one; "None" is a choice too.
  const selected =
    picked === undefined
      ? ((environments.find((entry) => entry.default === true) ?? environments[0])?.id ?? null)
      : picked !== null && environments.some((entry) => entry.id === picked)
        ? picked
        : null;
  return (
    <div className="flex items-center gap-1.5" title="Environment">
      <EnvironmentIcon className="size-3.5 text-muted" />
      <select
        id={id}
        aria-label="Environment"
        className={selectClass}
        value={selected ?? ''}
        onChange={(event) => {
          pickEnvironment(event.target.value === '' ? null : event.target.value);
        }}
      >
        <option value="">None</option>
        {environments.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.default === true ? `${entry.name} (default)` : entry.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** What an edited value means: text as typed when it was text, else JSON when it parses (else the text). */
function parsed(text: string, was: unknown): unknown {
  if (typeof was === 'string') return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * The carried run variables: a braces icon with the count; its tooltip lists
 * names and values, and clicking opens a popup where any value can be
 * changed. Nothing while none are carried.
 */
export function RunVariablesNote() {
  const { vars } = useTabState();
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const entries = Object.entries(vars);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      ref.current?.querySelector('button')?.focus();
    };
    const onPointer = (event: PointerEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);
  if (entries.length === 0) return null;
  const title = entries.map(([name, value]) => `${name} = ${display(value)}`).join('\n');
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={`${iconButtonClass} relative`}
        aria-label={`Variables, ${String(entries.length)} carried`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={title}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <VariableIcon className="size-3.5" />
        <span
          aria-hidden="true"
          className="absolute -top-1.5 -right-1.5 min-w-3.5 rounded-full bg-accent px-1 text-center font-mono text-[10px] leading-[14px] text-surface"
        >
          {entries.length}
        </span>
      </button>
      {open ? (
        <section
          id={id}
          aria-label="Run variables"
          className="absolute top-full left-0 z-30 mt-1 max-h-[60vh] w-[min(28rem,calc(100vw-2rem))] overflow-auto rounded border border-line-strong bg-surface p-3 shadow-lg"
        >
          <p className="mb-2 text-muted">
            The variables the last sends ended with; they carry into the next send. Edit a value to change it.
          </p>
          <ul className="grid gap-1.5">
            {entries.map(([name, value]) => (
              <li key={name} className="flex items-center gap-2">
                <label htmlFor={`${id}-${name}`} className="w-28 shrink-0 truncate font-mono text-mono" title={name}>
                  {name}
                </label>
                <input
                  id={`${id}-${name}`}
                  className={inputClass}
                  value={display(value)}
                  spellCheck={false}
                  onChange={(event) => {
                    setVariable(name, parsed(event.target.value, value));
                  }}
                />
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                resetVariables();
                setOpen(false);
              }}
            >
              Reset variables
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
