import { describe, expect, it } from 'vitest';

import { ACCEPT_ANY, chooseMediaType, firstByPreference, parseAccept } from './accept.js';
import { parseMediaType } from './media-type.js';

const choose = (accept: string | string[] | undefined, candidates: string[], preference: string[] = []) => {
  const parsed = parseAccept(typeof accept === 'string' ? [accept] : accept);
  const ranges = parsed.ranges.length > 0 ? parsed.ranges : ACCEPT_ANY;
  return chooseMediaType(ranges, candidates, preference)?.mediaType ?? null;
};

describe('parseAccept', () => {
  it('treats an absent or empty header as */*', () => {
    expect(parseAccept(undefined)).toEqual({ present: false, ranges: [], dropped: [], droppedPositions: [] });
    expect(parseAccept([''])).toMatchObject({ present: false, ranges: [], dropped: [] });
    expect(parseAccept([' , '])).toMatchObject({ present: false, ranges: [], dropped: [] });
  });

  it('parses ranges, weights, specificity and parameters', () => {
    const { ranges } = parseAccept(['Text/HTML;Level=1;q=0.5;ext=1, application/*;q=0.25, */*;q=0']);
    expect(ranges.map(({ text, weight, specificity }) => ({ text, weight, specificity }))).toEqual([
      { text: 'text/html;level=1', weight: 500, specificity: 3 },
      { text: 'application/*', weight: 250, specificity: 1 },
      { text: '*/*', weight: 0, specificity: 0 },
    ]);
  });

  it('combines field lines in wire order', () => {
    expect(parseAccept(['text/html', 'application/json;q=0.5']).ranges.map((range) => range.text)).toEqual([
      'text/html',
      'application/json',
    ]);
  });

  it('keeps commas inside quoted parameter values', () => {
    const { ranges, dropped } = parseAccept(['text/plain;format="a,b", text/html']);
    expect(dropped).toEqual([]);
    expect(ranges.map((range) => range.text)).toEqual(['text/plain;format="a,b"', 'text/html']);
  });

  it.each([
    'text',
    '*/html',
    'text/html;q=2',
    'text/html;q=0.1234',
    'text/html;q=-1',
    'text/html;q=1.001',
    'text/html;q=abc',
    'text/html;q=0.5;q=0.6',
    'text/html;q',
    'te xt/html',
    'text/*;level=1',
  ])('drops the malformed range %j', (range) => {
    const parsed = parseAccept([`${range}, application/json`]);
    expect(parsed.dropped).toEqual([range]);
    expect(parsed.ranges.map((entry) => entry.text)).toEqual(['application/json']);
  });

  it('accepts q with up to three decimals', () => {
    expect(parseAccept(['a/b;q=0.125, c/d;q=1.000, e/f;Q=0.']).ranges.map((range) => range.weight)).toEqual([
      125, 1000, 0,
    ]);
  });

  it('collapses identical ranges to their highest q', () => {
    const { ranges } = parseAccept(['text/html;q=0.2, TEXT/HTML;q=0.8, text/html;q=0.5']);
    expect(ranges.map(({ text, weight }) => [text, weight])).toEqual([['text/html', 800]]);
  });

  it('reports a header with no usable range as present with no ranges', () => {
    expect(parseAccept(['nonsense'])).toEqual({
      present: true,
      ranges: [],
      dropped: ['nonsense'],
      droppedPositions: ['#1'],
    });
  });

  it('numbers dropped members across field lines, for traces that must not quote them', () => {
    expect(parseAccept(['a/b, bad', ', c/d;q=9']).droppedPositions).toEqual(['#2', '#3']);
  });

  it('makes dropped ranges safe to quote back', () => {
    const [dropped] = parseAccept([`bad"\\é${'x'.repeat(100)}`]).dropped;
    expect(dropped).toMatch(/^bad\?\?\?x+\.\.\.$/);
    expect(dropped).toHaveLength(64);
  });
});

describe('chooseMediaType', () => {
  const both = ['application/json', 'application/yaml'];

  it('ranks by quality first', () => {
    expect(choose('application/json;q=0.5, application/yaml', both)).toBe('application/yaml');
  });

  it('takes quality from the most specific matching range, not the highest', () => {
    expect(choose('application/json;q=0.1, */*;q=0.9', both)).toBe('application/yaml');
    expect(choose('application/*;q=0.2, */*', ['application/json', 'text/csv'])).toBe('text/csv');
  });

  it('breaks quality ties by specificity', () => {
    expect(choose('application/*, application/yaml', both)).toBe('application/yaml');
    expect(choose('*/*, application/json', both)).toBe('application/json');
  });

  it('breaks remaining ties by mediaTypePreference, then lexical order', () => {
    expect(choose('*/*', both)).toBe('application/json');
    expect(choose('*/*', both, ['application/yaml'])).toBe('application/yaml');
    expect(choose(undefined, ['text/plain', 'application/xml'])).toBe('application/xml');
  });

  it('never selects a media type refused with q=0', () => {
    expect(choose('application/json;q=0, */*', both)).toBe('application/yaml');
    expect(choose('application/*;q=0', both)).toBeNull();
    expect(choose('*/*;q=0', both)).toBeNull();
  });

  it('does not match a parameterized range against a filename media type', () => {
    expect(choose('application/json;version=2', both)).toBeNull();
    expect(choose('application/json;version=2, application/yaml;q=0.1', both)).toBe('application/yaml');
  });

  it('ignores accept extensions after q', () => {
    expect(choose('application/yaml;q=0.9;foo=bar, application/json;q=0.5', both)).toBe('application/yaml');
  });

  it('matches case-insensitively and suffixed types exactly', () => {
    expect(choose('APPLICATION/JSON', both)).toBe('application/json');
    expect(choose('application/json', ['application/vnd.acme+json'])).toBeNull();
    expect(choose('application/vnd.acme+json', ['application/vnd.acme+json'])).toBe('application/vnd.acme+json');
  });

  it('returns null when nothing matches', () => {
    expect(choose('text/csv', both)).toBeNull();
  });

  it('reports the deciding range', () => {
    const { ranges } = parseAccept(['application/*;q=0.5, */*;q=0.1']);
    expect(chooseMediaType(ranges, ['application/yaml'], [])?.range.text).toBe('application/*');
  });
});

describe('firstByPreference', () => {
  it('orders by preference, then lexically', () => {
    expect(firstByPreference(['text/plain', 'application/json'], [])).toBe('application/json');
    expect(firstByPreference(['text/plain', 'application/json'], ['text/plain'])).toBe('text/plain');
    expect(firstByPreference([], [])).toBeNull();
  });
});

describe('parseMediaType', () => {
  it('parses Content-Type values', () => {
    expect(parseMediaType('Application/JSON; Charset="utf-8"')).toEqual({
      type: 'application',
      subtype: 'json',
      parameters: [['charset', 'utf-8']],
    });
    expect(parseMediaType('multipart/form-data; boundary=x;')).toMatchObject({ subtype: 'form-data' });
  });

  it.each(['', 'json', 'application/', '/json', 'application/json; charset', 'a b/c', 'text/plain; x="unterminated'])(
    'rejects %j',
    (value) => {
      expect(parseMediaType(value)).toBeNull();
    },
  );
});
