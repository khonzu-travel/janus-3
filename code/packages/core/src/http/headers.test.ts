import { describe, expect, it } from 'vitest';

import type { ResponseDescription } from '../types/index.js';
import { decodeFieldValue, encodeFieldValue, isFixtureFieldValue, wireHeaders } from './headers.js';

describe('fixture header values', () => {
  it('accepts text without control characters', () => {
    for (const value of ['', 'plain', 'café', '€', '☃', 'a\tb', '\u{1f600}']) {
      expect(isFixtureFieldValue(value)).toBe(true);
    }
    for (const value of ['a\r\nb', 'a\u0000', '\u007f', '\u0085', '\ud800'])
      expect(isFixtureFieldValue(value)).toBe(false);
  });

  it('sends text as its UTF-8 bytes, one character per byte', () => {
    expect(encodeFieldValue('plain')).toBe('plain');
    expect(encodeFieldValue('café')).toBe('cafÃ©');
    expect(encodeFieldValue('€')).toBe('â\u0082¬');
  });

  it('reads received bytes back as text when they are UTF-8, and leaves them alone otherwise', () => {
    expect(decodeFieldValue('cafÃ©')).toBe('café');
    expect(decodeFieldValue(encodeFieldValue('€ ☃'))).toBe('€ ☃');
    expect(decodeFieldValue('café')).toBe('café');
    expect(decodeFieldValue('plain')).toBe('plain');
  });
});

describe('wireHeaders', () => {
  const response = (recorded: boolean): ResponseDescription => ({
    kind: 'response',
    status: 200,
    headers: { 'x-a': ['café', 'plain'] },
    body: null,
    trace: {
      snapshotVersion: '0',
      scenario: 'default',
      normalizedPath: '/',
      outcome: { kind: 'route-not-found' },
      ...(recorded
        ? {
            recording: {
              scenario: 'default',
              exchange: '000001',
              outcome: 'captured' as const,
              upstreamMs: 1,
              upstream: 'http://127.0.0.1:1',
            },
          }
        : {}),
    },
  });

  it('encodes fixture values as UTF-8 bytes', () => {
    expect(wireHeaders(response(false))).toEqual({ 'x-a': ['cafÃ©', 'plain'] });
  });

  it('relays an upstream response unchanged: its values are already bytes', () => {
    expect(wireHeaders(response(true))).toEqual({ 'x-a': ['café', 'plain'] });
  });
});
