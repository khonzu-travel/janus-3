import { describe, expect, it } from 'vitest';

import { looksLikeCurl, parseCurl, type CurlResult } from './curl.js';

function ok(result: CurlResult) {
  if (!result.ok) throw Error(result.message);
  return result;
}

describe('parseCurl', () => {
  it('reads what Chrome copies as bash', () => {
    const result = ok(
      parseCurl(`curl 'https://api.example.com/v1/carts?x=1' \\
  -H 'accept: application/json' \\
  -H 'content-type: application/json' \\
  -b 'session=abc; theme=dark' \\
  --data-raw '{"sku":"A-1","qty":2}' \\
  --compressed`),
    );
    expect(result.request).toEqual({
      method: 'POST',
      url: 'https://api.example.com/v1/carts?x=1',
      headers: [
        { name: 'accept', value: 'application/json' },
        { name: 'content-type', value: 'application/json' },
        { name: 'Cookie', value: 'session=abc; theme=dark' },
      ],
      body: { type: 'json', text: '{"sku":"A-1","qty":2}' },
    });
    expect(result.notes).toEqual([]);
  });

  it("reads bash's $'…' strings and double quotes", () => {
    const result = ok(parseCurl(`curl "https://x.test/a" -H "X-Name: \\"q\\"" --data-raw $'line1\\nit\\'s'`));
    expect(result.request.headers).toEqual([{ name: 'X-Name', value: '"q"' }]);
    expect(result.request.body).toEqual({ type: 'text', text: "line1\nit's" });
  });

  it('reads what Chrome copies as cmd', () => {
    const result = ok(
      parseCurl(`curl ^"https://api.example.com/v1/carts^" ^
  -H ^"accept: */*^" ^
  -H ^"content-type: application/json^" ^
  --data-raw ^"^{^\\^"sku^\\^":^\\^"A-1^\\^"^}^"`),
    );
    expect(result.request).toEqual({
      method: 'POST',
      url: 'https://api.example.com/v1/carts',
      headers: [
        { name: 'accept', value: '*/*' },
        { name: 'content-type', value: 'application/json' },
      ],
      body: { type: 'json', text: '{"sku":"A-1"}' },
    });
  });

  it('defaults to GET, and to http:// without a scheme', () => {
    expect(ok(parseCurl('curl localhost:8080/health')).request).toEqual({
      method: 'GET',
      url: 'http://localhost:8080/health',
    });
  });

  it('reads grouped short options and values joined to them', () => {
    const result = ok(parseCurl('curl -sSLXDELETE -HAccept:text/plain https://x.test/items/1'));
    expect(result.request).toEqual({
      method: 'DELETE',
      url: 'https://x.test/items/1',
      headers: [{ name: 'Accept', value: 'text/plain' }],
    });
    expect(result.notes).toEqual([]);
  });

  it('turns name=value data into a form body', () => {
    const result = ok(
      parseCurl(`curl https://x.test/login -d 'user=jo+e' -d 'pass=a%26b' --data-urlencode 'note=a b&c'`),
    );
    expect(result.request.method).toBe('POST');
    expect(result.request.body).toEqual({
      type: 'form',
      fields: [
        { name: 'user', value: 'jo e' },
        { name: 'pass', value: 'a&b' },
        { name: 'note', value: 'a b&c' },
      ],
    });
  });

  it('sends JSON data as JSON, with a note, when no content type is given', () => {
    const result = ok(parseCurl(`curl https://x.test -d '{"a":1}'`));
    expect(result.request.body).toEqual({ type: 'json', text: '{"a":1}' });
    expect(result.notes).toHaveLength(1);
  });

  it('moves data into the query with -G', () => {
    expect(ok(parseCurl(`curl -G https://x.test/search?a=1 -d q=shoes --data-urlencode 'size=4 5'`)).request).toEqual({
      method: 'GET',
      url: 'https://x.test/search?a=1&q=shoes&size=4%205',
    });
  });

  it('reads --json, -u, -A, -e, --oauth2-bearer and -I', () => {
    const json = ok(parseCurl(`curl --json '{"a":1}' -u jo:secret -A agent/1 -e https://ref.test https://x.test`));
    expect(json.request).toEqual({
      method: 'POST',
      url: 'https://x.test',
      headers: [
        { name: 'Authorization', value: `Basic ${btoa('jo:secret')}` },
        { name: 'User-Agent', value: 'agent/1' },
        { name: 'Referer', value: 'https://ref.test' },
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Accept', value: 'application/json' },
      ],
      body: { type: 'json', text: '{"a":1}' },
    });
    expect(ok(parseCurl('curl -I --oauth2-bearer t0k https://x.test')).request).toEqual({
      method: 'HEAD',
      url: 'https://x.test',
      headers: [{ name: 'Authorization', value: 'Bearer t0k' }],
    });
  });

  it('reads -F into a multipart body', () => {
    const result = ok(
      parseCurl(`curl https://x.test/up -F 'title=Hello;type=text/plain' -F 'file=@photo.png;type=image/png'`),
    );
    expect(result.request.body).toEqual({
      type: 'multipart',
      parts: [
        { name: 'title', value: 'Hello' },
        { name: 'file', file: 'photo.png', contentType: 'image/png' },
      ],
    });
    expect(result.notes).toHaveLength(1);
  });

  it('names the options it leaves out, and drops output-only ones', () => {
    const result = ok(
      parseCurl(
        'curl -k --proxy http://p.test:3128 --cert me.pem -o out.json --max-time 5 -d @body.json https://x.test',
      ),
    );
    expect(result.request).toEqual({ method: 'GET', url: 'https://x.test' });
    expect(result.notes.join('\n')).toContain('runner.skipTlsVerify');
    expect(result.notes.join('\n')).toContain('-d reads from a file');
    expect(result.notes.at(-1)).toBe('Left out, as a request cannot hold them: --proxy, --cert.');
  });

  it('refuses what is not a curl command', () => {
    expect(parseCurl('wget https://x.test')).toEqual({
      ok: false,
      message: 'This is not a curl command: it should start with curl',
    });
    expect(parseCurl('curl -s')).toEqual({ ok: false, message: 'The command has no URL' });
    expect(parseCurl(`curl 'https://x.test`)).toEqual({ ok: false, message: 'A quote is not closed' });
    expect(parseCurl('curl -H')).toEqual({ ok: false, message: '-H needs a value' });
  });
});

it('looksLikeCurl', () => {
  expect(looksLikeCurl('  curl https://x.test')).toBe(true);
  expect(looksLikeCurl('$ curl.exe https://x.test')).toBe(true);
  expect(looksLikeCurl('https://x.test/curl')).toBe(false);
});
