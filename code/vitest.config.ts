import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

import { listWorkspacePackages } from './tests/workspace-packages.js';

const root = import.meta.dirname;

// Tests run against package source, never a prior build: every workspace
// package name is aliased to its `src/index.ts`. The alias list is generated
// from pnpm-workspace.yaml so a new package cannot be missed. (The
// `@janus/source` export condition would also work; aliases were chosen so
// resolution does not depend on how Vite applies custom conditions.)
const alias = Object.fromEntries(
  listWorkspacePackages(root).map((pkg) => [pkg.name, resolve(root, pkg.dir, 'src/index.ts')]),
);

export default defineConfig({
  resolve: { alias },
  test: {
    watch: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'apps/ui/**'],
        },
      },
      // The browser UI runs under jsdom with its own Vite config (React, no workspace aliases).
      'apps/ui/vite.config.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}'],
      reporter: ['text', 'html'],
    },
  },
});
