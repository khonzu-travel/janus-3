import { isAppPage } from './urls.js';

/**
 * Whether a bridge call may proceed: the sender must be a frame
 * of one of the app's own page views, currently showing janus-app://app/.
 */
export function senderAllowed(frameUrl: string | undefined, isAppView: boolean): boolean {
  return isAppView && frameUrl !== undefined && isAppPage(frameUrl);
}

/** `openRecent` and `removeRecent` accept only paths in the recent list. */
export function recentPathArgument(value: unknown, recent: readonly string[]): string | null {
  return typeof value === 'string' && recent.includes(value) ? value : null;
}

/** `openProblemFile` takes an index into the window's own current problems, never a path. */
export function problemIndexArgument(value: unknown, count: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < count ? value : null;
}
