import { describe, expect, it } from 'vitest';

import { requestTokenGrammar } from '@janus/core';

import { validateEnvironmentValue, validateFolderValue } from './documents.js';
import { buildRequestTree, environmentValues, type BuildRequestTreeResult } from './tree.js';

// The request snapshot's layout.

const grammar = requestTokenGrammar({});
const encoder = new TextEncoder();

function build(files: Record<string, string>, directories: string[]): BuildRequestTreeResult {
  return buildRequestTree(
    {
      files: new Map(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)])),
      directories: new Set(directories),
    },
    { grammar },
  );
}

const REQUEST = 'name: A\nmethod: GET\nurl: https://example.com/a\n';

describe('shared environments', () => {
  it('reads environments directly under the root, never as a collection', () => {
    const { tree, errors, warnings } = build(
      {
        'environments/staging.yaml': 'name: Staging\nvars:\n  host: https://a.example.com\n',
        'environments/staging.local.yaml': 'vars:\n  token: mine\n',
        'environments/dev.yaml': 'vars:\n  host: http://localhost\n',
        'api/010-a.request.yaml': REQUEST,
        'shop/010-a.request.yaml': REQUEST,
      },
      ['environments', 'api', 'shop'],
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(tree.collections.map((collection) => collection.id)).toEqual(['api', 'shop']);
    expect(tree.nodes.has('environments')).toBe(false);
    expect(tree.environments.map((entry) => entry.id)).toEqual(['dev', 'staging']);
    expect(tree.environments[1]?.local?.vars).toEqual({ token: 'mine' });
  });

  it('checks environment files as before', () => {
    const { errors } = build(
      {
        'environments/orphan.local.yaml': 'vars:\n  a: b\n',
        'environments/Bad.yaml': 'vars: {}\n',
        'environments/ok.yaml': 'vars:\n  a: b\n',
      },
      ['environments'],
    );
    expect(errors.map((error) => [error.code, error.path])).toEqual([
      ['request-invalid-name', 'environments/Bad.yaml'],
      ['request-invalid-environment', 'environments/orphan.local.yaml'],
    ]);
  });

  it('skips a collection’s own environments directory with a warning, and keeps deeper ones as folders', () => {
    const { tree, errors, warnings } = build(
      {
        'api/environments/staging.yaml': 'vars:\n  a: b\n',
        'api/payments/environments/010-a.request.yaml': REQUEST,
      },
      ['api', 'api/environments', 'api/payments', 'api/payments/environments'],
    );
    expect(errors).toEqual([]);
    expect(tree.environments).toEqual([]);
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'requests-collection-environments', path: 'api/environments' }),
    ]);
    expect(warnings[0]?.message).toContain('environments/ directly under the requests root');
    expect(tree.nodes.get('api/payments/environments/010-a')?.kind).toBe('request');
  });

  it('validates a collection’s preferred environment; a missing one is a warning', () => {
    const { tree, errors, warnings } = build(
      {
        'environments/staging.yaml': 'vars: {}\n',
        'api/folder.yaml': 'environment: staging\n',
        'shop/folder.yaml': 'environment: prod\n',
      },
      ['environments', 'api', 'shop'],
    );
    expect(errors).toEqual([]);
    expect(tree.nodes.get('api')).toMatchObject({ document: { environment: 'staging' } });
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'requests-unknown-environment', path: 'shop/folder.yaml' }),
    ]);
    const invalid = build({ 'api/folder.yaml': 'environment: Not A Name\n' }, ['api']);
    expect(invalid.errors).toEqual([expect.objectContaining({ code: 'request-invalid', path: 'api/folder.yaml' })]);
    const nested = validateFolderValue({ environment: 'staging' }, 'api/sub/folder.yaml', { grammar }, false);
    expect(nested.problems[0]?.message).toContain('only be set in a collection');
  });

  it('keeps disabled variables in the files but leaves them out of the values', () => {
    const { tree, errors } = build(
      {
        'environments/staging.yaml': 'vars:\n  host: h\n  token: shared\n  keep: k\ndisabled: [token, absent]\n',
        'environments/staging.local.yaml': 'vars:\n  token: mine\n  extra: e\n',
      },
      ['environments'],
    );
    expect(errors).toEqual([]);
    const entry = tree.environments[0];
    if (entry === undefined) throw new Error('no environment');
    expect(entry.document.disabled).toEqual(['token', 'absent']);
    expect(environmentValues(entry)).toEqual({ host: 'h', keep: 'k', extra: 'e' });
  });

  it('refuses disabled in a .local.yaml and names that are not variable names', () => {
    const local = validateEnvironmentValue({ vars: { a: 'b' }, disabled: ['a'] }, 'environments/x.local.yaml', true);
    expect(local.problems).toEqual([expect.objectContaining({ code: 'request-invalid', pointer: 'disabled' })]);
    const main = validateEnvironmentValue({ disabled: ['1bad'] }, 'environments/x.yaml', false);
    expect(main.problems).toEqual([expect.objectContaining({ code: 'request-invalid', pointer: 'disabled[0]' })]);
    const { errors } = build({ 'environments/x.yaml': 'vars: {}\n', 'environments/x.local.yaml': 'disabled: [a]\n' }, [
      'environments',
    ]);
    expect(errors).toEqual([expect.objectContaining({ path: 'environments/x.local.yaml' })]);
  });

  it('reads default only from the main file', () => {
    const main = validateEnvironmentValue({ vars: {}, default: true }, 'environments/x.yaml', false);
    expect(main.problems).toEqual([]);
    expect(main.document?.default).toBe(true);
    const local = validateEnvironmentValue({ default: true }, 'environments/x.local.yaml', true);
    expect(local.problems).toEqual([expect.objectContaining({ code: 'request-invalid' })]);
  });
});
