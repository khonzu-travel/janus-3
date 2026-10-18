import { describe, expect, it } from 'vitest';

import { checkBoundaries, extractImports, findPlatformGlobalReferences } from './check.js';
import type { RuleId, Violation, WorkspacePackage } from './check.js';

const APPS = new Set(['server', 'ui', 'desktop']);

/** Builds a one-file package; Janus dependencies default to what the source imports. */
function pkg(name: string, source: string, deps: readonly string[] = []): WorkspacePackage {
  const short = name.replace('@janus/', '');
  return {
    name,
    dir: `${APPS.has(short) ? 'apps' : 'packages'}/${short}`,
    manifest: { dependencies: Object.fromEntries(deps.map((dep) => [dep, 'workspace:*'])) },
    files: [{ path: 'src/index.ts', contents: source }],
  };
}

function check(...packages: WorkspacePackage[]): Violation[] {
  return checkBoundaries({ packages });
}

function rules(violations: readonly Violation[]): RuleId[] {
  return violations.map((violation) => violation.rule);
}

describe('extractImports', () => {
  it('finds every import form with its line and type-only status', () => {
    const source = [
      "import a from 'static';",
      "import 'side-effect';",
      "import type { T } from 'type-clause';",
      "import { type U, type V } from 'type-specifiers';",
      "import { type W, x } from 'mixed';",
      "export { y } from 're-export';",
      "export type { Z } from 'type-re-export';",
      "export { type Y } from 'inline-type-re-export';",
      "export * from 'star';",
      "const lazy = import('dynamic');",
      "const cjs = require('required');",
      "import eq = require('import-equals');",
      "type Q = import('import-type').Q;",
      'const computed = import(name);',
    ].join('\n');
    expect(extractImports({ path: 'src/a.ts', contents: source })).toEqual([
      { specifier: 'static', kind: 'static', typeOnly: false, line: 1 },
      { specifier: 'side-effect', kind: 'static', typeOnly: false, line: 2 },
      { specifier: 'type-clause', kind: 'type', typeOnly: true, line: 3 },
      { specifier: 'type-specifiers', kind: 'static', typeOnly: false, line: 4 },
      { specifier: 'mixed', kind: 'static', typeOnly: false, line: 5 },
      { specifier: 're-export', kind: 'static', typeOnly: false, line: 6 },
      { specifier: 'type-re-export', kind: 'type', typeOnly: true, line: 7 },
      { specifier: 'inline-type-re-export', kind: 'static', typeOnly: false, line: 8 },
      { specifier: 'star', kind: 'static', typeOnly: false, line: 9 },
      { specifier: 'dynamic', kind: 'dynamic', typeOnly: false, line: 10 },
      { specifier: 'required', kind: 'require', typeOnly: false, line: 11 },
      { specifier: 'import-equals', kind: 'require', typeOnly: false, line: 12 },
      { specifier: 'import-type', kind: 'type', typeOnly: true, line: 13 },
      { specifier: null, kind: 'dynamic', typeOnly: false, line: 14 },
    ]);
  });

  it('ignores imports in comments and strings', () => {
    const source = "// import 'node:fs';\n/* require('x') */\nconst s = \"import 'y'\";\nconst t = `import('z')`;";
    expect(extractImports({ path: 'src/a.ts', contents: source })).toEqual([]);
  });
});

describe('findPlatformGlobalReferences', () => {
  it('reports browser-only globals too', () => {
    const source = 'const w = window;\ndocument.title;\nconst o = { document: 1 };';
    expect(findPlatformGlobalReferences({ path: 'src/a.ts', contents: source })).toEqual([
      { name: 'window', line: 1 },
      { name: 'document', line: 2 },
    ]);
  });

  it('reports references but not property names or shadowing declarations', () => {
    const source = [
      "Buffer.from('');",
      'const env = process.env;',
      'const o = { process: 1, global: 2 };',
      'o.process;',
      'function f(__dirname: string) { return __dirname; }',
      'type G = typeof global;',
    ].join('\n');
    expect(findPlatformGlobalReferences({ path: 'src/a.ts', contents: source })).toEqual([
      { name: 'Buffer', line: 1 },
      { name: 'process', line: 2 },
      { name: 'global', line: 6 },
    ]);
  });
});

describe('checkBoundaries', () => {
  describe('passing cases', () => {
    it('accepts the allowed edges', () => {
      expect(
        check(
          pkg('@janus/core', "import type { X } from './types/index.js';\nexport const x = globalThis.fetch;"),
          pkg('@janus/adapter-http', "import 'node:http';\nimport { createEngine } from '@janus/core';", [
            '@janus/core',
          ]),
          pkg('@janus/adapter-fetch', "export * from '@janus/core';", ['@janus/core']),
          pkg('@janus/fixtures-fs', "import { readFile } from 'node:fs/promises';\nimport '@janus/core';", [
            '@janus/core',
          ]),
          pkg('@janus/fixtures-vite', "import '@janus/core';\nimport '@janus/fixtures-fs';", [
            '@janus/core',
            '@janus/fixtures-fs',
          ]),
          pkg('@janus/server', "import '@janus/core';\nimport '@janus/adapter-http';\nimport '@janus/fixtures-fs';", [
            '@janus/core',
            '@janus/adapter-http',
            '@janus/fixtures-fs',
          ]),
          pkg(
            '@janus/ui',
            "import { useState } from 'react';\nimport { useQuery } from '@tanstack/react-query';\nconst el = document.body;\nwindow.location.hash = '';",
          ),
        ),
      ).toEqual([]);
    });
  });

  describe('rule table coverage', () => {
    it('rejects a package without a rule', () => {
      expect(rules(check(pkg('@janus/mystery', 'export {};')))).toEqual(['unknown-package']);
    });
  });

  describe('rule 1: core imports nothing platform-specific', () => {
    it.each([
      ["import { readFile } from 'node:fs';", 'core-node-import'],
      ["import path from 'path';", 'core-node-import'],
      ["import 'fs/promises';", 'core-node-import'],
      ["const fs = await import('node:fs');", 'core-node-import'],
      ["import { merge } from 'lodash';", 'third-party'],
      ["const x = await import('undici');", 'third-party'],
      ["import '@janus/adapter-http';", 'janus-edge'],
      ['const m = await import(name);', 'core-dynamic-specifier'],
    ] as const)('rejects %s', (source, rule) => {
      expect(rules(check(pkg('@janus/core', source)))).toContain(rule);
    });

    it.each(['Buffer', 'process', 'require', '__dirname', '__filename', 'global'])(
      'rejects the Node global %s',
      (name) => {
        const violations = check(pkg('@janus/core', `export const x = ${name};`));
        expect(violations).toEqual([expect.objectContaining({ rule: 'core-node-global', specifier: name, line: 1 })]);
      },
    );

    it.each(['window', 'document', 'localStorage', 'navigator', 'XMLHttpRequest', 'status'])(
      'rejects the browser-only global %s',
      (name) => {
        const violations = check(pkg('@janus/core', `export const x = ${name};`));
        expect(violations).toEqual([
          expect.objectContaining({ rule: 'core-browser-global', specifier: name, line: 1 }),
        ]);
      },
    );

    it('allows web-standard globals and local names that shadow browser globals', () => {
      const source = [
        'export const signal = new AbortController().signal;',
        "export const url = new URL('https://example.test/');",
        "export const bytes = new TextEncoder().encode('x');",
        'export const subtle = globalThis.crypto.subtle;',
        'export function f(name: string, status: number) { return { name, status, length: name.length }; }',
      ].join('\n');
      expect(check(pkg('@janus/core', source))).toEqual([]);
    });
  });

  describe('rule 3: ui imports no Janus package', () => {
    it('rejects even a type-only import of core', () => {
      expect(rules(check(pkg('@janus/ui', "import type { Engine } from '@janus/core';")))).toEqual(['janus-edge']);
    });

    it.each([
      ["import { readFile } from 'node:fs';", 'browser-node-import'],
      ["import path from 'path';", 'browser-node-import'],
      ['const env = process.env;', 'browser-node-global'],
      ["const bytes = Buffer.from('x');", 'browser-node-global'],
      ["import axios from 'axios';", 'third-party'],
      ["import { z } from 'zod';", 'third-party'],
    ])('rejects %s', (source, rule) => {
      expect(rules(check(pkg('@janus/ui', source)))).toEqual([rule]);
    });
  });

  describe('rule 4: adapters and sources depend only on core', () => {
    it('rejects an adapter importing a source', () => {
      const violations = check(pkg('@janus/adapter-http', "import '@janus/fixtures-fs';"));
      expect(rules(violations)).toEqual(['janus-edge']);
    });

    it('rejects fixtures-fs importing fixtures-vite (the exception is one-way)', () => {
      expect(rules(check(pkg('@janus/fixtures-fs', "import '@janus/fixtures-vite';")))).toEqual(['janus-edge']);
    });
  });

  describe('rule 5: only server wires everything', () => {
    it('rejects a dependency on server', () => {
      const violations = check(pkg('@janus/adapter-http', "import '@janus/server';", ['@janus/server']));
      expect(rules(violations)).toContain('server-only-wires');
    });

    it('rejects a non-server package wiring several adapters and sources', () => {
      const rulesTable = {
        '@janus/wiring': { dependencyRule: 'test', janusDeps: ['@janus/adapter-http', '@janus/fixtures-fs'] },
      };
      const violations = checkBoundaries(
        { packages: [pkg('@janus/wiring', 'export {};', ['@janus/adapter-http', '@janus/fixtures-fs'])] },
        rulesTable,
      );
      expect(rules(violations)).toEqual(['server-only-wires']);
    });
  });

  describe('manifests agree with the rules', () => {
    it('rejects a disallowed manifest edge even without an import', () => {
      expect(rules(check(pkg('@janus/core', 'export {};', ['@janus/fixtures-fs'])))).toEqual(['manifest-edge']);
    });

    it('rejects a disallowed devDependency or peerDependency', () => {
      const base = pkg('@janus/ui', 'export {};');
      const violations = check({
        ...base,
        manifest: { devDependencies: { '@janus/core': 'workspace:*' }, peerDependencies: { '@janus/server': '*' } },
      });
      expect(rules(violations)).toEqual(['manifest-edge', 'manifest-edge', 'server-only-wires']);
    });

    it('rejects a Janus dependency not declared as workspace:*', () => {
      const base = pkg('@janus/adapter-http', 'export {};');
      expect(rules(check({ ...base, manifest: { dependencies: { '@janus/core': '^0.0.0' } } }))).toEqual([
        'manifest-edge',
      ]);
    });

    it('rejects an allowed import that the manifest does not declare', () => {
      expect(rules(check(pkg('@janus/adapter-http', "import '@janus/core';")))).toEqual(['manifest-missing']);
    });
  });

  describe('no reaching into other packages', () => {
    it('rejects a relative import that leaves the package', () => {
      const violations = check(pkg('@janus/adapter-http', "import { x } from '../../core/src/index.js';"));
      expect(violations).toEqual([
        expect.objectContaining({
          rule: 'relative-escape',
          specifier: '../../core/src/index.js',
          file: 'src/index.ts',
        }),
      ]);
    });

    it('allows a relative import inside the package', () => {
      expect(check(pkg('@janus/adapter-http', "import { x } from '../src/other.js';"))).toEqual([]);
    });

    it('rejects a deep import of another package', () => {
      const violations = check(pkg('@janus/adapter-http', "import '@janus/core/src/types/index.js';", ['@janus/core']));
      expect(rules(violations)).toEqual(['deep-import']);
    });
  });

  describe('asset dependencies', () => {
    const server = (source: string, deps: readonly string[] = ['@janus/core', '@janus/ui']) =>
      check(pkg('@janus/server', source, deps));

    it("allows resolving the asset dependency's dist/ files", () => {
      expect(server("const index = import.meta.resolve('@janus/ui/dist/index.html');")).toEqual([]);
    });

    it('rejects a static import of it', () => {
      expect(rules(server("import '@janus/ui';"))).toEqual(['asset-import']);
      expect(rules(server("export { x } from '@janus/ui';"))).toEqual(['asset-import']);
    });

    it('rejects a dynamic import or require of it', () => {
      expect(rules(server("const ui = await import('@janus/ui/dist/index.js');"))).toEqual([
        'deep-import',
        'asset-import',
      ]);
      expect(rules(server("const ui = await import('@janus/ui');"))).toEqual(['asset-import']);
      expect(rules(server("const ui = require('@janus/ui');"))).toEqual(['asset-import']);
    });

    it('rejects resolving anything but dist/, or a package that is not an asset dependency', () => {
      expect(rules(server("import.meta.resolve('@janus/ui/src/main.tsx');"))).toEqual(['asset-resolve']);
      expect(rules(server("import.meta.resolve('@janus/core/dist/index.js');"))).toEqual(['asset-resolve']);
    });

    it('requires the asset dependency in the manifest', () => {
      expect(rules(server("import.meta.resolve('@janus/ui/dist/index.html');", ['@janus/core']))).toEqual([
        'manifest-missing',
      ]);
    });

    it('rejects declaring it from a package without the rule', () => {
      expect(rules(check(pkg('@janus/adapter-http', 'export {};', ['@janus/ui'])))).toEqual(['manifest-edge']);
    });
  });

  describe('rule 7: the desktop app runs Janus only through the server', () => {
    const DEPS = ['@janus/server', '@janus/ui'];
    const desktop = (path: string, source: string, deps: readonly string[] = DEPS): Violation[] =>
      check({
        name: '@janus/desktop',
        dir: 'apps/desktop',
        manifest: { dependencies: Object.fromEntries(deps.map((dep) => [dep, 'workspace:*'])) },
        files: [{ path, contents: source }],
      });

    it('accepts the allowed imports in each directory', () => {
      expect(
        desktop('src/main/index.ts', "import { app } from 'electron';\nimport { launch } from '@janus/server';"),
      ).toEqual([]);
      expect(
        desktop('src/server-host/index.ts', "import { launch } from '@janus/server';\nimport 'node:path';"),
      ).toEqual([]);
      expect(
        desktop('src/pages/start.tsx', "import { useState } from 'react';\nimport '../shared/bridge.js';"),
      ).toEqual([]);
      expect(
        desktop(
          'src/preload/index.ts',
          "import { contextBridge, ipcRenderer } from 'electron';\nimport '../shared/bridge.js';",
        ),
      ).toEqual([]);
      expect(desktop('src/main/ui.ts', "import.meta.resolve('@janus/ui/dist/index.html');")).toEqual([]);
    });

    it('rejects importing core from the main process', () => {
      expect(rules(desktop('src/main/index.ts', "import '@janus/core';", [...DEPS, '@janus/core']))).toEqual([
        'manifest-edge',
        'janus-edge',
      ]);
    });

    it('rejects UI code, even as an asset', () => {
      expect(rules(desktop('src/main/index.ts', "import '@janus/ui';"))).toEqual(['asset-import']);
    });

    it('rejects React in the main process', () => {
      expect(rules(desktop('src/main/index.ts', "import 'react';"))).toEqual(['third-party']);
    });

    it('rejects Node built-ins, Node globals, Electron and Janus packages in a page', () => {
      expect(rules(desktop('src/pages/start.tsx', "import 'node:fs';"))).toEqual(['browser-node-import']);
      expect(rules(desktop('src/pages/start.tsx', 'export const p = process.platform;'))).toEqual([
        'browser-node-global',
      ]);
      expect(rules(desktop('src/pages/start.tsx', "import { ipcRenderer } from 'electron';"))).toEqual(['third-party']);
      expect(rules(desktop('src/pages/start.tsx', "import '@janus/server';"))).toEqual(['janus-edge']);
    });

    it('rejects anything in the preload beyond contextBridge and ipcRenderer', () => {
      expect(rules(desktop('src/preload/index.ts', "import { shell } from 'electron';"))).toEqual(['directory-import']);
      expect(rules(desktop('src/preload/index.ts', "import * as electron from 'electron';"))).toEqual([
        'directory-import',
      ]);
      expect(rules(desktop('src/preload/index.ts', "import 'node:fs';"))).toEqual(['directory-import']);
      expect(rules(desktop('src/preload/index.ts', "import '@janus/server';"))).toEqual([
        'directory-import',
        'janus-edge',
      ]);
    });

    it('still rejects a dependency on the server from any other package', () => {
      expect(rules(check(pkg('@janus/ui', "import '@janus/server';", ['@janus/server'])))).toContain(
        'server-only-wires',
      );
    });
  });
});
