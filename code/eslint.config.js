import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

import { BROWSER_ONLY_GLOBALS, NODE_GLOBALS } from './tests/boundaries/rules.ts';

// Editor-facing copy of dependency rule 1 (see README.md).
// tests/boundaries.test.ts is the authoritative check.
const coreRestrictedImports = {
  patterns: [
    { group: ['node:*'], message: 'core must stay platform-neutral: no Node built-ins.' },
    { group: ['@janus/*'], message: 'core imports no other Janus package.' },
  ],
};
const coreRestrictedGlobals = [
  ...NODE_GLOBALS.map((name) => ({ name, message: `core must stay platform-neutral: no Node global \`${name}\`.` })),
  ...BROWSER_ONLY_GLOBALS.map((name) => ({
    name,
    message: `core must stay platform-neutral: no browser-only global \`${name}\`.`,
  })),
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      'apps/desktop/release/**',
      'packages/runner/src/sandbox/chai-source.generated.ts',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // `import { type A } from 'x'` still emits `import {} from 'x'` under verbatimModuleSyntax.
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', coreRestrictedImports],
      'no-restricted-globals': ['error', ...coreRestrictedGlobals],
    },
  },
  {
    // Rule 3: the UI is a browser app that talks to Janus only over HTTP.
    files: ['apps/ui/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest'], jsxA11y.flatConfigs.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      // Scrollable body previews must be reachable by keyboard (WCAG 2.1.1).
      'jsx-a11y/no-noninteractive-tabindex': ['error', { tags: ['pre'], roles: ['tabpanel'] }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'the UI runs in a browser: no Node built-ins.' },
            { group: ['@janus/*'], message: 'the UI imports no Janus package; use the Atlas HTTP API.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...NODE_GLOBALS.map((name) => ({ name, message: `the UI runs in a browser: no Node global \`${name}\`.` })),
      ],
    },
  },
  {
    // Rule 7: the desktop app's own pages are browser code that reaches the app only through its bridge.
    files: ['apps/desktop/src/pages/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest'], jsxA11y.flatConfigs.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      'jsx-a11y/no-noninteractive-tabindex': ['error', { tags: ['pre'] }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: "the app's pages run in a browser: no Node built-ins." },
            { group: ['@janus/*', 'electron'], message: "the app's pages reach the app only through window.janusApp." },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...NODE_GLOBALS.map((name) => ({
          name,
          message: `the app's pages run in a browser: no Node global \`${name}\`.`,
        })),
      ],
    },
  },
  prettier,
);
