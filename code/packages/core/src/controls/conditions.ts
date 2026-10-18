import { isMap, isScalar, isSeq, type Node as YamlNode, type Pair } from 'yaml';

import { checkJsonPath, firstMatch } from '../dynamic/jsonpath.js';
import { InvalidBodyDocument, readBodyDocument, type BodyDocument } from '../http/body-document.js';
import type { JsonScalar } from '../dynamic/types.js';
import type { TextPosition } from '../fixtures/json.js';
import { cookieNamed } from '../http/cookie.js';
import { ifNoneMatchMatches, parseEntityTag, type EntityTag } from '../http/etag.js';
import { parseMediaType } from '../http/media-type.js';
import type { QueryPair } from '../http/target.js';
import { isToken } from '../http/token.js';
import { suggest } from '../suggest.js';
import type { HeaderMap } from '../types/index.js';
import type { ControlProblem, YamlSource } from './yaml.js';

/**
 * The condition language of `variants.yaml` and `expect.yaml`:
 * a reference into the request mapped to a test. Parsed once at load; every
 * mistake that can be known then is an error then.
 */

export type ReferenceSource = 'path' | 'query' | 'header' | 'cookie' | 'body' | 'contentType';

export interface Reference {
  readonly source: ReferenceSource;
  /** Parameter, query, lower-cased header or cookie name, or the JSONPath; "" for `contentType`. */
  readonly name: string;
  /** The reference as written, e.g. `header.X-Tier`. */
  readonly text: string;
}

/** A literal operand: a value, or one `{{$scenario.ids.<name>}}` token resolved per selected scenario. */
export type Literal =
  | { readonly kind: 'value'; readonly value: JsonScalar }
  | {
      readonly kind: 'scenario-id';
      readonly name: string;
      /** The token as written. */
      readonly written: string;
      readonly position: TextPosition | undefined;
    };

export type RangeBound = 'gt' | 'gte' | 'lt' | 'lte';

export type ConditionTest =
  | { readonly kind: 'equals'; readonly literal: Literal }
  | { readonly kind: 'in'; readonly literals: readonly Literal[] }
  | { readonly kind: 'present'; readonly present: boolean }
  | { readonly kind: 'range'; readonly bounds: Readonly<Partial<Record<RangeBound, number>>> }
  | { readonly kind: 'matchesETag'; readonly tag: EntityTag; readonly written: string };

export interface Condition {
  readonly reference: Reference;
  readonly test: ConditionTest;
  readonly position: TextPosition | undefined;
}

/** What a reference may name: the route's parameters, or null to skip that check. */
export interface ConditionContext {
  readonly pathParameters: readonly string[] | null;
}

/** At most this many conditions in one `when` or `expect`. */
export const MAX_CONDITIONS = 16;
/** `in` takes 1 to this many literals. */
export const MAX_IN = 64;

const SCENARIO_ID_LITERAL = /^\{\{\$\s*scenario\.ids\.([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}$/;
const PATH_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;
const TEST_KEYS = ['in', 'present', 'gt', 'gte', 'lt', 'lte', 'matchesETag'];
const RANGE_KEYS: ReadonlySet<string> = new Set(['gt', 'gte', 'lt', 'lte']);
const REFERENCES = 'path.<name>, query.<name>, header.<name>, cookie.<name>, body.<JSONPath> or contentType';

/** Parses a reference such as `query.status`, or reports why it is not one. */
export function parseReference(
  text: string,
  node: YamlNode | null | undefined,
  source: YamlSource,
  context: ConditionContext,
  problems: ControlProblem[],
): Reference | null {
  if (text === 'contentType') return { source: 'contentType', name: '', text };
  const dot = text.indexOf('.');
  const prefix = dot === -1 ? text : text.slice(0, dot);
  const name = dot === -1 ? '' : text.slice(dot + 1);
  const fail = (message: string, code: ControlProblem['code'] = 'invalid-control'): null => {
    problems.push(source.problem(node, message, code));
    return null;
  };
  switch (prefix) {
    case 'path': {
      if (!PATH_NAME.test(name)) return fail(`"${text}" needs a path parameter name, e.g. path.orderId`);
      const bound = context.pathParameters;
      if (bound !== null && !bound.includes(name)) {
        const suggestion = suggest(name, bound);
        const available =
          bound.length === 0
            ? 'the route binds no parameters'
            : `the route binds ${bound.map((p) => `{${p}}`).join(', ')}`;
        return fail(
          `path.${name} is not a parameter of this route; ${available}${suggestion === null ? '' : `; did you mean "path.${suggestion}"?`}`,
          'unknown-path-parameter',
        );
      }
      return { source: 'path', name, text };
    }
    case 'query':
      if (name === '') return fail(`"${text}" needs a query parameter name, e.g. query.page`);
      return { source: 'query', name, text };
    case 'header':
      if (!isToken(name)) return fail(`"${text}" needs a header name, e.g. header.x-tier`);
      return { source: 'header', name: name.toLowerCase(), text };
    case 'cookie':
      if (!isToken(name)) return fail(`"${text}" needs a cookie name, e.g. cookie.cart`);
      return { source: 'cookie', name, text };
    case 'body': {
      const problem = name === '' ? `"${text}" needs a JSONPath, e.g. body.$.quantity` : checkJsonPath(name);
      if (problem !== null) return fail(problem);
      return { source: 'body', name, text };
    }
    default:
      return fail(`"${text}" is not a reference; use ${REFERENCES}`);
  }
}

/**
 * Parses a `when` or `expect` mapping: 1 to 16 conditions,
 * each reference at most once. Returns null when any problem was found.
 */
export function parseConditions(
  node: YamlNode | null | undefined,
  source: YamlSource,
  context: ConditionContext,
  what: string,
  problems: ControlProblem[],
): readonly Condition[] | null {
  if (!isMap(node) || node.items.length === 0 || node.items.length > MAX_CONDITIONS) {
    problems.push(
      source.problem(
        node,
        `"${what}" must be a mapping of 1 to ${String(MAX_CONDITIONS)} conditions, e.g. { query.status: shipped }`,
      ),
    );
    return null;
  }
  const before = problems.length;
  const conditions: Condition[] = [];
  const seen = new Set<string>();
  for (const pair of node.items as Pair<YamlNode | null, YamlNode | null>[]) {
    const key = pair.key;
    const text = isScalar(key) && typeof key.value === 'string' ? key.value : null;
    if (text === null) {
      problems.push(source.problem(key, `a condition's key must be a reference: ${REFERENCES}`));
      continue;
    }
    const reference = parseReference(text, key, source, context, problems);
    if (reference === null) continue;
    const identity = `${reference.source}\0${reference.name}`;
    if (seen.has(identity)) {
      problems.push(source.problem(key, `"${text}" appears more than once in "${what}"`));
      continue;
    }
    seen.add(identity);
    const test = parseTest(pair.value, reference, source, problems);
    if (test !== null) conditions.push(Object.freeze({ reference, test, position: source.at(key).position }));
  }
  return problems.length === before ? Object.freeze(conditions) : null;
}

function parseTest(
  node: YamlNode | null,
  reference: Reference,
  source: YamlSource,
  problems: ControlProblem[],
): ConditionTest | null {
  if (node === null || isScalar(node)) {
    const literal = parseLiteral(node, reference, source, problems);
    return literal === null ? null : { kind: 'equals', literal };
  }
  if (!isMap(node)) {
    problems.push(
      source.problem(node, `"${reference.text}" takes a literal or a test such as { in: [a, b] } or { present: true }`),
    );
    return null;
  }
  const entries = new Map<string, { key: YamlNode | null; value: YamlNode | null }>();
  for (const pair of node.items as Pair<YamlNode | null, YamlNode | null>[]) {
    const name = isScalar(pair.key) && typeof pair.key.value === 'string' ? pair.key.value : null;
    if (name === null || !TEST_KEYS.includes(name)) {
      problems.push(
        source.problem(pair.key, `unknown test${name === null ? '' : ` "${name}"`}; use ${TEST_KEYS.join(', ')}`),
      );
      return null;
    }
    entries.set(name, { key: pair.key, value: pair.value });
  }
  if (entries.size === 0) {
    problems.push(source.problem(node, `"${reference.text}" has an empty test; use ${TEST_KEYS.join(', ')}`));
    return null;
  }
  const names = [...entries.keys()];
  const ranges = names.filter((name) => RANGE_KEYS.has(name));
  if (ranges.length > 0 && ranges.length < names.length) {
    problems.push(source.problem(node, `"${reference.text}" combines a range with another test; write one test`));
    return null;
  }
  if (ranges.length === 0 && names.length > 1) {
    problems.push(source.problem(node, `"${reference.text}" has several tests (${names.join(', ')}); write one`));
    return null;
  }
  if (ranges.length > 0) return parseRange(node, entries, reference, source, problems);

  const [name] = names;
  const entry = entries.get(name ?? '');
  if (entry === undefined) return null;
  const { value } = entry;
  switch (name) {
    case 'present': {
      if (!isScalar(value) || typeof value.value !== 'boolean') {
        problems.push(source.problem(value ?? entry.key, '"present" must be true or false'));
        return null;
      }
      return { kind: 'present', present: value.value };
    }
    case 'in': {
      if (!isSeq(value) || value.items.length === 0 || value.items.length > MAX_IN) {
        problems.push(source.problem(value ?? entry.key, `"in" must be a list of 1 to ${String(MAX_IN)} literals`));
        return null;
      }
      const literals: Literal[] = [];
      const seen = new Set<string>();
      for (const item of value.items as (YamlNode | null)[]) {
        const literal = parseLiteral(item, reference, source, problems);
        if (literal === null) return null;
        const key = literal.kind === 'value' ? JSON.stringify(literal.value) : `$${literal.name}`;
        if (seen.has(key)) {
          problems.push(source.problem(item, `"in" lists ${source.source(item) ?? key} more than once`));
          return null;
        }
        seen.add(key);
        literals.push(literal);
      }
      return { kind: 'in', literals: Object.freeze(literals) };
    }
    case 'matchesETag': {
      if (reference.source !== 'header' || reference.name !== 'if-none-match') {
        problems.push(source.problem(entry.key, '"matchesETag" applies only to header.if-none-match'));
        return null;
      }
      const written = isScalar(value) && typeof value.value === 'string' ? value.value : null;
      const tag = written === null ? null : parseEntityTag(written.trim());
      if (written === null || tag === null) {
        problems.push(
          source.problem(value ?? entry.key, `"matchesETag" takes one entity tag in quotes, e.g. '"v2"' or 'W/"v2"'`),
        );
        return null;
      }
      return { kind: 'matchesETag', tag, written: written.trim() };
    }
    default:
      return null;
  }
}

function parseRange(
  node: YamlNode,
  entries: ReadonlyMap<string, { key: YamlNode | null; value: YamlNode | null }>,
  reference: Reference,
  source: YamlSource,
  problems: ControlProblem[],
): ConditionTest | null {
  const bounds: Partial<Record<RangeBound, number>> = {};
  for (const [name, { key, value }] of entries) {
    if (!isScalar(value) || typeof value.value !== 'number' || !Number.isFinite(value.value)) {
      problems.push(source.problem(value ?? key, `"${name}" must be a number`));
      return null;
    }
    bounds[name as RangeBound] = value.value;
  }
  if ((bounds.gt !== undefined && bounds.gte !== undefined) || (bounds.lt !== undefined && bounds.lte !== undefined)) {
    problems.push(
      source.problem(node, `"${reference.text}" has two lower or two upper bounds; write at most one of each`),
    );
    return null;
  }
  const lower = bounds.gt ?? bounds.gte;
  const upper = bounds.lt ?? bounds.lte;
  const exclusive = bounds.gt !== undefined || bounds.lt !== undefined;
  if (lower !== undefined && upper !== undefined && (lower > upper || (lower === upper && exclusive))) {
    problems.push(source.problem(node, `"${reference.text}" describes an empty range, so it can never be true`));
    return null;
  }
  return { kind: 'range', bounds: Object.freeze(bounds) };
}

function parseLiteral(
  node: YamlNode | null,
  reference: Reference,
  source: YamlSource,
  problems: ControlProblem[],
): Literal | null {
  const value = node === null ? null : isScalar(node) ? node.value : undefined;
  if (value === undefined) {
    problems.push(source.problem(node, `a literal must be a single value, not a list or mapping`));
    return null;
  }
  if (typeof value === 'string' && value.includes('{{$')) {
    const match = SCENARIO_ID_LITERAL.exec(value.trim());
    if (match === null) {
      problems.push(
        source.problem(node, 'the only dynamic value a control file may hold is one {{$scenario.ids.<name>}} literal'),
      );
      return null;
    }
    return { kind: 'scenario-id', name: match[1] ?? '', written: value, position: source.at(node).position };
  }
  if (reference.source !== 'body') {
    if (typeof value !== 'string') {
      const written = source.source(node) ?? JSON.stringify(value);
      problems.push(
        source.problem(
          node,
          `${reference.text} compares text, so write the literal as a string: '${written.replace(/'/g, "''")}'`,
        ),
      );
      return null;
    }
    return { kind: 'value', value };
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    problems.push(source.problem(node, 'a body literal must be a JSON value; infinity and NaN are not'));
    return null;
  }
  if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    problems.push(source.problem(node, 'a body literal must be a JSON scalar'));
    return null;
  }
  return { kind: 'value', value };
}

/** Every `{{$scenario.ids.<name>}}` literal of some conditions, for the per-scenario check. */
export function scenarioIdLiterals(conditions: readonly Condition[]): (Literal & { kind: 'scenario-id' })[] {
  const out: (Literal & { kind: 'scenario-id' })[] = [];
  for (const { test } of conditions) {
    const literals = test.kind === 'equals' ? [test.literal] : test.kind === 'in' ? test.literals : [];
    for (const literal of literals) if (literal.kind === 'scenario-id') out.push(literal);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation

/** A value the request does not have. */
export const MISSING: unique symbol = Symbol('missing');
export type RequestValue = JsonScalar | object | typeof MISSING;

/** A JSON or XML request body that does not decode: `400 invalid-request`. */
export class InvalidRequestBody extends Error {
  constructor(message = 'the request body is not valid JSON') {
    super(message);
  }
}

/** The request values conditions read. Never logged or traced. */
export interface RequestFacts {
  readonly params: Readonly<Record<string, string>>;
  readonly query: readonly QueryPair[];
  readonly headers: HeaderMap;
  /** The JSON body or XML document, parsed on first use, or MISSING; throws `InvalidRequestBody`. */
  body(): unknown;
  /** True when `body()` is an XML document, whose values compare as strings. */
  bodyIsXml(): boolean;
  /** The selected scenario's effective `ids`. */
  readonly scenarioIds: ReadonlyMap<string, string>;
}

/** Facts over one request, parsing its body at most once and only when asked. */
export function requestFacts(input: {
  readonly params: Readonly<Record<string, string>>;
  readonly query: readonly QueryPair[];
  readonly headers: HeaderMap;
  readonly body: Uint8Array | null;
  readonly scenarioIds: ReadonlyMap<string, string>;
  /** `codecs.xml`; defaults to true. */
  readonly xml?: boolean;
}): RequestFacts {
  let parsed: { document: BodyDocument } | undefined;
  const read = (): BodyDocument => {
    parsed ??= { document: bodyDocument(input.body, input.headers, input.xml ?? true) };
    return parsed.document;
  };
  return {
    params: input.params,
    query: input.query,
    headers: input.headers,
    scenarioIds: input.scenarioIds,
    body: () => read()?.value ?? MISSING,
    bodyIsXml: () => read()?.kind === 'xml',
  };
}

/** The parsed body, or null; throws `InvalidRequestBody`. */
export function bodyDocument(body: Uint8Array | null, headers: HeaderMap, xml: boolean): BodyDocument {
  try {
    return readBodyDocument(body, headers, xml);
  } catch (error) {
    if (error instanceof InvalidBodyDocument) throw new InvalidRequestBody(error.message);
    throw error;
  }
}

/** A JSON body parsed, or MISSING for any other body; throws `InvalidRequestBody`. */
export function jsonBody(body: Uint8Array | null, headers: HeaderMap): unknown {
  const document = bodyDocument(body, headers, false);
  return document === null ? MISSING : document.value;
}

/** The value a reference reads from the request. */
export function referenceValue(reference: Reference, facts: RequestFacts): RequestValue {
  const { name } = reference;
  switch (reference.source) {
    case 'path':
      return Object.hasOwn(facts.params, name) ? (facts.params[name] ?? MISSING) : MISSING;
    case 'query':
      return facts.query.find(([key]) => key === name)?.[1] ?? MISSING;
    case 'header':
      return facts.headers[name]?.[0]?.trim() ?? MISSING;
    case 'cookie':
      return cookieNamed(facts.headers['cookie'], name) ?? MISSING;
    case 'contentType': {
      const value = facts.headers['content-type']?.[0];
      const parsed = value === undefined ? null : parseMediaType(value);
      return parsed === null ? MISSING : `${parsed.type}/${parsed.subtype}`.toLowerCase();
    }
    case 'body': {
      const document = facts.body();
      if (document === MISSING) return MISSING;
      let match: unknown;
      try {
        match = firstMatch(name, document);
      } catch {
        return MISSING;
      }
      return match === undefined ? MISSING : match;
    }
  }
}

/** True when the condition holds for the request. Throws `InvalidRequestBody` for a body that must parse and does not. */
export function holds(condition: Condition, facts: RequestFacts): boolean {
  const { reference, test } = condition;
  if (test.kind === 'matchesETag') return ifNoneMatchMatches(facts.headers['if-none-match'], test.tag);
  const value = referenceValue(reference, facts);
  if (test.kind === 'present') return (value !== MISSING) === test.present;
  if (value === MISSING) return false;
  switch (test.kind) {
    case 'equals':
      return equalsLiteral(value, test.literal, facts, xmlValue(reference, facts));
    case 'in':
      return test.literals.some((literal) => equalsLiteral(value, literal, facts, xmlValue(reference, facts)));
    case 'range': {
      let number: number;
      if (reference.source === 'body' && !facts.bodyIsXml()) {
        if (typeof value !== 'number') return false;
        number = value;
      } else {
        if (typeof value !== 'string' || !DECIMAL.test(value)) return false;
        number = Number(value);
      }
      const { gt, gte, lt, lte } = test.bounds;
      return (
        (gt === undefined || number > gt) &&
        (gte === undefined || number >= gte) &&
        (lt === undefined || number < lt) &&
        (lte === undefined || number <= lte)
      );
    }
  }
}

/** True for a body reference reading an XML document. */
function xmlValue(reference: Reference, facts: RequestFacts): boolean {
  return reference.source === 'body' && facts.bodyIsXml();
}

function equalsLiteral(value: RequestValue, literal: Literal, facts: RequestFacts, xml: boolean): boolean {
  const expected = literal.kind === 'value' ? literal.value : facts.scenarioIds.get(literal.name);
  if (expected === undefined) return false;
  // XML values are strings; a number or boolean literal matches its JSON text, null nothing.
  if (xml) return expected !== null && typeof value === 'string' && value === String(expected);
  // JSON typing: 5 matches the number 5 only; objects and arrays never equal a literal.
  return typeof value === typeof expected && value === expected;
}

/** The conditions that do not hold, in order. */
export function failing(conditions: readonly Condition[], facts: RequestFacts): readonly Condition[] {
  return conditions.filter((condition) => !holds(condition, facts));
}

/** A literal as Atlas and error envelopes show it: as written, with a scenario ID resolved only when asked. */
export function literalText(literal: Literal, scenarioIds?: ReadonlyMap<string, string>): JsonScalar {
  if (literal.kind === 'value') return literal.value;
  return scenarioIds?.get(literal.name) ?? literal.written;
}
