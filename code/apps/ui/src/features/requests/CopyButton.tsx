import { useEffect, useState } from 'react';

import { iconButtonClass } from '../../components/buttonClass.js';
import { CheckIcon } from '../../components/icons.js';
import { CopyIcon } from './icons.js';

/** How long the button shows that the copy worked, or did not. */
const SHOWN_MS = 1500;

/** "Copy request body" for "Request body"; a name that starts with an acronym, such as JSON, keeps it. */
export function copyLabel(name: string): string {
  return `Copy ${/^[A-Z][a-z]/.test(name) ? `${name.charAt(0).toLowerCase()}${name.slice(1)}` : name}`;
}

/** An icon button that copies `text()` to the clipboard, as it is when pressed. */
export function CopyButton({ label, text }: { readonly label: string; readonly text: () => string }) {
  const [outcome, setOutcome] = useState<'copied' | 'failed' | null>(null);
  useEffect(() => {
    if (outcome === null) return;
    const timer = setTimeout(() => {
      setOutcome(null);
    }, SHOWN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [outcome]);
  const said = outcome === 'copied' ? 'Copied' : outcome === 'failed' ? 'Could not copy' : '';
  return (
    <>
      <button
        type="button"
        className={iconButtonClass}
        aria-label={label}
        title={said === '' ? label : said}
        onClick={() => {
          // The clipboard is there only in a secure context, which loopback is.
          if (!('clipboard' in navigator)) {
            setOutcome('failed');
            return;
          }
          navigator.clipboard.writeText(text()).then(
            () => {
              setOutcome('copied');
            },
            () => {
              setOutcome('failed');
            },
          );
        }}
      >
        {outcome === 'copied' ? <CheckIcon className="size-3.5 text-ok" /> : <CopyIcon className="size-3.5" />}
      </button>
      <span role="status" className="sr-only">
        {said}
      </span>
    </>
  );
}
