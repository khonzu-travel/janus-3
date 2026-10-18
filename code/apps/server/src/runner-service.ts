import {
  explanationDocument,
  type AtlasRunnerEvent,
  type AtlasRunnerService,
  type RunnerAnswer,
  type RunnerMethod,
} from '@janus/adapter-http';
import { fileDigest, parseInstant, type HeaderMap } from '@janus/core';
import {
  buildRequestTree,
  ENVIRONMENTS_DIRECTORY,
  environmentDigest,
  environmentValues,
  FOLDER_FILE,
  folderChain,
  importSources,
  LOCAL_SUFFIX,
  parentOf,
  readRequestText,
  REQUEST_SUFFIX,
  validateEnvironmentValue,
  validateFolderValue,
  validateRequestValue,
  writeYamlDocument,
  RUN_MODES,
  type FolderNode,
  type ImportedFile,
  type ImportSource,
  type RequestProblem,
  type RequestTree,
  type Runner,
  type TreeNode,
  type ValidationContext,
} from '@janus/runner';

import type { RequestStore } from './requests.js';

/**
 * The runner's Atlas service: reads the request snapshot,
 * writes request, folder and environment files with preconditions,
 * imports collections and starts runs. Every value shown or written is the
 * developer's own: nothing is redacted.
 */

export interface RunnerServiceOptions {
  readonly store: RequestStore;
  readonly runner: Runner;
  readonly context: ValidationContext;
  /** Loopback, or `runner.allowNonLoopback`. */
  readonly available: boolean;
  readonly maxImportBytes: number;
  /** `atlas.resolve`: false refuses explain mode, as it unmounts `/_janus/resolve`. Defaults to true. */
  readonly explain?: boolean;
  /** Scenarios of the active fixture snapshot, and `scenarios.default`. */
  readonly scenarios: () => { readonly names: readonly string[]; readonly default: string };
  readonly logger: { info(event: string, fields?: Readonly<Record<string, string | number>>): void };
}

export interface RunnerService extends AtlasRunnerService {
  /** Publishes a run event; the runner's progress port calls it. */
  publish(event: AtlasRunnerEvent): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createRunnerService(options: RunnerServiceOptions): RunnerService {
  const { store, runner } = options;
  const listeners = new Set<(event: AtlasRunnerEvent) => void>();
  const publish = (event: AtlasRunnerEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A failing listener never breaks a write or a run.
      }
    }
  };
  store.subscribe((changed) => {
    publish({ type: 'requests', changed });
  });

  return {
    publish,
    maxImportBytes: options.maxImportBytes,
    capability: () => ({
      available: options.available,
      ...(options.available ? {} : { reason: 'non-loopback' as const }),
      collections: store.tree.collections.length,
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tree: () => ({
      ok: true,
      status: 200,
      document: {
        version: store.tree.version,
        collections: store.tree.collections.map(treeNode),
        // Shared by every collection.
        environments: store.tree.environments.map((entry) => ({
          id: entry.id,
          name: entry.document.name ?? entry.id,
          ...(entry.document.default === true ? { default: true } : {}),
        })),
        problems: store.problems.errors.map((error) => ({
          code: error.code,
          path: error.path,
          ...(error.line === undefined ? {} : { line: error.line }),
          ...(error.column === undefined ? {} : { column: error.column }),
          ...(error.key === undefined ? {} : { pointer: error.key }),
          message: error.message,
        })),
      },
    }),
    request: (method, id, headers, body) => requestRoute(options, method, id, headers, body),
    folder: (method, id, headers, body) => folderRoute(options, method, id, headers, body),
    environment: (method, name, headers, body) => environmentRoute(options, method, name, headers, body),
    import: (body) => importRoute(options, body),
    startRun: (body) => Promise.resolve(startRun(options, body)),
    runs: () => ({ ok: true, status: 200, document: { runs: runner.list() } }),
    run(method, id) {
      const found = runner.get(id);
      if (found === null) return notFound('No run with this ID is kept');
      if (method === 'GET') {
        const steps = found.steps.map(({ explanation, ...step }) =>
          explanation === undefined ? step : { ...step, explanation: explanationDocument(explanation) },
        );
        return { ok: true, status: 200, document: { ...found, steps } };
      }
      if (!runner.cancel(id)) return failure(409, 'run-finished', 'The run has already finished');
      return { ok: true, status: 202, document: { id } };
    },
  };
}

function treeNode(node: TreeNode): Record<string, unknown> {
  if (node.kind === 'request') {
    return { kind: 'request', id: node.id, name: node.document.name, method: node.document.method };
  }
  return { kind: node.kind, id: node.id, name: node.name, children: node.children.map(treeNode) };
}

function failure(
  status: number,
  code: Extract<RunnerAnswer, { ok: false }>['code'],
  message: string,
  details?: Readonly<Record<string, unknown>>,
): RunnerAnswer {
  return { ok: false, status, code, message, ...(details === undefined ? {} : { details }) };
}

function notFound(message: string): RunnerAnswer {
  return failure(404, 'atlas-resource-not-found', message);
}

function invalid(problems: readonly RequestProblem[]): RunnerAnswer {
  return failure(422, 'request-invalid', 'The document is not valid', { problems: problems.map(problemJson) });
}

function problemJson(problem: RequestProblem): Record<string, unknown> {
  return { ...problem };
}

/** `If-Match` (a digest) or `If-None-Match: *`. */
type Precondition = { readonly kind: 'match'; readonly digest: string } | { readonly kind: 'absent' } | null;

function precondition(headers: HeaderMap): Precondition {
  const match = headers['if-match']?.[0]?.trim();
  if (match !== undefined && match !== '') return { kind: 'match', digest: match.replace(/^"(.*)"$/, '$1') };
  if (headers['if-none-match']?.[0]?.trim() === '*') return { kind: 'absent' };
  return null;
}

const PRECONDITION_REQUIRED = failure(
  428,
  'precondition-required',
  'Send If-Match with the current digest to replace or delete, or If-None-Match: * to create',
);

function yamlBytes(existing: Uint8Array | null, document: Readonly<Record<string, unknown>>): Uint8Array {
  return encoder.encode(writeYamlDocument(existing === null ? null : decoder.decode(existing), document));
}

/** The folders a request or folder inherits from, collection first, as the editor shows them. */
function chainJson(tree: RequestTree, id: string): Record<string, unknown>[] {
  return folderChain(tree, id).map((folder: FolderNode) => ({
    id: folder.id,
    kind: folder.kind,
    name: folder.name,
    document: folder.document,
  }));
}

/** Every shared environment with the values a run would use: local values laid over, disabled ones left out. */
function environmentsJson(tree: RequestTree): Record<string, unknown>[] {
  return tree.environments.map((entry) => ({
    id: entry.id,
    name: entry.document.name ?? entry.id,
    vars: environmentValues(entry),
  }));
}

/** True when the folder or collection that would hold `id` exists. */
function parentExists(tree: RequestTree, id: string): boolean {
  const parent = parentOf(id);
  if (parent === '') return true;
  const node = tree.nodes.get(parent);
  return node !== undefined && node.kind !== 'request';
}

async function requestRoute(
  options: RunnerServiceOptions,
  method: RunnerMethod,
  id: string,
  headers: HeaderMap,
  body: unknown,
): Promise<RunnerAnswer> {
  const { store, context } = options;
  const tree = store.tree;
  const node = tree.nodes.get(id);
  const file = `${id}${REQUEST_SUFFIX}`;
  if (method === 'GET') {
    if (node?.kind !== 'request') return notFound('No request with this ID exists');
    return {
      ok: true,
      status: 200,
      document: {
        id,
        digest: node.digest,
        document: node.document,
        folders: chainJson(tree, id),
        environments: environmentsJson(tree),
      },
    };
  }
  const condition = precondition(headers);
  if (condition === null) return PRECONDITION_REQUIRED;
  // What is on disk now, which the tree may not have reloaded yet.
  const changed = async (): Promise<RunnerAnswer> => {
    const bytes = await store.readFile(file);
    const loaded = store.tree.nodes.get(id);
    let current: { digest: string; document: unknown } | null = null;
    if (bytes !== null) {
      const read = readRequestText(decoder.decode(bytes), file, context);
      const document = read.document ?? (loaded?.kind === 'request' ? loaded.document : null);
      if (document !== null) current = { digest: fileDigest(bytes), document };
    }
    return failure(412, 'request-changed', 'The request file changed since it was read', { current });
  };
  if (method === 'DELETE') {
    if (condition.kind !== 'match') return PRECONDITION_REQUIRED;
    if (node?.kind !== 'request' && (await store.digestOf(file)) === null)
      return notFound('No request with this ID exists');
    const result = await store.write([{ path: file, bytes: null }], [{ path: file, digest: condition.digest }]);
    if (!result.ok)
      return result.reason === 'changed' ? await changed() : failure(500, 'requests-write-failed', result.message);
    return { ok: true, status: 204 };
  }
  if (!parentExists(tree, id)) return notFound(`No folder "${parentOf(id)}" exists; create it first`);
  const validated = validateRequestValue(body, file, context);
  if (validated.document === null || validated.problems.length > 0) return invalid(validated.problems);
  const existing = condition.kind === 'match' ? await store.readFile(file) : null;
  const bytes = yamlBytes(existing, validated.document as unknown as Record<string, unknown>);
  const result = await store.write(
    [{ path: file, bytes }],
    [{ path: file, digest: condition.kind === 'match' ? condition.digest : null }],
  );
  if (!result.ok)
    return result.reason === 'changed' ? await changed() : failure(500, 'requests-write-failed', result.message);
  return { ok: true, status: condition.kind === 'absent' ? 201 : 200, document: { id, digest: fileDigest(bytes) } };
}

async function folderRoute(
  options: RunnerServiceOptions,
  method: RunnerMethod,
  id: string,
  headers: HeaderMap,
  body: unknown,
): Promise<RunnerAnswer> {
  const { store, context } = options;
  const tree = store.tree;
  const node = tree.nodes.get(id);
  const file = `${id}/${FOLDER_FILE}`;
  const collection = !id.includes('/');
  if (method === 'GET') {
    if (node === undefined || node.kind === 'request') return notFound('No folder with this ID exists');
    return { ok: true, status: 200, document: { id, kind: node.kind, digest: node.digest, document: node.document } };
  }
  const condition = precondition(headers);
  const current = await store.digestOf(file);
  const changed = (): RunnerAnswer =>
    failure(412, 'request-changed', 'The folder settings changed since they were read', {
      current: node === undefined || node.kind === 'request' ? null : { digest: node.digest, document: node.document },
    });
  if (method === 'DELETE') {
    if (node === undefined || node.kind === 'request') return notFound('No folder with this ID exists');
    if (current !== null && condition?.kind !== 'match') return PRECONDITION_REQUIRED;
    const result = await store.removeDirectory(
      id,
      current === null ? [] : [{ path: file, digest: condition?.kind === 'match' ? condition.digest : null }],
    );
    if (result === 'not-empty') return failure(409, 'folder-not-empty', 'Only an empty folder can be deleted');
    if (!result.ok)
      return result.reason === 'changed' ? changed() : failure(500, 'requests-write-failed', result.message);
    return { ok: true, status: 204 };
  }
  if (condition === null) return PRECONDITION_REQUIRED;
  if (node?.kind === 'request') return failure(409, 'request-invalid', 'A request has this ID');
  if (!parentExists(tree, id)) return notFound(`No folder "${parentOf(id)}" exists; create it first`);
  // The shared environments directory, and the old per-collection one the tree skips.
  if (id === ENVIRONMENTS_DIRECTORY) {
    return failure(422, 'request-invalid', '"environments" holds the shared environments and cannot be a collection');
  }
  if (id.split('/').at(-1) === ENVIRONMENTS_DIRECTORY && id.split('/').length === 2) {
    return failure(422, 'request-invalid', '"environments" directly in a collection is not read; use another name');
  }
  const validated = validateFolderValue(body, file, context, collection);
  if (validated.document === null || validated.problems.length > 0) return invalid(validated.problems);
  const existing = condition.kind === 'match' ? await store.readFile(file) : null;
  const document = validated.document as unknown as Record<string, unknown>;
  // An empty folder needs no settings file: creating one makes only the directory.
  if (condition.kind === 'absent' && Object.keys(document).length === 0) {
    if (current !== null || node !== undefined) return changed();
    const made = await store.makeDirectory(id);
    if (!made.ok) return failure(500, 'requests-write-failed', 'The folder could not be created');
    return { ok: true, status: 201, document: { id, digest: null } };
  }
  const bytes = yamlBytes(existing, document);
  const result = await store.write(
    [{ path: file, bytes }],
    [{ path: file, digest: condition.kind === 'match' ? condition.digest : null }],
    true,
  );
  if (!result.ok)
    return result.reason === 'changed' ? changed() : failure(500, 'requests-write-failed', result.message);
  return { ok: true, status: condition.kind === 'absent' ? 201 : 200, document: { id, digest: fileDigest(bytes) } };
}

/** A shared environment: `environments/<name>.yaml` and its `.local.yaml`. */
async function environmentRoute(
  options: RunnerServiceOptions,
  method: RunnerMethod,
  name: string,
  headers: HeaderMap,
  body: unknown,
): Promise<RunnerAnswer> {
  const { store } = options;
  const entry = store.tree.environments.find((environment) => environment.id === name);
  const main = `${ENVIRONMENTS_DIRECTORY}/${name}.yaml`;
  const local = `${ENVIRONMENTS_DIRECTORY}/${name}${LOCAL_SUFFIX}`;
  if (method === 'GET') {
    if (entry === undefined) return notFound('No environment with this name exists');
    return {
      ok: true,
      status: 200,
      document: {
        id: name,
        digest: entry.digest,
        document: entry.document,
        local: entry.local,
      },
    };
  }
  const condition = precondition(headers);
  if (condition === null) return PRECONDITION_REQUIRED;
  const mainBytes = await store.readFile(main);
  const localBytes = await store.readFile(local);
  const currentDigest = mainBytes === null ? null : environmentDigest(mainBytes, localBytes);
  const changed = (): RunnerAnswer =>
    failure(412, 'request-changed', 'The environment changed since it was read', {
      current: entry === undefined ? null : { digest: entry.digest, document: entry.document, local: entry.local },
    });
  if (condition.kind === 'absent' ? currentDigest !== null : currentDigest !== condition.digest) return changed();
  const checks = [
    { path: main, digest: mainBytes === null ? null : fileDigest(mainBytes) },
    { path: local, digest: localBytes === null ? null : fileDigest(localBytes) },
  ];
  if (method === 'DELETE') {
    if (condition.kind !== 'match') return PRECONDITION_REQUIRED;
    const result = await store.write(
      [
        { path: main, bytes: null },
        { path: local, bytes: null },
      ],
      checks,
    );
    if (!result.ok)
      return result.reason === 'changed' ? changed() : failure(500, 'requests-write-failed', result.message);
    return { ok: true, status: 204 };
  }
  const input = (typeof body === 'object' && body !== null ? body : {}) as { document?: unknown; local?: unknown };
  const mainDocument = validateEnvironmentValue(input.document ?? {}, main, false);
  const localDocument =
    input.local === null || input.local === undefined ? null : validateEnvironmentValue(input.local, local, true);
  const problems = [...mainDocument.problems, ...(localDocument?.problems ?? [])];
  if (mainDocument.document === null || localDocument?.document === null || problems.length > 0)
    return invalid(problems);
  const newMain = yamlBytes(mainBytes, mainDocument.document as Record<string, unknown>);
  const newLocal =
    localDocument === null ? null : yamlBytes(localBytes, localDocument.document as Record<string, unknown>);
  const result = await store.write(
    [
      { path: main, bytes: newMain },
      { path: local, bytes: newLocal },
    ],
    checks,
    true,
  );
  if (!result.ok)
    return result.reason === 'changed' ? changed() : failure(500, 'requests-write-failed', result.message);
  return {
    ok: true,
    status: condition.kind === 'absent' ? 201 : 200,
    document: { id: name, digest: environmentDigest(newMain, newLocal) },
  };
}

interface ImportBody {
  readonly files?: unknown;
  readonly into?: unknown;
  readonly replace?: unknown;
  readonly preview?: unknown;
  readonly includeStatic?: unknown;
  readonly origins?: unknown;
  readonly positions?: unknown;
}

/** An imported file's path below `runner.root`: environments are shared, the rest sit in the collection. */
export function importedPath(collection: string, file: ImportedFile): string {
  return file.kind === 'environment' ? file.path : `${collection}/${file.path}`;
}

/** Serializes an import's files, by their paths below `runner.root`. */
export function importedBytes(collection: string, files: readonly ImportedFile[]): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const file of files) {
    out.set(
      importedPath(collection, file),
      file.kind === 'body' ? file.bytes : yamlBytes(null, file.document as unknown as Record<string, unknown>),
    );
  }
  return out;
}

/** The shared environments an import writes, by name. */
export function importedEnvironments(files: readonly ImportedFile[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    if (file.kind !== 'environment') continue;
    const base = file.path.slice(`${ENVIRONMENTS_DIRECTORY}/`.length);
    names.add(base.endsWith(LOCAL_SUFFIX) ? base.slice(0, -LOCAL_SUFFIX.length) : base.slice(0, -'.yaml'.length));
  }
  return [...names].sort();
}

/** Problems the imported collection and environments would load with, checked before anything is written. */
export function importProblems(
  collection: string,
  files: ReadonlyMap<string, Uint8Array>,
  context: ValidationContext,
): readonly RequestProblem[] {
  const directories = new Set<string>([collection]);
  for (const path of files.keys()) {
    for (let parent = parentOf(path); parent !== ''; parent = parentOf(parent)) directories.add(parent);
  }
  return buildRequestTree({ files, directories }, context).errors;
}

async function importRoute(options: RunnerServiceOptions, body: unknown): Promise<RunnerAnswer> {
  const input = (typeof body === 'object' && body !== null ? body : {}) as ImportBody;
  if (!Array.isArray(input.files) || input.files.length === 0) {
    return failure(400, 'atlas-invalid-request', 'Invalid Atlas request: "files" must list the files to import');
  }
  const sources: ImportSource[] = [];
  for (const entry of input.files as unknown[]) {
    const item = entry as { name?: unknown; contentBase64?: unknown };
    if (typeof item.name !== 'string' || typeof item.contentBase64 !== 'string' || item.name === '') {
      return failure(400, 'atlas-invalid-request', 'Invalid Atlas request: each file needs "name" and "contentBase64"');
    }
    const bytes = Buffer.from(item.contentBase64, 'base64');
    sources.push({ name: item.name, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
  }
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
  const numbers = (value: unknown): number[] | undefined =>
    Array.isArray(value) && value.every((item) => Number.isInteger(item)) ? (value as number[]) : undefined;
  const origins = strings(input.origins);
  const positions = numbers(input.positions);
  if (input.into !== undefined && typeof input.into !== 'string') {
    return failure(400, 'atlas-invalid-request', 'Invalid Atlas request: "into" must be a collection name');
  }
  const result = importSources(
    sources,
    {
      maxBytes: options.maxImportBytes,
      ...(typeof input.into === 'string' && input.into !== '' ? { into: input.into } : {}),
      ...(input.includeStatic === true ? { includeStatic: true } : {}),
      ...(origins === undefined ? {} : { origins }),
      ...(positions === undefined ? {} : { positions }),
    },
    options.context.checkScript ?? undefined,
  );
  if (!result.ok) {
    const status = result.code === 'import-too-large' ? 413 : result.code === 'import-unsupported-format' ? 415 : 400;
    return failure(status, result.code, result.message);
  }
  const exists =
    options.store.tree.nodes.has(result.collection) || (await options.store.digestOf(result.collection)) !== null;
  // An existing shared environment is replaced only as an existing collection is.
  const existingEnvironments: string[] = [];
  for (const name of importedEnvironments(result.files)) {
    if (
      options.store.tree.environments.some((entry) => entry.id === name) ||
      (await options.store.digestOf(`${ENVIRONMENTS_DIRECTORY}/${name}.yaml`)) !== null
    )
      existingEnvironments.push(name);
  }
  const bytes = importedBytes(result.collection, result.files);
  const problems = importProblems(result.collection, bytes, options.context);
  const document = {
    format: result.format,
    collection: result.collection,
    name: result.name,
    exists,
    existingEnvironments,
    files: result.files.map((file) => ({ path: importedPath(result.collection, file), kind: file.kind })),
    report: result.report,
    ...(result.origins === undefined ? {} : { origins: result.origins }),
    ...(result.transactions === undefined ? {} : { transactions: result.transactions }),
    problems: problems.map(problemJson),
  };
  if (input.preview === true)
    return { ok: true, status: 200, document: { preview: true, written: false, ...document } };
  if (problems.length > 0)
    return failure(422, 'import-invalid', 'The converted collection would not load', {
      problems: problems.map(problemJson),
    });
  const written = await options.store.writeCollection(result.collection, bytes, input.replace === true);
  if (written === 'exists') {
    return failure(
      409,
      'import-destination-exists',
      `The collection "${result.collection}" or an environment it brings exists; import with replace to overwrite them`,
    );
  }
  if (!written.ok)
    return failure(500, 'requests-write-failed', written.reason === 'failed' ? written.message : 'The import failed');
  options.logger.info('import', { collection: result.collection, format: result.format, files: result.files.length });
  return { ok: true, status: 201, document: { preview: false, written: true, ...document } };
}

interface RunBody {
  readonly target?: unknown;
  readonly environment?: unknown;
  readonly mode?: unknown;
  readonly scenario?: unknown;
  readonly vars?: unknown;
  readonly now?: unknown;
}

/** `POST /_janus/runs`. */
function startRun(options: RunnerServiceOptions, body: unknown): RunnerAnswer {
  const input = (typeof body === 'object' && body !== null ? body : {}) as RunBody;
  const target = (typeof input.target === 'object' && input.target !== null ? input.target : {}) as {
    id?: unknown;
    request?: unknown;
  };
  if (typeof target.id !== 'string' || target.id === '') {
    return failure(
      400,
      'atlas-invalid-request',
      'Invalid Atlas request: "target.id" names a request, folder or collection',
    );
  }
  const mode = RUN_MODES.find((entry) => entry === input.mode);
  if (mode === undefined) {
    return failure(
      400,
      'atlas-invalid-request',
      'Invalid Atlas request: "mode" must be mock, upstream, record or explain',
    );
  }
  if (mode === 'explain' && options.explain === false) {
    return failure(400, 'atlas-invalid-request', 'Invalid Atlas request: explain mode is off (atlas.resolve: false)');
  }
  let nowMs: number | undefined;
  if (input.now !== undefined && input.now !== null) {
    const parsed = typeof input.now === 'string' && mode === 'explain' ? parseInstant(input.now) : null;
    if (parsed === null) {
      return failure(
        400,
        'atlas-invalid-request',
        'Invalid Atlas request: "now" is an RFC 3339 instant, and only explain mode takes one',
      );
    }
    nowMs = parsed;
  }
  if (input.environment !== undefined && input.environment !== null && typeof input.environment !== 'string') {
    return failure(400, 'atlas-invalid-request', 'Invalid Atlas request: "environment" must be an environment name');
  }
  const vars: unknown = input.vars ?? {};
  if (typeof vars !== 'object' || vars === null || Array.isArray(vars)) {
    return failure(400, 'atlas-invalid-request', 'Invalid Atlas request: "vars" must map names to values');
  }
  if (input.scenario !== undefined && input.scenario !== null && typeof input.scenario !== 'string') {
    return failure(400, 'atlas-invalid-request', 'Invalid Atlas request: "scenario" must be a scenario name');
  }
  // A picked scenario is added only to requests without their own X-Mock-Scenario; none leaves it to Janus.
  const scenarios = options.scenarios();
  const scenario = typeof input.scenario === 'string' ? input.scenario : null;
  if (scenario !== null && !scenarios.names.includes(scenario)) {
    return failure(
      400,
      'unknown-scenario',
      `No scenario named ${JSON.stringify(scenario)} exists in the current snapshot`,
      {
        known: scenarios.names,
      },
    );
  }
  const tree = options.store.tree;
  let runTarget;
  if (target.request !== undefined) {
    const id = target.id;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)+$/.test(id) || !parentExists(tree, id)) {
      return notFound('The request is edited as an ID whose folder does not exist');
    }
    const validated = validateRequestValue(target.request, `${id}${REQUEST_SUFFIX}`, options.context);
    if (validated.document === null || validated.problems.length > 0) {
      return failure(400, 'request-invalid', 'The request is not valid', {
        problems: validated.problems.map(problemJson),
      });
    }
    runTarget = { kind: 'request' as const, id, document: validated.document };
  } else {
    runTarget = { kind: 'node' as const, id: target.id };
  }
  const started = options.runner.start(
    {
      target: runTarget,
      environment: typeof input.environment === 'string' ? input.environment : null,
      mode,
      scenario,
      vars: vars as Record<string, unknown>,
      ...(nowMs === undefined ? {} : { nowMs }),
    },
    tree,
  );
  if (!started.ok) {
    if (started.code === 'runner-busy') return failure(503, 'runner-busy', started.message);
    if (started.code === 'unknown-environment') return failure(400, 'unknown-environment', started.message);
    return notFound(started.message);
  }
  options.logger.info('run-started', { run: started.id, target: target.id, mode, scenario: scenario ?? '-' });
  return { ok: true, status: 202, document: { id: started.id } };
}
