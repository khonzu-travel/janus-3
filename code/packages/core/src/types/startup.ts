/** Which input a startup problem was found in. Also the report's primary sort key. */
/** `requests` is the request tree under `runner.root`. */
export type StartupSource = 'cli' | 'config' | 'fixtures' | 'requests' | 'ui';

/** Stable, machine-readable startup error codes. */
export type StartupErrorCode =
  // Command line and configuration file
  | 'cli-conflict'
  | 'config-not-found'
  | 'config-unreadable'
  | 'config-invalid-yaml'
  | 'config-duplicate-key'
  | 'config-unknown-key'
  | 'config-invalid-value'
  // Source (reading the fixture tree)
  | 'data-root-missing'
  | 'data-root-not-directory'
  | 'unreadable'
  | 'symbolic-link'
  | 'unsupported-file-type'
  | 'invalid-source-path'
  // Layout
  | 'missing-default-scenario'
  | 'unexpected-file'
  | 'misplaced-file'
  | 'invalid-path-segment'
  | 'invalid-path-parameter'
  | 'duplicate-path-parameter'
  | 'multiple-template-children'
  | 'reserved-path'
  | 'invalid-method'
  | 'duplicate-route'
  | 'case-conflict'
  // Response files
  | 'invalid-filename'
  | 'missing-response'
  | 'multiple-responses'
  | 'duplicate-representation'
  | 'invalid-accepts'
  | 'orphan-header-sidecar'
  | 'invalid-json'
  | 'invalid-bodyless'
  | 'invalid-headers'
  | 'reserved-header'
  | 'status-header-conflict'
  // Dynamic values
  | 'unknown-dynamic-token'
  | 'invalid-dynamic-token'
  | 'unknown-timezone'
  | 'unknown-path-parameter'
  | 'impure-faker-path'
  | 'invalid-alias'
  | 'invalid-text-body'
  // Scenarios
  | 'invalid-scenario-name'
  | 'too-many-scenarios'
  | 'invalid-flow'
  | 'unknown-parent-scenario'
  | 'scenario-cycle'
  | 'scenario-chain-too-deep'
  | 'stale-scenario-reference'
  | 'contradictory-scenario-reference'
  | 'duplicate-scenario-reference'
  | 'unknown-default-scenario'
  // Choosing between responses
  | 'duplicate-variant'
  | 'invalid-control'
  | 'conflicting-controls'
  | 'unknown-identity'
  | 'unknown-scenario-id'
  // Recording
  | 'recording-invalid-endpoint'
  | 'recording-overlap'
  | 'captures-inside-fixtures'
  | 'captures-not-writable'
  | 'recording-non-loopback'
  // Promotion
  | 'invalid-provenance'
  | 'fixtures-not-writable'
  | 'promotion-unreviewed'
  // Request runner
  | 'request-invalid'
  | 'request-invalid-name'
  | 'request-invalid-template'
  | 'request-invalid-path-params'
  | 'request-invalid-script'
  | 'request-invalid-extract'
  | 'request-invalid-environment'
  | 'requests-overlap'
  | 'runner-invalid-ca';

/** Stable codes for problems that are reported but never change behaviour. */
export type StartupWarningCode =
  | 'non-loopback-bind'
  | 'config-similar-file-ignored'
  | 'redundant-content-type'
  // Header policy
  | 'janus-computed-header'
  | 'content-type-override'
  // Dynamic values
  | 'fully-dynamic-fixture'
  // The UI build is missing while the UI is enabled
  | 'ui-assets-missing'
  // A matchesETag rule the plain 200's ETag can never produce
  | 'etag-mismatch'
  // Recording
  | 'recording-exposed'
  | 'capture-incomplete'
  // Promotion
  | 'promotions-pending'
  | 'stale-provenance'
  // A method directory the HTTP server cannot receive
  | 'unreceivable-method'
  // A sidecar Access-Control-* header dropped under fixture CORS
  | 'cors-header-ignored'
  // Request runner
  | 'runner-exposed'
  | 'requests-unknown-file'
  // Shared environments
  | 'requests-collection-environments'
  | 'requests-unknown-environment';

/** One located problem that stops Janus from starting. Shared by the command line, configuration, and fixtures. */
export interface StartupError {
  readonly code: StartupErrorCode;
  readonly source: StartupSource;
  /**
   * Fixtures: source-relative path of the offending file or directory ("" for the data root).
   * Requests: the path as displayed, under `runner.root` as given.
   * Config: the configuration file's display name. CLI: the offending flag.
   */
  readonly path: string;
  /** 1-based, when the input is text and the parser can locate the problem. */
  readonly line?: number;
  readonly column?: number;
  /** The offending key, segment, filename, or value, verbatim and safe to print. */
  readonly token?: string;
  /** Config only: the key path, e.g. "server.port". */
  readonly key?: string;
  readonly message: string;
}

/** A problem worth reporting that does not stop Janus from starting. */
export interface StartupWarning {
  readonly code: StartupWarningCode;
  readonly source: StartupSource;
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  /** Safe to serve over HTTP: never contains an absolute or data-root path. */
  readonly message: string;
}
