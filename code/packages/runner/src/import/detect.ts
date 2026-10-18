import { BRUNO_MARKERS, BRUNO_YAML_MARKERS } from './bruno-read.js';
import { isPostmanCollection, isPostmanEnvironment, isPostmanV1 } from './postman.js';
import { baseName, decodeUtf8, isRecord, parseJson, record } from './text.js';
import type { ImportFormat, ImportSource } from './types.js';

/**
 * Format detection from content: a file's extension alone
 * decides nothing, except that Charles's `.chls` binary sessions have no
 * readable content to look at.
 */

export const CHARLES_REFUSED =
  'Charles binary (.chls) and XML (.chlsx) sessions are not supported; in Charles choose File › Export Session… › JSON Session File (.chlsj) and import that file';

export type Detection =
  | { readonly kind: 'format'; readonly format: ImportFormat; readonly json: ReadonlyMap<string, unknown> }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

/** True for a Charles transaction: a record with a method and a host or scheme. */
function isCharlesTransaction(value: unknown): boolean {
  const tx = record(value);
  return typeof tx.method === 'string' && (typeof tx.host === 'string' || typeof tx.scheme === 'string');
}

function isCharlesXml(content: string): boolean {
  return content.trimStart().startsWith('<') && /<charles-session[\s>/]/.test(content.slice(0, 4096));
}

/** Classifies sources that are already expanded from any zip. */
export function detect(sources: readonly ImportSource[]): Detection {
  const json = new Map<string, unknown>();
  if (sources.some((source) => BRUNO_YAML_MARKERS.includes(baseName(source.name)))) {
    return { kind: 'format', format: 'bruno-yaml', json };
  }
  if (sources.some((source) => BRUNO_MARKERS.includes(baseName(source.name)) || source.name.endsWith('.bru'))) {
    return { kind: 'format', format: 'bruno', json };
  }
  let found: ImportFormat | null = null;
  for (const source of sources) {
    const content = decodeUtf8(source.bytes);
    if (content === null) {
      if (/\.chls$/i.test(source.name)) return { kind: 'refused', message: CHARLES_REFUSED };
      continue;
    }
    if (isCharlesXml(content)) return { kind: 'refused', message: CHARLES_REFUSED };
    const parsed = parseJson(content);
    if (parsed === undefined) {
      if (/\.chls$/i.test(source.name)) return { kind: 'refused', message: CHARLES_REFUSED };
      continue;
    }
    json.set(source.name, parsed);
    if (isPostmanV1(parsed)) {
      return {
        kind: 'unknown',
        message: `${source.name} is a Postman Collection v1 export; export the collection again as v2.1 and import that`,
      };
    }
    if (isPostmanCollection(parsed)) found = 'postman';
    else if (found === null && isRecord(parsed) && Array.isArray(record(parsed.log).entries)) found = 'har';
    else if (
      found === null &&
      Array.isArray(parsed) &&
      (parsed.some(isCharlesTransaction) || (parsed.length === 0 && /\.chlsj$/i.test(source.name)))
    ) {
      found = 'charles';
    }
  }
  if (found !== null) return { kind: 'format', format: found, json };
  const onlyEnvironments = [...json.values()].length > 0 && [...json.values()].every(isPostmanEnvironment);
  return {
    kind: 'unknown',
    message: onlyEnvironments
      ? 'Postman environment files are imported with their collection; add the collection export'
      : 'the sources are not a recognised export: expected a Postman v2 collection, a Bruno collection, a Charles JSON session (.chlsj) or a HAR file',
  };
}
