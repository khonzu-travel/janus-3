import { describe, expect, it } from 'vitest';

import { writeYamlDocument } from './write.js';

describe('writeYamlDocument', () => {
  it('writes a new document with block literals for multi-line text', () => {
    expect(writeYamlDocument(null, { name: 'A', method: 'GET', scripts: { after: 'a();\nb();\n' } })).toBe(
      'name: A\nmethod: GET\nscripts:\n  after: |\n    a();\n    b();\n',
    );
  });

  it('keeps comments, key order and untouched values', () => {
    const before =
      '# Create a cart\nname: Create cart # shown in the tree\nmethod: POST\nurl: "{{baseUrl}}/carts"\nvars:\n  a: "1" # first\n  b: two\n';
    const after = writeYamlDocument(before, {
      name: 'Create cart',
      method: 'PUT',
      url: '{{baseUrl}}/carts',
      vars: { a: '1', c: '3' },
    });
    expect(after).toBe(
      '# Create a cart\nname: Create cart # shown in the tree\nmethod: PUT\nurl: "{{baseUrl}}/carts"\nvars:\n  a: "1" # first\n  c: "3"\n',
    );
  });

  it('drops members that are gone', () => {
    expect(writeYamlDocument('name: A\ndocs: old\n', { name: 'A' })).toBe('name: A\n');
  });
});
