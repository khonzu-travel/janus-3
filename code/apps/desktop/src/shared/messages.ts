// The messages between the main process and a server process,
// and their validation. Each side validates what it receives; anything else is
// logged and ignored.

/** The only `ServeArgs` the app ever sends. */
export interface StartArgs {
  readonly noConfig: false;
  /** Set only by Start on a Free Port, to 0. */
  readonly port?: number;
}

export type MainToServer = { readonly type: 'start'; readonly args: StartArgs } | { readonly type: 'stop' };

export interface ProblemData {
  readonly code: string;
  readonly source: string;
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly token?: string;
  readonly key?: string;
  readonly message: string;
}

export interface PathsData {
  readonly cwd: string;
  readonly configFile: string | null;
  readonly fixturesRoot: string | null;
  readonly captures: string | null;
}

/** A `LaunchResult` without its server handle: `started` carries the server's URL instead. */
export type ResultData =
  | {
      readonly kind: 'invalid';
      readonly errors: readonly ProblemData[];
      readonly warnings: readonly ProblemData[];
      readonly notes: readonly string[];
      readonly paths: PathsData;
    }
  | {
      readonly kind: 'bind-failed';
      readonly code: string;
      readonly host: string;
      readonly port: number;
      readonly paths: PathsData;
    }
  | {
      readonly kind: 'started';
      readonly url: string;
      readonly uiUrl: string | null;
      readonly warnings: readonly ProblemData[];
      readonly summary: readonly string[];
      readonly paths: PathsData;
    };

export type ServerToMain =
  | { readonly type: 'log'; readonly stream: 'out' | 'err'; readonly line: string }
  | { readonly type: 'result'; readonly result: ResultData }
  | { readonly type: 'stopped' };

type Record_ = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Record_ =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535;
const isOptional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);
const isPositiveInteger = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;
const hasOnly = (value: Record_, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

export function isMainToServer(value: unknown): value is MainToServer {
  if (!isRecord(value)) return false;
  if (value['type'] === 'stop') return hasOnly(value, ['type']);
  if (value['type'] !== 'start' || !hasOnly(value, ['type', 'args'])) return false;
  const args = value['args'];
  return (
    isRecord(args) &&
    hasOnly(args, ['noConfig', 'port']) &&
    args['noConfig'] === false &&
    isOptional(args['port'], isPort)
  );
}

function isProblem(value: unknown): value is ProblemData {
  return (
    isRecord(value) &&
    isString(value['code']) &&
    isString(value['source']) &&
    isString(value['path']) &&
    isString(value['message']) &&
    isOptional(value['line'], isPositiveInteger) &&
    isOptional(value['column'], isPositiveInteger) &&
    isOptional(value['token'], isString) &&
    isOptional(value['key'], isString)
  );
}

const isProblems = (value: unknown): value is readonly ProblemData[] => Array.isArray(value) && value.every(isProblem);
const isStrings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(isString);
const isNullableString = (value: unknown): boolean => value === null || isString(value);

function isPaths(value: unknown): value is PathsData {
  return (
    isRecord(value) &&
    isString(value['cwd']) &&
    isNullableString(value['configFile']) &&
    isNullableString(value['fixturesRoot']) &&
    isNullableString(value['captures'])
  );
}

function isResult(value: unknown): value is ResultData {
  if (!isRecord(value) || !isPaths(value['paths'])) return false;
  switch (value['kind']) {
    case 'invalid':
      return isProblems(value['errors']) && isProblems(value['warnings']) && isStrings(value['notes']);
    case 'bind-failed':
      return isString(value['code']) && isString(value['host']) && isPort(value['port']);
    case 'started':
      return (
        isHttpUrl(value['url']) &&
        (value['uiUrl'] === null || isHttpUrl(value['uiUrl'])) &&
        isProblems(value['warnings']) &&
        isStrings(value['summary'])
      );
    default:
      return false;
  }
}

function isHttpUrl(value: unknown): boolean {
  if (!isString(value)) return false;
  try {
    return new URL(value).protocol === 'http:';
  } catch {
    return false;
  }
}

export function isServerToMain(value: unknown): value is ServerToMain {
  if (!isRecord(value)) return false;
  switch (value['type']) {
    case 'log':
      return (
        hasOnly(value, ['type', 'stream', 'line']) &&
        (value['stream'] === 'out' || value['stream'] === 'err') &&
        isString(value['line'])
      );
    case 'result':
      return hasOnly(value, ['type', 'result']) && isResult(value['result']);
    case 'stopped':
      return hasOnly(value, ['type']);
    default:
      return false;
  }
}
