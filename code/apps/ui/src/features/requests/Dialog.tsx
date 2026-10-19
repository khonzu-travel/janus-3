import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A modal dialog in the Promote dialog's manner: focus starts inside,
 * Escape closes, Tab stays inside, and focus returns where it was.
 */
export function Dialog({
  title,
  aside,
  onClose,
  children,
  wide = false,
  focus = 'input, select, textarea, button',
}: {
  readonly title: ReactNode;
  readonly aside?: ReactNode;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly wide?: boolean;
  /** The selector for where focus starts: the first match. */
  readonly focus?: string;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLElement>(focus)?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
    // Only where focus starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [
        ...element.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    element.addEventListener('keydown', onKeyDown);
    return () => {
      element.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-fg/40 p-4 max-sm:p-0">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`flex w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} flex-col rounded border border-line bg-bg shadow-lg max-sm:min-h-full max-sm:rounded-none`}
      >
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
          <h2 id={titleId} className="font-medium">
            {title}
          </h2>
          {aside === undefined ? null : <span className="ml-auto text-muted">{aside}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}
