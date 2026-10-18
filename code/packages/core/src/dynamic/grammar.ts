import { suggest } from '../suggest.js';
import { checkJsonPath } from './jsonpath.js';
import { checkFakerPath, fakerPaths } from './random.js';
import { isValidTimeZone } from './time.js';
import type {
  ClockStep,
  DynamicErrorCode,
  DynamicProblem,
  DynamicToken,
  FormatSpec,
  GeneratorSpec,
  JsonScalar,
  PatternField,
  PatternPart,
  Segment,
  Template,
  TokenSpec,
  Unit,
} from './types.js';

/**
 * The token grammar:
 *
 *     {{$ base [offset…] [@timezone] [:format] [:unique] }}
 *
 * Whitespace outside quotes is ignored, `{{$$` is a literal `{{$`, and a token
 * ends at the first `}}`. Parsing checks everything that can be known before a
 * request arrives, so a mistake is a startup error, never a wrong response.
 */

/** What a clock alias stands for: a start, steps, and (for `epoch`) a default format. */
export interface ClockExpansion {
  readonly start: 'now' | 'today';
  readonly steps: readonly ClockStep[];
  readonly format: FormatSpec | null;
}

export interface GrammarContext {
  /** Custom aliases from `dynamic.aliases`, already validated and expanded. */
  readonly aliases: ReadonlyMap<string, ClockExpansion>;
  /** The parameters the fixture's route binds; null skips the `path.<name>` check. */
  readonly pathParameters: readonly string[] | null;
  /**
   * Whether the method directory has `sequence.yaml` or a rule sequence, so
   * `{{$sequence.position}}` has a sequence to read. Allowed when absent.
   */
  readonly sequencePosition?: boolean;
}

export const EMPTY_GRAMMAR: GrammarContext = Object.freeze({ aliases: new Map(), pathParameters: null });

const add = (amount: number, unit: Unit): ClockStep => ({ kind: 'add', amount, unit });

/** Built-in aliases: sugar over `now`/`today` with an offset or snap. */
export const BUILT_IN_ALIASES: ReadonlyMap<string, ClockExpansion> = new Map<string, ClockExpansion>([
  ['tomorrow', { start: 'today', steps: [add(1, 'd')], format: null }],
  ['yesterday', { start: 'today', steps: [add(-1, 'd')], format: null }],
  ['oneWeekFromToday', { start: 'today', steps: [add(1, 'w')], format: null }],
  ['oneWeekAgo', { start: 'today', steps: [add(-1, 'w')], format: null }],
  ['oneMonthFromToday', { start: 'today', steps: [add(1, 'mo')], format: null }],
  ['oneYearFromToday', { start: 'today', steps: [add(1, 'y')], format: null }],
  ['startOfDay', { start: 'now', steps: [{ kind: 'snap', to: 'startOfDay' }], format: null }],
  ['endOfDay', { start: 'now', steps: [{ kind: 'snap', to: 'endOfDay' }], format: null }],
  ['startOfMonth', { start: 'today', steps: [{ kind: 'snap', to: 'startOfMonth' }], format: null }],
  ['endOfMonth', { start: 'today', steps: [{ kind: 'snap', to: 'endOfMonth' }], format: null }],
  ['epoch', { start: 'now', steps: [], format: { kind: 'unix' } }],
]);

const CLOCK_BASES = ['now', 'today'] as const;
const SIMPLE_GENERATORS = ['uuid', 'ulid', 'randomBool'] as const;
const REQUEST_PREFIXES = ['path', 'query', 'header', 'body'] as const;

/** Every name a custom alias may not take, and every base "did you mean" can suggest. */
export const BUILT_IN_NAMES: readonly string[] = Object.freeze([
  ...CLOCK_BASES,
  ...BUILT_IN_ALIASES.keys(),
  ...SIMPLE_GENERATORS,
  'randomInt',
  'randomFrom',
  'method',
  'faker',
  ...REQUEST_PREFIXES,
  'scenario',
  'sequence',
]);

const UNITS: readonly Unit[] = ['ms', 'min', 'mo', 's', 'h', 'd', 'w', 'y'];
const FORMATS = ['date', 'datetime', 'time', 'unix', 'unixMillis', 'http'] as const;
const PATTERN_FIELDS: ReadonlySet<string> = new Set<PatternField>([
  'yyyy',
  'yy',
  'MM',
  'M',
  'dd',
  'd',
  'HH',
  'H',
  'mm',
  'ss',
  'SSS',
  'EEE',
  'MMM',
  'XXX',
]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+/;
const QUERY_NAME = /^[^:@"']+/;
const TRAILING_OFFSET = /[+-]\d+(?:ms|min|mo|s|h|d|w|y)$/;
const TRAILING_SUFFIX =
  /(?::(?:date|datetime|time|unix|unixMillis|http|unique|"[^"]*")|(?<!\.)@[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)*)$/;

export type ParseResult =
  | { readonly ok: true; readonly token: DynamicToken }
  | { readonly ok: false; readonly code: DynamicErrorCode; readonly message: string };

class GrammarError extends Error {
  constructor(
    readonly code: DynamicErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const invalid = (message: string): never => {
  throw new GrammarError('invalid-dynamic-token', message);
};

/** Parses the text between `{{$` and `}}`. */
export function parseExpression(inner: string, context: GrammarContext = EMPTY_GRAMMAR): ParseResult {
  try {
    const expression = stripWhitespace(inner);
    return { ok: true, token: Object.freeze({ expression, spec: Object.freeze(parseSpec(expression, context)) }) };
  } catch (error) {
    if (error instanceof GrammarError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}

/**
 * Finds every token and escape in a string. Returns a template when the
 * string must be rendered (it has a token or a `{{$$`), and every problem.
 */
export function scanTemplate(
  text: string,
  context: GrammarContext = EMPTY_GRAMMAR,
  locate: (start: number, ordinal: number) => readonly (string | number)[] = (start) => [start],
): { readonly template: Template | null; readonly problems: readonly DynamicProblem[] } {
  if (!text.includes('{{$')) return { template: null, problems: [] };
  const segments: Segment[] = [];
  const problems: DynamicProblem[] = [];
  let literal = '';
  let index = 0;
  let ordinal = 0;
  for (;;) {
    const start = text.indexOf('{{$', index);
    if (start === -1) {
      literal += text.slice(index);
      break;
    }
    literal += text.slice(index, start);
    if (text.charAt(start + 3) === '$') {
      literal += '{{$';
      index = start + 4;
      continue;
    }
    const close = text.indexOf('}}', start + 3);
    if (close === -1) {
      const token = text.slice(start, start + 40);
      problems.push({
        code: 'invalid-dynamic-token',
        message: 'the token has no closing "}}"; write {{$$ for a literal {{$',
        offset: start,
        token: token.length < text.length - start ? `${token}…` : token,
      });
      literal += text.slice(start);
      break;
    }
    const end = close + 2;
    const parsed = parseExpression(text.slice(start + 3, close), context);
    if (parsed.ok) {
      if (literal !== '') segments.push({ kind: 'text', text: literal });
      literal = '';
      segments.push({ kind: 'token', token: parsed.token, start, end, ordinal, location: locate(start, ordinal) });
      ordinal++;
    } else {
      problems.push({ code: parsed.code, message: parsed.message, offset: start, token: text.slice(start, end) });
      literal += text.slice(start, end);
    }
    index = end;
  }
  if (literal !== '') segments.push({ kind: 'text', text: literal });
  return { template: Object.freeze({ segments: Object.freeze(segments), tokens: ordinal }), problems };
}

/** Removes whitespace outside single- and double-quoted text; an unclosed quote is an error. */
function stripWhitespace(inner: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const char = inner.charAt(i);
    if (quote !== null) {
      out += char;
      if (char === '\\' && quote === '"' && i + 1 < inner.length) out += inner.charAt(++i);
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      out += char;
    } else if (!/\s/.test(char)) {
      out += char;
    }
  }
  if (quote !== null)
    invalid(`unterminated ${quote === '"' ? 'double' : 'single'} quote; a token ends at the first "}}"`);
  return out;
}

function parseSpec(expression: string, context: GrammarContext): TokenSpec {
  if (expression === '') return invalid('the token is empty; name a value such as {{$now}}');

  const contextual = /^(scenario|sequence)(?=$|[.+\-@:])/.exec(expression)?.[1];
  if (contextual !== undefined) return parseContext(expression, context);

  const prefix = /^(path|query|header|body)\./.exec(expression)?.[1] as (typeof REQUEST_PREFIXES)[number] | undefined;
  if (prefix !== undefined) return parseRequest(prefix, expression.slice(prefix.length + 1), context);
  if (expression.startsWith('faker.')) return parseFaker(expression.slice(6));

  const name = IDENTIFIER.exec(expression)?.[0];
  if (name === undefined) return invalid(`"${expression}" does not start with a value name such as now or uuid`);
  const rest = expression.slice(name.length);

  if (name === 'method') {
    if (rest !== '') rejectSuffix(rest, 'method');
    return { category: 'request', source: 'method', name: '' };
  }
  if ((REQUEST_PREFIXES as readonly string[]).includes(name) || name === 'faker') {
    return invalid(`"${name}" needs a name after a dot, e.g. ${name === 'body' ? 'body.$.id' : `${name}.id`}`);
  }
  if (name === 'randomInt' || name === 'randomFrom') {
    if (!rest.startsWith('(')) return invalid(`${name} takes arguments in parentheses, e.g. ${exampleOf(name)}`);
    const close = closingParen(rest);
    const generator =
      name === 'randomInt' ? parseRandomInt(rest.slice(1, close)) : parseRandomFrom(rest.slice(1, close));
    return generatorSpec(generator, rest.slice(close + 1), name);
  }
  if ((SIMPLE_GENERATORS as readonly string[]).includes(name)) {
    if (rest.startsWith('(')) return invalid(`${name} takes no arguments`);
    return generatorSpec({ kind: name as (typeof SIMPLE_GENERATORS)[number] }, rest, name);
  }

  const expansion: ClockExpansion | undefined =
    name === 'now' || name === 'today'
      ? { start: name, steps: [], format: null }
      : (BUILT_IN_ALIASES.get(name) ?? context.aliases.get(name));
  if (expansion === undefined) {
    const suggestion = suggest(name, [...BUILT_IN_NAMES, ...context.aliases.keys()]);
    throw new GrammarError(
      'unknown-dynamic-token',
      `unknown dynamic value "${name}"${suggestion === null ? '' : `; did you mean "${suggestion}"?`}`,
    );
  }
  return parseClock(expansion, rest);
}

const SCENARIO_ID = /^scenario\.ids\.([A-Za-z][A-Za-z0-9_]{0,63})(.*)$/;

/** `scenario.name`, `scenario.ids.<name>` and `sequence.position`: no offsets, zones or formats. */
function parseContext(expression: string, context: GrammarContext): TokenSpec {
  const suffix = (rest: string, name: string): void => {
    if (rest !== '') rejectSuffix(rest, name);
  };
  if (expression.startsWith('scenario.name')) {
    suffix(expression.slice('scenario.name'.length), 'scenario.name');
    return { category: 'context', source: 'scenario-name', name: '' };
  }
  const id = SCENARIO_ID.exec(expression);
  if (id !== null) {
    suffix(id[2] ?? '', 'scenario.ids values');
    return { category: 'context', source: 'scenario-id', name: id[1] ?? '' };
  }
  if (expression.startsWith('sequence.position')) {
    suffix(expression.slice('sequence.position'.length), 'sequence.position');
    if (context.sequencePosition === false) {
      throw new GrammarError(
        'unknown-dynamic-token',
        'sequence.position needs sequence.yaml or a rule sequence in this method directory',
      );
    }
    return { category: 'context', source: 'sequence-position', name: '' };
  }
  return expression.startsWith('scenario')
    ? invalid('scenario values are scenario.name or scenario.ids.<name>, e.g. scenario.ids.cartId')
    : invalid('the sequence value is sequence.position');
}

function exampleOf(name: 'randomInt' | 'randomFrom'): string {
  return name === 'randomInt' ? 'randomInt(1,5)' : 'randomFrom("a","b")';
}

/** Offsets, `@zone`, `:format` — in that order — after a clock base or alias. */
function parseClock(expansion: ClockExpansion, text: string): TokenSpec {
  const { steps, rest: afterOffsets } = parseOffsets(text);
  let rest = afterOffsets;
  let zone: string | null = null;
  if (rest.startsWith('@')) {
    const match = /^@([^:]*)/.exec(rest);
    zone = match?.[1] ?? '';
    if (zone === '') return invalid('"@" needs an IANA time zone, e.g. @Europe/Paris');
    if (TRAILING_OFFSET.test(zone) && !isValidTimeZone(zone)) {
      return invalid('offsets must come before the time zone and format');
    }
    if (!isValidTimeZone(zone)) {
      throw new GrammarError('unknown-timezone', `"${zone}" is not an IANA time zone, e.g. Europe/Paris or UTC`);
    }
    rest = rest.slice(zone.length + 1);
  }
  let format: FormatSpec | null = null;
  if (rest.startsWith(':')) {
    const parsed = parseFormat(rest.slice(1));
    format = parsed.format;
    rest = parsed.rest;
  }
  if (rest.startsWith(':unique')) return invalid(':unique applies only to generated values such as uuid');
  if (rest.startsWith('@')) return invalid('the time zone must come before the format');
  if (rest.startsWith('+') || rest.startsWith('-')) return invalid('offsets must come before the time zone and format');
  if (rest !== '') return invalid(`unexpected "${rest}"`);
  const start = expansion.start;
  return {
    category: 'clock',
    start,
    steps: Object.freeze([...expansion.steps, ...steps]),
    zone,
    format:
      format ??
      expansion.format ??
      (start === 'today' ? { kind: 'date' } : zone === null ? { kind: 'utc' } : { kind: 'datetime' }),
  };
}

/** `+1mo-1d`, `+2h15min`: signed groups of one or more amount-unit pairs. */
export function parseOffsets(text: string): { readonly steps: ClockStep[]; readonly rest: string } {
  const steps: ClockStep[] = [];
  let rest = text;
  while (rest.startsWith('+') || rest.startsWith('-')) {
    const sign = rest.startsWith('-') ? -1 : 1;
    rest = rest.slice(1);
    let pairs = 0;
    for (;;) {
      const digits = /^\d+/.exec(rest)?.[0];
      if (digits === undefined) break;
      const after = rest.slice(digits.length);
      const unit = UNITS.find((candidate) => after.startsWith(candidate));
      if (unit === undefined) {
        const letter = /^[A-Za-z]+/.exec(after)?.[0];
        if (letter === undefined) return invalid(`the offset ${digits} needs a unit: ${UNITS.join(', ')}`);
        if (letter === 'm' || letter === 'M' || letter.startsWith('m') || letter.startsWith('M')) {
          return invalid(`"${letter}" is not a unit; write min for minutes or mo for months`);
        }
        return invalid(`"${letter}" is not a unit; use one of ${UNITS.join(', ')}`);
      }
      const amount = Number(digits);
      if (!Number.isSafeInteger(amount)) return invalid(`the offset ${digits} is too large`);
      steps.push({ kind: 'add', amount: sign * amount, unit });
      rest = after.slice(unit.length);
      pairs++;
    }
    if (pairs === 0) return invalid(`"${sign < 0 ? '-' : '+'}" must be followed by an amount and unit, e.g. +7d`);
  }
  return { steps, rest };
}

function parseFormat(text: string): { format: FormatSpec | null; rest: string } {
  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1);
    if (close === -1) return invalid('unterminated format pattern');
    return { format: { kind: 'pattern', parts: parsePattern(text.slice(1, close)) }, rest: text.slice(close + 1) };
  }
  const word = /^[A-Za-z]+/.exec(text)?.[0] ?? '';
  if (word === 'unique') return { format: null, rest: `:${text}` };
  if (!(FORMATS as readonly string[]).includes(word)) {
    const suggestion = suggest(word, FORMATS);
    return invalid(
      `unknown format "${word}"; use ${FORMATS.join(', ')} or a quoted pattern${suggestion === null ? '' : ` (did you mean "${suggestion}"?)`}`,
    );
  }
  return { format: { kind: word as (typeof FORMATS)[number] }, rest: text.slice(word.length) };
}

/** Pattern letters; text in single quotes is literal and `''` is a quote. */
export function parsePattern(pattern: string): readonly PatternPart[] {
  const parts: PatternPart[] = [];
  let literal = '';
  const flush = (): void => {
    if (literal !== '') parts.push({ kind: 'literal', text: literal });
    literal = '';
  };
  for (let i = 0; i < pattern.length;) {
    const char = pattern.charAt(i);
    if (char === "'") {
      if (pattern.charAt(i + 1) === "'") {
        literal += "'";
        i += 2;
        continue;
      }
      let j = i + 1;
      for (;;) {
        if (j >= pattern.length) return invalid('unterminated quoted text in the format pattern');
        if (pattern.charAt(j) !== "'") literal += pattern.charAt(j++);
        else if (pattern.charAt(j + 1) === "'") {
          literal += "'";
          j += 2;
        } else break;
      }
      i = j + 1;
      continue;
    }
    if (/[A-Za-z]/.test(char)) {
      let end = i;
      while (pattern.charAt(end) === char) end++;
      const run = pattern.slice(i, end);
      if (!PATTERN_FIELDS.has(run)) {
        return invalid(
          `"${run}" is not a supported pattern field; use yyyy, yy, MM, M, dd, d, HH, H, mm, ss, SSS, EEE, MMM or XXX, and quote literal letters`,
        );
      }
      flush();
      parts.push({ kind: 'field', field: run as PatternField });
      i = end;
      continue;
    }
    literal += char;
    i++;
  }
  flush();
  return Object.freeze(parts);
}

function generatorSpec(generator: GeneratorSpec, rest: string, name: string): TokenSpec {
  if (rest === ':unique') return { category: 'generator', generator, unique: true };
  if (rest === '') return { category: 'generator', generator, unique: false };
  return rejectSuffix(rest, name);
}

/** Offsets, zones and formats belong to clock values; `:unique` to generators. */
function rejectSuffix(rest: string, name: string): never {
  if (rest.startsWith('+') || rest.startsWith('-')) return invalid(`offsets apply only to clock values, not ${name}`);
  if (rest.startsWith('@')) return invalid(`time zones apply only to clock values, not ${name}`);
  if (rest.startsWith(':unique')) return invalid(`:unique applies only to generated values, not ${name}`);
  if (rest.startsWith(':')) return invalid(`formats apply only to clock values, not ${name}`);
  return invalid(`unexpected "${rest}" after ${name}`);
}

function parseRequest(source: (typeof REQUEST_PREFIXES)[number], text: string, context: GrammarContext): TokenSpec {
  if (source === 'body') {
    if (TRAILING_SUFFIX.test(text) || TRAILING_OFFSET.test(text)) {
      return invalid('offsets, time zones, formats and :unique do not apply to body values');
    }
    const problem = checkJsonPath(text);
    if (problem !== null) return invalid(problem);
    return { category: 'request', source, name: text };
  }
  const pattern = source === 'path' ? IDENTIFIER : source === 'header' ? HEADER_NAME : QUERY_NAME;
  const name = pattern.exec(text)?.[0];
  if (name === undefined) return invalid(`${source}. needs a ${source === 'header' ? 'header' : 'parameter'} name`);
  const rest = text.slice(name.length);
  if (rest !== '' || TRAILING_OFFSET.test(name)) {
    return rejectSuffix(rest === '' ? (TRAILING_OFFSET.exec(name)?.[0] ?? rest) : rest, `${source} values`);
  }
  if (source === 'path' && context.pathParameters !== null && !context.pathParameters.includes(name)) {
    const bound = context.pathParameters;
    const suggestion = suggest(name, bound);
    const available =
      bound.length === 0 ? 'the route binds no parameters' : `the route binds ${bound.map((p) => `{${p}}`).join(', ')}`;
    throw new GrammarError(
      'unknown-path-parameter',
      `path.${name} is not a parameter of this route; ${available}${suggestion === null ? '' : `; did you mean "path.${suggestion}"?`}`,
    );
  }
  return { category: 'request', source, name: source === 'header' ? name.toLowerCase() : name };
}

function parseFaker(text: string): TokenSpec {
  const match = /^([A-Za-z][A-Za-z0-9]*)\.([A-Za-z][A-Za-z0-9]*)/.exec(text);
  if (match === null) return invalid('faker values are written faker.<module>.<method>, e.g. faker.person.firstName');
  const [path = '', module = '', method = ''] = match;
  const reason = checkFakerPath(module, method);
  if (reason !== null) {
    const suggestion = suggest(path, fakerPaths());
    throw new GrammarError(
      'impure-faker-path',
      `${reason}${suggestion === null || suggestion === path ? '' : `; did you mean "faker.${suggestion}"?`}`,
    );
  }
  return generatorSpec({ kind: 'faker', module, method }, text.slice(path.length), `faker.${path}`);
}

/** The index of the ")" matching the "(" at 0, skipping JSON strings. */
function closingParen(text: string): number {
  let quoted = false;
  for (let i = 1; i < text.length; i++) {
    const char = text.charAt(i);
    if (quoted) {
      if (char === '\\') i++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ')') return i;
  }
  return invalid('missing ")"');
}

function parseRandomInt(args: string): GeneratorSpec {
  const parts = args.split(',');
  if (parts.length !== 2) return invalid('randomInt takes two integers: randomInt(min,max)');
  const [min, max] = parts.map((part) => {
    if (!/^[+-]?\d+$/.test(part)) return invalid(`randomInt arguments must be base-10 integers, got "${part}"`);
    const value = Number(part);
    if (!Number.isSafeInteger(value)) return invalid(`${part} is not a safe integer`);
    return value;
  }) as [number, number];
  if (min > max) return invalid(`randomInt(${String(min)},${String(max)}) needs min <= max`);
  return { kind: 'randomInt', min, max };
}

const JSON_LITERAL = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

function parseRandomFrom(args: string): GeneratorSpec {
  const values: JsonScalar[] = [];
  let i = 0;
  for (;;) {
    let raw: string;
    if (args.charAt(i) === '"') {
      let end = i + 1;
      while (end < args.length && args.charAt(end) !== '"') end += args.charAt(end) === '\\' ? 2 : 1;
      raw = args.slice(i, end + 1);
      i = end + 1;
    } else {
      const comma = args.indexOf(',', i);
      raw = args.slice(i, comma === -1 ? args.length : comma);
      i += raw.length;
      if (!JSON_LITERAL.test(raw)) {
        return invalid(
          raw === ''
            ? 'randomFrom needs a non-empty list of JSON values: strings in double quotes, numbers, true, false or null'
            : `randomFrom values are JSON scalars; "${raw}" is not (quote strings with ")`,
        );
      }
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return invalid(`randomFrom value ${raw} is not a valid JSON string`);
    }
    values.push(value as JsonScalar);
    if (i >= args.length) break;
    if (args.charAt(i) !== ',') return invalid(`unexpected "${args.slice(i)}" in randomFrom`);
    i++;
  }
  return { kind: 'randomFrom', values: Object.freeze(values) };
}

/**
 * Validates and expands `dynamic.aliases`. Each expression is
 * `<base><offsets>` where the base is `now`, `today`, a built-in alias or
 * another custom alias. Returns the expansions and, per bad alias, a message.
 */
export function expandAliases(raw: Readonly<Record<string, string>>): {
  readonly aliases: ReadonlyMap<string, ClockExpansion>;
  readonly problems: readonly { readonly name: string; readonly message: string }[];
} {
  const problems: { name: string; message: string }[] = [];
  const done = new Map<string, ClockExpansion>();
  const failed = new Set<string>();

  const resolve = (name: string, trail: readonly string[]): ClockExpansion | null => {
    const known = done.get(name);
    if (known !== undefined) return known;
    if (failed.has(name)) return null;
    const fail = (message: string): null => {
      failed.add(name);
      problems.push({ name, message });
      return null;
    };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      return fail(`alias name "${name}" must be a letter or "_" followed by letters, digits or "_"`);
    if (BUILT_IN_NAMES.includes(name)) return fail(`alias "${name}" shadows the built-in value of the same name`);
    if (trail.includes(name)) return fail(`alias "${name}" refers to itself through ${[...trail, name].join(' → ')}`);
    const expression = stripSafely(raw[name] ?? '');
    const base = IDENTIFIER.exec(expression)?.[0];
    if (base === undefined) return fail(`alias "${name}" must be a clock value and offsets, e.g. today+30d`);
    let expansion: ClockExpansion | null | undefined =
      base === 'now' || base === 'today' ? { start: base, steps: [], format: null } : BUILT_IN_ALIASES.get(base);
    if (expansion === undefined) {
      if (!Object.hasOwn(raw, base)) {
        const suggestion = suggest(base, [...CLOCK_BASES, ...BUILT_IN_ALIASES.keys(), ...Object.keys(raw)]);
        return fail(
          `alias "${name}" expands to unknown value "${base}"${suggestion === null ? '' : `; did you mean "${suggestion}"?`}`,
        );
      }
      expansion = resolve(base, [...trail, name]);
      if (expansion === null) {
        if (!failed.has(name)) fail(`alias "${name}" depends on invalid alias "${base}"`);
        return null;
      }
    }
    let steps: ClockStep[];
    try {
      const parsed = parseOffsets(expression.slice(base.length));
      if (parsed.rest !== '') return fail(`alias "${name}" may only add offsets to ${base}, found "${parsed.rest}"`);
      steps = parsed.steps;
    } catch (error) {
      if (error instanceof GrammarError) return fail(`alias "${name}": ${error.message}`);
      throw error;
    }
    const result: ClockExpansion = Object.freeze({
      start: expansion.start,
      steps: Object.freeze([...expansion.steps, ...steps]),
      format: expansion.format,
    });
    done.set(name, result);
    return result;
  };

  for (const name of Object.keys(raw).sort()) resolve(name, []);
  return { aliases: done, problems };
}

function stripSafely(text: string): string {
  try {
    return stripWhitespace(text);
  } catch {
    return text;
  }
}
