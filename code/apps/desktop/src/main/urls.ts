import { APP_ORIGIN } from '../shared/bridge.js';

/**
 * The address an Atlas window loads: a server listening on an
 * unspecified address is reached on the loopback address of the same family,
 * which the host check accepts; any other URL is used as it is.
 */
export function atlasAddress(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname === '0.0.0.0') parsed.hostname = '127.0.0.1';
  else if (parsed.hostname === '[::]') parsed.hostname = '[::1]';
  return parsed.toString();
}

/** What happens to a URL leaving a window: shown in the system browser, or dropped. */
export type ExternalDecision = 'external' | 'drop';

/** Only `http:` and `https:` URLs ever reach the system browser. */
export function externalDecision(url: string): ExternalDecision {
  const parsed = parse(url);
  return parsed !== null && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? 'external' : 'drop';
}

/**
 * Whether an Atlas window may navigate to `url`: only URLs under
 * its server's `/_janus/ui/`. Anything else is cancelled and, when it is
 * `http:` or `https:`, opened in the system browser.
 */
export function atlasNavigation(url: string, uiUrl: string): 'allow' | ExternalDecision {
  const target = parse(url);
  const ui = parse(uiUrl);
  if (target !== null && ui !== null && target.origin === ui.origin && target.pathname.startsWith(ui.pathname)) {
    return 'allow';
  }
  return externalDecision(url);
}

/** Whether one of the app's own windows may navigate to `url`: only within janus-app://app/. */
export function appNavigation(url: string): 'allow' | ExternalDecision {
  return isAppPage(url) ? 'allow' : externalDecision(url);
}

/** A page of the app's own, on janus-app://app/. */
export function isAppPage(url: string): boolean {
  const parsed = parse(url);
  return parsed !== null && `${parsed.protocol}//${parsed.host}` === APP_ORIGIN;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
