import { useSyncExternalStore } from 'react';

/** The layouts: `xwide` adds the inspector pane beside the detail pane. */
export type Viewport = 'xwide' | 'wide' | 'medium' | 'narrow';

export const XWIDE_QUERY = '(min-width: 1280px)';
export const WIDE_QUERY = '(min-width: 1024px)';
/** From 769 px the Endpoints list is a foldable pane; below, it is its own view. */
export const MEDIUM_QUERY = '(min-width: 769px)';

function current(): Viewport {
  if (typeof window.matchMedia !== 'function') return 'xwide';
  if (window.matchMedia(XWIDE_QUERY).matches) return 'xwide';
  if (window.matchMedia(WIDE_QUERY).matches) return 'wide';
  return window.matchMedia(MEDIUM_QUERY).matches ? 'medium' : 'narrow';
}

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const queries = [XWIDE_QUERY, WIDE_QUERY, MEDIUM_QUERY].map((query) => window.matchMedia(query));
  for (const query of queries) query.addEventListener('change', onChange);
  return () => {
    for (const query of queries) query.removeEventListener('change', onChange);
  };
}

/** Which layout the viewport calls for; `xwide` where media queries are unavailable. */
export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, current, () => 'xwide');
}
