import type { StartupError, StartupWarning } from './startup.js';

/**
 * A fixture source's complete contents: source-relative POSIX paths ("default/v1/GET/200")
 * mapped to file bytes. Keys never begin with "/" and use "/" on every platform.
 * Directories and symbolic links are never values. Enumeration order has no meaning.
 */
export type FixtureFiles = ReadonlyMap<string, Uint8Array>;

/** Public summary of an immutable, validated fixture snapshot. Build one with `buildSnapshot`. */
export interface FixtureSnapshot {
  /** Stable identifier derived from the snapshot's logical content (not file order, spelling, or timing). */
  readonly version: string;
  /** Number of method-level fixtures (one per route and method) in `default`. */
  readonly fixtureCount: number;
  /** Number of distinct URL paths in `default`. */
  readonly routeCount: number;
}

/** Both outcomes carry warnings, sorted like errors; a warning never makes a tree invalid. */
export type BuildSnapshotResult =
  | { readonly ok: true; readonly snapshot: FixtureSnapshot; readonly warnings: readonly StartupWarning[] }
  | { readonly ok: false; readonly errors: readonly StartupError[]; readonly warnings: readonly StartupWarning[] };

/** Configuration the snapshot is validated against. */
export interface BuildSnapshotOptions {
  /** `dynamic.aliases`: custom clock aliases tokens may name. Invalid entries are ignored here; config parsing reports them. */
  readonly aliases?: Readonly<Record<string, string>>;
  /** `scenarios.default`: a name that is not a scenario directory is `unknown-default-scenario`. */
  readonly defaultScenario?: string;
  /**
   * The methods the transport can receive (for Node, `http.METHODS`). A method
   * directory outside the list is the warning `unreceivable-method`. Absent, every
   * method token is assumed receivable.
   */
  readonly receivableMethods?: readonly string[];
  /** `cors.fixtures.origins` is non-empty: sidecar `Access-Control-*` headers are dropped with a warning. */
  readonly fixtureCors?: boolean;
}
