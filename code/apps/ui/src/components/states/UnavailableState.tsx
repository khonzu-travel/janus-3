import { useId } from 'react';

import { AtlasError } from '../../atlas/client.js';
import { buttonClass } from '../buttonClass.js';
import { DisconnectedIcon } from '../icons.js';
import { DEPLOYMENT_DOCS_URL, useConnectionContext, type ConnectionContext } from './connection.js';
import { panelClass } from './panelClass.js';

/** Top-level view when the health probe fails: icon, reason, configured target, and retry. */
export function UnavailableState({
  error,
  target,
  onRetry,
}: {
  readonly error: Error;
  readonly target: string;
  readonly onRetry: () => void;
}) {
  const titleId = useId();
  const connection = useConnectionContext();
  const corsHint = connection.crossOrigin && error instanceof AtlasError && error.kind === 'network';
  return (
    <section role="alert" aria-labelledby={titleId} className={`${panelClass} border-bad`}>
      <h2 id={titleId} className="flex items-center gap-2 text-lg font-medium text-fg">
        <DisconnectedIcon className="size-4" />
        Janus is unavailable
      </h2>
      <p className="mt-1 text-muted">{describeUnavailable(error, connection)}</p>
      {corsHint ? (
        <p className="mt-1 text-muted">
          This page's origin is <code className="break-all">{connection.pageOrigin}</code>. Add it to{' '}
          <code>cors.origins</code> in the server's configuration, or{' '}
          <a className="text-accent underline" href={DEPLOYMENT_DOCS_URL}>
            read how to deploy the Atlas UI
          </a>
          .
        </p>
      ) : null}
      <p className="mt-1 text-muted">
        Target: <code className="break-all">{target}</code>
        {error instanceof AtlasError && error.details.code !== undefined ? (
          <>
            {' · '}Code: <code>{error.details.code}</code>
          </>
        ) : null}
      </p>
      <button type="button" className={`${buttonClass} mt-3`} onClick={onRetry}>
        Retry connection
      </button>
    </section>
  );
}

function describeUnavailable(error: Error, connection: ConnectionContext): string {
  if (!(error instanceof AtlasError)) return 'The connection check failed unexpectedly.';
  switch (error.kind) {
    case 'network':
      // A browser reports a CORS refusal exactly like an unreachable server.
      return connection.crossOrigin
        ? "Could not reach the server. It may be down, or it may not list this page's origin in cors.origins."
        : 'The server is unreachable. Check that Janus is running and that the address is right.';
    case 'timeout':
      return `The server did not answer in time. ${error.message}.`;
    case 'not-ready':
      return `The server is not ready. ${error.message}.`;
    case 'incompatible':
      return `The server's Atlas API is not compatible. ${error.message}.`;
    case 'decode':
      return 'The server answered, but not with the Atlas health document. Is the address a Janus server?';
    default:
      return `${error.message}.`;
  }
}
