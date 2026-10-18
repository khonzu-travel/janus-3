import { describe, expect, it } from 'vitest';

import { positionAt, scanJson } from './json.js';

describe('scanJson', () => {
  it.each([
    '{}',
    '[]',
    ' {"a": [1, -2.5e+3, true, false, null, "x\\"\\u00e9\\n"], "b": {}} ',
    '"text"',
    '0',
    '-0.5E-2',
    '\n\t\r 1 \n',
  ])('accepts what JSON.parse accepts: %j', (text) => {
    expect(() => JSON.parse(text) as unknown).not.toThrow();
    expect(scanJson(text).ok).toBe(true);
  });

  it.each([
    ['', 1, 1, 'unexpected end of input', undefined],
    ['{"a":1,}', 1, 8, 'unexpected "}"', '}'],
    ['{\n  "a": 1\n  "b": 2\n}', 3, 3, 'unexpected "\\""', '"'],
    ['[1 2]', 1, 4, 'unexpected "2"', '2'],
    ['{"a":tru}', 1, 9, 'unexpected "}"', '}'],
    ['01', 1, 2, 'unexpected "1"', '1'],
    ['1.', 1, 3, 'unexpected end of input', undefined],
    ['1e+x', 1, 4, 'unexpected "x"', 'x'],
    ['-', 1, 2, 'unexpected end of input', undefined],
    ['"a\tb"', 1, 3, 'unexpected control character', '\t'],
    ['"\\x"', 1, 3, 'unexpected "x"', 'x'],
    ['"\\u12G4"', 1, 6, 'unexpected "G"', 'G'],
    ["{'a':1}", 1, 2, 'unexpected "\'"', "'"],
    ['{"a":1} x', 1, 9, 'unexpected "x"', 'x'],
    ['{"a":"unterminated', 1, 19, 'unexpected end of input', undefined],
  ])('locates the first error in %j', (text, line, column, message, token) => {
    expect(() => JSON.parse(text) as unknown).toThrow();
    expect(scanJson(text)).toEqual({
      ok: false,
      message,
      position: { line, column },
      ...(token === undefined ? {} : { token }),
    });
  });

  it('records the position of each top-level member name', () => {
    const result = scanJson('{\n  "Location": "/a",\n  "X-A": {"nested": 1},\n  "Location": "/b"\n}');
    expect(result.ok && [...result.members]).toEqual([
      ['Location', { line: 2, column: 3 }],
      ['X-A', { line: 3, column: 3 }],
    ]);
  });

  it('reports excessive nesting instead of overflowing the stack', () => {
    const deep = '['.repeat(10_000) + ']'.repeat(10_000);
    expect(scanJson(deep)).toMatchObject({ ok: false, message: 'nesting is too deep to check' });
  });

  it('counts lines on LF and columns in UTF-16 code units', () => {
    expect(positionAt('ab\r\ncd', 5)).toEqual({ line: 2, column: 2 });
    expect(positionAt('é😀x', 3)).toEqual({ line: 1, column: 4 });
  });
});
