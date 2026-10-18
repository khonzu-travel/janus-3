import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import { parseExpect, parsePages, parseSequence, parseVariants } from '../fixtures/controls.js';
import { cookieNamed, parseCookies } from '../http/cookie.js';
import { ifNoneMatchMatches, parseEntityTag, parseIfNoneMatch } from '../http/etag.js';
import { parseIdempotencyKey } from '../http/idempotency.js';
import type { HeaderMap } from '../types/index.js';
import { describeCondition, firstMatchingRule, pageText } from './choose.js';
import {
  failing,
  holds,
  InvalidRequestBody,
  MISSING,
  requestFacts,
  type Condition,
  type RequestFacts,
} from './conditions.js';

// The condition language and control files.

const CONTEXT = { pathParameters: ['orderId'] };

/** The conditions of a one-rule variants.yaml whose `when` is `when`. */
function conditions(when: string): readonly Condition[] {
  const result = parseVariants(utf8Encode(`rules:\n  - when: ${when}\n    serve: 200.x\n`), CONTEXT);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.control.rules[0]?.when ?? [];
}

/** The problems a variants.yaml whose only rule has `when` reports. */
function problems(when: string): string[] {
  const result = parseVariants(utf8Encode(`rules:\n  - when: ${when}\n    serve: 200.x\n`), CONTEXT);
  return result.ok ? [] : result.problems.map((problem) => `${problem.code}: ${problem.message}`);
}

function facts(
  input: {
    params?: Record<string, string>;
    query?: [string, string][];
    headers?: HeaderMap;
    body?: unknown;
    ids?: Record<string, string>;
  } = {},
): RequestFacts {
  const body =
    input.body === undefined
      ? null
      : utf8Encode(typeof input.body === 'string' ? input.body : JSON.stringify(input.body));
  return requestFacts({
    params: input.params ?? {},
    query: input.query ?? [],
    headers: body === null ? (input.headers ?? {}) : { 'content-type': ['application/json'], ...input.headers },
    body,
    scenarioIds: new Map(Object.entries(input.ids ?? {})),
  });
}

const all = (when: string, request: RequestFacts): boolean =>
  conditions(when).every((condition) => holds(condition, request));

describe('references', () => {
  it('reads every source', () => {
    expect(all('{ path.orderId: ord-1 }', facts({ params: { orderId: 'ord-1' } }))).toBe(true);
    expect(
      all(
        '{ query.status: shipped }',
        facts({
          query: [
            ['status', 'shipped'],
            ['status', 'other'],
          ],
        }),
      ),
    ).toBe(true);
    expect(
      all(
        '{ query.status: other }',
        facts({
          query: [
            ['status', 'shipped'],
            ['status', 'other'],
          ],
        }),
      ),
    ).toBe(false);
    expect(all('{ header.X-Tier: gold }', facts({ headers: { 'x-tier': [' gold ', 'silver'] } }))).toBe(true);
    expect(all('{ cookie.cart: c1 }', facts({ headers: { cookie: ['bad; cart=c1; Cart=C2'] } }))).toBe(true);
    expect(all('{ cookie.Cart: C2 }', facts({ headers: { cookie: ['cart=c1; Cart=C2'] } }))).toBe(true);
    expect(all('{ body.$.amount.currency: EUR }', facts({ body: { amount: { currency: 'EUR' } } }))).toBe(true);
    expect(
      all(
        '{ contentType: application/json }',
        facts({ headers: { 'content-type': ['Application/JSON; charset=utf-8'] } }),
      ),
    ).toBe(true);
  });

  it('treats an absent or non-JSON body as missing, and a malformed JSON body as invalid', () => {
    expect(all('{ body.$.a: { present: false } }', facts())).toBe(true);
    expect(
      all('{ body.$.a: { present: false } }', facts({ headers: { 'content-type': ['text/plain'] }, body: 'x' })),
    ).toBe(true);
    const malformed = requestFacts({
      params: {},
      query: [],
      headers: { 'content-type': ['application/json'] },
      body: utf8Encode('{not json'),
      scenarioIds: new Map(),
    });
    expect(() => holds(conditions('{ body.$.a: 1 }')[0] as Condition, malformed)).toThrow(InvalidRequestBody);
  });

  it('rejects unknown references and path parameters the route lacks', () => {
    expect(problems('{ form.a: b }')).toEqual([expect.stringContaining('invalid-control')]);
    expect(problems('{ path.nope: b }')).toEqual([expect.stringContaining('unknown-path-parameter')]);
    expect(problems('{ body.a: b }')).toEqual([expect.stringContaining('invalid-control')]);
  });
});

describe('tests', () => {
  it('compares non-body literals as strings only', () => {
    expect(problems('{ query.page: 2 }')).toEqual([expect.stringContaining("'2'")]);
    expect(problems('{ header.x: true }')).toHaveLength(1);
    expect(all("{ query.page: '2' }", facts({ query: [['page', '2']] }))).toBe(true);
  });

  it('types body literals as JSON', () => {
    expect(all('{ body.$.n: 5 }', facts({ body: { n: 5 } }))).toBe(true);
    expect(all('{ body.$.n: 5 }', facts({ body: { n: '5' } }))).toBe(false);
    expect(all("{ body.$.n: '5' }", facts({ body: { n: '5' } }))).toBe(true);
    expect(all('{ body.$.n: null }', facts({ body: { n: null } }))).toBe(true);
    expect(all('{ body.$.n: { present: true } }', facts({ body: { n: null } }))).toBe(true);
  });

  it('tests membership, presence and ranges', () => {
    expect(all('{ header.x-tier: { in: [gold, platinum] } }', facts({ headers: { 'x-tier': ['platinum'] } }))).toBe(
      true,
    );
    expect(all('{ header.x-tier: { in: [gold, platinum] } }', facts({ headers: { 'x-tier': ['Gold'] } }))).toBe(false);
    expect(all('{ cookie.cart: { present: false } }', facts())).toBe(true);
    expect(all('{ cookie.cart: { present: true } }', facts())).toBe(false);
    expect(all('{ body.$.q: { gte: 1, lt: 10 } }', facts({ body: { q: 1 } }))).toBe(true);
    expect(all('{ body.$.q: { gte: 1, lt: 10 } }', facts({ body: { q: 10 } }))).toBe(false);
    expect(all('{ body.$.q: { gte: 1 } }', facts({ body: { q: '5' } }))).toBe(false);
    expect(all('{ query.q: { gt: 1.5 } }', facts({ query: [['q', '2']] }))).toBe(true);
    expect(all('{ query.q: { gt: 1.5 } }', facts({ query: [['q', 'two']] }))).toBe(false);
  });

  it('fails every test on a missing value except present: false', () => {
    const empty = facts();
    for (const when of [
      '{ query.a: x }',
      '{ query.a: { in: [x] } }',
      '{ query.a: { gt: 0 } }',
      '{ query.a: { present: true } }',
    ]) {
      expect(all(when, empty)).toBe(false);
    }
  });

  it('rejects empty lists, empty ranges, mixed tests and misplaced matchesETag', () => {
    expect(problems('{ query.a: { in: [] } }')).toHaveLength(1);
    expect(problems('{ query.a: { in: [x, x] } }')).toHaveLength(1);
    expect(problems('{ query.a: { gt: 5, lt: 5 } }')).toHaveLength(1);
    expect(problems('{ query.a: { gte: 6, lte: 5 } }')).toHaveLength(1);
    expect(problems('{ query.a: { gte: 5, lte: 5 } }')).toEqual([]);
    expect(problems('{ query.a: { gt: 1, in: [x] } }')).toHaveLength(1);
    expect(problems('{ query.a: { matchesETag: \'"v"\' } }')).toHaveLength(1);
    expect(problems('{ header.if-none-match: { matchesETag: v } }')).toHaveLength(1);
    expect(problems('{ query.a: "{{$now}}" }')).toHaveLength(1);
    expect(problems('{}')).toHaveLength(1);
  });

  it('compares a $scenario.ids literal with the selected scenario’s value', () => {
    const when = '{ body.$.orderId: "{{$scenario.ids.orderId}}" }';
    expect(all(when, facts({ body: { orderId: 'ord-7' }, ids: { orderId: 'ord-7' } }))).toBe(true);
    expect(all(when, facts({ body: { orderId: 'ord-7' }, ids: { orderId: 'ord-8' } }))).toBe(false);
  });

  it('describes a condition with its operands as written', () => {
    expect(conditions('{ header.X-Tier: { in: [gold] }, body.$.q: { gte: 1 } }').map(describeCondition)).toEqual([
      { reference: 'header.X-Tier', test: 'in', values: ['gold'] },
      { reference: 'body.$.q', test: 'range', bounds: { gte: 1 } },
    ]);
  });

  it('lists failing conditions in file order', () => {
    const parsed = parseExpect(utf8Encode('expect:\n  query.a: x\n  query.b: y\n  query.c: z\n'), CONTEXT);
    if (!parsed.ok) throw new Error('expected a valid expect.yaml');
    const failed = failing(parsed.control.expect, facts({ query: [['b', 'y']] }));
    expect(failed.map((condition) => condition.reference.text)).toEqual(['query.a', 'query.c']);
  });
});

describe('control files', () => {
  const codes = (result: { ok: boolean; problems?: readonly { code: string }[] }) =>
    result.ok ? [] : (result.problems ?? []).map((problem) => problem.code);

  it('locates YAML problems', () => {
    const result = parseVariants(
      utf8Encode('rules:\n  - when: { query.a: x }\n    serve: 200\n    extra: 1\n'),
      CONTEXT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toMatchObject({ code: 'invalid-control', position: { line: 4 } });
    expect(codes(parseVariants(utf8Encode('rules: &a []\n'), CONTEXT))).toEqual(['invalid-control']);
    expect(codes(parseVariants(utf8Encode('rules: []\n'), CONTEXT))).toEqual(['invalid-control']);
    expect(codes(parseSequence(utf8Encode('steps: []\n')))).toEqual(['invalid-control']);
    expect(codes(parseSequence(utf8Encode('steps: [200, 200]\nmore: 1\n')))).toEqual(['invalid-control']);
  });

  it('reads identities as written, rule sequences and pages', () => {
    const rules = parseVariants(
      utf8Encode('rules:\n  - when: { query.a: x }\n    serve: [202.pending, 200]\n'),
      CONTEXT,
    );
    expect(rules.ok && rules.control.rules[0]).toMatchObject({ number: 1, serve: null, steps: ['202.pending', '200'] });
    expect(rules.ok && rules.identities.map((identity) => identity.identity)).toEqual(['202.pending', '200']);

    const pages = parsePages(
      utf8Encode('by: body.$.cursor\nwhenAbsent: "1"\npages:\n  "1": 200\n  "2.5": 200.next\notherwise: 404\n'),
      CONTEXT,
    );
    expect(pages.ok && pages.control).toMatchObject({
      whenAbsent: '1',
      otherwise: '404',
      pages: [
        ['1', '200'],
        ['2.5', '200.next'],
      ],
    });
    if (!pages.ok) return;
    expect(pageText(pages.control.by, facts({ body: { cursor: 2.5 } }))).toBe('2.5');
    expect(pageText(pages.control.by, facts({ body: { cursor: '2.5' } }))).toBe('2.5');
    expect(pageText(pages.control.by, facts({ body: { cursor: true } }))).toBeNull();
    expect(pageText(pages.control.by, facts())).toBe(MISSING);
    expect(codes(parsePages(utf8Encode('by: query.p\npages:\n  2: 200\n'), CONTEXT))).toEqual(['invalid-control']);
  });

  it('picks the first matching rule and counts the rules tried', () => {
    const parsed = parseVariants(
      utf8Encode(
        'rules:\n  - when: { query.a: x }\n    serve: 200.x\n  - when: { query.b: y }\n    serve: 200.y\n  - when: { query.b: { present: true } }\n    serve: 200.z\n',
      ),
      CONTEXT,
    );
    if (!parsed.ok) throw new Error('expected valid rules');
    expect(firstMatchingRule(parsed.control.rules, facts({ query: [['b', 'y']] }))).toMatchObject({
      rule: { number: 2 },
      tried: 2,
    });
    expect(firstMatchingRule(parsed.control.rules, facts())).toEqual({ rule: null, tried: 3 });
  });
});

describe('request headers', () => {
  it('parses cookies, skipping malformed pairs', () => {
    expect(parseCookies(['a=1; b="2"; =x; c', 'd=4'])).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['d', '4'],
    ]);
    expect(cookieNamed(['a=1; a=2'], 'a')).toBe('1');
    expect(cookieNamed(undefined, 'a')).toBeUndefined();
  });

  it('compares entity tags weakly', () => {
    const tag = parseEntityTag('"v2"');
    expect(tag).toEqual({ weak: false, opaque: 'v2' });
    expect(parseEntityTag('v2')).toBeNull();
    if (tag === null) return;
    expect(ifNoneMatchMatches(['W/"v2"'], tag)).toBe(true);
    expect(ifNoneMatchMatches(['"v1", "v2"'], tag)).toBe(true);
    expect(ifNoneMatchMatches(['"v1"', '"v2"'], tag)).toBe(true);
    expect(ifNoneMatchMatches(['*'], tag)).toBe(true);
    expect(ifNoneMatchMatches(['"v1"'], tag)).toBe(false);
    expect(ifNoneMatchMatches(['"v2", junk'], tag)).toBe(false);
    expect(parseIfNoneMatch(['*, "v2"'])).toBeNull();
  });

  it('accepts one visible-ASCII or sf-string idempotency key', () => {
    expect(parseIdempotencyKey(undefined, 'Idempotency-Key')).toEqual({ kind: 'absent' });
    expect(parseIdempotencyKey(['k-1'], 'Idempotency-Key')).toEqual({ kind: 'key', key: 'k-1' });
    expect(parseIdempotencyKey(['"k\\"1"'], 'Idempotency-Key')).toEqual({ kind: 'key', key: 'k"1' });
    for (const lines of [['a', 'b'], [''], ['a b'], ['x'.repeat(256)], ['é']]) {
      expect(parseIdempotencyKey(lines, 'Idempotency-Key').kind).toBe('invalid');
    }
    expect(parseIdempotencyKey(['x'.repeat(255)], 'Idempotency-Key').kind).toBe('key');
  });
});
