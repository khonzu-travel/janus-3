import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import { parseAccepts } from './accepts.js';

const parse = (text: string) => parseAccepts(utf8Encode(text));

describe('parseAccepts', () => {
  it('reads accepted media types and the optional missing-Content-Type default', () => {
    expect(
      parse('accepts: [application/json, multipart/form-data]\nallowMissingContentType: application/json\n'),
    ).toEqual({
      ok: true,
      policy: { mediaTypes: ['application/json', 'multipart/form-data'], allowMissingContentType: 'application/json' },
    });
    expect(parse('accepts:\n  - text/csv\n')).toEqual({
      ok: true,
      policy: { mediaTypes: ['text/csv'], allowMissingContentType: null },
    });
  });

  it('matches allowMissingContentType case-insensitively and keeps the listed spelling', () => {
    expect(parse('accepts: [Application/JSON]\nallowMissingContentType: application/json\n')).toMatchObject({
      ok: true,
      policy: { allowMissingContentType: 'Application/JSON' },
    });
  });

  it.each([
    ['', 'must be a mapping'],
    ['- application/json\n', 'must be a mapping'],
    ['allowMissingContentType: application/json\n', 'needs an "accepts" list'],
    ['accepts: []\n', 'non-empty list'],
    ['accepts: application/json\n', 'non-empty list'],
    ['accepts: [application/*]\n', 'wildcard'],
    ['accepts: ["*/*"]\n', 'wildcard'],
    ['accepts: ["application/json; charset=utf-8"]\n', 'has parameters'],
    ['accepts: [json]\n', 'not a media type'],
    ['accepts: [1]\n', 'not a string'],
    ['accepts: [application/json, APPLICATION/JSON]\n', 'more than once'],
    ['accepts: [application/json]\nallowMissingContentType: text/plain\n', 'one of the media types'],
    ['accepts: [application/json]\nallow: application/json\n', 'unknown key "allow"'],
    ['accepts: [application/json]\naccepts: [text/plain]\n', 'duplicate key'],
    ['accepts: [application/json\n', 'invalid YAML'],
  ])('rejects %j', (text, message) => {
    const result = parse(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.message).join('\n')).toContain(message);
  });

  it('locates each problem', () => {
    const result = parse('accepts:\n  - application/json\n  - text/*\nextra: 1\n');
    expect(result).toEqual({
      ok: false,
      problems: [
        {
          message: 'unknown key "extra" in accepts.yaml; expected accepts or allowMissingContentType',
          position: { line: 4, column: 1 },
          token: 'extra',
        },
        {
          message: '"accepts" entry "text/*" is a wildcard; list each media type',
          position: { line: 3, column: 5 },
          token: 'text/*',
        },
      ],
    });
  });

  it('rejects invalid UTF-8', () => {
    expect(parseAccepts(new Uint8Array([0xff]))).toEqual({
      ok: false,
      problems: [{ message: 'the file is not valid UTF-8' }],
    });
  });
});
