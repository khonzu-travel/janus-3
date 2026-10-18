import { AtlasError } from '../../atlas/client.js';

export function isStale(error: Error | null): boolean {
  return error instanceof AtlasError && error.kind === 'stale';
}

export function isNotFound(error: Error | null): boolean {
  return error instanceof AtlasError && error.kind === 'not-found';
}

/** A server that predates a resource answers with the generic `404 route-not-found`. */
export function isUnsupported(error: Error | null): boolean {
  return (
    error instanceof AtlasError &&
    error.kind === 'http' &&
    error.details.status === 404 &&
    error.details.code === 'route-not-found'
  );
}
