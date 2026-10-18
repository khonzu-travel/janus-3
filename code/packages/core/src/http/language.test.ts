import { describe, expect, it } from 'vitest';

import { chooseLanguage, isLanguageTag, parseAcceptLanguage } from './language.js';

describe('isLanguageTag', () => {
  it.each(['en', 'en-US', 'de-ch', 'zh-Hant-TW', 'sr-Latn-RS', 'es-419', 'en-US-x-twain'])('accepts %s', (tag) => {
    expect(isLanguageTag(tag)).toBe(true);
  });

  it.each(['', 'e', 'en_US', 'en-', '-en', 'en--US', '*', 'en-toolongsubtag', '1en', 'en US'])('rejects %j', (tag) => {
    expect(isLanguageTag(tag)).toBe(false);
  });
});

describe('parseAcceptLanguage', () => {
  it('orders by weight, keeping field order for equal weights', () => {
    expect(parseAcceptLanguage(['fr;q=0.5, en-US, de;q=0.9, en'])).toEqual([
      { range: 'en-us', weight: 1000 },
      { range: 'en', weight: 1000 },
      { range: 'de', weight: 900 },
      { range: 'fr', weight: 500 },
    ]);
  });

  it('combines repeated fields in order', () => {
    expect(parseAcceptLanguage(['fr', 'de']).map((p) => p.range)).toEqual(['fr', 'de']);
  });

  it('accepts the wildcard, q=0, and optional whitespace', () => {
    expect(parseAcceptLanguage([' * ; q=0.1 ,en ;Q=0'])).toEqual([
      { range: '*', weight: 100 },
      { range: 'en', weight: 0 },
    ]);
  });

  it('ignores malformed members instead of failing', () => {
    expect(parseAcceptLanguage([',, en_US, fr;q=2, de;q=0.1234, it;x=1, es;q=0.5;q=0.4, nl'])).toEqual([
      { range: 'nl', weight: 1000 },
    ]);
  });
});

describe('chooseLanguage', () => {
  const tags = ['de', 'en-gb', 'en-us', 'fr-ca', 'fr-fr'];

  it.each([
    // [Accept-Language, expected tag or "fallback"/"none", has fallback]
    ['en-US', 'en-us', false],
    ['EN-us', 'en-us', false],
    ['de-AT', 'de', false], // lookup truncates the range
    ['de-Latn-AT-x-y', 'de', false],
    ['en', 'en-gb', false], // the first extension in tag order
    ['fr', 'fr-ca', false],
    ['it, fr-FR;q=0.5', 'fr-fr', false],
    ['fr-FR;q=0.5, en-GB;q=0.8', 'en-gb', false],
    ['*', 'de', false],
    ['*', 'fallback', true],
    ['it', 'fallback', true],
    ['it', 'none', false],
    ['', 'de', false], // no usable member: like a missing header
    ['en_US', 'fallback', true],
    ['en;q=0', 'none', false],
    ['*, de;q=0', 'en-gb', false],
    ['en, en-GB;q=0', 'en-us', false],
    ['de-AT, de;q=0', 'none', false],
  ])('%j chooses %s (fallback: %s)', (header, expected, hasFallback) => {
    const choice = chooseLanguage([header], tags, hasFallback);
    expect(choice).toMatchObject(
      expected === 'fallback' || expected === 'none' ? { kind: expected } : { kind: 'tag', key: expected },
    );
  });

  it('treats a missing header as "any language"', () => {
    expect(chooseLanguage(undefined, tags, true)).toEqual({ kind: 'fallback', range: '*' });
    expect(chooseLanguage(undefined, tags, false)).toEqual({ kind: 'tag', key: 'de', range: '*' });
  });

  it('reports the range that decided the choice', () => {
    expect(chooseLanguage(['it, de-AT;q=0.9'], tags, false)).toEqual({ kind: 'tag', key: 'de', range: 'de' });
    expect(chooseLanguage(['en'], tags, false)).toEqual({ kind: 'tag', key: 'en-gb', range: 'en' });
    expect(chooseLanguage(['it'], tags, true)).toEqual({ kind: 'fallback', range: null });
  });
});
