import { utf8DecodeStrict } from '../bytes.js';
import type { HeaderMap } from '../types/index.js';
import { mediaTypeEssence } from './media-type.js';
import { decodeXmlBody, isXmlMediaType } from './xml.js';

/**
 * The request body as `body.<JSONPath>` references read it: a JSON body parsed, an XML body decoded
 * into its document when
 * `codecs.xml` is on, and nothing for any other body. Values are never logged.
 */
export type BodyDocument = { readonly kind: 'json' | 'xml'; readonly value: unknown } | null;

/** A body that a reference needs and that does not decode: `400 invalid-request`. */
export class InvalidBodyDocument extends Error {}

export function isJsonMediaType(value: string): boolean {
  const essence = mediaTypeEssence(value);
  return essence === 'application/json' || essence.endsWith('+json');
}

/** Reads a non-empty body with one JSON or XML `Content-Type`; null otherwise. Throws `InvalidBodyDocument`. */
export function readBodyDocument(body: Uint8Array | null, headers: HeaderMap, xml: boolean): BodyDocument {
  const contentType = headers['content-type'];
  if (body === null || body.length === 0 || contentType?.length !== 1) return null;
  const type = contentType[0] ?? '';
  if (isJsonMediaType(type)) {
    const text = utf8DecodeStrict(body);
    try {
      if (text === null) throw new SyntaxError('not UTF-8');
      return { kind: 'json', value: JSON.parse(text) as unknown };
    } catch {
      throw new InvalidBodyDocument('the request body is not valid JSON');
    }
  }
  if (xml && isXmlMediaType(type)) {
    const decoded = decodeXmlBody(body, type);
    if (!decoded.ok) throw new InvalidBodyDocument(decoded.reason);
    return { kind: 'xml', value: decoded.document };
  }
  return null;
}
