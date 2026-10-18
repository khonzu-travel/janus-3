import { AtlasError } from '../../atlas/client.js';
import { useAtlasSession } from '../../hooks/AtlasSession.js';

/** Where the two deployment modes and `cors.origins` are documented. */
export const DEPLOYMENT_DOCS_URL =
  'https://github.com/khonzu-travel/janus-2/blob/main/code/README.md#deploying-the-atlas-ui';

/** The page and the server it talks to, as connection diagnostics need them. */
export interface ConnectionContext {
  /** This page's origin, to copy into `cors.origins`. */
  readonly pageOrigin: string;
  /** True when the Atlas lives on another origin, so the browser applies CORS. */
  readonly crossOrigin: boolean;
}

export function connectionContext(atlasRoot: URL, pageUrl: string): ConnectionContext {
  const pageOrigin = new URL(pageUrl).origin;
  return { pageOrigin, crossOrigin: atlasRoot.origin !== pageOrigin };
}

export function useConnectionContext(): ConnectionContext {
  return connectionContext(useAtlasSession().client.atlasRoot, window.location.href);
}

/**
 * Why a state-changing request (a simulation) failed, when the reason is the
 * page's origin rather than the request. Null for anything else.
 */
export function describeOriginFailure(error: Error | null, connection: ConnectionContext): string | null {
  if (!(error instanceof AtlasError)) return null;
  if (error.kind === 'origin-forbidden') {
    return (
      `This page's origin (${connection.pageOrigin}) is not allowed to change this server. ` +
      "If a reverse proxy serves this page, have it pass the client's Host header through, " +
      'or list the origin in cors.origins.'
    );
  }
  if (error.kind === 'network' && connection.crossOrigin) {
    return (
      'The request failed. The server may be down, or it may no longer list ' +
      `this page's origin (${connection.pageOrigin}) in cors.origins.`
    );
  }
  return null;
}
