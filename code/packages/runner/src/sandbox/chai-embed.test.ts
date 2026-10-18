/// <reference types="node" />
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderChaiModule, renderChaiSource } from './chai-embed.js';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('the embedded chai', () => {
  it('is current with the installed chai', () => {
    const { version } = JSON.parse(read('../../node_modules/chai/package.json')) as { version: string };
    const expected = renderChaiModule(read('../../node_modules/chai/index.js'), version);
    expect(
      read('./chai-source.generated.ts') === expected,
      'run: node --import tsx packages/runner/scripts/embed-chai.ts',
    ).toBe(true);
  });

  it('returns the exports it needs, renamed or not', () => {
    const source = renderChaiSource(
      'var a = 1;\nfunction e() {}\nexport {\n  a as assert,\n  AssertionError,\n  e as expect\n};\n',
    );
    expect(source).toContain('return { expect: e, assert: a, AssertionError: AssertionError };');
    expect(() => renderChaiSource('var a = 1;\nexport { a as assert };\n')).toThrow(/expect is not exported/);
    expect(() => renderChaiSource('import x from "y";\nexport { x as expect };\n')).toThrow(/no imports/);
    expect(() => renderChaiSource('var a = 1;')).toThrow(/no trailing export list/);
  });
});
