import {
  array,
  boolean,
  count,
  DecodeError,
  literal,
  nullable,
  object,
  oneOf,
  optional,
  pattern,
  string,
  type Decoder,
} from './decode.js';
import type { Explanation } from './client.js';
import { decodeExplanation, type Preview, type ResponseHeader, type WireExplanation } from './wire.js';

/**
 * The request runner's Atlas resources, as the UI reads them.
 * Request, folder and environment documents are the JSON form of their YAML
 * files; the UI edits them as values and sends them back whole.
 */

/** A collection, folder, request or environment name. */
export const RUNNER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ID = /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/;
const RUN_ID = /^r-[0-9]{6,}$/;

const runnerId = pattern(ID, 'a request ID');
const runId = pattern(RUN_ID, 'a run ID');
const code = pattern(/^[a-z0-9-]{1,64}$/, 'a code');

export interface NameValue {
  readonly name: string;
  readonly value: string;
  readonly disabled?: boolean;
}

export type MultipartPart =
  | { readonly name: string; readonly value: string; readonly disabled?: boolean }
  | { readonly name: string; readonly file: string; readonly contentType?: string; readonly disabled?: boolean };

export type RequestBody =
  | { readonly type: 'json' | 'text' | 'xml'; readonly text: string }
  | { readonly type: 'form'; readonly fields: readonly NameValue[] }
  | { readonly type: 'multipart'; readonly parts: readonly MultipartPart[] }
  | { readonly type: 'file'; readonly file: string; readonly contentType?: string }
  | { readonly type: 'graphql'; readonly query: string; readonly variables?: string };

export type BodyType = RequestBody['type'];
export const BODY_TYPES: readonly BodyType[] = ['json', 'text', 'xml', 'form', 'multipart', 'file', 'graphql'];

export type ExtractEntry =
  | string
  | {
      readonly value: string;
      readonly match?: string;
      readonly optional?: boolean;
      readonly default?: unknown;
    };

export interface Scripts {
  readonly before?: string;
  readonly after?: string;
}

/** `<name>.request.yaml`. */
export interface RequestDocument {
  readonly name: string;
  readonly method: string;
  readonly url: string;
  readonly pathParams?: Readonly<Record<string, string>>;
  readonly headers?: readonly NameValue[];
  readonly body?: RequestBody;
  readonly vars?: Readonly<Record<string, string>>;
  readonly extract?: Readonly<Record<string, ExtractEntry>>;
  readonly scripts?: Scripts;
  readonly route?: string;
  readonly docs?: string;
  readonly source?: { readonly format: string; readonly file: string; readonly item: string };
}

/** `folder.yaml`. */
export interface FolderDocument {
  readonly name?: string;
  readonly vars?: Readonly<Record<string, string>>;
  readonly headers?: readonly NameValue[];
  readonly scripts?: Scripts;
  readonly stripPrefix?: string;
  readonly cookies?: boolean;
  readonly docs?: string;
  /** A collection's preferred environment, picked when one of its requests opens. */
  readonly environment?: string;
}

export interface EnvironmentDocument {
  readonly name?: string;
  readonly vars?: Readonly<Record<string, string>>;
  /** Variables kept in the files but not used; only in the main file. */
  readonly disabled?: readonly string[];
  /** The default environment: picked until another is; only in the main file. */
  readonly default?: boolean;
}

export interface RunnerProblem {
  readonly code: string;
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly pointer?: string;
  readonly message: string;
}

export type TreeNode =
  | { readonly kind: 'request'; readonly id: string; readonly name: string; readonly method: string }
  | {
      readonly kind: 'folder';
      readonly id: string;
      readonly name: string;
      readonly children: readonly TreeNode[];
    }
  | {
      readonly kind: 'collection';
      readonly id: string;
      readonly name: string;
      readonly children: readonly TreeNode[];
    };

export type CollectionNode = Extract<TreeNode, { kind: 'collection' }>;
export type ContainerNode = Extract<TreeNode, { kind: 'collection' | 'folder' }>;

/** An environment as the tree lists it. */
export interface EnvironmentEntry {
  readonly id: string;
  readonly name: string;
  /** The default environment, picked until another is. */
  readonly default?: boolean;
}

export interface RequestTree {
  readonly version: string;
  readonly collections: readonly CollectionNode[];
  /** Shared by every collection. */
  readonly environments: readonly EnvironmentEntry[];
  readonly problems: readonly RunnerProblem[];
}

/** `GET /_janus/requests/{id}`: the file, the folders above it and every environment. */
export interface RequestDetail {
  readonly id: string;
  readonly digest: string;
  readonly document: RequestDocument;
  /** Collection first. */
  readonly folders: readonly {
    readonly id: string;
    readonly kind: 'collection' | 'folder';
    readonly name: string;
    readonly document: FolderDocument;
  }[];
  /** Values merged with `.local.yaml`. */
  readonly environments: readonly {
    readonly id: string;
    readonly name: string;
    readonly vars: Readonly<Record<string, string>>;
  }[];
}

export interface FolderDetail {
  readonly id: string;
  readonly kind: 'collection' | 'folder';
  /** Null when the folder has no `folder.yaml`. */
  readonly digest: string | null;
  readonly document: FolderDocument;
}

export interface EnvironmentDetail {
  readonly id: string;
  readonly digest: string;
  readonly document: EnvironmentDocument;
  readonly local: EnvironmentDocument | null;
}

export interface Written {
  readonly id: string;
  readonly digest: string | null;
  /** `201`: the file did not exist. */
  readonly created: boolean;
}

export interface ImportReportItem {
  readonly file: string;
  readonly location: string;
  readonly name: string;
  readonly outcome: 'converted' | 'converted-with-notes' | 'skipped';
  readonly notes: readonly string[];
  readonly id?: string;
}

export interface ImportTransaction {
  readonly position: number;
  readonly method: string;
  readonly url: string;
  readonly origin: string;
  readonly static: boolean;
  readonly included: boolean;
}

export interface ImportResult {
  readonly preview: boolean;
  readonly written: boolean;
  readonly format: string;
  readonly collection: string;
  readonly name: string;
  readonly exists: boolean;
  /** Shared environments the import brings that exist already; importing replaces them. */
  readonly existingEnvironments: readonly string[];
  readonly files: readonly { readonly path: string; readonly kind: string }[];
  readonly report: readonly ImportReportItem[];
  readonly origins: readonly { readonly origin: string; readonly variable: string; readonly transactions: number }[];
  readonly transactions: readonly ImportTransaction[];
  readonly problems: readonly RunnerProblem[];
}

export interface ImportRequest {
  readonly files: readonly { readonly name: string; readonly contentBase64: string }[];
  readonly into?: string;
  readonly replace?: boolean;
  readonly preview?: boolean;
  readonly includeStatic?: boolean;
  readonly origins?: readonly string[];
  readonly positions?: readonly number[];
}

/**
 * Where a run sends: Janus (`mock`), the real API (`upstream`), the real API
 * with a capture (`record`), or nowhere: `explain` asks what the mock would answer.
 */
export type RunMode = 'mock' | 'upstream' | 'record' | 'explain';

export interface RunRequest {
  readonly target: { readonly id: string; readonly request?: RequestDocument };
  readonly environment?: string;
  readonly mode: RunMode;
  readonly scenario?: string;
  readonly vars?: Readonly<Record<string, unknown>>;
  /** Explain mode: the RFC 3339 instant to render at. */
  readonly now?: string;
}

export type StepOutcome = 'passed' | 'failed' | 'not-run' | 'running' | 'pending';

export interface StepResult {
  readonly step: number;
  readonly requestId: string;
  readonly name: string;
  readonly outcome: StepOutcome;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: readonly ResponseHeader[];
    readonly body: Preview;
  } | null;
  readonly response: {
    readonly status: number;
    readonly headers: readonly ResponseHeader[];
    readonly body: Preview;
    readonly timeMs: number;
  } | null;
  readonly tests: readonly { readonly name: string; readonly passed: boolean; readonly message?: string }[];
  readonly console: readonly { readonly level: 'log' | 'info' | 'warn' | 'error'; readonly text: string }[];
  /** Set in this step; null = unset. */
  readonly variables: Readonly<Record<string, unknown>>;
  readonly capture: string | null;
  /** Where the scenario came from: the request's own X-Mock-Scenario, or the run's; null when neither named one. */
  readonly scenarioFrom: 'request' | 'run' | null;
  readonly janusRequestId: string | null;
  /** Mock and explain mode: the decisions Janus made (or would make) answering the request. */
  readonly explanation: Explanation | null;
}

export interface RunSummary {
  readonly id: string;
  readonly target: {
    readonly kind: 'request' | 'folder' | 'collection';
    readonly id: string;
    readonly unsaved: boolean;
  };
  readonly environment: string | null;
  readonly mode: RunMode;
  /** The scenario picked for the run, or null when Janus decided. */
  readonly scenario: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly state: 'running' | 'finished';
  readonly outcome: 'passed' | 'failed' | 'cancelled' | null;
  readonly stepCount: number;
  readonly passed: number;
  readonly failed: number;
}

export interface RunRecord extends RunSummary {
  readonly steps: readonly StepResult[];
  readonly vars: Readonly<Record<string, unknown>>;
}

/** What a `412 request-changed` carries: the file as it is now, or null when it is gone. */
export interface CurrentFile {
  readonly digest: string;
  readonly document: Readonly<Record<string, unknown>>;
  readonly local?: Readonly<Record<string, unknown>> | null;
}

// ---------------------------------------------------------------------------
// Decoders

/** A JSON object, kept as a record. */
const record: Decoder<Readonly<Record<string, unknown>>> = (value, path) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DecodeError(path, 'an object');
  return value as Record<string, unknown>;
};

const stringMap: Decoder<Readonly<Record<string, string>>> = (value, path) => {
  const map = record(value, path);
  for (const [key, entry] of Object.entries(map)) string(entry, `${path}.${key}`);
  return map as Record<string, string>;
};

const optionalNumber = (value: unknown, path: string): number | undefined =>
  value === undefined ? undefined : count(value, path);

const problem: Decoder<RunnerProblem> = (value, path) => {
  const raw = object({ code, path: string, message: string })(value, path);
  const extra = value as { line?: unknown; column?: unknown; pointer?: unknown };
  const line = optionalNumber(extra.line, `${path}.line`);
  const column = optionalNumber(extra.column, `${path}.column`);
  return {
    ...raw,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    ...(typeof extra.pointer === 'string' ? { pointer: extra.pointer } : {}),
  };
};

export const decodeProblems: Decoder<readonly RunnerProblem[]> = array(problem);

const nameValue: Decoder<NameValue> = (value, path) => {
  const row = object({ name: string, value: string })(value, path);
  const disabled = (value as { disabled?: unknown }).disabled;
  return disabled === true ? { ...row, disabled: true } : row;
};

/**
 * A request document: the fields the editor shows are checked; the body and
 * `extract` are checked by shape, so an edited file the server accepted
 * always opens.
 */
export const decodeRequestDocument: Decoder<RequestDocument> = (value, path) => {
  const raw = record(value, path);
  const at = (key: string): string => (path === '' ? key : `${path}.${key}`);
  const base = object({ name: string, method: string, url: string })(raw, path);
  const out: { -readonly [K in keyof RequestDocument]: RequestDocument[K] } = { ...raw, ...base };
  if (raw['pathParams'] !== undefined) out.pathParams = stringMap(raw['pathParams'], at('pathParams'));
  if (raw['headers'] !== undefined) out.headers = array(nameValue)(raw['headers'], at('headers'));
  if (raw['vars'] !== undefined) out.vars = stringMap(raw['vars'], at('vars'));
  if (raw['body'] !== undefined) {
    const body = record(raw['body'], at('body'));
    if (!BODY_TYPES.includes(body['type'] as BodyType)) throw new DecodeError(at('body.type'), 'a body type');
    out.body = body as unknown as RequestBody;
  }
  if (raw['extract'] !== undefined) {
    const extract = record(raw['extract'], at('extract'));
    for (const [key, entry] of Object.entries(extract)) {
      if (typeof entry !== 'string') object({ value: string })(entry, `${at('extract')}.${key}`);
    }
    out.extract = extract as Record<string, ExtractEntry>;
  }
  if (raw['scripts'] !== undefined) out.scripts = scripts(raw['scripts'], at('scripts'));
  for (const key of ['route', 'docs'] as const) {
    if (raw[key] !== undefined) out[key] = string(raw[key], at(key));
  }
  return out;
};

const scripts: Decoder<Scripts> = (value, path) => {
  const raw = record(value, path);
  return {
    ...(raw['before'] === undefined ? {} : { before: string(raw['before'], `${path}.before`) }),
    ...(raw['after'] === undefined ? {} : { after: string(raw['after'], `${path}.after`) }),
  };
};

export const decodeFolderDocument: Decoder<FolderDocument> = (value, path) => {
  const raw = record(value, path);
  const out: { -readonly [K in keyof FolderDocument]: FolderDocument[K] } = { ...raw };
  if (raw['name'] !== undefined) out.name = string(raw['name'], `${path}.name`);
  if (raw['vars'] !== undefined) out.vars = stringMap(raw['vars'], `${path}.vars`);
  if (raw['headers'] !== undefined) out.headers = array(nameValue)(raw['headers'], `${path}.headers`);
  if (raw['scripts'] !== undefined) out.scripts = scripts(raw['scripts'], `${path}.scripts`);
  if (raw['docs'] !== undefined) out.docs = string(raw['docs'], `${path}.docs`);
  if (raw['stripPrefix'] !== undefined) out.stripPrefix = string(raw['stripPrefix'], `${path}.stripPrefix`);
  if (raw['cookies'] !== undefined) out.cookies = boolean(raw['cookies'], `${path}.cookies`);
  if (raw['environment'] !== undefined) out.environment = string(raw['environment'], `${path}.environment`);
  return out;
};

const environmentDocument: Decoder<EnvironmentDocument> = (value, path) => {
  const raw = record(value, path);
  return {
    ...(raw['name'] === undefined ? {} : { name: string(raw['name'], `${path}.name`) }),
    ...(raw['vars'] === undefined ? {} : { vars: stringMap(raw['vars'], `${path}.vars`) }),
    ...(raw['disabled'] === undefined ? {} : { disabled: array(string)(raw['disabled'], `${path}.disabled`) }),
    ...(raw['default'] === undefined ? {} : { default: boolean(raw['default'], `${path}.default`) }),
  };
};

const treeNode: Decoder<TreeNode> = (value, path) => {
  const raw = object({
    kind: oneOf<TreeNode['kind']>('a node kind', literal('collection'), literal('folder'), literal('request')),
    id: runnerId,
    name: string,
  })(value, path);
  const extra = value as { method?: unknown; children?: unknown };
  if (raw.kind === 'request') return { ...raw, kind: 'request', method: string(extra.method, `${path}.method`) };
  const children = array(treeNode)(extra.children, `${path}.children`);
  if (raw.kind === 'folder') return { ...raw, kind: 'folder', children };
  return { ...raw, kind: 'collection', children };
};

export const decodeRequestTree: Decoder<RequestTree> = (value, path) => {
  const raw = object({
    version: string,
    collections: array(treeNode),
    environments: optional(
      array((entry, at) => {
        const raw = object({ id: string, name: string, default: optional(boolean, false) })(entry, at);
        return raw.default ? raw : { id: raw.id, name: raw.name };
      }),
      [],
    ),
    problems: optional(decodeProblems, []),
  })(value, path);
  return { ...raw, collections: raw.collections.filter((node): node is CollectionNode => node.kind === 'collection') };
};

export const decodeRequestDetail: Decoder<RequestDetail> = object<RequestDetail>({
  id: runnerId,
  digest: string,
  document: decodeRequestDocument,
  folders: array(
    object({
      id: runnerId,
      kind: oneOf<'collection' | 'folder'>('a folder kind', literal('collection'), literal('folder')),
      name: string,
      document: decodeFolderDocument,
    }),
  ),
  environments: array(object({ id: string, name: string, vars: stringMap })),
});

export const decodeFolderDetail: Decoder<FolderDetail> = object<FolderDetail>({
  id: runnerId,
  kind: oneOf<'collection' | 'folder'>('a folder kind', literal('collection'), literal('folder')),
  digest: nullable(string),
  document: decodeFolderDocument,
});

export const decodeEnvironmentDetail: Decoder<EnvironmentDetail> = object<EnvironmentDetail>({
  id: string,
  digest: string,
  document: environmentDocument,
  local: nullable(environmentDocument),
});

export const decodeWritten: Decoder<Omit<Written, 'created'>> = (value, path) => {
  const raw = record(value, path);
  return {
    id: string(raw['id'], `${path}.id`),
    digest: raw['digest'] === undefined ? null : nullable(string)(raw['digest'], `${path}.digest`),
  };
};

const reportItem: Decoder<ImportReportItem> = (value, path) => {
  const raw = object({
    file: string,
    location: string,
    name: string,
    outcome: oneOf<ImportReportItem['outcome']>(
      'an import outcome',
      literal('converted'),
      literal('converted-with-notes'),
      literal('skipped'),
    ),
    notes: array(string),
  })(value, path);
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? { ...raw, id } : raw;
};

export const decodeImportResult: Decoder<ImportResult> = object<ImportResult>({
  preview: boolean,
  written: boolean,
  format: string,
  collection: string,
  name: string,
  exists: boolean,
  existingEnvironments: optional(array(string), []),
  files: array(object({ path: string, kind: string })),
  report: array(reportItem),
  origins: optional(array(object({ origin: string, variable: string, transactions: count })), []),
  transactions: optional(
    array(
      object<ImportTransaction>({
        position: count,
        method: string,
        url: string,
        origin: string,
        static: boolean,
        included: boolean,
      }),
    ),
    [],
  ),
  problems: optional(decodeProblems, []),
});

const preview: Decoder<Preview> = oneOf<Preview>(
  'a preview',
  object({
    state: literal('available'),
    encoding: oneOf<'utf8' | 'base64'>('an encoding', literal('utf8'), literal('base64')),
    value: string,
    byteLength: count,
    truncated: boolean,
  }),
  object({
    state: literal('unavailable'),
    reason: oneOf<'bodyless' | 'render-failed'>('a reason', literal('bodyless'), literal('render-failed')),
  }),
);

const headers = array(object({ name: string, value: string }));

const stepOutcome = oneOf<StepOutcome>(
  'a step outcome',
  literal('passed'),
  literal('failed'),
  literal('not-run'),
  literal('running'),
  literal('pending'),
);

const maybe = <T>(decoder: Decoder<T>): Decoder<T | null> => optional<T | null>(nullable(decoder), null);

type WireStep = Omit<StepResult, 'explanation'> & { readonly explanation: WireExplanation | null };

const step: Decoder<WireStep> = object<WireStep>({
  step: count,
  requestId: runnerId,
  name: string,
  outcome: stepOutcome,
  failure: maybe(object({ code: string, message: string })),
  request: maybe(object({ method: string, url: string, headers, body: preview })),
  response: maybe(object({ status: count, headers, body: preview, timeMs: count })),
  tests: optional(
    array((value, path) => {
      const raw = object({ name: string, passed: boolean })(value, path);
      const message = (value as { message?: unknown }).message;
      return typeof message === 'string' ? { ...raw, message } : raw;
    }),
    [],
  ),
  console: optional(
    array(
      object({
        level: oneOf<'log' | 'info' | 'warn' | 'error'>(
          'a console level',
          literal('log'),
          literal('info'),
          literal('warn'),
          literal('error'),
        ),
        text: string,
      }),
    ),
    [],
  ),
  variables: optional(record, {}),
  capture: maybe(string),
  scenarioFrom: maybe(oneOf<'request' | 'run'>('a scenario source', literal('request'), literal('run'))),
  janusRequestId: maybe(string),
  explanation: maybe(decodeExplanation),
});

const summaryShape = {
  id: runId,
  target: object({
    kind: oneOf<RunSummary['target']['kind']>(
      'a target kind',
      literal('request'),
      literal('folder'),
      literal('collection'),
    ),
    id: runnerId,
    unsaved: boolean,
  }),
  environment: nullable(string),
  mode: oneOf<RunMode>('a run mode', literal('mock'), literal('upstream'), literal('record'), literal('explain')),
  scenario: nullable(string),
  startedAt: string,
  finishedAt: nullable(string),
  state: oneOf<RunSummary['state']>('a run state', literal('running'), literal('finished')),
  outcome: nullable(
    oneOf<'passed' | 'failed' | 'cancelled'>(
      'a run outcome',
      literal('passed'),
      literal('failed'),
      literal('cancelled'),
    ),
  ),
  stepCount: count,
  passed: count,
  failed: count,
};

const runSummary: Decoder<RunSummary> = object<RunSummary>(summaryShape);

export const decodeRunList: Decoder<readonly RunSummary[]> = (value, path) =>
  object({ runs: array(runSummary) })(value, path).runs;

/** A run; `link` checks each step's explanation links as `resolve` does. */
export function decodeRunRecord(link: (explanation: WireExplanation) => Explanation): Decoder<RunRecord> {
  const wire = object<Omit<RunRecord, 'steps'> & { readonly steps: readonly WireStep[] }>({
    ...summaryShape,
    steps: array(step),
    vars: optional(record, {}),
  });
  return (value, path) => {
    const run = wire(value, path);
    return {
      ...run,
      steps: run.steps.map((entry) => ({
        ...entry,
        explanation: entry.explanation === null ? null : link(entry.explanation),
      })),
    };
  };
}

export const decodeRunStarted: Decoder<string> = (value, path) => object({ id: runId })(value, path).id;

/** `error.problems` of a `422`, or null when the body carries none. */
export function problemsOf(body: unknown): readonly RunnerProblem[] | null {
  const raw = (body as { error?: { problems?: unknown } } | null)?.error?.problems;
  if (raw === undefined) return null;
  try {
    return decodeProblems(raw, 'error.problems');
  } catch {
    return null;
  }
}

/** `error.current` of a `412 request-changed`: the file now, null when it is gone, undefined when absent. */
export function currentOf(body: unknown): CurrentFile | null | undefined {
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (error === undefined || !('current' in error)) return undefined;
  const raw = error['current'];
  if (raw === null) return null;
  try {
    const current = object({ digest: string, document: record })(raw, 'error.current');
    const local = (raw as { local?: unknown }).local;
    return local === undefined ? current : { ...current, local: local === null ? null : record(local, 'local') };
  } catch {
    return undefined;
  }
}

/** The JSON-safe path to a request, folder or environment resource. */
export function runnerPath(resource: 'requests' | 'folders' | 'environments', id: string): string {
  return `${resource}/${id.split('/').map(encodeURIComponent).join('/')}`;
}
