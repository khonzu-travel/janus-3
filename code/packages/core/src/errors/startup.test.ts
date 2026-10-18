import { describe, expect, it } from 'vitest';

import type { StartupError, StartupWarning } from '../types/index.js';
import { formatStartupReport, sortStartupProblems } from './startup.js';

const ERRORS: readonly StartupError[] = [
  {
    code: 'invalid-json',
    source: 'fixtures',
    path: 'default/v1/GET/200.headers.json',
    line: 3,
    column: 15,
    message: 'invalid JSON: unexpected "}"',
  },
  {
    code: 'config-invalid-value',
    source: 'config',
    path: 'janus.config.yaml',
    line: 9,
    column: 18,
    message: 'expected 404 or 405, got 403',
  },
  { code: 'data-root-missing', source: 'fixtures', path: '', message: 'the data root does not exist' },
  {
    code: 'config-unknown-key',
    source: 'config',
    path: 'janus.config.yaml',
    line: 4,
    column: 3,
    message: 'unknown key "prot" under "server"; did you mean "port"?',
  },
  { code: 'cli-conflict', source: 'cli', path: '--config', message: '--config and --no-config cannot be combined' },
  { code: 'invalid-method', source: 'fixtures', path: 'default/v1/get', token: 'get', message: 'bad method' },
  {
    code: 'config-duplicate-key',
    source: 'config',
    path: 'janus.config.yaml',
    line: 4,
    column: 3,
    message: 'duplicate',
  },
];

const WARNINGS: readonly StartupWarning[] = [
  {
    code: 'redundant-content-type',
    source: 'fixtures',
    path: 'default/GET/200.headers.json',
    line: 1,
    column: 2,
    message: 'redundant',
  },
  { code: 'non-loopback-bind', source: 'cli', path: '--host', message: 'not loopback' },
];

describe('sortStartupProblems', () => {
  it('orders by source, path, line, column, then code', () => {
    expect(
      sortStartupProblems(ERRORS).map((error) => `${error.source} ${error.path}:${String(error.line)} ${error.code}`),
    ).toEqual([
      'cli --config:undefined cli-conflict',
      'config janus.config.yaml:4 config-duplicate-key',
      'config janus.config.yaml:4 config-unknown-key',
      'config janus.config.yaml:9 config-invalid-value',
      'fixtures :undefined data-root-missing',
      'fixtures default/v1/GET/200.headers.json:3 invalid-json',
      'fixtures default/v1/get:undefined invalid-method',
    ]);
  });

  it('does not depend on input order', () => {
    const forward = sortStartupProblems(ERRORS);
    const reversed = sortStartupProblems([...ERRORS].reverse());
    const rotated = sortStartupProblems([...ERRORS.slice(3), ...ERRORS.slice(0, 3)]);
    expect(reversed).toEqual(forward);
    expect(rotated).toEqual(forward);
    expect(Object.isFrozen(forward)).toBe(true);
  });
});

describe('formatStartupReport', () => {
  it('prints a summary, then errors, then warnings, one per line', () => {
    expect(formatStartupReport(ERRORS, WARNINGS, { fixturesRoot: 'data', outcome: 'not starting' })).toBe(
      [
        'janus: 7 startup errors and 2 warnings; not starting.',
        '  --config: --config and --no-config cannot be combined [cli-conflict]',
        '  janus.config.yaml:4:3: duplicate [config-duplicate-key]',
        '  janus.config.yaml:4:3: unknown key "prot" under "server"; did you mean "port"? [config-unknown-key]',
        '  janus.config.yaml:9:18: expected 404 or 405, got 403 [config-invalid-value]',
        '  data: the data root does not exist [data-root-missing]',
        '  data/default/v1/GET/200.headers.json:3:15: invalid JSON: unexpected "}" [invalid-json]',
        '  data/default/v1/get: bad method [invalid-method]',
        '  warning: --host: not loopback [non-loopback-bind]',
        '  warning: data/default/GET/200.headers.json:1:2: redundant [redundant-content-type]',
        '',
      ].join('\n'),
    );
  });

  it('uses singular nouns, omits a zero warning count, and adds notes', () => {
    expect(formatStartupReport(ERRORS.slice(0, 1), [], { outcome: 'not starting', notes: ['fixtures skipped'] })).toBe(
      [
        'janus: 1 startup error; not starting.',
        '  default/v1/GET/200.headers.json:3:15: invalid JSON: unexpected "}" [invalid-json]',
        '  note: fixtures skipped',
        '',
      ].join('\n'),
    );
  });

  it('shows the data root as "." without a display root', () => {
    expect(formatStartupReport(ERRORS.slice(2, 3), [], { outcome: 'x' })).toContain(
      '  .: the data root does not exist [data-root-missing]',
    );
    expect(formatStartupReport(ERRORS.slice(2, 3), [], { fixturesRoot: '.', outcome: 'x' })).toContain('  .: the');
  });
});
