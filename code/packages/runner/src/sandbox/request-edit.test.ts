import { describe, expect, it } from 'vitest';

import {
  addQuery,
  brunoBody,
  parsePath,
  queryJson,
  queryString,
  removeQuery,
  setBodyText,
  setBrunoBody,
  upsertHeader,
} from './request-edit.js';

describe('request edits', () => {
  it('edits the query of a URL template as text', () => {
    expect(queryString('{{base}}/a?x=1&y={{y}}#f')).toBe('x=1&y={{y}}');
    expect(queryString('{{base}}/a')).toBe('');
    expect(addQuery('{{base}}/a', 'q', '{{term}}')).toBe('{{base}}/a?q={{term}}');
    expect(addQuery('{{base}}/a?#f', 'flag', null)).toBe('{{base}}/a?flag#f');
    expect(removeQuery('/a?x=1&y=2&x=3#f', 'x')).toBe('/a?y=2#f');
    expect(removeQuery('/a?x=1', 'x')).toBe('/a');
    expect(removeQuery('/a', 'x')).toBe('/a');
  });

  it('upserts a header case-insensitively and drops duplicates', () => {
    const headers = [
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
      { name: 'a', value: '3' },
    ];
    expect(upsertHeader(headers, 'a', 'x')).toEqual([
      { name: 'a', value: 'x' },
      { name: 'B', value: '2' },
    ]);
    expect(upsertHeader(headers, 'C', 'c')).toHaveLength(4);
  });

  it('sets body text, keeping a raw type', () => {
    expect(setBodyText({ type: 'xml', text: '<a/>' }, 'x')).toEqual({ type: 'xml', text: 'x' });
    expect(setBodyText(undefined, '[1]')).toEqual({ type: 'json', text: '[1]' });
    expect(setBodyText(undefined, '1')).toEqual({ type: 'text', text: '1' });
    expect(setBodyText({ type: 'file', file: 'a' }, '{}')).toEqual({ type: 'json', text: '{}' });
    expect(setBrunoBody({ type: 'form', fields: [] }, { a: '1', b: 2 })).toEqual({
      type: 'form',
      fields: [
        { name: 'a', value: '1' },
        { name: 'b', value: '2' },
      ],
    });
    expect(setBrunoBody(undefined, [1])).toEqual({ type: 'json', text: '[1]' });
    expect(brunoBody({ type: 'json', text: 'not json' })).toBe('not json');
    expect(
      brunoBody({
        type: 'multipart',
        parts: [
          { name: 'a', value: '1' },
          { name: 'f', file: 'x' },
        ],
      }),
    ).toEqual({
      a: '1',
      f: { file: 'x' },
    });
  });

  it('reads simple paths', () => {
    expect(parsePath('data.items[0].id')).toEqual(['data', 'items', 0, 'id']);
    expect(parsePath('a["b.c"][\'d\']')).toEqual(['a', 'b.c', 'd']);
    expect(parsePath('')).toEqual([]);
    expect(parsePath('a[x]')).toBeNull();
    const value = { a: [{ b: null }], 'b.c': 1 };
    expect(queryJson(value, 'a[0].b')).toEqual({ found: true, value: null });
    expect(queryJson(value, 'a.0.b')).toEqual({ found: true, value: null });
    expect(queryJson(value, '["b.c"]')).toEqual({ found: true, value: 1 });
    expect(queryJson(value, 'a[1]')).toEqual({ found: false });
    expect(queryJson(value, 'toString')).toEqual({ found: false });
    expect(queryJson(value, '')).toEqual({ found: true, value });
  });
});
