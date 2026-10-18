import { describe, expect, it } from 'vitest';

import { chooseResponseCoding, parseContentEncoding, parseExpect } from './coding.js';

// Content-Encoding, Accept-Encoding and Expect.

const ALL = ['br', 'gzip', 'deflate'] as const;

describe('Content-Encoding', () => {
  it('lists codings in the order applied, across field lines, case-insensitively', () => {
    expect(parseContentEncoding(undefined)).toEqual({ kind: 'codings', codings: [] });
    expect(parseContentEncoding(['GZip'])).toEqual({ kind: 'codings', codings: ['gzip'] });
    expect(parseContentEncoding(['deflate, x-gzip', 'BR'])).toEqual({
      kind: 'codings',
      codings: ['deflate', 'x-gzip', 'br'],
    });
    expect(parseContentEncoding(['identity'])).toEqual({ kind: 'codings', codings: [] });
    expect(parseContentEncoding(['gzip, , identity'])).toEqual({ kind: 'codings', codings: ['gzip'] });
  });

  it('refuses unknown codings and more than four as unsupported', () => {
    expect(parseContentEncoding(['compress'])).toEqual({ kind: 'unsupported' });
    expect(parseContentEncoding(['zstd, gzip'])).toEqual({ kind: 'unsupported' });
    expect(parseContentEncoding(['gzip, gzip, gzip, gzip'])).toEqual({
      kind: 'codings',
      codings: ['gzip', 'gzip', 'gzip', 'gzip'],
    });
    expect(parseContentEncoding(['gzip, gzip, gzip, gzip, gzip'])).toEqual({ kind: 'unsupported' });
  });

  it('refuses quoted and non-token members as malformed', () => {
    expect(parseContentEncoding(['"gzip"'])).toEqual({ kind: 'malformed' });
    expect(parseContentEncoding(['gzip;q=1'])).toEqual({ kind: 'malformed' });
    expect(parseContentEncoding(['g zip'])).toEqual({ kind: 'malformed' });
  });
});

describe('Accept-Encoding', () => {
  it('chooses the highest quality, ties going to the configured order', () => {
    expect(chooseResponseCoding(undefined, ALL)).toBeNull();
    expect(chooseResponseCoding(['gzip, deflate, br'], ALL)).toBe('br');
    expect(chooseResponseCoding(['gzip, deflate, br'], ['deflate', 'gzip'])).toBe('deflate');
    expect(chooseResponseCoding(['gzip;q=0.5, deflate;q=0.8'], ALL)).toBe('deflate');
    expect(chooseResponseCoding(['GZIP;Q=1.000'], ALL)).toBe('gzip');
    expect(chooseResponseCoding(['x-gzip'], ALL)).toBe('gzip');
  });

  it('reads lists across field lines, * and q=0', () => {
    expect(chooseResponseCoding(['deflate;q=0.1', 'gzip;q=0.2'], ALL)).toBe('gzip');
    expect(chooseResponseCoding(['*'], ALL)).toBe('br');
    expect(chooseResponseCoding(['br;q=0, *;q=0.5'], ALL)).toBe('gzip');
    expect(chooseResponseCoding(['gzip;q=0'], ALL)).toBeNull();
    expect(chooseResponseCoding(['identity'], ALL)).toBeNull();
    expect(chooseResponseCoding([''], ALL)).toBeNull();
    expect(chooseResponseCoding(['zstd'], ALL)).toBeNull();
  });

  it('treats a malformed field as no preference', () => {
    expect(chooseResponseCoding(['gzip;q=2'], ALL)).toBeNull();
    expect(chooseResponseCoding(['gzip;q=0.1234'], ALL)).toBeNull();
    expect(chooseResponseCoding(['gzip;level=1'], ALL)).toBeNull();
    expect(chooseResponseCoding(['"gzip"'], ALL)).toBeNull();
  });
});

describe('Expect', () => {
  it('meets only 100-continue', () => {
    expect(parseExpect({})).toEqual({ kind: 'none' });
    expect(parseExpect({ expect: ['100-continue'] })).toEqual({ kind: 'continue' });
    expect(parseExpect({ expect: ['100-Continue'] })).toEqual({ kind: 'continue' });
    expect(parseExpect({ expect: ['100-continue', '100-continue'] })).toEqual({ kind: 'continue' });
    expect(parseExpect({ expect: ['200-ok'] })).toEqual({ kind: 'unsupported' });
    expect(parseExpect({ expect: ['100-continue, 200-ok'] })).toEqual({ kind: 'unsupported' });
    expect(parseExpect({ expect: [''] })).toEqual({ kind: 'unsupported' });
    expect(parseExpect({ expect: ['"100-continue"'] })).toEqual({ kind: 'unsupported' });
  });
});
