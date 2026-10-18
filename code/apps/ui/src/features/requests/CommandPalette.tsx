import { useId, useState, type ReactNode } from 'react';

import { Dialog } from './Dialog.js';
import { inputClass } from './fields.js';

export interface Command {
  readonly label: string;
  /** Muted text after the label: a path, or the key that does the same. */
  readonly hint?: string;
  readonly icon?: ReactNode;
  readonly run: () => void;
}

/**
 * Ctrl + K on the Requests tab: finds any action or
 * any request, folder, collection or environment by name. Arrow keys move,
 * Enter runs, Escape closes.
 */
export function CommandPalette({
  commands,
  onClose,
}: {
  readonly commands: readonly Command[];
  readonly onClose: () => void;
}) {
  const listId = useId();
  const [text, setText] = useState('');
  const [at, setAt] = useState(0);
  const query = text.trim().toLowerCase();
  const shown = (
    query === ''
      ? commands
      : commands.filter((command) => `${command.label} ${command.hint ?? ''}`.toLowerCase().includes(query))
  ).slice(0, 50);
  const index = Math.min(at, Math.max(shown.length - 1, 0));
  const run = (command: Command | undefined): void => {
    if (command === undefined) return;
    onClose();
    command.run();
  };
  return (
    <Dialog title="Find an action or a request" aside="Ctrl + K" onClose={onClose}>
      <div className="grid gap-2 px-4 py-3">
        <input
          className={inputClass}
          aria-label="Find"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={shown.length === 0 ? undefined : `${listId}-${String(index)}`}
          placeholder="New request, Import, checkout…"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setAt(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setAt((index + 1) % Math.max(shown.length, 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setAt((index - 1 + shown.length) % Math.max(shown.length, 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              run(shown[index]);
            }
          }}
        />
        {shown.length === 0 ? (
          <p className="text-muted">Nothing matches.</p>
        ) : (
          <ul id={listId} role="listbox" aria-label="Matches" className="max-h-80 overflow-y-auto">
            {shown.map((command, position) => (
              // The input keeps focus and moves the active option; a click runs one too.
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events
              <li
                key={`${command.label} ${command.hint ?? ''}`}
                id={`${listId}-${String(position)}`}
                role="option"
                aria-selected={position === index}
                className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 ${
                  position === index ? 'bg-accent-soft' : 'hover:bg-hover'
                }`}
                onClick={() => {
                  run(command);
                }}
              >
                <span className="w-3.5 shrink-0 text-muted">{command.icon}</span>
                <span className="truncate">{command.label}</span>
                {command.hint === undefined ? null : (
                  <span className="ml-auto truncate font-mono text-mono text-muted">{command.hint}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
