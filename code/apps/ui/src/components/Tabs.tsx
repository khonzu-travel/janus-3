import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabSpec<K extends string> {
  readonly key: K;
  readonly label: string;
  /** A count shown after the label in a fainter tone. */
  readonly count?: number | undefined;
}

/**
 * Text tabs with an accent underline, following the
 * ARIA tabs pattern: arrow keys, Home and End move between tabs, and the
 * panel is labelled by its tab. `extra` sits at the right end of the row.
 */
export function Tabs<K extends string>({
  label,
  tabs,
  selected,
  onSelect,
  extra,
  panelClassName = '',
  children,
}: {
  readonly label: string;
  readonly tabs: readonly TabSpec<K>[];
  readonly selected: K;
  readonly onSelect: (key: K) => void;
  readonly extra?: ReactNode;
  readonly panelClassName?: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = tabs.findIndex((tab) => tab.key === selected);
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null;
    const tab = next === null ? undefined : tabs[next];
    if (tab === undefined) return;
    event.preventDefault();
    onSelect(tab.key);
    listRef.current?.querySelector<HTMLElement>(`[data-tab="${tab.key}"]`)?.focus();
  };
  return (
    <>
      <div className="flex min-h-[34px] flex-wrap items-end gap-x-0.5 border-b border-line px-4">
        <div
          ref={listRef}
          role="tablist"
          aria-label={label}
          className="-mb-px flex min-w-0 max-w-full overflow-x-auto overflow-y-hidden pb-px [scrollbar-width:thin]"
        >
          {tabs.map((tab) => {
            const active = tab.key === selected;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                id={`${id}-${tab.key}`}
                data-tab={tab.key}
                aria-selected={active}
                aria-controls={`${id}-panel`}
                tabIndex={active ? 0 : -1}
                className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-2.5 pt-[7px] pb-1.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                  active ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'
                }`}
                onKeyDown={onKeyDown}
                onClick={() => {
                  onSelect(tab.key);
                }}
              >
                {tab.label}
                {tab.count === undefined ? null : <span className="ml-1 text-label text-faint">{tab.count}</span>}
              </button>
            );
          })}
        </div>
        {extra === undefined ? null : <div className="ml-auto flex items-center gap-2 self-center py-1">{extra}</div>}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${selected}`}
        tabIndex={0}
        className={panelClassName}
      >
        {children}
      </div>
    </>
  );
}
