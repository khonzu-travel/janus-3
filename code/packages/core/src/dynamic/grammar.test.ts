import { describe, expect, it } from 'vitest';

import { expandAliases, parseExpression, scanTemplate, type GrammarContext } from './grammar.js';
import { TokenRandom } from './random.js';

// The token grammar and its load-time errors.

const context = (
  pathParameters: readonly string[] | null = null,
  aliases: Record<string, string> = {},
): GrammarContext => ({
  aliases: expandAliases(aliases).aliases,
  pathParameters,
});

function spec(expression: string, grammar = context()) {
  const parsed = parseExpression(expression, grammar);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.token.spec;
}

function failure(expression: string, grammar = context()) {
  const parsed = parseExpression(expression, grammar);
  if (parsed.ok) throw new Error(`expected ${expression} to fail`);
  return { code: parsed.code, message: parsed.message };
}

describe('syntax', () => {
  it('ignores whitespace inside the braces, except in quotes', () => {
    expect(parseExpression(' today + 7d ')).toEqual(parseExpression('today+7d'));
    expect(parseExpression(' now : "dd MM" ')).toEqual(parseExpression('now:"dd MM"'));
    const parsed = parseExpression('randomFrom( "a b" , 1 )');
    expect(parsed.ok && parsed.token.expression).toBe('randomFrom("a b",1)');
  });

  it('turns {{$$ into a literal {{$ and keeps the rest as text', () => {
    const { template, problems } = scanTemplate('{{$$today}} and {{$$');
    expect(problems).toEqual([]);
    expect(template?.segments).toEqual([{ kind: 'text', text: '{{$today}} and {{$' }]);
    expect(template?.tokens).toBe(0);
  });

  it('leaves strings without {{$ alone', () => {
    expect(scanTemplate('{{ now }} {$today} $today')).toEqual({ template: null, problems: [] });
  });

  it('closes a token on the first }}, so a quoted format containing }} is rejected', () => {
    const { problems } = scanTemplate('{{$today:"a}}b"}}');
    expect(problems).toEqual([expect.objectContaining({ code: 'invalid-dynamic-token', offset: 0 })]);
    expect(problems[0]?.message).toContain('first "}}"');
  });

  it('reports a token without a closing }}', () => {
    expect(scanTemplate('x {{$today').problems).toEqual([
      expect.objectContaining({ code: 'invalid-dynamic-token', offset: 2, token: '{{$today' }),
    ]);
  });

  it('records each token’s offsets and ordinal', () => {
    const { template } = scanTemplate('a{{$uuid}}b{{$ uuid }}');
    expect(template?.segments).toMatchObject([
      { kind: 'text', text: 'a' },
      { kind: 'token', start: 1, end: 10, ordinal: 0 },
      { kind: 'text', text: 'b' },
      { kind: 'token', start: 11, end: 22, ordinal: 1 },
    ]);
  });

  it('round-trips: a token’s normalised expression parses to the same token (property)', () => {
    const random = new TokenRandom(new Uint8Array(32).fill(3));
    const pick = <T>(list: readonly T[]): T => list[random.integer(0, list.length - 1)] as T;
    const bases = ['now', 'today', 'tomorrow', 'endOfMonth', 'epoch', 'startOfDay'];
    const units = ['ms', 's', 'min', 'h', 'd', 'w', 'mo', 'y'];
    const formats = ['', ':date', ':datetime', ':time', ':unix', ':unixMillis', ':http', ':"yyyy MM dd"'];
    const zones = ['', '@UTC', '@Asia/Tokyo', '@America/New_York'];
    const others = [
      'uuid',
      'ulid:unique',
      'randomInt(-3,9)',
      'randomFrom("x",true,null,2.5)',
      'method',
      'query.page',
      'header.X-Id',
      'body.$.a[0]',
      'faker.person.firstName',
    ];
    const space = (text: string): string =>
      text
        .split('')
        .map((char, i) => (i > 0 && random.integer(0, 3) === 0 && !text.slice(0, i).includes('"') ? ` ${char}` : char))
        .join('');
    for (let i = 0; i < 300; i++) {
      let expression: string;
      if (random.integer(0, 2) === 0) expression = pick(others);
      else {
        let offsets = '';
        for (let n = random.integer(0, 3); n > 0; n--)
          offsets += `${pick(['+', '-'])}${String(random.integer(0, 40))}${pick(units)}`;
        expression = `${pick(bases)}${offsets}${pick(zones)}${pick(formats)}`;
      }
      const first = parseExpression(space(expression));
      expect(first.ok, expression).toBe(true);
      if (!first.ok) continue;
      expect(first.token.expression).toBe(expression);
      expect(parseExpression(first.token.expression)).toEqual(first);
    }
  });
});

describe('bases', () => {
  it('parses clock bases with their default formats', () => {
    expect(spec('now')).toEqual({ category: 'clock', start: 'now', steps: [], zone: null, format: { kind: 'utc' } });
    expect(spec('today')).toMatchObject({ start: 'today', format: { kind: 'date' } });
    expect(spec('now@Asia/Tokyo')).toMatchObject({ zone: 'Asia/Tokyo', format: { kind: 'datetime' } });
    expect(spec('epoch')).toMatchObject({ start: 'now', format: { kind: 'unix' } });
  });

  it('parses request bases', () => {
    expect(spec('path.productId', context(['productId']))).toEqual({
      category: 'request',
      source: 'path',
      name: 'productId',
    });
    expect(spec('query.page')).toMatchObject({ source: 'query', name: 'page' });
    expect(spec('header.X-Request-Id')).toMatchObject({ source: 'header', name: 'x-request-id' });
    expect(spec('body.$.customer.name')).toMatchObject({ source: 'body', name: '$.customer.name' });
    expect(spec('body.$..items[?(@.qty > 1)].sku')).toMatchObject({ source: 'body', name: '$..items[?(@.qty>1)].sku' });
    // An XML attribute step is a member name, not a time zone.
    expect(spec('body.$.order.@id')).toMatchObject({ source: 'body', name: '$.order.@id' });
    expect(spec('method')).toMatchObject({ source: 'method' });
  });

  it('parses generators and :unique', () => {
    expect(spec('uuid')).toEqual({ category: 'generator', generator: { kind: 'uuid' }, unique: false });
    expect(spec('ulid:unique')).toMatchObject({ generator: { kind: 'ulid' }, unique: true });
    expect(spec('randomBool')).toMatchObject({ generator: { kind: 'randomBool' } });
    expect(spec('randomInt(-5, 5)')).toMatchObject({ generator: { kind: 'randomInt', min: -5, max: 5 } });
    expect(spec('randomInt(3,3)')).toMatchObject({ generator: { min: 3, max: 3 } });
    expect(spec('randomFrom("a,b", "c)", "", 1, -2.5e3, true, null)')).toMatchObject({
      generator: { kind: 'randomFrom', values: ['a,b', 'c)', '', 1, -2500, true, null] },
    });
    expect(spec('randomFrom("\\u00e9\\"")')).toMatchObject({ generator: { values: ['é"'] } });
    expect(spec('faker.commerce.productName:unique')).toMatchObject({
      generator: { kind: 'faker', module: 'commerce', method: 'productName' },
      unique: true,
    });
  });

  it('expands custom aliases, which may refer to other aliases', () => {
    const grammar = context(null, { trialEnd: 'today+30d', graceEnd: 'trialEnd+7d', stamp: 'epoch' });
    expect(spec('graceEnd-1d', grammar)).toMatchObject({
      start: 'today',
      steps: [
        { kind: 'add', amount: 30, unit: 'd' },
        { kind: 'add', amount: 7, unit: 'd' },
        { kind: 'add', amount: -1, unit: 'd' },
      ],
    });
    expect(spec('stamp', grammar)).toMatchObject({ format: { kind: 'unix' } });
  });
});

describe('load-time errors', () => {
  it.each([
    ['tommorow', 'unknown-dynamic-token', 'did you mean "tomorrow"?'],
    ['Today', 'unknown-dynamic-token', 'did you mean "today"?'],
    ['randomint(1,2)', 'unknown-dynamic-token', 'did you mean "randomInt"?'],
    ['xyz', 'unknown-dynamic-token', 'unknown dynamic value "xyz"'],
    ['', 'invalid-dynamic-token', 'empty'],
    ['7d', 'invalid-dynamic-token', 'does not start with a value name'],
    ['today+7', 'invalid-dynamic-token', 'needs a unit'],
    ['today+', 'invalid-dynamic-token', 'must be followed by an amount'],
    ['now+1m', 'invalid-dynamic-token', 'write min for minutes or mo for months'],
    ['now+1M', 'invalid-dynamic-token', 'write min for minutes or mo for months'],
    ['now+1q', 'invalid-dynamic-token', '"q" is not a unit'],
    ['today+99999999999999999d', 'invalid-dynamic-token', 'too large'],
    ['now:iso', 'invalid-dynamic-token', 'unknown format "iso"'],
    ['now:"yyyy-QQ"', 'invalid-dynamic-token', '"QQ" is not a supported pattern field'],
    ['now:"yyy"', 'invalid-dynamic-token', '"yyy" is not a supported pattern field'],
    ['now:"\'x"', 'invalid-dynamic-token', 'unterminated quoted text'],
    ['now:"dd', 'invalid-dynamic-token', 'unterminated double quote'],
    ['now:unique', 'invalid-dynamic-token', ':unique applies only to generated values'],
    ['now:date@UTC', 'invalid-dynamic-token', 'time zone must come before the format'],
    ['now@UTC+1d', 'invalid-dynamic-token', 'offsets must come before the time zone'],
    ['now@Mars/Olympus', 'unknown-timezone', '"Mars/Olympus" is not an IANA time zone'],
    ['now@', 'invalid-dynamic-token', 'needs an IANA time zone'],
    ['uuid+1d', 'invalid-dynamic-token', 'offsets apply only to clock values'],
    ['uuid@UTC', 'invalid-dynamic-token', 'time zones apply only to clock values'],
    ['uuid:date', 'invalid-dynamic-token', 'formats apply only to clock values'],
    ['uuid()', 'invalid-dynamic-token', 'takes no arguments'],
    ['query.page+1d', 'invalid-dynamic-token', 'offsets apply only to clock values'],
    ['query.page:unique', 'invalid-dynamic-token', ':unique applies only to generated values'],
    ['header.x@UTC', 'invalid-dynamic-token', 'time zones apply only'],
    ['method:date', 'invalid-dynamic-token', 'formats apply only'],
    ['body.$.a:date', 'invalid-dynamic-token', 'do not apply to body values'],
    ['body.$.a@UTC', 'invalid-dynamic-token', 'do not apply to body values'],
    ['body.a', 'invalid-dynamic-token', 'starting with "$"'],
    ['body.$[?(@.a ==)]', 'invalid-dynamic-token', 'not a valid JSONPath'],
    ['query', 'invalid-dynamic-token', 'needs a name after a dot'],
    ['randomInt', 'invalid-dynamic-token', 'takes arguments in parentheses'],
    ['randomInt(1)', 'invalid-dynamic-token', 'two integers'],
    ['randomInt(5,1)', 'invalid-dynamic-token', 'needs min <= max'],
    ['randomInt(1.5,2)', 'invalid-dynamic-token', 'base-10 integers'],
    ['randomInt(0x1,2)', 'invalid-dynamic-token', 'base-10 integers'],
    ['randomInt(0,9007199254740992)', 'invalid-dynamic-token', 'not a safe integer'],
    ['randomInt(1,2', 'invalid-dynamic-token', 'missing ")"'],
    ['randomFrom()', 'invalid-dynamic-token', 'non-empty list'],
    ['randomFrom(a,b)', 'invalid-dynamic-token', 'JSON scalars'],
    ['randomFrom("a",)', 'invalid-dynamic-token', 'non-empty list'],
    ['randomFrom([1])', 'invalid-dynamic-token', 'JSON scalars'],
    ['randomFrom("\\x")', 'invalid-dynamic-token', 'not a valid JSON string'],
    ['faker.person', 'invalid-dynamic-token', 'faker.<module>.<method>'],
    ['faker.person.fullNam', 'impure-faker-path', 'did you mean "faker.person.fullName"?'],
    ['faker.date.past', 'impure-faker-path', 'depends on the current date'],
    ['faker.helpers.arrayElement', 'impure-faker-path', 'needs arguments'],
    ['faker.string.fromCharacters', 'impure-faker-path', 'needs arguments'],
    ['faker.git.commitEntry', 'impure-faker-path', 'depends on the current date'],
    ['faker.person.constructor', 'impure-faker-path', 'not a faker generator'],
    ['faker.fakerCore.randomizer', 'impure-faker-path', 'not a faker generator'],
  ])('%j is %s', (expression, code, message) => {
    const result = failure(expression);
    expect(result.code).toBe(code);
    expect(result.message).toContain(message);
  });

  it('checks path parameters against the route', () => {
    expect(failure('path.productID', context(['productId']))).toEqual({
      code: 'unknown-path-parameter',
      message:
        'path.productID is not a parameter of this route; the route binds {productId}; did you mean "path.productId"?',
    });
    expect(failure('path.id', context([])).message).toContain('the route binds no parameters');
    expect(spec('path.anything', context(null))).toMatchObject({ name: 'anything' });
  });
});
