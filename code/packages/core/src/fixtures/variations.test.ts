import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import type { StartupError, StartupWarning } from '../types/index.js';
import { buildSnapshot } from './build.js';
import { snapshotData, type StoredResponse } from './snapshot.js';

// Load-time rules.

const files = (entries: Readonly<Record<string, string>>) =>
  new Map(Object.entries(entries).map(([path, value]) => [path, utf8Encode(value)]));

function errorsOf(entries: Readonly<Record<string, string>>): readonly StartupError[] {
  const result = buildSnapshot(files(entries));
  if (result.ok) throw new Error('expected startup errors');
  return result.errors;
}

const codesOf = (entries: Readonly<Record<string, string>>): string[] =>
  errorsOf(entries).map((error) => `${error.code} ${error.path}`);

function warningsOf(entries: Readonly<Record<string, string>>): readonly StartupWarning[] {
  const result = buildSnapshot(files(entries));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.warnings;
}

/** The stored representations of `method` at a literal path. */
function stored(entries: Readonly<Record<string, string>>, segments: string[], method = 'GET'): StoredResponse[] {
  const result = buildSnapshot(files(entries));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  let node = snapshotData(result.snapshot).root;
  for (const segment of segments) {
    const next = node.children.get(segment) ?? node.param?.node;
    if (next === undefined) throw new Error(`no node for ${segment}`);
    node = next;
  }
  const methodEntry = node.methods.get(method);
  if (methodEntry === undefined) throw new Error('no method');
  return [
    ...(methodEntry.fallback?.representations ?? []),
    ...methodEntry.localized.flatMap((group) => group.representations),
  ];
}

const JSON_OK = '{"ok":true}';

describe('path parameters', () => {
  it('accepts {name} directories and counts distinct templates', () => {
    const result = buildSnapshot(
      files({
        'default/v1/products/{productId}/GET/200_{application-json}.json': JSON_OK,
        'default/v1/products/{productId}/reviews/{reviewId}/GET/200_{application-json}.json': JSON_OK,
        'default/v1/products/featured/GET/200_{application-json}.json': JSON_OK,
        'default/{_x9}/GET/204': '',
      }),
    );
    expect(result).toMatchObject({ ok: true, snapshot: { routeCount: 4, fixtureCount: 4 } });
  });

  it.each(['p-{id}', '{1id}', '{}', '{id', 'id}', '{a-b}', '{id}x', '{{id}}', '%7Bid-x%7D'])(
    'rejects %j as invalid-path-parameter',
    (name) => {
      expect(codesOf({ [`default/v1/${name}/GET/204`]: '' })).toEqual([`invalid-path-parameter default/v1/${name}`]);
    },
  );

  it('rejects binding the same name twice in one route', () => {
    const errors = errorsOf({ 'default/{id}/items/{id}/GET/204': '' });
    expect(errors.map((error) => `${error.code} ${error.path}`)).toEqual([
      'duplicate-path-parameter default/{id}/items/{id}',
    ]);
    expect(errors[0]?.token).toBe('{id}');
  });

  it('rejects two template children of one directory, naming both', () => {
    const errors = errorsOf({
      'default/v1/products/{productId}/GET/204': '',
      'default/v1/products/{sku}/reviews/GET/204': '',
    });
    expect(errors.map((error) => `${error.code} ${error.path}`)).toEqual([
      'multiple-template-children default/v1/products',
    ]);
    expect(errors[0]?.message).toContain('{productId} and {sku}');
  });

  it('lets literal children and one template child coexist', () => {
    expect(
      buildSnapshot(
        files({
          'default/a/b/GET/204': '',
          'default/a/{x}/GET/204': '',
          'default/a/{x}/c/GET/204': '',
          'default/a/b/{y}/GET/204': '',
        }),
      ).ok,
    ).toBe(true);
  });

  it('does not report case conflicts for parameters, only for literals', () => {
    expect(codesOf({ 'default/a/{id}/GET/204': '', 'default/A/{id}/POST/204': '' })).toEqual([
      'case-conflict default/A',
      'case-conflict default/A/{id}',
    ]);
    expect(codesOf({ 'default/a/{id}/GET/204': '', 'default/a/{Id}/x/POST/204': '' })).toEqual([
      'multiple-template-children default/a',
    ]);
  });

  it('includes templates in the snapshot version', () => {
    const version = (name: string): string => {
      const result = buildSnapshot(files({ [`default/${name}/GET/204`]: '' }));
      if (!result.ok) throw new Error('invalid');
      return result.snapshot.version;
    };
    expect(version('{id}')).not.toBe(version('{key}'));
    expect(version('{id}')).not.toBe(version('id'));
  });
});

describe('representation groups', () => {
  it('stores one file per locale per media type, each group sorted by media type', () => {
    const representations = stored(
      {
        'default/greeting/GET/200_{application-yaml}.yaml': 'a: 1\n',
        'default/greeting/GET/200_{application-json}.json': JSON_OK,
        'default/greeting/GET/200_[fr]_{text-html}.html': '<p>',
        'default/greeting/GET/200_[fr]_{application-json}.json': JSON_OK,
        'default/greeting/GET/200.headers.json': '{"X-Shared":"1"}',
      },
      ['greeting'],
    );
    expect(representations.map((entry) => [entry.locale, entry.mediaType, entry.headers['x-shared']])).toEqual([
      [null, 'application/json', ['1']],
      [null, 'application/yaml', ['1']],
      ['fr', 'application/json', ['1']],
      ['fr', 'text/html', ['1']],
    ]);
    expect(new Set(representations.map((entry) => entry.id)).size).toBe(4);
  });

  it('allows +suffix media types', () => {
    expect(
      stored({ 'default/a/GET/200_{application-vnd.acme+json}.json': JSON_OK }, ['a'])[0]?.headers['content-type'],
    ).toEqual(['application/vnd.acme+json']);
  });

  it('takes the media type of a short-form name from its extension', () => {
    const responses = stored(
      { 'default/a/GET/200.json': JSON_OK, 'default/a/GET/200.yml': 'a: 1', 'default/a/GET/200_[fr].html': '<p/>' },
      ['a'],
    );
    expect(responses.map((response) => response.headers['content-type'])).toEqual([
      ['application/json'],
      ['application/yaml'],
      ['text/html'],
    ]);
  });

  it('treats a short-form and an explicit name of one media type as the same representation', () => {
    const errors = errorsOf({
      'default/a/GET/200.json': JSON_OK,
      'default/a/GET/200_{application-json}.json': JSON_OK,
    });
    expect(errors.map((error) => error.code)).toEqual(['duplicate-representation']);
  });

  it('keeps the fixture ID when an explicit name is shortened', () => {
    const explicit = stored({ 'default/a/GET/200_{application-json}.json': JSON_OK }, ['a']);
    const short = stored({ 'default/a/GET/200.json': JSON_OK }, ['a']);

    expect(short[0]?.id).toBe(explicit[0]?.id);
  });

  it('treats short-form extension aliases as the same representation', () => {
    const errors = errorsOf({
      'default/a/GET/200.yaml': 'a: 1',
      'default/a/GET/200.yml': 'a: 1',
    });

    expect(errors.map((error) => error.code)).toEqual(['duplicate-representation']);
  });

  it('rejects two files with the same locale and media type', () => {
    const errors = errorsOf({
      'default/a/GET/200_{application-json}.json': JSON_OK,
      'default/a/GET/200_{Application-JSON}.txt': JSON_OK,
    });
    expect(errors.map((error) => error.code)).toEqual(['duplicate-representation']);
    expect(errors[0]?.message).toContain('200_{Application-JSON}.txt, 200_{application-json}.json');
  });

  it('rejects a group mixing statuses, but lets groups differ', () => {
    expect(
      codesOf({
        'default/a/GET/200_{application-json}.json': JSON_OK,
        'default/a/GET/201_{application-yaml}.yaml': 'a: 1',
      }),
    ).toEqual(['multiple-responses default/a/GET']);
    expect(
      buildSnapshot(
        files({
          'default/a/GET/200_[en]_{application-json}.json': JSON_OK,
          'default/a/GET/200_[en]_{application-yaml}.yaml': 'a: 1',
          'default/a/GET/404_[fr]_{application-json}.json': JSON_OK,
        }),
      ).ok,
    ).toBe(true);
  });

  it('keeps a bodyless status alone in its group', () => {
    const errors = errorsOf({ 'default/a/GET/204': '', 'default/a/GET/200_{application-json}.json': JSON_OK });
    expect(errors.map((error) => error.code)).toEqual(['multiple-responses']);
    expect(errors[0]?.message).toContain('bodyless');
    expect(buildSnapshot(files({ 'default/a/GET/204': '', 'default/a/GET/200_[fr]_{text-plain}.txt': 'x' })).ok).toBe(
      true,
    );
  });
});

describe('accepts.yaml', () => {
  it('attaches the policy to its method', () => {
    const result = buildSnapshot(
      files({
        'default/p/POST/accepts.yaml': 'accepts: [application/json]\n',
        'default/p/POST/201_{application-json}.json': JSON_OK,
      }),
    );
    if (!result.ok) throw new Error('invalid');
    expect(snapshotData(result.snapshot).root.children.get('p')?.methods.get('POST')?.accepts).toEqual({
      mediaTypes: ['application/json'],
      allowMissingContentType: null,
    });
  });

  it('reports a malformed accepts.yaml with its location', () => {
    expect(
      errorsOf({
        'default/p/POST/accepts.yaml': 'accepts: [application/json, "*/*"]\n',
        'default/p/POST/201_{application-json}.json': JSON_OK,
      }),
    ).toEqual([
      {
        code: 'invalid-accepts',
        source: 'fixtures',
        path: 'default/p/POST/accepts.yaml',
        line: 1,
        column: 29,
        token: '"*/*"',
        message: '"accepts" entry "*/*" is a wildcard; list each media type',
      },
    ]);
  });

  it('still needs a response file', () => {
    expect(codesOf({ 'default/p/POST/accepts.yaml': 'accepts: [application/json]\n' })).toEqual([
      'missing-response default/p/POST',
    ]);
  });

  it('changes the snapshot version', () => {
    const version = (accepts: string | null): string => {
      const result = buildSnapshot(
        files({
          'default/p/POST/201_{application-json}.json': JSON_OK,
          ...(accepts === null ? {} : { 'default/p/POST/accepts.yaml': accepts }),
        }),
      );
      if (!result.ok) throw new Error('invalid');
      return result.snapshot.version;
    };
    expect(version(null)).not.toBe(version('accepts: [application/json]'));
    expect(version('accepts: [application/json]')).not.toBe(version('accepts: [text/csv]'));
  });
});

describe('response header policy', () => {
  const tree = (sidecar: string) => ({
    'default/a/GET/200_{application-json}.json': JSON_OK,
    'default/a/GET/200.headers.json': sidecar,
  });

  it.each([
    'Connection',
    'Keep-Alive',
    'Proxy-Authenticate',
    'Proxy-Authorization',
    'TE',
    'Trailer',
    'Transfer-Encoding',
    'Upgrade',
  ])('forbids hop-by-hop %s', (name) => {
    expect(codesOf(tree(`{"${name}":"x"}`))).toEqual(['invalid-headers default/a/GET/200.headers.json']);
  });

  it('reserves X-Mock-* names', () => {
    const errors = errorsOf(tree('{\n  "X-Mock-Identity": "fx_1"\n}'));
    expect(errors).toEqual([
      {
        code: 'reserved-header',
        source: 'fixtures',
        path: 'default/a/GET/200.headers.json',
        line: 2,
        column: 3,
        token: 'X-Mock-Identity',
        message: '"X-Mock-Identity" is reserved: Janus adds X-Mock-* diagnostic headers itself',
      },
    ]);
  });

  it.each(['Content-Length', 'Date', 'Content-Encoding'])('drops Janus-computed %s with a located warning', (name) => {
    const entries = tree(`{\n  "${name}": "x",\n  "X-Kept": "y"\n}`);
    expect(warningsOf(entries)).toEqual([
      {
        code: 'janus-computed-header',
        source: 'fixtures',
        path: 'default/a/GET/200.headers.json',
        line: 2,
        column: 3,
        message: `"${name}" is computed by Janus and is dropped when served; remove it`,
      },
    ]);
    const [response] = stored(entries, ['a']);
    expect(response?.headers[name.toLowerCase()]).toBeUndefined();
    expect(response?.headers['x-kept']).toEqual(['y']);
    expect(response?.dropped).toEqual([{ name: name.toLowerCase(), values: ['x'] }]);
  });

  it('replays everything else exactly, keeping repeated values in order', () => {
    const [response] = stored(
      tree(
        '{"Location":"/x","ETag":"\\"1\\"","Cache-Control":"no-store","Set-Cookie":["a=1","b=2"],"Retry-After":"3","WWW-Authenticate":"Basic","X-Other":"z"}',
      ),
      ['a'],
    );
    expect(response?.headers).toMatchObject({
      location: ['/x'],
      etag: ['"1"'],
      'cache-control': ['no-store'],
      'set-cookie': ['a=1', 'b=2'],
      'retry-after': ['3'],
      'www-authenticate': ['Basic'],
      'x-other': ['z'],
    });
  });
});

describe('Content-Type', () => {
  const one = (sidecar: string | null, body = 'default/a/GET/200_{application-json}.json') => ({
    [body]: JSON_OK,
    ...(sidecar === null ? {} : { 'default/a/GET/200.headers.json': sidecar }),
  });
  const served = (entries: Readonly<Record<string, string>>) => stored(entries, ['a'])[0];

  it('absent: sends the filename media type', () => {
    expect(served(one(null))?.headers['content-type']).toEqual(['application/json']);
    expect(warningsOf(one(null))).toEqual([]);
  });

  it('identical: sends the same value with a redundant-content-type warning', () => {
    const entries = one('{"Content-Type":"Application/JSON"}');
    expect(served(entries)?.headers['content-type']).toEqual(['application/json']);
    expect(served(entries)?.contentTypeOverride).toBeNull();
    expect(warningsOf(entries).map((warning) => warning.code)).toEqual(['redundant-content-type']);
  });

  it('same type and subtype with parameters: sends the sidecar value without a warning', () => {
    const entries = one('{"Content-Type":"application/json; charset=utf-8"}');
    expect(served(entries)?.headers['content-type']).toEqual(['application/json; charset=utf-8']);
    expect(served(entries)?.contentTypeOverride).toBeNull();
    expect(warningsOf(entries)).toEqual([]);
  });

  it('a different media type: an override, sent with a content-type-override warning', () => {
    const entries = one('{"Content-Type":"text/plain"}');
    expect(served(entries)).toMatchObject({
      mediaType: 'application/json',
      headers: { 'content-type': ['text/plain'] },
      contentTypeOverride: { representation: 'application/json', wire: 'text/plain' },
    });
    expect(warningsOf(entries)).toEqual([
      {
        code: 'content-type-override',
        source: 'fixtures',
        path: 'default/a/GET/200.headers.json',
        line: 1,
        column: 2,
        message:
          '"Content-Type" overrides the file name\'s media type "application/json"; Accept negotiation still uses the file name',
      },
    ]);
  });

  it('any value for a bodyless status: status-header-conflict', () => {
    expect(
      codesOf({ 'default/a/GET/204': '', 'default/a/GET/204.headers.json': '{"Content-Type":"text/plain"}' }),
    ).toEqual(['status-header-conflict default/a/GET/204.headers.json']);
  });

  it('any value when the status has several media types: status-header-conflict', () => {
    const errors = errorsOf({
      'default/a/GET/200_{application-json}.json': JSON_OK,
      'default/a/GET/200_{application-yaml}.yaml': 'a: 1',
      'default/a/GET/200.headers.json': '{"Content-Type":"application/json"}',
    });
    expect(errors.map((error) => error.code)).toEqual(['status-header-conflict']);
    expect(errors[0]?.message).toContain('several media types (application/json, application/yaml)');
  });
});

describe('Vary', () => {
  const vary = (entries: Readonly<Record<string, string>>) =>
    stored(entries, ['a']).map((entry) => entry.headers['vary']);

  it('adds Accept to every bodyful representation, even a single one', () => {
    expect(vary({ 'default/a/GET/200_{application-json}.json': JSON_OK })).toEqual([['Accept']]);
  });

  it('adds nothing for a bodyless group', () => {
    expect(vary({ 'default/a/GET/204': '' })).toEqual([undefined]);
  });

  it('lists Accept first, then Accept-Language, after the sidecar Vary, without duplicates', () => {
    expect(
      vary({
        'default/a/GET/200_[en]_{application-json}.json': JSON_OK,
        'default/a/GET/200.headers.json': '{"Vary":["Origin","accept"]}',
      }),
    ).toEqual([['Origin', 'accept', 'Accept-Language']]);
    expect(vary({ 'default/a/GET/200_[en]_{application-json}.json': JSON_OK })).toEqual([['Accept, Accept-Language']]);
  });

  it('never adds names beside *', () => {
    expect(
      vary({
        'default/a/GET/200_[en]_{application-json}.json': JSON_OK,
        'default/a/GET/200.headers.json': '{"Vary":"*"}',
      }),
    ).toEqual([['*']]);
  });
});
