import { useEffect, useId, useRef, useState } from 'react';

import { primaryButtonClass, buttonClass } from '../../components/buttonClass.js';
import { parseCurl, type CurlRequest } from './curl.js';
import { inputClass } from './fields.js';
import { BODY_TEXT } from './RequestEditor.js';

/**
 * The Import dialog's curl source: paste a command, see what it becomes and
 * what was left out, then Open puts it in a new untitled request.
 */
export function CurlImport({
  onClose,
  onOpen,
}: {
  readonly onClose: () => void;
  readonly onOpen: (request: CurlRequest) => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  // Chosen with the curl toggle: the box is where the paste goes.
  useEffect(() => {
    field.current?.focus();
  }, []);
  const result = text.trim() === '' ? null : parseCurl(text);
  const headers = result?.ok === true ? (result.request.headers?.length ?? 0) : 0;
  return (
    <div className="grid gap-4 px-4 py-3">
      <div>
        <label htmlFor={id} className="block text-muted">
          curl command
        </label>
        <textarea
          ref={field}
          id={id}
          rows={8}
          value={text}
          spellCheck={false}
          autoComplete="off"
          placeholder="curl 'https://api.example.com/v1/carts' -H 'accept: application/json'"
          className={`${inputClass} block resize-y`}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <p className="mt-0.5 text-muted">
          Paste a command from your browser’s “Copy as cURL” (bash or cmd), an API tool or a terminal.
        </p>
      </div>
      {result === null ? null : result.ok ? (
        <div className="grid gap-1" aria-live="polite">
          <p>
            <span className="font-mono text-mono">{result.request.method}</span>{' '}
            <span className="font-mono text-mono break-all">{result.request.url}</span>
          </p>
          <p className="text-muted">
            {headers} {headers === 1 ? 'header' : 'headers'}, {BODY_TEXT[result.request.body?.type ?? 'none']}
          </p>
          {result.notes.length === 0 ? null : (
            <ul aria-label="Notes" className="list-disc pl-5 text-warn">
              {result.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="text-bad" aria-live="polite">
          {result.message}.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonClass} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={primaryButtonClass}
          disabled={result?.ok !== true}
          onClick={() => {
            if (result?.ok === true) onOpen(result.request);
          }}
        >
          Open
        </button>
      </div>
    </div>
  );
}
