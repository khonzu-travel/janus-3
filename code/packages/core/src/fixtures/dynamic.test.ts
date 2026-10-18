import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import type { BuildSnapshotResult, StartupError } from '../types/index.js';
import { bodyKind } from './body-kind.js';
import { buildSnapshot } from './build.js';

// Body kinds and load-time validation of dynamic values.

function build(
  tree: Readonly<Record<string, string | Uint8Array>>,
  aliases: Record<string, string> = {},
): BuildSnapshotResult {
  return buildSnapshot(
    new Map(Object.entries(tree).map(([path, value]) => [path, typeof value === 'string' ? utf8Encode(value) : value])),
    { aliases },
  );
}

function errorsOf(tree: Readonly<Record<string, string | Uint8Array>>): readonly StartupError[] {
  const result = build(tree);
  if (result.ok) throw new Error('expected errors');
  return result.errors;
}

describe('body kinds', () => {
  it.each([
    ['application/json', 'json'],
    ['application/problem+json', 'json'],
    ['application/vnd.api+json', 'json'],
    ['APPLICATION/JSON; charset=utf-8', 'json'],
    ['text/plain', 'text'],
    ['text/html', 'text'],
    ['text/csv', 'text'],
    ['application/yaml', 'text'],
    ['application/xml', 'text'],
    ['application/atom+xml', 'text'],
    ['image/svg+xml', 'text'],
    ['application/x-www-form-urlencoded', 'text'],
    ['application/octet-stream', 'binary'],
    ['image/png', 'binary'],
    ['application/javascript', 'binary'],
    ['application/x-yaml', 'binary'],
  ])('%s is %s', (mediaType, kind) => {
    expect(bodyKind(mediaType)).toBe(kind);
  });

  it('requires text-kind bodies to be valid UTF-8', () => {
    expect(errorsOf({ 'default/t/GET/200_{text-plain}.txt': new Uint8Array([0x63, 0xe9]) })).toEqual([
      {
        code: 'invalid-text-body',
        source: 'fixtures',
        path: 'default/t/GET/200_{text-plain}.txt',
        message: 'a text/plain body must be valid UTF-8',
      },
    ]);
    expect(build({ 'default/t/GET/200_{application-octet-stream}.bin': new Uint8Array([0xe9]) }).ok).toBe(true);
    expect(build({ 'default/t/GET/200_{text-plain}.txt': new Uint8Array([0xef, 0xbb, 0xbf, 0x61]) }).ok).toBe(true);
  });

  it('requires a non-.json JSON-kind body to be JSON only when it has dynamic values', () => {
    expect(build({ 'default/t/GET/200_{application-json}.txt': '{"a":' }).ok).toBe(true);
    expect(errorsOf({ 'default/t/GET/200_{application-json}.txt': '{"a":"{{$now}}"' })[0]?.code).toBe('invalid-json');
  });
});

describe('load-time token errors', () => {
  it('rejects a duplicate key in a dynamic JSON body, located at the repeat', () => {
    expect(
      errorsOf({ 'default/v1/GET/200_{application-json}.json': '{"a":"{{$today}}",\n "b":{"c":1,"c":2}}' }),
    ).toEqual([
      {
        code: 'invalid-json',
        source: 'fixtures',
        path: 'default/v1/GET/200_{application-json}.json',
        line: 2,
        column: 13,
        token: 'c',
        message: 'invalid JSON: duplicate key "c"; each key may appear only once per object',
      },
    ]);
    expect(
      errorsOf({ 'default/v1/GET/200_{application-json}.json': '{"a":"{{$today}}","a":"static"}' })[0],
    ).toMatchObject({
      code: 'invalid-json',
      line: 1,
      column: 19,
    });
    // Keys in different objects, or a static body, are fine: a static body is served byte for byte.
    expect(
      build({ 'default/v1/GET/200_{application-json}.json': '{"a":{"a":"{{$today}}"},"b":[{"a":1},{"a":2}]}' }).ok,
    ).toBe(true);
    expect(build({ 'default/v1/GET/200_{application-json}.json': '{"a":1,"a":2}' }).ok).toBe(true);
  });

  it('locates a JSON token by line and column, with a suggestion', () => {
    expect(errorsOf({ 'default/v1/GET/200_{application-json}.json': '{\n  "due": "on {{$tommorow}}"\n}' })).toEqual([
      {
        code: 'unknown-dynamic-token',
        source: 'fixtures',
        path: 'default/v1/GET/200_{application-json}.json',
        line: 2,
        column: 14,
        token: '{{$tommorow}}',
        message: 'unknown dynamic value "tommorow"; did you mean "tomorrow"?',
      },
    ]);
  });

  it('locates tokens after JSON escapes and in text bodies', () => {
    const [json] = errorsOf({ 'default/v1/GET/200_{application-json}.json': '{"a":"\\u00e9\\n{{$bad}}"}' });
    expect(json).toMatchObject({ line: 1, column: 15 });
    const [text] = errorsOf({ 'default/v1/GET/200_{text-plain}.txt': 'line one\n  {{$now+1m}}' });
    expect(text).toMatchObject({ code: 'invalid-dynamic-token', line: 2, column: 3, token: '{{$now+1m}}' });
  });

  it('reports every token problem in one pass, across files', () => {
    const codes = errorsOf({
      'default/{id}/GET/200_{text-plain}.txt':
        '{{$path.id}} {{$path.productId}} {{$today@Nowhere/City}} {{$faker.date.past}}',
      'default/{id}/GET/200.headers.json': '{"X-A":"{{$uuid+1d}}"}',
    }).map((error) => `${error.code} ${error.path}`);
    expect(codes).toEqual([
      'invalid-dynamic-token default/{id}/GET/200.headers.json',
      'unknown-path-parameter default/{id}/GET/200_{text-plain}.txt',
      'unknown-timezone default/{id}/GET/200_{text-plain}.txt',
      'impure-faker-path default/{id}/GET/200_{text-plain}.txt',
    ]);
  });

  it('forbids tokens in Content-Type and Janus-computed headers', () => {
    const errors = errorsOf({
      'default/v1/GET/200_{text-plain}.txt': 'x',
      'default/v1/GET/200.headers.json':
        '{\n"Content-Type": "text/{{$randomFrom(\\"plain\\")}}",\n"Date": "{{$now:http}}"\n}',
    });
    expect(errors.map((error) => [error.code, error.token, error.line])).toEqual([
      ['invalid-dynamic-token', 'Content-Type', 2],
      ['invalid-dynamic-token', 'Date', 3],
    ]);
  });

  it('never evaluates object keys, file names or accepts.yaml', () => {
    expect(
      build({
        'default/v1/POST/200_{application-json}.json': '{"{{$bogus}}": 1}',
        'default/v1/POST/accepts.yaml': 'accepts: [application/json]\n# {{$bogus}}\n',
      }).ok,
    ).toBe(true);
  });

  it('resolves custom aliases from the build options', () => {
    expect(build({ 'default/a/GET/200_{text-plain}.txt': '{{$trialEnd}}' }, { trialEnd: 'today+30d' }).ok).toBe(true);
    expect(build({ 'default/a/GET/200_{text-plain}.txt': '{{$trialEnd}}' }).ok).toBe(false);
  });

  it('warns about a JSON body that is only dynamic values', () => {
    const result = build({
      'default/a/GET/200_{application-json}.json': '"{{$body.$}}"',
      'default/b/GET/200_{application-json}.json': '"x{{$uuid}}"',
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'fully-dynamic-fixture', path: 'default/a/GET/200_{application-json}.json' }),
    ]);
  });

  it('accepts {{$$ escapes and gives the same snapshot version for the same files', () => {
    const tree = { 'default/a/GET/200_{text-plain}.txt': '{{$$today}}' };
    const first = build(tree);
    const second = build(tree);
    expect(first.ok && second.ok && first.snapshot.version === second.snapshot.version).toBe(true);
  });
});
