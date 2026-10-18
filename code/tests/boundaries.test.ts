import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkBoundaries, formatViolation } from './boundaries/check.js';
import { PACKAGE_RULES } from './boundaries/rules.js';
import { scanWorkspace } from './boundaries/scan.js';

const workspace = scanWorkspace(resolve(import.meta.dirname, '..'));

describe('dependency rules', () => {
  it('finds the workspace packages', () => {
    expect(workspace.packages.map((pkg) => pkg.name)).toContain('@janus/core');
    for (const pkg of workspace.packages) expect(PACKAGE_RULES).toHaveProperty([pkg.name]);
  });

  it('has no boundary violations', () => {
    const violations = checkBoundaries(workspace).map(formatViolation);
    expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
  });
});
