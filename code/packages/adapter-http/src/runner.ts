import type { HeaderMap, RequestErrorCode } from '@janus/core';

/**
 * The request runner's Atlas routes. The server implements the
 * service: it reads and writes the request tree and keeps runs. The adapter
 * only checks IDs, parses JSON bodies and writes answers.
 */

export type RunnerAnswer =
  | {
      readonly ok: true;
      readonly status: number;
      /** Absent for `204`. */
      readonly document?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: RequestErrorCode;
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
    };

/** `requests` and `run` events: no request or response values. */
export type AtlasRunnerEvent =
  | { readonly type: 'requests'; readonly changed: readonly string[] }
  | {
      readonly type: 'run';
      readonly id: string;
      readonly state: 'started' | 'step' | 'finished';
      readonly step?: number;
      readonly outcome?: string;
    };

export type RunnerMethod = 'GET' | 'PUT' | 'DELETE';

export interface AtlasRunnerService {
  /** `capabilities.runner`. */
  capability(): { readonly available: boolean; readonly reason?: 'non-loopback'; readonly collections: number };
  /** `runner.maxImportBytes`: the decoded bound of an import. */
  readonly maxImportBytes: number;
  tree(): RunnerAnswer;
  request(method: RunnerMethod, id: string, headers: HeaderMap, body: unknown): Promise<RunnerAnswer>;
  folder(method: RunnerMethod, id: string, headers: HeaderMap, body: unknown): Promise<RunnerAnswer>;
  /** A shared environment, by name. */
  environment(method: RunnerMethod, name: string, headers: HeaderMap, body: unknown): Promise<RunnerAnswer>;
  import(body: unknown, signal?: AbortSignal): Promise<RunnerAnswer>;
  startRun(body: unknown): Promise<RunnerAnswer>;
  runs(): RunnerAnswer;
  run(method: 'GET' | 'DELETE', id: string): RunnerAnswer;
  subscribe(listener: (event: AtlasRunnerEvent) => void): () => void;
}

export type RunnerRoute = 'requests' | 'request' | 'folder' | 'environment' | 'imports' | 'runs' | 'run';

export const RUNNER_RESOURCES: ReadonlySet<string> = new Set([
  'requests',
  'folders',
  'environments',
  'imports',
  'runs',
]);

/** The methods each runner resource answers. */
export const RUNNER_METHODS: Readonly<Record<RunnerRoute, readonly string[]>> = {
  requests: ['GET', 'HEAD'],
  request: ['GET', 'HEAD', 'PUT', 'DELETE'],
  folder: ['GET', 'HEAD', 'PUT', 'DELETE'],
  environment: ['GET', 'HEAD', 'PUT', 'DELETE'],
  imports: ['POST'],
  runs: ['GET', 'HEAD', 'POST'],
  run: ['GET', 'HEAD', 'DELETE'],
};

/** The runner resource a path names, by shape only; IDs are checked by `runnerIds`. */
export function runnerRoute(segments: readonly string[]): RunnerRoute | null {
  const [, resource, ...rest] = segments;
  switch (resource) {
    case 'requests':
      return rest.length === 0 ? 'requests' : 'request';
    case 'folders':
      return rest.length === 0 ? null : 'folder';
    case 'environments':
      return rest.length === 1 ? 'environment' : null;
    case 'imports':
      return rest.length === 0 ? 'imports' : null;
    case 'runs':
      return rest.length === 0 ? 'runs' : rest.length === 1 ? 'run' : null;
    default:
      return null;
  }
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RUN_ID = /^r-[0-9]{6,}$/;
/** A collection, eight folders and a request. */
const MAX_ID_SEGMENTS = 10;

/** Each decoded segment checked against the name grammar before any filesystem access. */
function isRunnerId(parts: readonly string[]): boolean {
  return (
    parts.length > 0 &&
    parts.length <= MAX_ID_SEGMENTS &&
    parts.every((part) => NAME.test(part) && new TextEncoder().encode(part).length <= 64)
  );
}

export async function handleRunnerRequest(
  service: AtlasRunnerService,
  route: RunnerRoute,
  method: string,
  segments: readonly string[],
  headers: HeaderMap,
  body: Uint8Array | null,
  signal: AbortSignal | undefined,
): Promise<RunnerAnswer> {
  const notFound = (what: string): RunnerAnswer => ({
    ok: false,
    status: 404,
    code: 'atlas-resource-not-found',
    message: `No ${what} with this ID exists`,
  });
  if (!service.capability().available) {
    return {
      ok: false,
      status: 404,
      code: 'atlas-resource-not-found',
      message:
        'The request runner is not available on a non-loopback listener; set runner.allowNonLoopback to allow it',
    };
  }
  const parts = segments.slice(2);
  const read = method === 'HEAD' ? 'GET' : (method as RunnerMethod);
  let parsed: unknown = undefined;
  if (method === 'PUT' || method === 'POST') {
    const json = parseJsonBody(headers, body);
    if (!json.ok) return json.answer;
    parsed = json.value;
  }
  switch (route) {
    case 'requests':
      return service.tree();
    case 'request':
      if (!isRunnerId(parts) || parts.length < 2) return notFound('request');
      return service.request(read, parts.join('/'), headers, parsed);
    case 'folder':
      if (!isRunnerId(parts) || parts.length > MAX_ID_SEGMENTS - 1) return notFound('folder');
      return service.folder(read, parts.join('/'), headers, parsed);
    case 'environment': {
      const [name = ''] = parts;
      if (!isRunnerId([name])) return notFound('environment');
      return service.environment(read, name, headers, parsed);
    }
    case 'imports':
      return service.import(parsed, signal);
    case 'runs':
      return method === 'POST' ? service.startRun(parsed) : service.runs();
    case 'run': {
      const id = parts[0] ?? '';
      if (!RUN_ID.test(id)) return notFound('run');
      return service.run(method === 'DELETE' ? 'DELETE' : 'GET', id);
    }
  }
}

/** The JSON body rules: a JSON `Content-Type` and UTF-8 JSON text. */
function parseJsonBody(
  headers: HeaderMap,
  body: Uint8Array | null,
): { ok: true; value: unknown } | { ok: false; answer: RunnerAnswer } {
  const type = headers['content-type']?.[0]?.split(';', 1)[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    return {
      ok: false,
      answer: {
        ok: false,
        status: 415,
        code: 'unsupported-media-type',
        message: 'The request body must be application/json',
      },
    };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body ?? new Uint8Array())) };
  } catch {
    return {
      ok: false,
      answer: {
        ok: false,
        status: 400,
        code: 'atlas-invalid-request',
        message: 'Invalid Atlas request: the body is not valid UTF-8 JSON',
      },
    };
  }
}
