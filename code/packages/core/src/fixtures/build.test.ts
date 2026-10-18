import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import type { FixtureFiles, StartupError } from '../types/index.js';
import { buildSnapshot } from './build.js';

const files = (entries: Readonly<Record<string, string | Uint8Array>>): FixtureFiles =>
  new Map(
    Object.entries(entries).map(([path, value]) => [path, typeof value === 'string' ? utf8Encode(value) : value]),
  );

const JSON_OK = '{"ok":true}';

function errorsOf(entries: Readonly<Record<string, string>>): readonly StartupError[] {
  const result = buildSnapshot(files(entries));
  if (result.ok) throw new Error('expected startup errors');
  return result.errors;
}

function codesOf(entries: Readonly<Record<string, string>>): string[] {
  return errorsOf(entries).map((error) => `${error.code} ${error.path}`);
}

describe('buildSnapshot', () => {
  it('indexes a valid tree and counts routes and fixtures', () => {
    const result = buildSnapshot(
      files({
        'default/GET/200_{text-plain}.txt': 'root',
        'default/v1/products/GET/200_{application-json}.json': '[]',
        'default/v1/products/POST/201_{application-json}.json': JSON_OK,
        'default/v1/products/POST/201.headers.json': '{"Location":"/v1/products/1"}',
        'default/v1/health/GET/204': '',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.routeCount).toBe(3);
    expect(result.snapshot.fixtureCount).toBe(4);
    expect(result.snapshot.version).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
  });

  it('ignores allowlisted editor and OS files everywhere', () => {
    const result = buildSnapshot(
      files({
        '.DS_Store': 'x',
        'default/.gitkeep': '',
        'default/v1/Thumbs.db': 'x',
        'default/v1/GET/200_{text-plain}.txt': 'ok',
        'default/v1/GET/._200_{text-plain}.txt': 'x',
        'default/v1/GET/200_{text-plain}.txt~': 'x',
        'default/v1/GET/.200_{text-plain}.txt.swp': 'x',
      }),
    );
    expect(result).toMatchObject({ ok: true, snapshot: { routeCount: 1, fixtureCount: 1 } });
  });

  describe('snapshot version', () => {
    const tree = {
      'default/a/GET/200_{application-json}.json': '{"a":1}',
      'default/b/GET/200_{text-plain}.txt': 'b',
      'default/b/GET/200.headers.json': '{"X-B":"1"}',
    };
    const versionOf = (entries: Readonly<Record<string, string>>): string => {
      const result = buildSnapshot(files(entries));
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      return result.snapshot.version;
    };

    it('does not depend on map order', () => {
      const reversed = Object.fromEntries(Object.entries(tree).reverse());
      expect(versionOf(reversed)).toBe(versionOf(tree));
    });

    it('does not depend on sidecar formatting', () => {
      expect(versionOf({ ...tree, 'default/b/GET/200.headers.json': '{ "x-b" : ["1"] }' })).toBe(versionOf(tree));
    });

    // A filename spelling change changes the version, so a reload serves the new name.
    it('changes when a file name is spelt differently', () => {
      const { 'default/b/GET/200_{text-plain}.txt': body, ...rest } = tree;
      expect(versionOf({ ...rest, 'default/b/GET/200_{text-plain}.TXT': body })).not.toBe(versionOf(tree));
      const { 'default/a/GET/200_{application-json}.json': json, ...others } = tree;
      expect(versionOf({ ...others, 'default/%61/GET/200_{application-json}.json': json })).not.toBe(versionOf(tree));
    });

    it('changes when a dropped header changes', () => {
      const dated = (date: string) =>
        versionOf({ ...tree, 'default/b/GET/200.headers.json': `{"X-B":"1","Date":"${date}"}` });
      expect(dated('Mon, 05 Oct 2026 00:00:00 GMT')).not.toBe(dated('Tue, 06 Oct 2026 00:00:00 GMT'));
    });

    it('changes when content changes', () => {
      expect(versionOf({ ...tree, 'default/b/GET/200_{text-plain}.txt': 'B' })).not.toBe(versionOf(tree));
      expect(versionOf({ ...tree, 'default/b/GET/200.headers.json': '{"X-B":"2"}' })).not.toBe(versionOf(tree));
    });
  });

  describe('layout errors', () => {
    it('requires the default scenario', () => {
      expect(codesOf({})).toEqual(['missing-default-scenario default']);
      // An existing but empty default scenario is valid: every request is a miss.
      expect(buildSnapshot(files({ 'default/.DS_Store': '' }))).toMatchObject({
        ok: true,
        snapshot: { routeCount: 0 },
      });
      expect(codesOf({ default: 'x' })).toEqual(['invalid-scenario-name default']);
    });

    it('accepts sibling scenarios and rejects invalid names and root files', () => {
      expect(buildSnapshot(files({ 'default/GET/204': '', 'staging/GET/204': '', 'staging/v1/GET/204': '' })).ok).toBe(
        true,
      );
      expect(
        codesOf({
          'default/GET/204': '',
          'Staging/GET/204': '',
          'README.md': '',
        }),
      ).toEqual(['invalid-scenario-name README.md', 'invalid-scenario-name Staging']);
    });

    it('rejects files outside a method directory', () => {
      expect(codesOf({ 'default/200_{text-plain}.txt': 'x' })).toEqual(['misplaced-file default/200_{text-plain}.txt']);
      expect(codesOf({ 'default/v1/products/200_{text-plain}.txt': 'x' })).toEqual([
        'invalid-method default/v1/products',
      ]);
    });

    it('rejects lowercase or invalid method directories', () => {
      expect(codesOf({ 'default/v1/get/204': '' })).toEqual(['invalid-method default/v1/get']);
      expect(codesOf({ 'default/v1/Get/204': '' })).toEqual(['invalid-method default/v1/Get']);
    });

    it('accepts any uppercase method token', () => {
      expect(buildSnapshot(files({ 'default/v1/PURGE/204': '', 'default/v1/M-SEARCH/204': '' })).ok).toBe(true);
    });

    it('rejects a method directory that also has subdirectories', () => {
      expect(
        codesOf({
          'default/v1/GET/200_{text-plain}.txt': 'a',
          'default/v1/GET/x/GET/200_{text-plain}.txt': 'b',
        }),
      ).toEqual(['misplaced-file default/v1/GET']);
    });

    it('rejects invalid and reserved path segments', () => {
      expect(
        codesOf({
          'default/a%zz/GET/204': '',
          'default/a%2Fb/GET/204': '',
          'default/%2e%2e/GET/204': '',
          'default/_janus/GET/204': '',
          'default/%5Fjanus/x/GET/204': '',
          'default/v1/_janus/GET/204': '',
        }),
      ).toEqual([
        'invalid-path-segment default/%2e%2e',
        'reserved-path default/%5Fjanus',
        'reserved-path default/_janus',
        'invalid-path-segment default/a%2Fb',
        'invalid-path-segment default/a%zz',
      ]);
    });

    it('rejects duplicate logical paths from percent-encoding and Unicode normalisation', () => {
      const errors = errorsOf({
        'default/ab/GET/204': '',
        'default/a%62/GET/204': '',
        'default/caf\u00e9/GET/204': '',
        'default/cafe\u0301/POST/204': '',
      });
      expect(errors.map((error) => error.code)).toEqual(['duplicate-route', 'duplicate-route']);
      expect(errors[0]?.message).toContain('/ab');
    });

    it('rejects routes that differ only by case', () => {
      expect(
        codesOf({
          'default/Users/GET/204': '',
          'default/users/list/GET/204': '',
        }),
      ).toEqual(['case-conflict default/Users']);
    });

    it('rejects routes that differ only by non-ASCII case, however they are spelt', () => {
      expect(codesOf({ 'default/caf\u00e9/GET/204': '', 'default/CAF\u00c9/POST/204': '' })).toEqual([
        'case-conflict default/CAF%C3%89',
      ]);
      expect(codesOf({ 'default/caf%C3%A9/GET/204': '', 'default/CAFE\u0301/POST/204': '' })).toEqual([
        'case-conflict default/CAF%C3%89',
      ]);
    });
  });

  describe('method directory errors', () => {
    it('requires a response file, and one status per representation group', () => {
      expect(codesOf({ 'default/v1/GET/200.headers.json': '{}' })).toEqual([
        'missing-response default/v1/GET',
        'orphan-header-sidecar default/v1/GET/200.headers.json',
      ]);
      expect(
        codesOf({ 'default/v1/GET/200_{text-plain}.txt': 'a', 'default/v1/GET/404_{text-plain}.txt': 'b' }),
      ).toEqual(['multiple-responses default/v1/GET']);
      expect(
        codesOf({ 'default/v1/GET/200_{text-plain}.txt': 'a', 'default/v1/GET/404_{application-json}.json': '{}' }),
      ).toEqual(['multiple-responses default/v1/GET']);
    });

    it('rejects unrecognised files', () => {
      expect(codesOf({ 'default/v1/GET/200_{text-plain}.txt': 'a', 'default/v1/GET/notes.md': '' })).toEqual([
        'invalid-filename default/v1/GET/notes.md',
      ]);
    });

    it('rejects a sidecar for a different status', () => {
      expect(codesOf({ 'default/v1/GET/200_{text-plain}.txt': 'a', 'default/v1/GET/404.headers.json': '{}' })).toEqual([
        'orphan-header-sidecar default/v1/GET/404.headers.json',
      ]);
    });

    it('validates JSON bodies without reserialising them', () => {
      expect(codesOf({ 'default/v1/GET/200_{application-json}.json': '{"a":' })).toEqual([
        'invalid-json default/v1/GET/200_{application-json}.json',
      ]);
      expect(buildSnapshot(files({ 'default/v1/GET/200_{application-json}.json': '"caf\u00e9"' })).ok).toBe(true);
      expect(buildSnapshot(files({ 'default/v1/GET/200_{application-json}.json': new Uint8Array([0xff]) })).ok).toBe(
        false,
      );
      // A non-.json extension is not parsed, even with a JSON media type.
      expect(buildSnapshot(files({ 'default/v1/GET/200_{application-json}.txt': '{"a":' })).ok).toBe(true);
    });

    it('requires bodyless fixtures to be empty', () => {
      expect(codesOf({ 'default/v1/DELETE/204': 'x' })).toEqual(['invalid-bodyless default/v1/DELETE/204']);
      expect(codesOf({ 'default/v1/DELETE/204_{text-plain}.txt': '' })).toEqual([
        'invalid-bodyless default/v1/DELETE/204_{text-plain}.txt',
      ]);
    });

    it('requires Location for redirects other than 304', () => {
      expect(codesOf({ 'default/old/GET/301_{text-plain}.txt': 'moved' })).toEqual([
        'status-header-conflict default/old/GET/301_{text-plain}.txt',
      ]);
      expect(
        buildSnapshot(
          files({
            'default/old/GET/301_{text-plain}.txt': 'moved',
            'default/old/GET/301.headers.json': '{"Location":"/new"}',
            'default/cached/GET/304': '',
          }),
        ).ok,
      ).toBe(true);
    });

    it('reports invalid sidecars with their location', () => {
      expect(
        errorsOf({
          'default/v1/DELETE/204': '',
          'default/v1/DELETE/204.headers.json': '{"Transfer-Encoding":"chunked","Content-Type":"text/html"}',
        }),
      ).toEqual([
        {
          code: 'invalid-headers',
          source: 'fixtures',
          path: 'default/v1/DELETE/204.headers.json',
          line: 1,
          column: 2,
          token: 'Transfer-Encoding',
          message: '"Transfer-Encoding" is a hop-by-hop header and cannot be set by a fixture',
        },
        {
          code: 'status-header-conflict',
          source: 'fixtures',
          path: 'default/v1/DELETE/204.headers.json',
          line: 1,
          column: 32,
          token: 'Content-Type',
          message: '"Content-Type" cannot be set for a bodyless status',
        },
      ]);
    });
  });

  it('aggregates independent errors in one pass, sorted by path', () => {
    const errors = errorsOf({
      'default/b/GET/200_{application-json}.json': '{',
      'default/a/get/204': '',
      'default/c/GET/200': '',
      'extra_1/GET/204': '',
    });
    expect(errors.map((error) => error.path)).toEqual([
      'default/a/get',
      'default/b/GET/200_{application-json}.json',
      'default/c/GET/200',
      'extra_1',
    ]);
  });

  it('rejects malformed source keys', () => {
    expect(codesOf({ '/default/GET/204': '', 'default/GET/204': '' })).toEqual([
      'invalid-source-path /default/GET/204',
    ]);
    expect(codesOf({ 'default/../GET/204': '', 'default/GET/204': '' })).toEqual([
      'invalid-source-path default/../GET/204',
    ]);
  });

  it('copies body bytes so later source mutation cannot change the snapshot', async () => {
    const { createEngine } = await import('../create-engine.js');
    const body = utf8Encode('abc');
    const result = buildSnapshot(new Map([['default/GET/200_{text-plain}.txt', body]]));
    if (!result.ok) throw new Error('expected a snapshot');
    body[0] = 0x7a;
    const response = await createEngine({ snapshot: result.snapshot }).resolve({
      method: 'GET',
      target: '/',
      headers: {},
    });
    expect(new TextDecoder().decode(response.body ?? new Uint8Array())).toBe('abc');
  });
});

describe('buildSnapshot with localized responses', () => {
  it('accepts localized responses alongside an optional language-neutral one', () => {
    const result = buildSnapshot(
      files({
        'default/v1/GET/200_[en-US]_{application-json}.json': '{"hello":"Hello"}',
        'default/v1/GET/200_[fr]_{application-json}.json': '{"hello":"Bonjour"}',
        'default/v1/GET/200_{application-json}.json': '{"hello":"Hello"}',
        'default/v2/GET/200_[de]_{text-plain}.txt': 'Hallo',
      }),
    );
    // A method still counts as one fixture, however many locales it has.
    expect(result).toMatchObject({ ok: true, snapshot: { routeCount: 2, fixtureCount: 2 } });
  });

  it('changes the snapshot version when a locale is renamed', () => {
    const version = (name: string): string => {
      const result = buildSnapshot(files({ [`default/v1/GET/${name}`]: 'x' }));
      if (!result.ok) throw new Error('expected a snapshot');
      return result.snapshot.version;
    };
    expect(version('200_[en]_{text-plain}.txt')).not.toBe(version('200_[fr]_{text-plain}.txt'));
    expect(version('200_[en]_{text-plain}.txt')).not.toBe(version('200_{text-plain}.txt'));
  });

  it('rejects the same locale and media type twice, ignoring case', () => {
    const errors = errorsOf({
      'default/v1/GET/200_[en-US]_{text-plain}.txt': 'a',
      'default/v1/GET/200_[en-us]_{Text-Plain}.txt': 'b',
    });
    expect(errors.map((error) => `${error.code} ${error.path}`)).toEqual(['duplicate-representation default/v1/GET']);
    expect(errors[0]?.message).toContain('case-insensitive');
  });

  it('rejects two language-neutral files of one media type next to localized ones', () => {
    expect(
      codesOf({
        'default/v1/GET/200_[en]_{text-plain}.txt': 'a',
        'default/v1/GET/200_{text-plain}.txt': 'b',
        'default/v1/GET/200_{text-plain}.TXT': 'c',
      }),
    ).toEqual(['duplicate-representation default/v1/GET']);
  });

  it('lets each locale have its own status and media type', () => {
    expect(
      buildSnapshot(
        files({
          'default/v1/GET/200_[en]_{text-plain}.txt': 'a',
          'default/v1/GET/404_[fr]_{application-json}.json': '{}',
          'default/v1/GET/204': '',
        }),
      ),
    ).toMatchObject({ ok: true, snapshot: { routeCount: 1, fixtureCount: 1 } });
  });

  it('rejects one locale with two statuses', () => {
    const errors = errorsOf({
      'default/v1/GET/200_[en]_{text-plain}.txt': 'a',
      'default/v1/GET/404_[EN]_{text-html}.html': 'b',
    });
    expect(errors.map((error) => `${error.code} ${error.path}`)).toEqual(['multiple-responses default/v1/GET']);
    expect(errors[0]?.message).toContain('same status');
  });

  it('applies each header sidecar to the responses of its status', () => {
    expect(
      buildSnapshot(
        files({
          'default/v1/GET/200_[en]_{text-plain}.txt': 'a',
          'default/v1/GET/404_[fr]_{text-plain}.txt': 'b',
          'default/v1/GET/404.headers.json': '{"X-Missing":"fr"}',
        }),
      ).ok,
    ).toBe(true);
    expect(
      codesOf({
        'default/v1/GET/200_[en]_{text-plain}.txt': 'a',
        'default/v1/GET/302_[fr]_{text-plain}.txt': 'b',
        'default/v1/GET/200.headers.json': '{"Location":"/elsewhere"}',
        'default/v1/GET/500.headers.json': '{}',
      }),
    ).toEqual([
      'status-header-conflict default/v1/GET/302_[fr]_{text-plain}.txt',
      'orphan-header-sidecar default/v1/GET/500.headers.json',
    ]);
    // One sidecar Content-Type cannot agree with two media types.
    expect(
      codesOf({
        'default/v1/GET/200_[en]_{text-plain}.txt': 'a',
        'default/v1/GET/200_[fr]_{text-html}.html': 'b',
        'default/v1/GET/200.headers.json': '{"Content-Type":"text/plain"}',
      }),
    ).toEqual(['status-header-conflict default/v1/GET/200.headers.json']);
  });

  it('validates the JSON of every locale', () => {
    expect(
      codesOf({
        'default/v1/GET/200_[en]_{application-json}.json': '{}',
        'default/v1/GET/200_[fr]_{application-json}.json': '{',
      }),
    ).toEqual(['invalid-json default/v1/GET/200_[fr]_{application-json}.json']);
  });

  it('shares one header sidecar across locales but rejects Content-Language in it', () => {
    expect(
      buildSnapshot(
        files({
          'default/v1/GET/200_[en]_{text-plain}.txt': 'a',
          'default/v1/GET/200_[fr]_{text-plain}.txt': 'b',
          'default/v1/GET/200.headers.json': '{"X-Example":"shared"}',
        }),
      ).ok,
    ).toBe(true);
    expect(
      codesOf({
        'default/v1/GET/200_[en]_{text-plain}.txt': 'a',
        'default/v1/GET/200.headers.json': '{"Content-Language":"en"}',
      }),
    ).toEqual(['status-header-conflict default/v1/GET/200.headers.json']);
    // Without localized responses, Content-Language stays an ordinary fixture header.
    expect(
      buildSnapshot(
        files({
          'default/v1/GET/200_{text-plain}.txt': 'a',
          'default/v1/GET/200.headers.json': '{"Content-Language":"en"}',
        }),
      ).ok,
    ).toBe(true);
  });

  it('rejects malformed locales with the file path', () => {
    expect(codesOf({ 'default/v1/GET/200_[en_US]_{text-plain}.txt': 'a' })).toEqual([
      'invalid-filename default/v1/GET/200_[en_US]_{text-plain}.txt',
    ]);
  });

  describe('locations, tokens and warnings', () => {
    it('locates invalid JSON in response bodies and header sidecars', () => {
      expect(
        errorsOf({
          'default/v1/GET/200_{application-json}.json': '{\n  "a": 1,\n}',
          'default/v2/GET/200_{text-plain}.txt': 'x',
          'default/v2/GET/200.headers.json': '{\n  "X-A": "1"\n  }\n}',
        }),
      ).toEqual([
        {
          code: 'invalid-json',
          source: 'fixtures',
          path: 'default/v1/GET/200_{application-json}.json',
          line: 3,
          column: 1,
          token: '}',
          message: 'invalid JSON: unexpected "}"',
        },
        {
          code: 'invalid-headers',
          source: 'fixtures',
          path: 'default/v2/GET/200.headers.json',
          line: 4,
          column: 1,
          token: '}',
          message: 'invalid JSON: unexpected "}"',
        },
      ]);
    });

    it('names the offending segment, method or file name in token', () => {
      const tokens = errorsOf({
        'default/p-{id}/GET/204': '',
        'default/_janus/GET/204': '',
        'default/a%zz/GET/204': '',
        'default/v1/get/204': '',
        'default/v2/GET/200.docx': '',
      }).map((error) => `${error.code} ${error.token ?? '-'}`);
      expect(tokens).toEqual([
        'reserved-path _janus',
        'invalid-path-segment a%zz',
        'invalid-path-parameter p-{id}',
        'invalid-method get',
        'invalid-filename 200.docx',
      ]);
    });

    it('tags every fixture error with its source', () => {
      expect(
        errorsOf({ 'default/v1/get/204': '', 'staging/GET/204': '' }).every((error) => error.source === 'fixtures'),
      ).toBe(true);
    });

    it('warns about a sidecar Content-Type that repeats the file name', () => {
      const result = buildSnapshot(
        files({
          'default/v1/GET/200_{application-json}.json': JSON_OK,
          'default/v1/GET/200.headers.json': '{\n  "X-A": "1",\n  "content-type": "application/json"\n}',
        }),
      );
      expect(result).toMatchObject({ ok: true });
      expect(result.warnings).toEqual([
        {
          code: 'redundant-content-type',
          source: 'fixtures',
          path: 'default/v1/GET/200.headers.json',
          line: 3,
          column: 3,
          message: '"Content-Type" repeats the media type the response file name already sets; remove it',
        },
      ]);
      expect(result.warnings[0]?.message).not.toContain('default/');
    });

    it('reports warnings alongside errors, and none for a clean tree', () => {
      const result = buildSnapshot(
        files({
          'default/v1/GET/200_{text-plain}.txt': 'a',
          'default/v1/GET/200.headers.json': '{"Content-Type":"text/plain"}',
          'default/v2/get/204': '',
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.warnings.map((warning) => warning.code)).toEqual(['redundant-content-type']);
      expect(buildSnapshot(files({ 'default/GET/204': '' })).warnings).toEqual([]);
    });

    it('warns about a method directory the transport cannot receive, once per directory', () => {
      const result = buildSnapshot(
        files({
          'default/v1/GET/204': '',
          'default/v1/PURGE/204': '',
          'default/v1/FOO/204': '',
          'staging/v1/FOO/204': '',
        }),
        { receivableMethods: ['GET', 'PURGE'] },
      );
      expect(result).toMatchObject({ ok: true });
      expect(result.warnings).toEqual([
        {
          code: 'unreceivable-method',
          source: 'fixtures',
          path: 'default/v1/FOO',
          token: 'FOO',
          message:
            '"FOO" is a valid method token, but the HTTP server cannot receive it, so this directory is never served',
        },
        {
          code: 'unreceivable-method',
          source: 'fixtures',
          path: 'staging/v1/FOO',
          token: 'FOO',
          message:
            '"FOO" is a valid method token, but the HTTP server cannot receive it, so this directory is never served',
        },
      ]);
      // Without a list, every method token is assumed receivable.
      expect(buildSnapshot(files({ 'default/v1/FOO/204': '' })).warnings).toEqual([]);
    });
  });
});
