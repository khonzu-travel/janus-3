import { utf8Encode } from '../bytes.js';
import { positionAt, type TextPosition } from '../fixtures/json.js';
import { scanTemplate, type GrammarContext } from './grammar.js';
import { jsonStrings, parseJsonTree, type JsonNode } from './json-tree.js';
import type { DynamicErrorCode, Template, TokenCategory } from './types.js';

/**
 * What a fixture needs to render: its body template and its
 * replayed header templates, scanned once when the snapshot is built. A
 * fixture with neither is replayed byte for byte and has no `DynamicFixture`.
 */
export interface DynamicFixture {
  readonly body: DynamicBody | null;
  /** Lower-cased replayed header name → one entry per value; null for a static value. */
  readonly headers: ReadonlyMap<string, readonly (Template | null)[]>;
  /** Every token: the body's in document order, then the sidecar's in the order written. */
  readonly tokens: readonly TokenAnnotation[];
  /** Some token reads the clock: a clock value, or a generator (the instant is in its key). */
  readonly usesInstant: boolean;
  readonly usesUnique: boolean;
}

export type DynamicBody =
  | {
      readonly kind: 'json';
      readonly tree: JsonNode;
      /** JSON Pointer of each templated string value. */
      readonly templates: ReadonlyMap<string, Template>;
    }
  | { readonly kind: 'text'; readonly template: Template };

/** A token as Atlas describes it. */
export interface TokenAnnotation {
  readonly location: 'body' | 'header';
  /** JSON Pointer for JSON bodies and header sidecars; `line:column` for text bodies. */
  readonly pointer: string;
  /** Lower-cased header name, for header tokens. */
  readonly header: string | null;
  readonly expression: string;
  readonly category: TokenCategory;
  readonly unique: boolean;
  /**
   * UTF-16 offsets of the token in the raw body preview (as Atlas shows it,
   * BOM included) or in the header value.
   */
  readonly span: { readonly start: number; readonly end: number };
}

export interface LocatedDynamicProblem {
  readonly code: DynamicErrorCode;
  readonly message: string;
  readonly position: TextPosition;
  readonly token: string;
}

export interface BodyScan {
  readonly body: DynamicBody | null;
  readonly tokens: readonly TokenAnnotation[];
  readonly problems: readonly LocatedDynamicProblem[];
  /** The whole document is one string made only of tokens (`fully-dynamic-fixture`). */
  readonly fullyDynamic: boolean;
}

/** Scans a valid JSON body (text without its BOM; `bom` is its length in the preview, 0 or 1). */
export function scanJsonBody(text: string, bom: number, context: GrammarContext): BodyScan {
  if (!text.includes('{{$')) return { body: null, tokens: [], problems: [], fullyDynamic: false };
  const tree = parseJsonTree(text);
  const templates = new Map<string, Template>();
  const tokens: TokenAnnotation[] = [];
  const problems: LocatedDynamicProblem[] = [];
  for (const { pointer, node } of jsonStrings(tree)) {
    const { template, problems: found } = scanTemplate(node.value, context, (_start, ordinal) => [
      'json',
      pointer,
      ordinal,
    ]);
    const source = (index: number): number => node.location.sourceIndex[index] ?? node.location.offset;
    for (const problem of found) {
      problems.push({ ...problem, position: positionAt(text, source(problem.offset)) });
    }
    if (template === null) continue;
    templates.set(pointer, template);
    for (const segment of template.segments) {
      if (segment.kind !== 'token') continue;
      tokens.push(
        annotation('body', pointer, null, segment.token, {
          start: bom + source(segment.start),
          end: bom + source(segment.end - 1) + 1,
        }),
      );
    }
  }
  if (templates.size === 0 && problems.length === 0) return { body: null, tokens, problems, fullyDynamic: false };
  const rootTemplate = tree.kind === 'string' ? templates.get('') : undefined;
  const fullyDynamic = rootTemplate !== undefined && rootTemplate.segments.every((segment) => segment.kind === 'token');
  return { body: { kind: 'json', tree, templates }, tokens, problems, fullyDynamic };
}

/** Scans a UTF-8 text body (decoded with any BOM kept, so offsets match the preview). */
export function scanTextBody(text: string, context: GrammarContext): BodyScan {
  const { template, problems } = scanTemplate(text, context, (start) => [
    'text',
    utf8Encode(text.slice(0, start)).length,
  ]);
  const located = problems.map((problem) => ({ ...problem, position: positionAt(text, problem.offset) }));
  if (template === null) return { body: null, tokens: [], problems: located, fullyDynamic: false };
  const tokens: TokenAnnotation[] = [];
  for (const segment of template.segments) {
    if (segment.kind !== 'token') continue;
    const { line, column } = positionAt(text, segment.start);
    tokens.push(
      annotation('body', `${String(line)}:${String(column)}`, null, segment.token, {
        start: segment.start,
        end: segment.end,
      }),
    );
  }
  return { body: { kind: 'text', template }, tokens, problems: located, fullyDynamic: false };
}

export interface HeaderScan {
  readonly templates: ReadonlyMap<string, readonly (Template | null)[]>;
  readonly tokens: readonly TokenAnnotation[];
  readonly problems: readonly LocatedDynamicProblem[];
}

/**
 * Scans a header sidecar's values. `replayed` names the
 * headers served as written; any other header with a token (Content-Type, a
 * Janus-computed header) is an error, since its value is fixed at load.
 */
export function scanHeaderSidecar(text: string, replayed: ReadonlySet<string>, context: GrammarContext): HeaderScan {
  const templates = new Map<string, (Template | null)[]>();
  const tokens: TokenAnnotation[] = [];
  const problems: LocatedDynamicProblem[] = [];
  if (!text.includes('{{$')) return { templates, tokens, problems };
  const tree = parseJsonTree(text);
  if (tree.kind !== 'object') return { templates, tokens, problems };
  for (const [written, value] of tree.entries) {
    const name = written.toLowerCase();
    const strings = value.kind === 'string' ? [value] : value.kind === 'array' ? value.items : [];
    const entries: (Template | null)[] = [];
    strings.forEach((node, index) => {
      if (node.kind !== 'string') return;
      const pointer = value.kind === 'array' ? `/${escape(written)}/${String(index)}` : `/${escape(written)}`;
      const source = (at: number): number => node.location.sourceIndex[at] ?? node.location.offset;
      if (!node.value.includes('{{$')) {
        entries.push(null);
        return;
      }
      if (!replayed.has(name)) {
        problems.push({
          code: 'invalid-dynamic-token',
          message: `"${written}" cannot contain dynamic values: Janus fixes its value when the snapshot is built`,
          position: positionAt(text, source(node.value.indexOf('{{$'))),
          token: written,
        });
        return;
      }
      const { template, problems: found } = scanTemplate(node.value, context, (start) => [
        'header',
        name,
        index,
        utf8Encode(node.value.slice(0, start)).length,
      ]);
      for (const problem of found) problems.push({ ...problem, position: positionAt(text, source(problem.offset)) });
      entries.push(template);
      if (template === null) return;
      for (const segment of template.segments) {
        if (segment.kind !== 'token') continue;
        tokens.push(annotation('header', pointer, name, segment.token, { start: segment.start, end: segment.end }));
      }
    });
    if (entries.some((entry) => entry !== null)) templates.set(name, entries);
  }
  return { templates, tokens, problems };
}

function escape(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function annotation(
  location: 'body' | 'header',
  pointer: string,
  header: string | null,
  token: { readonly expression: string; readonly spec: { readonly category: TokenCategory } & object },
  span: { start: number; end: number },
): TokenAnnotation {
  const spec = token.spec as { category: TokenCategory; unique?: boolean };
  return Object.freeze({
    location,
    pointer,
    header,
    expression: token.expression,
    category: spec.category,
    unique: spec.unique === true,
    span: Object.freeze(span),
  });
}

/** Combines a body scan and header templates into what a stored response renders with, or null. */
export function dynamicFixture(
  body: DynamicBody | null,
  bodyTokens: readonly TokenAnnotation[],
  headers: ReadonlyMap<string, readonly (Template | null)[]>,
  headerTokens: readonly TokenAnnotation[],
): DynamicFixture | null {
  if (body === null && headers.size === 0) return null;
  const tokens = Object.freeze([...bodyTokens, ...headerTokens]);
  return Object.freeze({
    body,
    headers,
    tokens,
    usesInstant: tokens.some((token) => token.category === 'clock' || token.category === 'generator'),
    usesUnique: tokens.some((token) => token.unique),
  });
}
