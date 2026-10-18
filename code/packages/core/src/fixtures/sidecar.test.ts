import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import { parseHeaderSidecar } from './sidecar.js';

const parse = (json: string) => parseHeaderSidecar(utf8Encode(json));

describe('parseHeaderSidecar', () => {
  it('lower-cases names and normalises values to arrays', () => {
    const result = parse('{"Location":"/a","Set-Cookie":["a=1","b=2"],"X-Empty":""}');
    expect(result.problems).toEqual([]);
    expect([...result.headers]).toEqual([
      ['location', ['/a']],
      ['set-cookie', ['a=1', 'b=2']],
      ['x-empty', ['']],
    ]);
  });

  it('replays everything that is not forbidden or Janus-computed, including other X- headers', () => {
    const result = parse(
      '{"ETag":"\\"v1\\"","Cache-Control":"no-cache","Retry-After":"5","WWW-Authenticate":"Basic","X-Trace":"1"}',
    );
    expect(result.problems).toEqual([]);
    expect([...result.headers.keys()]).toEqual(['etag', 'cache-control', 'retry-after', 'www-authenticate', 'x-trace']);
  });

  it('sets Content-Type aside for build to apply', () => {
    const result = parse('{"Content-Type":"Application/JSON; charset=utf-8"}');
    expect(result.problems).toEqual([]);
    expect(result.headers.size).toBe(0);
    expect(result.contentType).toEqual({ value: 'Application/JSON; charset=utf-8', position: { line: 1, column: 2 } });
  });

  it.each(['Content-Length', 'Date', 'Content-Encoding'])('reports Janus-computed %s for dropping', (name) => {
    const result = parse(`{"${name}":"x","Keep":"yes"}`);
    expect(result.problems).toEqual([]);
    expect(result.computed).toEqual([{ name: name.toLowerCase(), written: name, position: { line: 1, column: 2 } }]);
    expect([...result.headers.keys()]).toEqual(['keep']);
  });

  it.each([
    ['[]', 'invalid-headers', 'JSON object'],
    ['null', 'invalid-headers', 'JSON object'],
    ['{', 'invalid-headers', 'invalid JSON'],
    ['{"Bad Name":"x"}', 'invalid-headers', 'not a valid HTTP field name'],
    ['{"X-A":"1","x-a":"2"}', 'invalid-headers', 'case-insensitive'],
    ['{"X-A":1}', 'invalid-headers', 'string or a non-empty array'],
    ['{"X-A":[]}', 'invalid-headers', 'string or a non-empty array'],
    ['{"X-A":["ok",2]}', 'invalid-headers', 'string or a non-empty array'],
    ['{"X-A":"a\\r\\nX-Injected: 1"}', 'invalid-headers', 'CR, LF, NUL'],
    ['{"X-A":"a\\nb"}', 'invalid-headers', 'CR, LF, NUL'],
    ['{"X-A":"a\\u0000"}', 'invalid-headers', 'CR, LF, NUL'],
    ['{"X-A":"a\\u0085b"}', 'invalid-headers', 'CR, LF, NUL'],
    ['{"X-A":"a\\u007f"}', 'invalid-headers', 'CR, LF, NUL'],
    ['{"X-A":"\\ud800"}', 'invalid-headers', 'not valid Unicode'],
    ['{"Connection":"close"}', 'invalid-headers', 'hop-by-hop'],
    ['{"Keep-Alive":"timeout=5"}', 'invalid-headers', 'hop-by-hop'],
    ['{"Proxy-Authenticate":"Basic"}', 'invalid-headers', 'hop-by-hop'],
    ['{"Proxy-Authorization":"Basic"}', 'invalid-headers', 'hop-by-hop'],
    ['{"TE":"trailers"}', 'invalid-headers', 'hop-by-hop'],
    ['{"Trailer":"X"}', 'invalid-headers', 'hop-by-hop'],
    ['{"Transfer-Encoding":"chunked"}', 'invalid-headers', 'hop-by-hop'],
    ['{"Upgrade":"h2c"}', 'invalid-headers', 'hop-by-hop'],
    ['{"X-Mock-Identity":"fx_1"}', 'reserved-header', 'reserved'],
    ['{"x-mock-anything":"1"}', 'reserved-header', 'reserved'],
    ['{"Content-Type":["application/json","text/plain"]}', 'invalid-headers', 'single value'],
    ['{"Content-Type":"not a media type"}', 'invalid-headers', 'not a media type'],
  ])('rejects %s', (json, code, message) => {
    const { problems } = parse(json);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe(code);
    expect(problems[0]?.message).toContain(message);
  });

  it('accepts any text without control characters, kept as text', () => {
    const result = parse('{"X-A":["caf\u00e9","\u20ac 5","\u2603","tab\\there"]}');
    expect(result.problems).toEqual([]);
    expect(result.headers.get('x-a')).toEqual(['café', '€ 5', '☃', 'tab\there']);
  });

  it('reports every bad header, not just the first', () => {
    expect(parse('{"Connection":"x","X-Mock-A":"1","Content-Length":"1","Good":"yes"}').problems).toHaveLength(2);
  });
});
