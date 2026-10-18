/**
 * Declarative dependency rules, numbered as in README.md. Every workspace
 * package must have an entry here; an unknown package fails the boundary test,
 * so adding a package forces a decision about where it sits.
 */

/** Narrower rules for one directory of a package; unset fields inherit the package's. */
export interface DirectoryRule {
  /** Browser code: no Node built-ins and no Node globals. */
  readonly browser?: boolean;
  /** Replaces the package's `janusDeps` for files here. */
  readonly janusDeps?: readonly string[];
  /** Replaces the package's third-party allowlist for files here. */
  readonly thirdPartyAllowlist?: readonly string[];
  /** When set, the only modules files here may import (relative imports aside), each with the names allowed. */
  readonly onlyImports?: Readonly<Record<string, readonly string[]>>;
}

export interface PackageRule {
  /** The numbered dependency rule that governs this package's Janus edges, used in violation messages. */
  readonly dependencyRule: string;
  /** `@janus/*` packages this package may import and declare in its manifest. */
  readonly janusDeps: readonly string[];
  /**
   * `@janus/*` packages this package may declare in its manifest but never
   * import. The only reference allowed is a string literal
   * beginning with `<package>/dist/` passed to `import.meta.resolve`.
   */
  readonly assetDeps?: readonly string[];
  /** Core's platform rules (rule 1): no Node built-ins, no Node or browser-only globals, no non-literal dynamic imports. */
  readonly platformNeutral?: boolean;
  /** Browser code (rule 3): no Node built-ins and no Node globals; DOM globals are allowed. */
  readonly browser?: boolean;
  /**
   * Third-party packages this package may import. Absent means any. Grows only
   * with a reviewed change to this file.
   */
  readonly thirdPartyAllowlist?: readonly string[];
  /** Directory rules, keyed by a path prefix relative to the package such as `src/pages/`. */
  readonly directories?: Readonly<Record<string, DirectoryRule>>;
}

export const PACKAGE_RULES: Readonly<Record<string, PackageRule>> = {
  '@janus/core': {
    dependencyRule: '1 core imports nothing platform-specific',
    janusDeps: [],
    platformNeutral: true,
    // Browser-safe config parsing and validation: YAML (`yaml` 2) validated with Zod 4.
    // Both are pure JavaScript with no Node built-ins.
    // Dynamic values: faker (pinned exactly) for generators and jsonpath-plus for
    // body.<JSONPath>; both browser-safe. Each faker instance gets an injected randomizer.
    // XML request bodies: fast-xml-parser, pinned exactly, browser-safe.
    thirdPartyAllowlist: ['yaml', 'zod', '@faker-js/faker', 'jsonpath-plus', 'fast-xml-parser'],
  },
  '@janus/runner': {
    dependencyRule: '8 the runner depends only on core and does no I/O',
    janusDeps: ['@janus/core'],
    // No Node built-ins or globals; the server reaches the network and files for it.
    platformNeutral: true,
    // QuickJS runs scripts in its own engine, chai is evaluated inside it as text,
    // tough-cookie keeps a run's cookies, @usebruno/lang reads .bru files and fflate reads
    // zips; yaml and zod read and validate request files.
    thirdPartyAllowlist: ['yaml', 'zod', 'quickjs-emscripten', 'tough-cookie', '@usebruno/lang', 'fflate'],
  },
  '@janus/adapter-http': { dependencyRule: '4 adapters depend only on core', janusDeps: ['@janus/core'] },
  '@janus/adapter-fetch': { dependencyRule: '4 adapters depend only on core', janusDeps: ['@janus/core'] },
  '@janus/fixtures-fs': { dependencyRule: '4 fixture sources depend only on core', janusDeps: ['@janus/core'] },
  '@janus/fixtures-vite': {
    dependencyRule: '4 fixture sources depend only on core (except fixtures-vite → fixtures-fs)',
    janusDeps: ['@janus/core', '@janus/fixtures-fs'],
  },
  '@janus/server': {
    dependencyRule: '5 only server wires everything',
    janusDeps: ['@janus/core', '@janus/adapter-http', '@janus/fixtures-fs', '@janus/runner'],
    // The server serves the built UI files and never imports UI code.
    assetDeps: ['@janus/ui'],
  },
  '@janus/desktop': {
    dependencyRule: '7 the desktop app runs Janus only through the server',
    janusDeps: ['@janus/server'],
    // The app ships the built UI and links its tokens.css; it never imports UI code.
    assetDeps: ['@janus/ui'],
    thirdPartyAllowlist: ['electron', 'react', 'react-dom'],
    directories: {
      'src/main/': { thirdPartyAllowlist: ['electron'] },
      'src/server-host/': { thirdPartyAllowlist: [] },
      // The app's own pages are browser code that reaches the app only through the bridge's global.
      'src/pages/': { browser: true, janusDeps: [], thirdPartyAllowlist: ['react', 'react-dom'] },
      // The preload's two imports, plus the shared contract bundled into it.
      'src/preload/': { janusDeps: [], onlyImports: { electron: ['contextBridge', 'ipcRenderer'] } },
      'src/shared/': { janusDeps: [], thirdPartyAllowlist: [] },
    },
  },
  '@janus/ui': {
    dependencyRule: '3 ui imports no Janus package',
    janusDeps: [],
    browser: true,
    // The adopted UI stack. Tailwind is used only from CSS. shiki 4 highlights
    // body previews, loaded lazily. CodeMirror 6 edits request scripts, also
    // loaded lazily.
    thirdPartyAllowlist: [
      'react',
      'react-dom',
      'react-router',
      '@tanstack/react-query',
      'shiki',
      '@codemirror/autocomplete',
      '@codemirror/commands',
      '@codemirror/lang-javascript',
      '@codemirror/lang-json',
      '@codemirror/language',
      '@codemirror/state',
      '@codemirror/view',
      '@lezer/highlight',
    ],
  },
};

/**
 * The package allowed to wire several adapters and sources together (rule 5).
 * Nothing depends on it except a package whose rule lists it, the desktop app (rule 7).
 */
export const COMPOSITION_ROOT = '@janus/server';

/** Adapters and fixture sources: only the composition root may depend on more than one (rule 5). */
export const ADAPTERS_AND_SOURCES: readonly string[] = [
  '@janus/adapter-http',
  '@janus/adapter-fetch',
  '@janus/fixtures-fs',
  '@janus/fixtures-vite',
];

/**
 * Node globals that platform-neutral source must not reference (rule 1). Shared
 * with eslint.config.js for editor feedback.
 */
export const NODE_GLOBALS: readonly string[] = ['Buffer', 'process', 'require', '__dirname', '__filename', 'global'];

/**
 * Browser-only globals that platform-neutral source must not reference (rule 1).
 * Core compiles with lib "DOM" for web-standard APIs shared by browsers and Node
 * (fetch, AbortSignal, URL, TextEncoder, crypto.subtle); these are the globals
 * that lib also declares but only a browser provides. Shared with
 * eslint.config.js for editor feedback.
 */
export const BROWSER_ONLY_GLOBALS: readonly string[] = [
  'window',
  'self',
  'top',
  'parent',
  'frames',
  'opener',
  'document',
  'navigator',
  'location',
  'history',
  'screen',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'cookieStore',
  'XMLHttpRequest',
  'alert',
  'confirm',
  'prompt',
  'open',
  'close',
  'print',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'getComputedStyle',
  'matchMedia',
  'customElements',
  // Confusing DOM globals that make a missing local declaration look valid.
  'name',
  'length',
  'status',
  'event',
  'origin',
  'external',
];
