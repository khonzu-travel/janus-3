import { useSyncExternalStore } from 'react';

/**
 * A yes/no choice remembered per browser and shared by every view showing
 * it, so all open editors change together. Without storage it lasts for the
 * page only.
 */
const resets: (() => void)[] = [];

/** Forgets every choice, as a new browser would have it; for tests. */
export function resetStoredFlags(): void {
  for (const reset of resets) reset();
}

export function storedFlag(key: string, initial: boolean): () => readonly [boolean, (on: boolean) => void] {
  let value: boolean | null = null;
  const listeners = new Set<() => void>();
  resets.push(() => {
    value = null;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Nothing stored.
    }
  });
  const read = (): boolean => {
    if (value === null) {
      try {
        const stored = window.localStorage.getItem(key);
        value = stored === null ? initial : stored === '1';
      } catch {
        value = initial;
      }
    }
    return value;
  };
  const set = (on: boolean): void => {
    value = on;
    try {
      window.localStorage.setItem(key, on ? '1' : '0');
    } catch {
      // Kept for this page only.
    }
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return () => [useSyncExternalStore(subscribe, read, () => initial), set] as const;
}

/** The response shows in the right pane, beside its explanation, instead of under the request. */
export const useResponseBeside = storedFlag('janus-requests-response-beside', false);

/** The scripting help under the Before and After scripts is shown. */
export const useScriptHelp = storedFlag('janus-requests-script-help', true);

/** Body views number their lines. */
export const useLineNumbers = storedFlag('janus-body-line-numbers', true);

/** JSON bodies open as Text rather than as the tree. */
export const useBodyAsText = storedFlag('janus-body-as-text', false);
