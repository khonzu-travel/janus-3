import { useEffect, useState } from 'react';

/**
 * Light and dark themes. `public/theme.js` applies the stored
 * choice before the first paint; this module keeps it applied afterwards and
 * lets the logo switch it. Keep the two in step.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'janus-atlas-theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function writeThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // The choice then lasts for this page only.
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

export function resolveTheme(choice: ThemeChoice): Theme {
  if (choice === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return choice;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * The current choice, a setter that stores and applies it, and the theme on
 * screen, which follows the system while the choice is System.
 */
export function useThemeChoice(): readonly [ThemeChoice, (choice: ThemeChoice) => void, Theme] {
  const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const theme: Theme = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  useEffect(() => {
    if (choice !== 'system' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(DARK_QUERY);
    const follow = (): void => {
      setSystemDark(systemPrefersDark());
    };
    follow();
    query.addEventListener('change', follow);
    return () => {
      query.removeEventListener('change', follow);
    };
  }, [choice]);
  return [
    choice,
    (next: ThemeChoice) => {
      writeThemeChoice(next);
      setChoice(next);
    },
    theme,
  ] as const;
}
