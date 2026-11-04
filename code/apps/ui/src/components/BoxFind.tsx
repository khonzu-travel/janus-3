import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { countText, findInputClass, FindToggles, IconButton } from './findBarParts.js';
import { ArrowDownIcon, ArrowUpIcon, CloseIcon } from './icons.js';
import { clearMatches, findInText, paintMatches, type FindSpec } from './textFind.js';

/**
 * The find bar over a read-only body, as in a code editor: Ctrl/⌘ + F opens
 * it with focus or the caret in the body. It searches the text as shown (a
 * JSON tree's collapsed rows are not), following the typing; Enter goes to the
 * next match, Shift + Enter to the previous, and Escape closes it.
 */
export function BoxFind({
  content,
  open,
  onClose,
}: {
  /** The element whose text is searched. */
  readonly content: RefObject<HTMLElement | null>;
  /** A new value each time Ctrl/⌘ + F opens or refocuses the bar, with the text to search for, if any. */
  readonly open: { readonly turn: number; readonly search: string };
  readonly onClose: () => void;
}) {
  const [spec, setSpec] = useState<FindSpec>({
    search: open.search,
    caseSensitive: false,
    wholeWord: false,
    regexp: false,
  });
  const [current, setCurrent] = useState(0);
  // A selection searched for on a later Ctrl/⌘ + F replaces the search.
  const [seen, setSeen] = useState(open);
  if (seen !== open) {
    setSeen(open);
    if (open.search !== '' && open.search !== spec.search) {
      setSpec({ ...spec, search: open.search });
      setCurrent(0);
    }
  }

  // The text changes under the bar: a row opened, Tree switched to Text, a new response.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const element = content.current;
    if (element === null) return;
    const observer = new MutationObserver(() => {
      setVersion((value) => value + 1);
    });
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
    };
  }, [content]);

  const found = useMemo(
    () => (content.current === null ? { valid: true, ranges: [] } : findInText(content.current, spec)),
    // `version` stands for the text under `content`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, spec, version],
  );
  const total = found.ranges.length;
  const at = total === 0 ? 0 : Math.min(current, total - 1);
  const range = found.ranges[at] ?? null;

  useEffect(() => {
    paintMatches(found.ranges, range);
  }, [found, range]);
  useEffect(() => clearMatches, []);
  // Into view on a move or a new search, not when the text merely changes.
  useEffect(() => {
    if (range === null) return;
    const element = range.startContainer.parentElement;
    if (typeof element?.scrollIntoView === 'function') element.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, spec]);

  const field = useRef<HTMLInputElement>(null);
  const before = useRef<Element | null>(null);
  useLayoutEffect(() => {
    before.current ??= document.activeElement;
    field.current?.focus();
    field.current?.select();
  }, [open]);

  const move = (step: 1 | -1): void => {
    if (total > 0) setCurrent((at + step + total) % total);
  };
  const close = (): void => {
    const back = before.current;
    onClose();
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  };
  const change = (next: Partial<FindSpec>): void => {
    setSpec({ ...spec, ...next });
    setCurrent(0);
  };

  return (
    // The bar's keys: Enter, Escape and the find keys; its controls are all buttons and a field.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="search"
      className="flex flex-wrap items-center gap-1"
      onKeyDown={(event) => {
        const mod = event.ctrlKey || event.metaKey;
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        } else if ((event.key === 'Enter' && event.target === field.current) || event.key === 'F3') {
          event.preventDefault();
          move(event.shiftKey ? -1 : 1);
        } else if (mod && !event.altKey && event.key.toLowerCase() === 'g') {
          event.preventDefault();
          move(event.shiftKey ? -1 : 1);
        } else if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          field.current?.focus();
          field.current?.select();
        }
      }}
    >
      <input
        ref={field}
        type="text"
        className={findInputClass}
        aria-label="Find"
        placeholder="Find"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={spec.search !== '' && !found.valid}
        value={spec.search}
        onChange={(event) => {
          change({ search: event.target.value });
        }}
      />
      <FindToggles options={spec} onChange={change} />
      <span className="min-w-20 px-1 text-label whitespace-nowrap text-muted" aria-live="polite">
        {countText(spec.search, found.valid, total, total === 0 ? 0 : at + 1)}
      </span>
      <IconButton
        label="Previous match (Shift + Enter)"
        disabled={total === 0}
        onClick={() => {
          move(-1);
        }}
      >
        <ArrowUpIcon />
      </IconButton>
      <IconButton
        label="Next match (Enter)"
        disabled={total === 0}
        onClick={() => {
          move(1);
        }}
      >
        <ArrowDownIcon />
      </IconButton>
      <IconButton label="Close (Escape)" onClick={close}>
        <CloseIcon />
      </IconButton>
    </div>
  );
}
