import { utf8DecodeStrict, utf8Encode } from '../bytes.js';
import {
  CanonicalWriter,
  canonicalJsonText,
  compareStrings,
  exceedsJsonDepth,
  MAX_CANONICAL_JSON_DEPTH,
} from '../canonical.js';
import { decodeFieldValue, isFixtureFieldValue } from '../http/headers.js';
import { InvalidBodyDocument, isJsonMediaType, readBodyDocument } from '../http/body-document.js';
import type { QueryPair } from '../http/target.js';
import type { HeaderMap } from '../types/index.js';
import type { DynamicFixture } from './fixture.js';
import { serializeJsonTree, type JsonWriter } from './json-tree.js';
import { firstMatch } from './jsonpath.js';
import { generate, TokenRandom } from './random.js';
import {
  evaluateClock,
  evaluateSteps,
  formatClock,
  parseRfc3339Date,
  parseRfc3339WithOffset,
  type EvaluatedClock,
  type Zone,
} from './time.js';
import type { RequestTransform, Segment, Template } from './types.js';

/**
 * Renders a dynamic fixture for one request. Pure: the
 * instant, seed and entropy source are inputs, and every generated value is a
 * function of its derivation key alone, so render order and concurrency never
 * change a response.
 */

/** The request values tokens may read. Never logged or traced. */
export interface RenderRequest {
  readonly method: string;
  readonly routeTemplate: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: readonly QueryPair[];
  readonly headers: HeaderMap;
  readonly body: Uint8Array | null;
  /** `codecs.xml`: XML bodies are read as documents. Defaults to true. */
  readonly xml?: boolean;
}

export interface RenderEnvironment {
  readonly instant: number;
  /** `dynamic.timezone`: the zone of tokens without `@zone`. */
  readonly timezone: string;
  readonly seed: number;
  readonly strictRefs: boolean;
  readonly randomBytes: ((count: number) => Uint8Array) | undefined;
  /** The fixture's Atlas ID and status: its identity in the derivation key. */
  readonly fixtureId: string;
  readonly status: number;
  /** Atlas previews: a missing request value is recorded, never a failure. */
  readonly preview: boolean;
  /** The selected scenario and the caller's sequence position; absent renders them as missing. */
  readonly context?: RenderContextValues;
}

/** What `{{$scenario.*}}` and `{{$sequence.position}}` render. */
export interface RenderContextValues {
  readonly scenario: string;
  readonly ids: ReadonlyMap<string, string>;
  /** Null when no sequence applies: a missing value. */
  readonly sequencePosition: number | null;
}

export type RenderResult =
  | {
      readonly ok: true;
      /** The rendered body, or undefined when the body is static. */
      readonly body: Uint8Array | undefined;
      readonly headers: HeaderMap;
      /** Expressions of request tokens that had no value. */
      readonly unresolved: readonly string[];
      /** UTF-16 spans of each body token's rendered text in the body, in token order. */
      readonly spans: readonly { readonly start: number; readonly end: number }[];
    }
  | { readonly ok: false; readonly kind: 'render-failed'; readonly token: string; readonly reason: string }
  | { readonly ok: false; readonly kind: 'invalid-request'; readonly reason: string };

class RenderFailure extends Error {
  constructor(
    readonly token: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}

class InvalidRequest extends Error {}

const MISSING = Symbol('missing');
type Value = unknown;

export function renderFixture(
  fixture: DynamicFixture,
  stored: { readonly body: Uint8Array | null; readonly headers: HeaderMap },
  request: RenderRequest,
  env: RenderEnvironment,
): RenderResult {
  const context = new RenderContext(request, env);
  try {
    let body: Uint8Array | undefined;
    const spans: { start: number; end: number }[] = [];
    if (fixture.body?.kind === 'json') {
      const { templates, tree } = fixture.body;
      const text = serializeJsonTree(tree, (node, pointer, out) => {
        const template = templates.get(pointer);
        if (template === undefined) out.write(JSON.stringify(node.value));
        else context.writeJson(template, out, spans);
      });
      body = utf8Encode(text);
    } else if (fixture.body?.kind === 'text') {
      body = utf8Encode(context.interpolate(fixture.body.template, spans));
    }

    const headers: Record<string, readonly string[]> = { ...stored.headers };
    for (const [name, templates] of fixture.headers) {
      const values = stored.headers[name] ?? [];
      headers[name] = Object.freeze(
        values.map((value, index) => {
          const template = templates[index];
          if (template === undefined || template === null) return value;
          const rendered = context.interpolate(template, []);
          if (!isFixtureFieldValue(rendered)) {
            throw new RenderFailure(
              firstToken(template),
              `the rendered "${name}" header value contains CR, LF, NUL or another control character`,
            );
          }
          return rendered;
        }),
      );
    }
    return { ok: true, body, headers, unresolved: Object.freeze(context.unresolved), spans: Object.freeze(spans) };
  } catch (error) {
    if (error instanceof RenderFailure)
      return { ok: false, kind: 'render-failed', token: error.token, reason: error.reason };
    if (error instanceof InvalidRequest) return { ok: false, kind: 'invalid-request', reason: error.message };
    throw error;
  }
}

function firstToken(template: Template): string {
  const token = template.segments.find((segment) => segment.kind === 'token');
  return token?.kind === 'token' ? token.token.expression : '';
}

class RenderContext {
  readonly unresolved: string[] = [];
  #digest: Uint8Array | undefined;
  #document: { value: unknown } | undefined;

  constructor(
    private readonly request: RenderRequest,
    private readonly env: RenderEnvironment,
  ) {}

  /** A JSON string value: whole-value typing for a lone token, otherwise an interpolated string. */
  writeJson(template: Template, out: JsonWriter, spans: { start: number; end: number }[]): void {
    const [only] = template.segments;
    if (template.segments.length === 1 && only?.kind === 'token') {
      const value = this.evaluate(only);
      const start = out.length;
      out.write(value === MISSING ? 'null' : jsonText(value));
      spans.push({ start, end: out.length });
      return;
    }
    out.write('"');
    for (const segment of template.segments) {
      if (segment.kind === 'text') {
        out.write(escapeJson(segment.text));
        continue;
      }
      const start = out.length;
      out.write(escapeJson(embedded(this.evaluate(segment))));
      spans.push({ start, end: out.length });
    }
    out.write('"');
  }

  interpolate(template: Template, spans: { start: number; end: number }[]): string {
    let out = '';
    for (const segment of template.segments) {
      if (segment.kind === 'text') {
        out += segment.text;
        continue;
      }
      const start = out.length;
      out += embedded(this.evaluate(segment));
      spans.push({ start, end: out.length });
    }
    return out;
  }

  evaluate(segment: Segment & { kind: 'token' }): Value {
    const { token } = segment;
    const spec = token.spec;
    switch (spec.category) {
      case 'clock': {
        const zone = spec.zone ?? this.env.timezone;
        try {
          return formatClock(evaluateClock(spec.start, spec.steps, zone, this.env.instant), spec.format, zone);
        } catch (error) {
          throw new RenderFailure(
            token.expression,
            error instanceof RangeError ? error.message : 'the clock value cannot be computed',
          );
        }
      }
      case 'request':
      case 'context': {
        let value =
          spec.category === 'request'
            ? this.requestValue(spec.source, spec.name)
            : this.contextValue(spec.source, spec.name);
        let reason = 'the request has no value for it';
        if (value !== MISSING && spec.category === 'request' && spec.transform !== undefined) {
          value = this.transform(spec.transform, value, token.expression);
          reason = `the request value is not ${spec.transform.kind === 'date' ? 'an RFC 3339 date or date-time' : 'a number'}`;
        }
        if (value !== MISSING) return value;
        if (this.env.strictRefs && !this.env.preview) {
          throw new RenderFailure(token.expression, `${reason} and dynamic.strictRefs is true`);
        }
        if (!this.unresolved.includes(token.expression)) this.unresolved.push(token.expression);
        return MISSING;
      }
      case 'generator': {
        let random: TokenRandom;
        if (spec.unique) {
          if (this.env.randomBytes === undefined) {
            throw new RenderFailure(token.expression, ':unique needs an entropy source, and none was provided');
          }
          random = new TokenRandom(this.env.randomBytes(32));
        } else {
          random = new TokenRandom(this.derive(segment));
        }
        try {
          return generate(spec.generator, random, this.env.instant);
        } catch (error) {
          throw new RenderFailure(
            token.expression,
            error instanceof RangeError ? error.message : 'the generator failed',
          );
        }
      }
    }
  }

  /** `date(…)` and `num(…)`: missing when the value is not a date or a number. */
  private transform(transform: RequestTransform, value: Value, expression: string): Value {
    if (transform.kind === 'num') {
      const number =
        typeof value === 'number' ? value : typeof value === 'string' && DECIMAL.test(value) ? Number(value) : NaN;
      if (!Number.isFinite(number)) return MISSING;
      const result = calculate(number, transform.operations);
      if (!Number.isFinite(result)) throw new RenderFailure(expression, 'the result is not a finite number');
      return result;
    }
    if (typeof value !== 'string') return MISSING;
    const date = parseRfc3339Date(value);
    const dateTime = date === null ? parseRfc3339WithOffset(value) : null;
    if (date === null && dateTime === null) return MISSING;
    const zone: Zone = transform.zone ?? (dateTime === null ? this.env.timezone : dateTime.offset);
    let evaluated: EvaluatedClock;
    try {
      evaluated =
        dateTime === null
          ? evaluateSteps({ mode: 'local', ms: date ?? 0 }, transform.steps, zone)
          : evaluateSteps({ mode: 'instant', ms: dateTime.instant }, transform.steps, zone);
    } catch (error) {
      throw new RenderFailure(expression, error instanceof RangeError ? error.message : 'the date cannot be computed');
    }
    return formatClock(evaluated, transform.format ?? { kind: dateTime === null ? 'date' : 'datetime' }, zone);
  }

  private contextValue(source: 'scenario-name' | 'scenario-id' | 'sequence-position', name: string): Value {
    const context = this.env.context;
    if (context === undefined) return MISSING;
    switch (source) {
      case 'scenario-name':
        return context.scenario;
      case 'scenario-id':
        return context.ids.get(name) ?? MISSING;
      case 'sequence-position':
        return context.sequencePosition ?? MISSING;
    }
  }

  private requestValue(source: 'path' | 'query' | 'header' | 'body' | 'method', name: string): Value {
    const request = this.request;
    switch (source) {
      case 'method':
        return request.method;
      case 'path':
        return Object.hasOwn(request.params, name) ? request.params[name] : MISSING;
      case 'query':
        return request.query.find(([key]) => key === name)?.[1] ?? MISSING;
      case 'header': {
        // Received values hold one character per byte; read them as the UTF-8 text they carry.
        const value = request.headers[name]?.[0];
        return value === undefined ? MISSING : decodeFieldValue(value);
      }
      case 'body': {
        const document = this.document();
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

  /** The request body as JSON or an XML document, parsed at most once and only when a token reads it. */
  private document(): unknown {
    if (this.#document === undefined) {
      const { body, headers, xml } = this.request;
      try {
        const document = readBodyDocument(body, headers, xml ?? true);
        if (document?.kind === 'json' && exceedsJsonDepth(document.value)) {
          throw new InvalidRequest(`the request body nests deeper than ${String(MAX_CANONICAL_JSON_DEPTH)} levels`);
        }
        this.#document = { value: document?.value ?? MISSING };
      } catch (error) {
        if (error instanceof InvalidBodyDocument) throw new InvalidRequest(error.message);
        throw error;
      }
    }
    return this.#document.value;
  }

  /** The 32-byte derivation key of a token. */
  private derive(segment: Segment & { kind: 'token' }): Uint8Array {
    const { env, request } = this;
    const writer = new CanonicalWriter()
      .string('janus-dynamic-key/1')
      .number(env.seed)
      .number(env.instant)
      .string(request.method)
      .string(request.routeTemplate)
      .bytes(this.requestDigest())
      .string(env.fixtureId)
      .number(env.status)
      .number(segment.location.length);
    for (const part of segment.location) writer.string(typeof part).string(String(part));
    return writer.string(segment.token.expression).digest();
  }

  /** Path parameters, sorted query pairs and the canonical body; never headers. */
  private requestDigest(): Uint8Array {
    this.#digest ??= canonicalRequestDigest(this.request);
    return this.#digest;
  }
}

/**
 * The canonical request digest: path parameters, sorted
 * query pairs and the body, JSON canonicalised; never headers apart from the
 * `Content-Type` that says whether the body is JSON.
 */
export function canonicalRequestDigest(
  request: Pick<RenderRequest, 'params' | 'query' | 'body' | 'headers'>,
): Uint8Array {
  const { params, query, body, headers } = request;
  const writer = new CanonicalWriter().string('janus-request-digest/1');
  const names = Object.keys(params).sort(compareStrings);
  writer.number(names.length);
  for (const name of names) writer.string(name).string(params[name] ?? '');
  const pairs = [...query].sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]));
  writer.number(pairs.length);
  for (const [name, value] of pairs) writer.string(name).string(value);
  // An empty body is no body, as for `accepts.yaml`.
  if (body === null || body.length === 0) writer.string('no-body');
  else {
    const contentType = headers['content-type'];
    const json = contentType?.length === 1 && isJsonMediaType(contentType[0] ?? '') ? canonicalJson(body) : null;
    if (json === null) writer.string('bytes').bytes(body);
    else writer.string('json').string(json);
  }
  return writer.digest();
}

export { isJsonMediaType };

/** Sorted keys and no insignificant whitespace, or null when the bytes are not JSON or nest too deep. */
function canonicalJson(bytes: Uint8Array): string | null {
  const text = utf8DecodeStrict(bytes);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  return canonicalJsonText(value);
}

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * `num(…)` arithmetic: `*` and `/` before `+` and `-`, each left to right.
 * A fractional result is rounded to 15 significant digits, so `0.1+0.2` is `0.3`.
 */
function calculate(value: number, operations: Extract<RequestTransform, { kind: 'num' }>['operations']): number {
  let sum = 0;
  let term = value;
  for (const { operator, operand } of operations) {
    if (operator === '*') term *= operand;
    else if (operator === '/') term /= operand;
    else {
      sum += term;
      term = operator === '+' ? operand : -operand;
    }
  }
  const result = sum + term;
  return Number.isInteger(result) || !Number.isFinite(result) ? result : Number(result.toPrecision(15));
}

/** A whole-value token's JSON text. */
function jsonText(value: Value): string {
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  // Every value here came from JSON, a clock, or a generator checked to return JSON data.
  return JSON.stringify(value);
}

/** A token's text inside a larger string: missing is empty, strings as they are, other values as JSON. */
function embedded(value: Value): string {
  if (value === MISSING || value === null) return value === null ? 'null' : '';
  return typeof value === 'string' ? value : jsonText(value);
}

/** The inside of a JSON string literal for `text`, exactly as `JSON.stringify` escapes it. */
function escapeJson(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}
