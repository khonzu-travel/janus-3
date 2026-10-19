import type { EditorView } from '@codemirror/view';

import type { EditorLanguage } from './codeMirror.js';
import { useEffect, useId, useLayoutEffect, useRef } from 'react';

import { VariableLine } from './fields.js';
import type { Scopes } from './variables.js';

/**
 * A labelled code editor, JavaScript for the Before and After scripts or
 * JSON or text for a body: line numbers, bracket matching, undo, Tab and
 * Shift + Tab for indenting. Given `scopes`, the variables the text reads show
 * under it, as under any template field.
 * CodeMirror loads with the first one shown.
 */
export function CodeEditor({
  label,
  value,
  onChange,
  describedBy,
  language = 'javascript',
  hideLabel = false,
  scopes = null,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly describedBy?: string;
  readonly language?: EditorLanguage;
  /** The label is for assistive technology only, when a heading beside the editor already says it. */
  readonly hideLabel?: boolean;
  readonly scopes?: Scopes | null;
}) {
  const labelId = useId();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const setValue = useRef<((view: EditorView, value: string) => void) | null>(null);
  const latest = useRef({ value, onChange });
  useLayoutEffect(() => {
    latest.current = { value, onChange };
  });

  useEffect(() => {
    let cancelled = false;
    void import('./codeMirror.js').then(({ createScriptEditor, setScriptValue }) => {
      if (cancelled || host.current === null) return;
      setValue.current = setScriptValue;
      view.current = createScriptEditor(host.current, {
        value: latest.current.value,
        labelledBy: labelId,
        language,
        ...(describedBy === undefined ? {} : { describedBy }),
        onChange: (next) => {
          latest.current.onChange(next);
        },
      });
    });
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = null;
    };
  }, [labelId, describedBy, language]);

  // A change from outside (a reload, a revert); typing already matches, so it is a no-op then.
  useEffect(() => {
    if (view.current !== null && setValue.current !== null) setValue.current(view.current, value);
  }, [value]);

  return (
    <div className="min-w-0">
      <span id={labelId} className={hideLabel ? 'sr-only' : 'block text-muted'}>
        {label}
      </span>
      <div
        ref={host}
        className="min-h-40 overflow-hidden rounded border border-line-strong bg-surface focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent"
      />
      <VariableLine text={value} scopes={scopes} />
    </div>
  );
}
