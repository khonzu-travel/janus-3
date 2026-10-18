import { mediaTypeEssence } from '../http/media-type.js';

/**
 * How a response body is validated and whether tokens in it are evaluated:
 * JSON with whole-value typing, text by interpolation, or
 * binary, which is never inspected.
 */
export type BodyKind = 'json' | 'text' | 'binary';

const TEXT_APPLICATION_TYPES: ReadonlySet<string> = new Set([
  'application/yaml',
  'application/xml',
  'application/x-www-form-urlencoded',
]);

export function bodyKind(mediaType: string): BodyKind {
  const essence = mediaTypeEssence(mediaType);
  const slash = essence.indexOf('/');
  const type = essence.slice(0, slash);
  const subtype = essence.slice(slash + 1);
  if (essence === 'application/json' || subtype.endsWith('+json')) return 'json';
  if (type === 'text' || TEXT_APPLICATION_TYPES.has(essence) || subtype.endsWith('+xml')) return 'text';
  return 'binary';
}
