import { useId } from 'react';
import { Link } from 'react-router';

import { AtlasError } from '../../atlas/client.js';
import { buttonClass } from '../buttonClass.js';
import { AlertIcon } from '../icons.js';
import { panelClass } from './panelClass.js';

export function ErrorState({
  title,
  error,
  message,
  onRetry,
  backTo,
  headingLevel = 3,
}: {
  readonly title: string;
  readonly error?: Error | null;
  readonly message?: string;
  readonly onRetry?: () => void;
  readonly backTo?: string;
  /** 2 when the state stands in for a whole view, so the heading hierarchy has no gap. */
  readonly headingLevel?: 2 | 3;
}) {
  const code = error instanceof AtlasError ? error.details.code : undefined;
  const titleId = useId();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section role="alert" aria-labelledby={titleId} className={`${panelClass} border-bad`}>
      <Heading id={titleId} className="flex items-center gap-2 font-medium text-fg">
        <AlertIcon className="size-4" />
        {title}
      </Heading>
      <p className="mt-1 text-muted">
        {message ?? (error instanceof AtlasError ? `${error.message}.` : 'An unexpected error occurred.')}
      </p>
      {code === undefined ? null : (
        <p className="mt-1 text-muted">
          Code: <code>{code}</code>
        </p>
      )}
      <div className="mt-3 flex gap-2">
        {onRetry === undefined ? null : (
          <button type="button" className={buttonClass} onClick={onRetry}>
            Retry
          </button>
        )}
        {backTo === undefined ? null : (
          <Link to={backTo} className={buttonClass}>
            Back
          </Link>
        )}
      </div>
    </section>
  );
}
