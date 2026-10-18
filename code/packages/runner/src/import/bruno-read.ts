import { bruno } from './bruno-lang.js';
import { parse as parseYaml } from 'yaml';

import type { SourceAuth } from './auth.js';
import type {
  BrunoBody,
  BrunoEnvironment,
  BrunoFiles,
  BrunoFolderMeta,
  BrunoPair,
  BrunoPart,
  BrunoRequest,
  BrunoSettings,
  Parsed,
} from './bruno.js';
import { baseName, decodeUtf8, isRecord, list, parseJson, record, text, type JsonRecord } from './text.js';
import { compact as optional } from './tree.js';
import type { ImportSource } from './types.js';

/**
 * Reads a Bruno collection folder in either format: `.bru`
 * files through `@usebruno/lang`, or the YAML "OpenCollection" layout
 * (`opencollection.yml`, `folder.yml`, one `.yml` per request and
 * `environments/*.yml`). Sources are named by their path below the folder.
 */

export const BRUNO_MARKERS: readonly string[] = ['bruno.json', 'collection.bru'];
export const BRUNO_YAML_MARKERS: readonly string[] = ['opencollection.yml', 'opencollection.yaml'];

/** Directories Bruno never reads. */
const DEFAULT_IGNORE: readonly string[] = ['node_modules', '.git'];

const ENV_REASON =
  'the .env file was not imported: its values are secrets that {{process.env.…}} reads; define them in an environment .local.yaml';

/**
 * The collection's root: the directory of the shallowest marker file, so a
 * zip with a top-level folder works. Returns the sources below it, renamed
 * relative to it.
 */
export function collectionSources(sources: readonly ImportSource[], markers: readonly string[]): ImportSource[] {
  const roots = sources
    .map((source) => source.name)
    .filter((name) => markers.includes(baseName(name)))
    .map((name) => name.slice(0, name.length - baseName(name).length))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  const root = roots[0] ?? commonDirectory(sources.map((source) => source.name));
  return sources
    .filter((source) => source.name.startsWith(root))
    .map((source) => ({ name: source.name.slice(root.length), bytes: source.bytes }));
}

function commonDirectory(names: readonly string[]): string {
  const [first, ...rest] = names;
  if (first === undefined) return '';
  let prefix = first.slice(0, first.length - baseName(first).length);
  for (const name of rest) while (!name.startsWith(prefix)) prefix = prefix.replace(/[^/]*\/$/, '');
  return prefix;
}

function parseWith<T>(source: ImportSource, parse: (text: string) => T): Parsed<T> {
  const content = decodeUtf8(source.bytes);
  if (content === null) return { ok: false, message: 'the file is not UTF-8 text' };
  try {
    return { ok: true, value: parse(content) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: message.split('\n').slice(0, 3).join(' ').trim() };
  }
}

function ignoredBy(name: string, ignore: readonly string[]): boolean {
  return name.split('/').some((part, index, parts) => index < parts.length - 1 && ignore.includes(part));
}

function seqOf(value: unknown): number | undefined {
  const seq = Number(text(value));
  return text(value) === undefined || Number.isNaN(seq) ? undefined : seq;
}

function brunoAuth(mode: string | undefined, values: JsonRecord, fallback: SourceAuth['type']): SourceAuth {
  const value = (key: string): string => text(values[key]) ?? '';
  switch (mode ?? fallback) {
    case 'inherit':
      return { type: 'inherit' };
    case 'none':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', token: value('token') };
    case 'basic':
      return { type: 'basic', username: value('username'), password: value('password') };
    case 'apikey': {
      const placement = value('placement');
      return {
        type: 'apikey',
        key: value('key'),
        value: value('value'),
        in: placement === 'queryparams' || placement === 'query' ? 'query' : 'header',
      };
    }
    default:
      return { type: 'other', name: mode ?? fallback };
  }
}

// ---------------------------------------------------------------------------
// .bru

function bruPairs(value: unknown): BrunoPair[] {
  return list(value)
    .map(record)
    .map((pair) => ({ name: text(pair.name) ?? '', value: text(pair.value) ?? '', enabled: pair.enabled !== false }));
}

function bruSettings(json: JsonRecord, defaultMode: SourceAuth['type']): BrunoSettings {
  const auth = record(json.auth);
  const mode = text(auth.mode);
  const vars = record(json.vars);
  const script = record(json.script);
  return optional({
    headers: bruPairs(json.headers),
    auth: brunoAuth(mode, record(auth[mode ?? '']), defaultMode),
    preVars: bruPairs(vars.req),
    postVars: bruPairs(vars.res),
    asserts: bruPairs(json.assertions),
    before: text(script.req),
    after: text(script.res),
    tests: text(json.tests),
    docs: text(json.docs),
  });
}

function bruBody(mode: string | undefined, body: JsonRecord): BrunoBody {
  switch (mode ?? 'none') {
    case 'none':
      return { mode: 'none' };
    case 'json':
    case 'text':
    case 'xml':
    case 'sparql':
      return { mode: mode as 'json', text: text(body[mode ?? '']) ?? '' };
    case 'form-urlencoded':
    case 'formUrlEncoded':
      return { mode: 'form', fields: bruPairs(body.formUrlEncoded) };
    case 'multipart-form':
    case 'multipartForm':
      return {
        mode: 'multipart',
        parts: list(body.multipartForm)
          .map(record)
          .map((part) => multipartPart(part, part.type === 'file')),
      };
    case 'graphql': {
      const graphql = record(body.graphql);
      return optional({ mode: 'graphql', query: text(graphql.query) ?? '', variables: text(graphql.variables) });
    }
    case 'file':
      return {
        mode: 'file',
        files: list(body.file)
          .map(record)
          .map((file) =>
            optional({
              path: text(file.filePath) ?? '',
              contentType: text(file.contentType) || undefined,
              selected: file.selected !== false,
            }),
          ),
      };
    default:
      return { mode: 'other', name: mode ?? '' };
  }
}

function multipartPart(part: JsonRecord, isFile: boolean): BrunoPart {
  const name = text(part.name) ?? '';
  const enabled = part.enabled !== false && part.disabled !== true;
  const contentType = text(part.contentType) || undefined;
  if (isFile) {
    const files = Array.isArray(part.value) ? part.value.map((path) => text(path) ?? '') : [text(part.value) ?? ''];
    return optional({ name, enabled, files, contentType });
  }
  return optional({ name, enabled, value: text(part.value) ?? '', contentType });
}

function bruRequest(json: JsonRecord): BrunoRequest {
  const meta = record(json.meta);
  const http = record(json.http);
  const type = json.grpc !== undefined ? 'grpc' : json.ws !== undefined ? 'ws' : (text(meta.type) ?? 'http');
  return optional({
    ...bruSettings({ ...json, auth: { mode: text(http.auth) ?? 'none', ...record(json.auth) } }, 'none'),
    name: text(meta.name) ?? '',
    type,
    seq: seqOf(meta.seq),
    method: text(http.method) ?? 'get',
    url: text(http.url) ?? '',
    params: bruPairs(json.params).map((pair, index) => ({
      ...pair,
      type: record(list(json.params)[index]).type === 'path' ? ('path' as const) : ('query' as const),
    })),
    body:
      type === 'graphql' && text(http.body) === undefined
        ? bruBody('graphql', record(json.body))
        : bruBody(text(http.body), record(json.body)),
  });
}

function bruEnvironment(json: JsonRecord, name: string): BrunoEnvironment {
  return {
    name,
    vars: list(json.variables)
      .map(record)
      .map((pair) => ({
        name: text(pair.name) ?? '',
        value: text(pair.value) ?? '',
        enabled: pair.enabled !== false,
        secret: pair.secret === true,
      })),
  };
}

/** Reads a `.bru` collection; `sources` are already relative to its root. */
export function readBruCollection(sources: readonly ImportSource[], fallbackName: string): BrunoFiles {
  const config = sources.find((source) => source.name === 'bruno.json');
  const configJson = record(config === undefined ? undefined : parseJson(decodeUtf8(config.bytes) ?? ''));
  const ignore = [...DEFAULT_IGNORE, ...list(configJson.ignore).map((entry) => text(entry) ?? '')];
  const name = text(configJson.name) ?? fallbackName;
  let collection: BrunoFiles['collection'] = {
    file: config === undefined ? 'collection.bru' : 'bruno.json',
    settings: null,
  };
  const folders = new Map<string, { file: string; meta: Parsed<BrunoFolderMeta> }>();
  const requests: BrunoFiles['requests'][number][] = [];
  const environments: BrunoFiles['environments'][number][] = [];
  const others: { file: string; reason: string }[] = [];
  for (const source of sources) {
    const file = source.name;
    if (file === 'bruno.json' || ignoredBy(file, ignore)) continue;
    if (file === 'collection.bru') {
      collection = {
        file,
        settings: parseWith(source, (content) => bruSettings(record(bruno.collectionBruToJson(content)), 'none')),
      };
    } else if (file.endsWith('/folder.bru')) {
      const dir = file.slice(0, -'/folder.bru'.length);
      folders.set(dir, {
        file,
        meta: parseWith(source, (content) => {
          const json = record(bruno.collectionBruToJson(content));
          const meta = record(json.meta);
          return optional({ ...bruSettings(json, 'inherit'), name: text(meta.name), seq: seqOf(meta.seq) });
        }),
      });
    } else if (/^environments\/[^/]+\.bru$/.test(file)) {
      const envName = baseName(file).replace(/\.bru$/, '');
      environments.push({
        file,
        environment: parseWith(source, (content) => bruEnvironment(record(bruno.bruToEnvJsonV2(content)), envName)),
      });
    } else if (file.endsWith('.bru')) {
      requests.push({ file, request: parseWith(source, (content) => bruRequest(record(bruno.bruToJsonV2(content)))) });
    } else if (file === '.env') {
      others.push({ file, reason: ENV_REASON });
    } else {
      others.push({ file, reason: 'the file is not part of a Bruno collection and was not imported' });
    }
  }
  return { name, collection, folders, requests, environments, others };
}

// ---------------------------------------------------------------------------
// YAML (OpenCollection)

/** Rows as `[{ name, value, disabled?/enabled? }]`, or a `{ name: value }` map. */
function yamlPairs(value: unknown): BrunoPair[] {
  if (isRecord(value)) {
    return Object.entries(value).map(([name, member]) => ({ name, value: text(member) ?? '', enabled: true }));
  }
  return list(value)
    .map(record)
    .map((pair) => ({
      name: text(pair.name) ?? text(pair.key) ?? '',
      value: text(pair.value) ?? '',
      enabled: pair.disabled !== true && pair.enabled !== false,
    }));
}

function yamlAuth(value: unknown, fallback: SourceAuth['type']): SourceAuth {
  if (typeof value === 'string') return brunoAuth(value, {}, fallback);
  const auth = record(value);
  const type = text(auth.type) ?? text(auth.mode);
  const nested = record(auth[type ?? '']);
  return brunoAuth(type, Object.keys(nested).length > 0 ? nested : auth, fallback);
}

/** Scripts as `[{ type, code }]` or `{ preRequest, postResponse, tests }`. */
function yamlScripts(value: unknown): { before?: string; after?: string; tests?: string } {
  const out: { before?: string; after?: string; tests?: string } = {};
  const add = (kind: string, code: string | undefined): void => {
    if (code === undefined) return;
    const key = /^(before|pre)/i.test(kind)
      ? 'before'
      : /^(after|post)/i.test(kind)
        ? 'after'
        : /^test/i.test(kind)
          ? 'tests'
          : null;
    if (key !== null) out[key] = out[key] === undefined ? code : `${out[key]}\n\n${code}`;
  };
  if (Array.isArray(value)) {
    for (const row of value.map(record)) add(text(row.type) ?? '', text(row.code) ?? text(row.script));
  } else {
    for (const [kind, code] of Object.entries(record(value))) add(kind, text(code) ?? text(record(code).code));
  }
  return out;
}

function yamlDocs(value: unknown): string | undefined {
  return text(value) ?? text(record(value).content);
}

/** Variables, actions and assertions of a `runtime` (request) or `request` (folder) block. */
function yamlRuntime(runtime: JsonRecord): Pick<BrunoSettings, 'preVars' | 'postVars' | 'asserts'> {
  const preVars: BrunoPair[] = [];
  const postVars: BrunoPair[] = [];
  const variables = isRecord(runtime.variables) ? yamlPairs(runtime.variables) : [];
  preVars.push(...variables);
  for (const row of list(runtime.variables).map(record)) {
    const pair = yamlPairs([row])[0];
    if (pair === undefined) continue;
    const phase = text(row.scope) ?? text(row.phase) ?? text(row.type) ?? '';
    (/post|after|response/i.test(phase) ? postVars : preVars).push(pair);
  }
  for (const row of list(runtime.actions).map(record)) {
    if (text(row.type) !== 'set-variable') continue;
    const variable = record(row.variable);
    const selector = record(row.selector);
    postVars.push({
      name: text(variable.name) ?? text(row.name) ?? '',
      value: text(selector.expression) ?? text(row.value) ?? '',
      enabled: row.disabled !== true && row.enabled !== false,
    });
  }
  const asserts = list(runtime.assertions)
    .map(record)
    .map((row) => {
      const expression = text(row.expression) ?? text(row.name) ?? '';
      const operator = text(row.operator);
      const value = text(row.value) ?? '';
      return {
        name: expression,
        value: operator === undefined ? value : `${operator} ${value}`.trim(),
        enabled: row.disabled !== true && row.enabled !== false,
      };
    });
  return { preVars, postVars, asserts };
}

function yamlSettings(
  block: JsonRecord,
  runtime: JsonRecord,
  docs: unknown,
  defaultMode: SourceAuth['type'],
): BrunoSettings {
  const scripts = yamlScripts(runtime.scripts ?? block.scripts);
  return optional<BrunoSettings>({
    headers: yamlPairs(block.headers),
    auth: yamlAuth(block.auth, defaultMode),
    ...yamlRuntime({ ...block, ...runtime }),
    before: scripts.before,
    after: scripts.after,
    tests: scripts.tests,
    docs: yamlDocs(docs),
  });
}

function yamlBody(value: unknown): BrunoBody {
  if (value === undefined || value === null) return { mode: 'none' };
  const body = record(value);
  const type = text(body.type) ?? text(body.mode) ?? 'none';
  const data = body.data ?? body.content ?? body.text;
  switch (type) {
    case 'none':
      return { mode: 'none' };
    case 'json':
    case 'text':
    case 'xml':
    case 'sparql':
      return {
        mode: type,
        text: text(data) ?? (isRecord(data) || Array.isArray(data) ? JSON.stringify(data, null, 2) : ''),
      };
    case 'form-urlencoded':
    case 'formUrlEncoded':
      return { mode: 'form', fields: yamlPairs(data) };
    case 'multipart-form':
    case 'multipartForm':
      return {
        mode: 'multipart',
        parts: list(data)
          .map(record)
          .map((part) => multipartPart(part, part.type === 'file')),
      };
    case 'graphql': {
      const graphql = isRecord(data) ? data : body;
      const variables = graphql.variables;
      return optional({
        mode: 'graphql',
        query: text(graphql.query) ?? '',
        variables: text(variables) ?? (isRecord(variables) ? JSON.stringify(variables, null, 2) : undefined),
      });
    }
    case 'file':
      return {
        mode: 'file',
        files: list(data)
          .map(record)
          .map((file) =>
            optional({
              path: text(file.filePath) ?? text(file.path) ?? '',
              contentType: text(file.contentType) || undefined,
              selected: file.selected !== false,
            }),
          ),
      };
    default:
      return { mode: 'other', name: type };
  }
}

function yamlRequest(json: JsonRecord, file: string): BrunoRequest {
  const info = record(json.info ?? json.meta);
  const block = record(json.http ?? json.graphql ?? json.request);
  const declared = text(info.type);
  const type =
    json.grpc !== undefined
      ? 'grpc'
      : json.websocket !== undefined || json.ws !== undefined
        ? 'ws'
        : (declared ?? 'http');
  const params = list(block.params)
    .map(record)
    .map((row) => ({
      ...(yamlPairs([row])[0] ?? { name: '', value: '', enabled: true }),
      type: text(row.type) === 'path' ? ('path' as const) : ('query' as const),
    }));
  return optional({
    ...yamlSettings(block, record(json.runtime), json.docs, 'inherit'),
    name: text(info.name) ?? baseName(file).replace(/\.ya?ml$/, ''),
    type: type === 'websocket' ? 'ws' : type,
    seq: seqOf(info.seq),
    method: text(block.method) ?? (type === 'graphql' ? 'post' : 'get'),
    url: text(block.url) ?? '',
    params,
    body:
      type === 'graphql' && block.body === undefined
        ? yamlBody({ type: 'graphql', ...record(json.graphql) })
        : yamlBody(block.body),
  });
}

function yamlEnvironment(json: JsonRecord, fallback: string): BrunoEnvironment {
  return {
    name: text(json.name) ?? fallback,
    vars: list(json.variables)
      .map(record)
      .map((row) => ({
        name: text(row.name) ?? '',
        value: text(row.value) ?? '',
        enabled: row.disabled !== true && row.enabled !== false,
        secret: row.secret === true,
      })),
  };
}

const parseYamlRecord = (content: string): JsonRecord => record(parseYaml(content, { maxAliasCount: 100 }));

/** Reads a YAML (OpenCollection) collection; `sources` are already relative to its root. */
export function readYamlCollection(sources: readonly ImportSource[], fallbackName: string): BrunoFiles {
  const marker = sources.find((source) => BRUNO_YAML_MARKERS.includes(source.name));
  const parsedRoot = marker === undefined ? null : parseWith(marker, parseYamlRecord);
  const rootJson = parsedRoot?.ok === true ? parsedRoot.value : {};
  const info = record(rootJson.info);
  const name = text(info.name) ?? text(rootJson.name) ?? fallbackName;
  const collection: BrunoFiles['collection'] = {
    file: marker?.name ?? 'opencollection.yml',
    settings:
      parsedRoot === null
        ? null
        : parsedRoot.ok
          ? { ok: true, value: yamlSettings(record(rootJson.request), {}, rootJson.docs, 'none') }
          : parsedRoot,
  };
  const folders = new Map<string, { file: string; meta: Parsed<BrunoFolderMeta> }>();
  const requests: BrunoFiles['requests'][number][] = [];
  const environments: BrunoFiles['environments'][number][] = [];
  const others: { file: string; reason: string }[] = [];
  for (const source of sources) {
    const file = source.name;
    if (BRUNO_YAML_MARKERS.includes(file) || ignoredBy(file, DEFAULT_IGNORE)) continue;
    const folderFile = /(^|\/)folder\.ya?ml$/.exec(file);
    if (folderFile !== null) {
      const dir = file.slice(0, folderFile.index);
      folders.set(dir, {
        file,
        meta: parseWith(source, (content) => {
          const json = parseYamlRecord(content);
          const meta = record(json.info ?? json.meta);
          return optional({
            ...yamlSettings(record(json.request), {}, json.docs, 'inherit'),
            name: text(meta.name),
            seq: seqOf(meta.seq),
          });
        }),
      });
    } else if (/^environments\/[^/]+\.ya?ml$/.test(file)) {
      const fallback = baseName(file).replace(/\.ya?ml$/, '');
      environments.push({
        file,
        environment: parseWith(source, (content) => yamlEnvironment(parseYamlRecord(content), fallback)),
      });
    } else if (/\.ya?ml$/.test(file)) {
      requests.push({ file, request: parseWith(source, (content) => yamlRequest(parseYamlRecord(content), file)) });
    } else if (file === '.env') {
      others.push({ file, reason: ENV_REASON });
    } else {
      others.push({ file, reason: 'the file is not part of a Bruno collection and was not imported' });
    }
  }
  return { name, collection, folders, requests, environments, others };
}
