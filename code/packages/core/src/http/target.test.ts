import { describe, expect, it } from 'vitest';

import { formatPath, normalizeTarget } from './target.js';

describe('normalizeTarget', () => {
  it.each([
    ['', null],
    ['/', []],
    ['/v1/products', ['v1', 'products']],
    ['/v1/products/', ['v1', 'products', '']],
    ['/V1/Products', ['V1', 'Products']],
    ['/a%20b', ['a b']],
    ['/caf%C3%A9', ['caf\u00e9']],
    ['/cafe%CC%81', ['caf\u00e9']], // NFD input is NFC-normalised
    ['/%2525', ['%25']], // decoded exactly once
    ['/a%3Fb?x=1', ['a?b']],
  ])('normalises %j', (target, segments) => {
    const result = normalizeTarget(target);
    if (segments === null) expect(result.ok).toBe(false);
    else expect(result).toMatchObject({ ok: true, segments });
  });

  it.each([
    ['*', 'must be a path'],
    ['http://example.com/a', 'must be a path'],
    ['/a/%zz', 'malformed'],
    ['/a/%', 'malformed'],
    ['/a/%C3', 'malformed'], // truncated UTF-8
    ['/a/%FF', 'malformed'], // invalid UTF-8
    ['/a/%00', 'NUL'],
    ['/a%2Fb', 'encoded "/"'],
    ['/a//b', 'empty'],
    ['//', 'empty'],
    ['/./a', 'dot-segment'],
    ['/a/..', 'dot-segment'],
    ['/a/%2e%2E', 'dot-segment'],
  ])('rejects %j', (target, reason) => {
    const result = normalizeTarget(target);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it('keeps query order, repeats, and blank values', () => {
    expect(normalizeTarget('/a?x=1&y=&x=2&z&q=a+b%21&bad=%zz')).toEqual({
      ok: true,
      segments: ['a'],
      query: [
        ['x', '1'],
        ['y', ''],
        ['x', '2'],
        ['z', ''],
        ['q', 'a b!'],
        ['bad', '%zz'],
      ],
    });
  });

  it('splits at the first "?" only', () => {
    expect(normalizeTarget('/a?b?c')).toMatchObject({ ok: true, segments: ['a'], query: [['b?c', '']] });
  });
});

describe('formatPath', () => {
  it('re-encodes decoded segments canonically', () => {
    expect(formatPath([])).toBe('/');
    expect(formatPath(['v1', 'a b', 'caf\u00e9', 'x:y@z'])).toBe('/v1/a%20b/caf%C3%A9/x:y@z');
  });
});

describe('normalizeTarget with strictTrailingSlash: false', () => {
  it.each([
    ['/', []],
    ['/a/', ['a']],
    ['/a/b/?q', ['a', 'b']],
    ['/a', ['a']],
  ])('normalises %j', (target, segments) => {
    expect(normalizeTarget(target, { strictTrailingSlash: false })).toMatchObject({ ok: true, segments });
  });

  it('drops only one trailing "/"', () => {
    expect(normalizeTarget('/a//', { strictTrailingSlash: false }).ok).toBe(false);
    expect(normalizeTarget('//', { strictTrailingSlash: false }).ok).toBe(false);
  });
});
