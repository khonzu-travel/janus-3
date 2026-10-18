import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import type { JanusAppBridge } from '../shared/bridge.js';
import './pages.css';

declare global {
  interface Window {
    /** The bridge the preload exposes to the app's own pages. */
    readonly janusApp: JanusAppBridge;
  }
}

/** The bridge: the only way these pages reach the app. They make no network requests. */
export const bridge: JanusAppBridge = window.janusApp;

/** Follows the system theme, as the Atlas does before its own switch is used. */
function followSystemTheme(): void {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = (): void => {
    document.documentElement.setAttribute('data-theme', query.matches ? 'dark' : 'light');
  };
  apply();
  query.addEventListener('change', apply);
}

export function mount(page: ReactNode): void {
  followSystemTheme();
  const root = document.getElementById('root');
  if (root === null) throw new Error('missing #root');
  createRoot(root).render(<StrictMode>{page}</StrictMode>);
}
