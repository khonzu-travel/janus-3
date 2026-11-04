import { useEffect, useState } from 'react';

import { iconButtonClass } from '../../components/buttonClass.js';
import { CheckIcon } from '../../components/icons.js';
import { CloseIcon, CopyIcon } from './icons.js';

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
        onClick={(event) => {
          const button = event.currentTarget;
          void copyText(text()).then((copied) => {
            setOutcome(copied ? 'copied' : 'failed');
            // The fallback borrows focus; give it back to the button.
            if (document.activeElement !== button) button.focus();
          });
        }}
      >
        {outcome === 'copied' ? (
          <CheckIcon className="size-3.5 text-ok" />
        ) : outcome === 'failed' ? (
          <CloseIcon className="size-3.5 text-bad" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </button>
      <span role="status" className="sr-only">
        {said}
      </span>
    </>
  );
}

/**
 * Puts `text` on the clipboard: through the Clipboard API where the page has
 * it (a secure context, and in the desktop app the permission to write), and
 * otherwise through the older copy command, which also works over plain http.
 */
export async function copyText(text: string): Promise<boolean> {
  if ('clipboard' in navigator) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused: try the copy command.
    }
  }
  return copyCommand(text);
}

function copyCommand(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    // Deprecated, but the only way to copy where the Clipboard API is missing.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
