import { XMLValidator } from 'fast-xml-parser';

import { utf8DecodeStrict } from '../bytes.js';
import { mediaTypeEssence, parseMediaType } from './media-type.js';

/**
 * XML request bodies. A small scanner of our own builds the
 * document so that text, repeats and the limits are exact and
 * enforced while scanning; fast-xml-parser's validator then confirms the
 * body is well-formed.
 */

export const MAX_XML_DEPTH = 64;
/** Elements and attributes (namespace declarations included) in total. */
export const MAX_XML_NODES = 10_000;

/** True for application/xml, text/xml and any +xml type (essence compared case-insensitively). */
export function isXmlMediaType(value: string): boolean {
  const essence = mediaTypeEssence(value);
  if (essence === 'application/xml' || essence === 'text/xml') return true;
  const slash = essence.indexOf('/');
  return slash > 0 && essence.endsWith('+xml') && essence.length - slash - 1 > '+xml'.length;
}

export type XmlValue = string | XmlElement;
export interface XmlElement {
  readonly [name: string]: XmlValue | readonly XmlValue[];
}

export type XmlDecodeResult =
  | { readonly ok: true; readonly document: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string };

/** Decodes an XML request body into the document, under the limits. contentType is the single Content-Type value. */
export function decodeXmlBody(body: Uint8Array, contentType: string): XmlDecodeResult {
  const charset = parseMediaType(contentType)?.parameters.find(([name]) => name === 'charset');
  if (charset !== undefined && charset[1].toLowerCase() !== 'utf-8') return fail(REASONS.charset);
  const decoded = utf8DecodeStrict(body);
  if (decoded === null) return fail(REASONS.utf8);
  // XML 1.0 §2.11: every line break reaches the application as "\n".
  const text = decoded.replace(/\r\n?/g, '\n');
  if (INVALID_CHAR.test(text)) return fail(REASONS.char);
  const declared = declaredEncoding(text);
  if (declared === undefined) return fail(REASONS.malformed);
  if (declared !== null && declared.toLowerCase() !== 'utf-8') return fail(REASONS.encoding);
  let document: Readonly<Record<string, unknown>>;
  try {
    document = new Scanner(text).document();
  } catch (error) {
    if (error instanceof XmlError) return fail(error.reason);
    throw error;
  }
  // A second, independent well-formedness check. Its successor, fast-xml-validator, is not a dependency.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  if (XMLValidator.validate(text) !== true) return fail(REASONS.malformed);
  return Object.freeze({ ok: true, document });
}

const REASONS = {
  charset: 'the XML body must be UTF-8, but the Content-Type names another charset',
  utf8: 'the XML body is not valid UTF-8',
  encoding: 'the XML body must be UTF-8, but its XML declaration names another encoding',
  doctype: 'the XML body has a document type declaration, which is not allowed',
  char: 'the XML body contains a character that XML does not allow',
  entity: 'the XML body references an entity other than the five predefined ones',
  charRef: 'the XML body has a character reference to a character that XML does not allow',
  ampersand: 'the XML body has an "&" that does not begin a reference',
  depth: `the XML body nests elements deeper than ${String(MAX_XML_DEPTH)} levels`,
  nodes: `the XML body has more than ${String(MAX_XML_NODES)} elements and attributes`,
  malformed: 'the XML body is not well-formed XML',
  noRoot: 'the XML body has no root element',
  roots: 'the XML body has more than one root element',
  outside: 'the XML body has text outside its root element',
  unclosed: 'the XML body has an unclosed element',
  mismatched: 'the XML body has an end tag that does not match its start tag',
  duplicateAttribute: 'the XML body repeats an attribute on one element',
} as const;

function fail(reason: string): XmlDecodeResult {
  return Object.freeze({ ok: false, reason });
}

class XmlError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

// XML 1.0 Char excludes these; lone surrogates cannot come out of strict UTF-8 decoding.
// eslint-disable-next-line no-control-regex
const INVALID_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

const NAME_START =
  ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NAME_CHAR = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const NC_NAME = `[${NAME_START.slice(1)}][${NAME_CHAR.slice(1)}]*`;
/** A QName (Namespaces in XML §4): an NCName, optionally with an NCName prefix. */
// eslint-disable-next-line no-misleading-character-class -- NameChar includes combining marks (XML 1.0 §2.3).
const QNAME = new RegExp(`^(?:${NC_NAME}:)?${NC_NAME}$`, 'u');
const WHITESPACE_ONLY = /^[ \t\n]*$/;

/**
 * The encoding named by a leading XML declaration; null when there is no
 * declaration or it names none, undefined when the declaration is malformed.
 */
function declaredEncoding(text: string): string | null | undefined {
  if (!/^<\?xml[ \t\n?]/.test(text)) return null;
  const end = text.indexOf('?>');
  if (end === -1) return undefined;
  const match = /\sencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(text.slice(5, end));
  return match === null ? null : (match[1] ?? match[2] ?? null);
}

interface Frame {
  readonly qname: string;
  readonly local: string;
  readonly attributes: (readonly [string, string])[];
  readonly children: Map<string, XmlValue[]>;
  text: string;
}

class Scanner {
  private pos = 0;
  private nodes = 0;
  private readonly stack: Frame[] = [];
  private root: readonly [string, XmlValue] | null = null;

  constructor(private readonly text: string) {}

  document(): Readonly<Record<string, unknown>> {
    const { text } = this;
    while (this.pos < text.length) {
      const lt = text.indexOf('<', this.pos);
      const end = lt === -1 ? text.length : lt;
      if (end > this.pos) this.characters(text.slice(this.pos, end));
      if (lt === -1) break;
      this.pos = lt;
      if (text.startsWith('<!--', lt)) this.comment();
      else if (text.startsWith('<![CDATA[', lt)) this.cdata();
      else if (text.startsWith('<?', lt)) this.processingInstruction();
      else if (text.startsWith('<!DOCTYPE', lt)) throw new XmlError(REASONS.doctype);
      else if (text.startsWith('</', lt)) this.endTag();
      else this.startTag();
    }
    if (this.stack.length > 0) throw new XmlError(REASONS.unclosed);
    if (this.root === null) throw new XmlError(REASONS.noRoot);
    return Object.freeze(member(this.root[0], this.root[1]));
  }

  private characters(raw: string): void {
    const frame = this.stack.at(-1);
    if (frame === undefined) {
      if (!WHITESPACE_ONLY.test(raw)) throw new XmlError(REASONS.outside);
      return;
    }
    if (raw.includes(']]>')) throw new XmlError(REASONS.malformed);
    frame.text += decodeReferences(raw);
  }

  private comment(): void {
    const end = this.text.indexOf('-->', this.pos + 4);
    if (end === -1 || this.text.slice(this.pos + 4, end).includes('--')) throw new XmlError(REASONS.malformed);
    this.pos = end + 3;
  }

  private cdata(): void {
    const frame = this.stack.at(-1);
    const start = this.pos + '<![CDATA['.length;
    const end = this.text.indexOf(']]>', start);
    if (frame === undefined || end === -1) throw new XmlError(REASONS.malformed);
    frame.text += this.text.slice(start, end);
    this.pos = end + 3;
  }

  private processingInstruction(): void {
    const end = this.text.indexOf('?>', this.pos + 2);
    if (end === -1) throw new XmlError(REASONS.malformed);
    const target = /^[^ \t\n?]*/.exec(this.text.slice(this.pos + 2, end))?.[0] ?? '';
    // The XML declaration is only allowed first; any other PI is ignored.
    if (!QNAME.test(target) || (target.toLowerCase() === 'xml' && this.pos !== 0))
      throw new XmlError(REASONS.malformed);
    this.pos = end + 2;
  }

  private endTag(): void {
    const close = this.text.indexOf('>', this.pos);
    if (close === -1) throw new XmlError(REASONS.malformed);
    const qname = this.text.slice(this.pos + 2, close).replace(/[ \t\n]+$/, '');
    const frame = this.stack.pop();
    if (frame === undefined) throw new XmlError(REASONS.malformed);
    if (frame.qname !== qname) throw new XmlError(REASONS.mismatched);
    this.pos = close + 1;
    this.finish(frame);
  }

  private startTag(): void {
    const { text } = this;
    if (this.root !== null) throw new XmlError(REASONS.roots);
    this.pos++;
    const qname = this.name();
    if (this.stack.length >= MAX_XML_DEPTH) throw new XmlError(REASONS.depth);
    this.count();
    const frame: Frame = { qname, local: localName(qname), attributes: [], children: new Map(), text: '' };
    const seen = new Set<string>();
    for (;;) {
      const spaced = this.skipWhitespace();
      if (text.startsWith('/>', this.pos)) {
        this.pos += 2;
        this.finish(frame);
        return;
      }
      if (text[this.pos] === '>') {
        this.pos++;
        this.stack.push(frame);
        return;
      }
      if (!spaced) throw new XmlError(REASONS.malformed);
      const attribute = this.name();
      this.count();
      this.skipWhitespace();
      if (text[this.pos] !== '=') throw new XmlError(REASONS.malformed);
      this.pos++;
      this.skipWhitespace();
      const value = this.attributeValue();
      if (attribute === 'xmlns' || attribute.startsWith('xmlns:')) continue;
      const key = `@${localName(attribute)}`;
      if (seen.has(key)) throw new XmlError(REASONS.duplicateAttribute);
      seen.add(key);
      frame.attributes.push([key, value]);
    }
  }

  private name(): string {
    const match = /^[^ \t\n/>=<"'&]+/.exec(this.text.slice(this.pos, this.pos + 1024));
    const name = match?.[0] ?? '';
    if (!QNAME.test(name)) throw new XmlError(REASONS.malformed);
    this.pos += name.length;
    return name;
  }

  private attributeValue(): string {
    const quote = this.text[this.pos];
    if (quote !== '"' && quote !== "'") throw new XmlError(REASONS.malformed);
    const end = this.text.indexOf(quote, this.pos + 1);
    if (end === -1) throw new XmlError(REASONS.malformed);
    const raw = this.text.slice(this.pos + 1, end);
    if (raw.includes('<')) throw new XmlError(REASONS.malformed);
    this.pos = end + 1;
    // Attribute-value normalisation (XML 1.0 §3.3.3): literal tabs and line breaks become spaces.
    return decodeReferences(raw.replace(/[\t\n]/g, ' '));
  }

  private skipWhitespace(): boolean {
    const start = this.pos;
    while (this.pos < this.text.length && ' \t\n'.includes(this.text.charAt(this.pos))) this.pos++;
    return this.pos > start;
  }

  private count(): void {
    if (++this.nodes > MAX_XML_NODES) throw new XmlError(REASONS.nodes);
  }

  private finish(frame: Frame): void {
    const value = elementValue(frame);
    const parent = this.stack.at(-1);
    if (parent === undefined) {
      this.root = [frame.local, value];
      return;
    }
    const repeats = parent.children.get(frame.local);
    if (repeats === undefined) parent.children.set(frame.local, [value]);
    else repeats.push(value);
  }
}

function elementValue(frame: Frame): XmlValue {
  const text = WHITESPACE_ONLY.test(frame.text) ? '' : frame.text;
  if (frame.attributes.length === 0 && frame.children.size === 0) return text;
  // Null-prototype objects, so names like "__proto__" or "constructor" are ordinary members.
  const element: Record<string, XmlValue | readonly XmlValue[]> = Object.create(null) as Record<string, never>;
  for (const [key, value] of frame.attributes) element[key] = value;
  for (const [name, values] of frame.children) {
    const [only] = values;
    element[name] = values.length === 1 && only !== undefined ? only : Object.freeze(values);
  }
  if (text !== '') element['#text'] = text;
  return Object.freeze(element);
}

function member(name: string, value: XmlValue): Record<string, unknown> {
  const document: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  document[name] = value;
  return document;
}

function localName(qname: string): string {
  return qname.slice(qname.indexOf(':') + 1);
}

const PREDEFINED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decodes the five predefined entities and character references; anything else fails. */
function decodeReferences(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&([^;&]*);?/g, (whole, body: string) => {
    if (!whole.endsWith(';')) throw new XmlError(REASONS.ampersand);
    const numeric = /^#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}))$/.exec(body);
    if (numeric !== null) {
      const code = numeric[1] !== undefined ? parseInt(numeric[1], 16) : parseInt(numeric[2] ?? '', 10);
      if (!isXmlChar(code)) throw new XmlError(REASONS.charRef);
      return String.fromCodePoint(code);
    }
    if (Object.hasOwn(PREDEFINED, body)) return PREDEFINED[body] ?? '';
    throw new XmlError(QNAME.test(body) ? REASONS.entity : REASONS.ampersand);
  });
}

function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}
