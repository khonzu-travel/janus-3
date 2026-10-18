import type { NameValue, RequestBody } from '../model.js';

/**
 * The contract between a run and the script sandbox. The run
 * owns the request, response and variables; a script reaches them only
 * through this model, which the sandbox exposes as `pm`, `bru`, `req`, `res`,
 * `test`, `expect`, `tests` and the older Postman globals.
 */

/** Which scripts are running: `before` may change the request; `after` sees the response. */
export type ScriptPhase = 'before' | 'after';

/**
 * The request a script sees, before templates are rendered. In a `before`
 * script the sandbox may change it in place; the run renders it afterwards.
 * Changes in an `after` script are refused with `script-error`.
 */
export interface ScriptRequest {
  method: string;
  /** The URL template, query included. */
  url: string;
  /** The active headers, inherited ones first; disabled rows are left out. */
  headers: NameValue[];
  /** Absent for no body. */
  body: RequestBody | undefined;
}

/** The response an `after` script sees. */
export interface ScriptResponse {
  readonly status: number;
  /** The reason phrase, e.g. "Created"; "" when unknown. */
  readonly statusText: string;
  /** Header lines in the order received, names as received. */
  readonly headers: readonly (readonly [string, string])[];
  /** The body as UTF-8 text (replacement characters for invalid bytes). */
  readonly text: string;
  readonly timeMs: number;
}

/**
 * Variables as scripts see them. `get` reads the scopes in
 * order, run variables first; `set` and `unset` change run variables only.
 * Values are JSON values; `undefined` means not defined.
 */
export interface ScriptVariables {
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  unset(name: string): void;
  has(name: string): boolean;
  /** One scope only, for `bru.getRequestVar`, `getFolderVar`, `getCollectionVar` and `getEnvVar`. */
  scope(scope: 'request' | 'folder' | 'collection' | 'environment', name: string): unknown;
  /** Renders `{{name}}` variables in text, as `pm.variables.replaceIn` and `bru.interpolate` do. Unknown names are left as written. */
  interpolate(text: string): string;
  /** The environment's display name, or null without one. */
  readonly environmentName: string | null;
}

export interface ScriptInfo {
  /** The request's display name. */
  readonly requestName: string;
  /** The request ID, e.g. `checkout/010-create-cart`. */
  readonly requestId: string;
}

export interface ScriptLimits {
  /** `runner.scriptTimeoutMs`. */
  readonly timeoutMs: number;
  /** `runner.scriptMemoryBytes`. */
  readonly memoryBytes: number;
}

export interface ScriptInput {
  readonly source: string;
  readonly phase: ScriptPhase;
  readonly request: ScriptRequest;
  /** Present in the `after` phase. */
  readonly response?: ScriptResponse;
  readonly variables: ScriptVariables;
  readonly info: ScriptInfo;
  readonly limits: ScriptLimits;
}

/** A named test result. */
export interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  /** The assertion message when it failed. */
  readonly message?: string;
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error';

export interface ConsoleLine {
  readonly level: ConsoleLevel;
  /** At most 4 KiB. */
  readonly text: string;
}

export type ScriptFailureCode = 'script-error' | 'script-timeout' | 'script-memory' | 'script-unsupported';

export interface ScriptFailure {
  readonly code: ScriptFailureCode;
  /** The error's message; for `script-unsupported`, names the call. */
  readonly message: string;
  /** 1-based line in the script, when known. */
  readonly line?: number;
}

export interface ScriptOutcome {
  /** Null when the script ran to the end. */
  readonly failure: ScriptFailure | null;
  /** In the order recorded. */
  readonly tests: readonly TestResult[];
  /** At most 1 000 lines. */
  readonly console: readonly ConsoleLine[];
}

/** A syntax problem found when a script is compiled at load time. */
export interface ScriptSyntaxProblem {
  readonly message: string;
  /** 1-based. */
  readonly line: number;
  readonly column: number;
}
