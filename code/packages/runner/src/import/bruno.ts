import {
  METHOD_PATTERN,
  REFUSED_METHODS,
  type ExtractEntry,
  type FolderDocument,
  type MultipartPart,
  type NameValue,
  type RequestBody,
  type Scripts,
} from '../model.js';
import { applyAuth, NO_AUTH_SCOPE, type AuthScope, type SourceAuth } from './auth.js';
import type { Converted, ImportContext } from './context.js';
import { toRunnerName, toVariableName } from './names.js';
import { fileReference } from './postman.js';
import { joinScripts, reviewScript } from './scripts.js';
import { convertTemplate, type Note } from './template.js';
import {
  compact,
  nonEmpty,
  nonEmptyList,
  type Draft,
  type EnvironmentDraft,
  type FolderDraft,
  type ReportEntry,
} from './tree.js';
import { absoluteUrl, appendQuery, reconcilePathParams } from './url.js';

/**
 * Bruno collections. The `.bru` and YAML readers produce the
 * model below; this module turns it into folders, requests and environments.
 */

export interface BrunoPair {
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean;
}

export interface BrunoPart {
  readonly name: string;
  readonly enabled: boolean;
  /** A text part's value. */
  readonly value?: string;
  /** A file part's paths. */
  readonly files?: readonly string[];
  readonly contentType?: string;
}

export type BrunoBody =
  | { readonly mode: 'json' | 'text' | 'xml' | 'sparql'; readonly text: string }
  | { readonly mode: 'form'; readonly fields: readonly BrunoPair[] }
  | { readonly mode: 'multipart'; readonly parts: readonly BrunoPart[] }
  | { readonly mode: 'graphql'; readonly query: string; readonly variables?: string }
  | {
      readonly mode: 'file';
      readonly files: readonly { readonly path: string; readonly contentType?: string; readonly selected: boolean }[];
    }
  | { readonly mode: 'none' }
  | { readonly mode: 'other'; readonly name: string };

/** What a collection, folder and request share. */
export interface BrunoSettings {
  readonly headers: readonly BrunoPair[];
  readonly auth: SourceAuth;
  readonly preVars: readonly BrunoPair[];
  readonly postVars: readonly BrunoPair[];
  readonly before?: string;
  readonly after?: string;
  readonly tests?: string;
  readonly asserts: readonly BrunoPair[];
  readonly docs?: string;
}

export interface BrunoFolderMeta extends BrunoSettings {
  readonly name?: string;
  readonly seq?: number;
}

export interface BrunoRequest extends BrunoSettings {
  readonly name: string;
  /** `http`, `graphql`, or a non-HTTP type such as `grpc` or `ws`. */
  readonly type: string;
  readonly seq?: number;
  readonly method: string;
  readonly url: string;
  readonly params: readonly (BrunoPair & { readonly type: 'query' | 'path' })[];
  readonly body: BrunoBody;
}

export interface BrunoEnvironment {
  readonly name: string;
  readonly vars: readonly (BrunoPair & { readonly secret: boolean })[];
}

/** A file's parse result: the value, or why it could not be read. */
export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** A collection as the readers find it; paths are relative to the collection's root, "/" separated. */
export interface BrunoFiles {
  readonly name: string;
  readonly collection: { readonly file: string; readonly settings: Parsed<BrunoSettings> | null };
  /** Folder settings by directory. */
  readonly folders: ReadonlyMap<string, { readonly file: string; readonly meta: Parsed<BrunoFolderMeta> }>;
  readonly requests: readonly { readonly file: string; readonly request: Parsed<BrunoRequest> }[];
  readonly environments: readonly { readonly file: string; readonly environment: Parsed<BrunoEnvironment> }[];
  /** Other files, each with why it is not imported. */
  readonly others: readonly { readonly file: string; readonly reason: string }[];
}

export const EMPTY_SETTINGS: BrunoSettings = Object.freeze({
  headers: [],
  auth: { type: 'inherit' as const },
  preVars: [],
  postVars: [],
  asserts: [],
});

interface DirectoryNode {
  readonly path: string;
  readonly folders: Map<string, DirectoryNode>;
  readonly requests: { readonly file: string; readonly request: Parsed<BrunoRequest> }[];
}

function directoryOf(file: string): string {
  const slash = file.lastIndexOf('/');
  return slash === -1 ? '' : file.slice(0, slash);
}

export function convertBruno(files: BrunoFiles, format: 'bruno' | 'bruno-yaml', context: ImportContext): Converted {
  const { report } = context;
  const rootEntry = report.entry(files.collection.file, files.collection.file, files.name);
  const tree: DirectoryNode = { path: '', folders: new Map(), requests: [] };
  const nodeFor = (dir: string): DirectoryNode => {
    let node = tree;
    for (const part of dir === '' ? [] : dir.split('/')) {
      let next = node.folders.get(part);
      if (next === undefined) {
        next = { path: node.path === '' ? part : `${node.path}/${part}`, folders: new Map(), requests: [] };
        node.folders.set(part, next);
      }
      node = next;
    }
    return node;
  };
  for (const dir of files.folders.keys()) nodeFor(dir);

  const converter = new BrunoConverter(format, context);
  for (const { file, request } of files.requests) nodeFor(directoryOf(file)).requests.push({ file, request });

  const collection = files.collection.settings;
  if (collection !== null && !collection.ok) {
    rootEntry.note(`the collection settings could not be parsed and were dropped: ${collection.message}`);
  }
  const rootSettings =
    collection?.ok === true ? collection.value : { ...EMPTY_SETTINGS, auth: { type: 'none' as const } };
  const { document, scope } = converter.settings(rootSettings, files.name, rootEntry, NO_AUTH_SCOPE);
  const root: FolderDraft = {
    kind: 'folder',
    base: '',
    document,
    children: converter.children(tree, scope, files),
    report: rootEntry,
  };

  const environments: EnvironmentDraft[] = [];
  for (const { file, environment } of files.environments) {
    const name = environment.ok ? environment.value.name : file;
    const entry = report.entry(file, file, name);
    if (!environment.ok) {
      entry.skip(`the file could not be parsed: ${environment.message}`);
      continue;
    }
    environments.push(convertEnvironment(environment.value, entry));
  }
  for (const { file, reason } of files.others) report.entry(file, file, file).skip(reason);
  return { ok: true, name: files.name, root, environments };
}

class BrunoConverter {
  constructor(
    private readonly format: 'bruno' | 'bruno-yaml',
    private readonly context: ImportContext,
  ) {}

  children(node: DirectoryNode, scope: AuthScope, files: BrunoFiles): Draft[] {
    const folders = [...node.folders.values()].map((child) => {
      const settings = files.folders.get(child.path);
      const meta = settings?.meta.ok === true ? settings.meta.value : undefined;
      const label = meta?.name ?? child.path.slice(child.path.lastIndexOf('/') + 1);
      return { child, settings, meta, label, seq: meta?.seq };
    });
    folders.sort((a, b) => compareSeq(a.seq, b.seq) || compareText(a.label, b.label));
    const requests = node.requests
      .flatMap(({ file, request }) => (request.ok ? [{ file, request: request.value }] : []))
      .sort((a, b) => compareSeq(a.request.seq, b.request.seq) || compareText(a.request.name, b.request.name));
    const drafts: Draft[] = [];
    for (const { child, settings, meta, label } of folders) {
      const file = settings?.file ?? child.path;
      const entry = this.context.report.entry(file, file, label);
      if (settings !== undefined && !settings.meta.ok) {
        entry.note(`the folder settings could not be parsed and were dropped: ${settings.meta.message}`);
      }
      const converted = this.settings(meta ?? EMPTY_SETTINGS, label, entry, scope);
      drafts.push({
        kind: 'folder',
        base: toRunnerName(label, 'folder'),
        document: converted.document,
        children: this.children(child, converted.scope, files),
        report: entry,
      });
    }
    for (const { file, request } of requests) {
      const draft = this.request(file, request, this.context.report.entry(file, file, request.name), scope);
      if (draft !== null) drafts.push(draft);
    }
    for (const { file, request } of node.requests) {
      if (!request.ok)
        this.context.report.entry(file, file, file).skip(`the file could not be parsed: ${request.message}`);
    }
    return drafts;
  }

  settings(
    settings: BrunoSettings,
    name: string,
    entry: ReportEntry,
    inherited: AuthScope,
  ): { document: FolderDocument; scope: AuthScope } {
    const note = entry.note;
    const applied = applyAuth(settings.auth, inherited, 'bruno', name, note);
    if (applied.query !== null) {
      note(`the API key query parameter "${applied.query.name}" is added to each request below that inherits it`);
    }
    const postLines = settings.postVars
      .filter((pair) => keep(pair, 'post-response variable', note))
      .map((pair) => setVarLine(pair, note));
    const document = compact<FolderDocument>({
      name,
      vars: this.vars(settings.preVars, note),
      headers: nonEmptyList([...this.headers(settings.headers, note), ...applied.headers]),
      scripts: this.scripts(settings, postLines, entry),
      docs: blank(settings.docs),
    });
    return { document, scope: applied.scope };
  }

  request(file: string, request: BrunoRequest, entry: ReportEntry, scope: AuthScope): Draft | null {
    const note = entry.note;
    if (request.type !== 'http' && request.type !== 'graphql') {
      entry.skip(`${request.type} requests are not HTTP requests and are not imported`);
      return null;
    }
    const method = request.method.toUpperCase();
    if (!METHOD_PATTERN.test(method) || REFUSED_METHODS.has(method)) {
      entry.skip(`the method ${method} cannot be sent by Janus`);
      return null;
    }
    const absolute = absoluteUrl(convertTemplate(request.url, 'bruno', note));
    if (request.url.trim() === '' || absolute === null) {
      entry.skip(
        request.url.trim() === '' ? 'the request has no URL' : `the URL ${request.url} is not an http or https URL`,
      );
      return null;
    }
    if (absolute.added) note('the URL had no scheme; http:// was added, as Bruno assumes');
    let url = absolute.url;
    const pathValues: Record<string, string> = {};
    for (const param of request.params) {
      if (param.type === 'path') pathValues[param.name] = convertTemplate(param.value, 'bruno', note);
      else if (!param.enabled)
        note(`the disabled query parameter ${param.name} was dropped; Janus keeps the query in the URL`);
    }
    const pathParams = reconcilePathParams(url, pathValues, note);
    const applied = applyAuth(request.auth, scope, 'bruno', request.name, note);
    if (applied.query !== null) {
      url = appendQuery(url, applied.query.name, applied.query.value);
      if (request.auth.type === 'inherit' && scope.query !== null) {
        note(
          `the API key query parameter "${scope.query.name}" inherited from "${scope.query.from}" was added to the URL`,
        );
      }
    }
    const headers = [...this.headers(request.headers, note), ...applied.headers];
    const extract: Record<string, ExtractEntry> = {};
    const postLines: string[] = [];
    for (const pair of request.postVars) {
      if (!keep(pair, 'post-response variable', note)) continue;
      const token = extractToken(pair.value);
      if (token === null) postLines.push(setVarLine(pair, note));
      else extract[variableName(pair.name, note)] = token;
    }
    const document = compact({
      name: request.name,
      method,
      url,
      pathParams,
      headers: nonEmptyList(headers),
      body: this.body(request, headers, note),
      vars: this.vars(request.preVars, note),
      extract: nonEmpty(extract),
      scripts: this.scripts(request, postLines, entry),
      docs: blank(request.docs),
      source: { format: this.format, file, item: file },
    });
    return { kind: 'request', base: toRunnerName(request.name, 'request'), document, report: entry };
  }

  private headers(pairs: readonly BrunoPair[], note: Note): NameValue[] {
    return pairs
      .filter((pair) => pair.name !== '')
      .map((pair) => {
        const header = { name: pair.name, value: convertTemplate(pair.value, 'bruno', note) };
        return pair.enabled ? header : { ...header, disabled: true };
      });
  }

  private vars(pairs: readonly BrunoPair[], note: Note): Readonly<Record<string, string>> | undefined {
    const vars: Record<string, string> = {};
    for (const pair of pairs) {
      if (keep(pair, 'variable', note))
        vars[variableName(pair.name, note)] = convertTemplate(pair.value, 'bruno', note);
    }
    return nonEmpty(vars);
  }

  private scripts(settings: BrunoSettings, postLines: readonly string[], entry: ReportEntry): Scripts | undefined {
    const tests = settings.asserts
      .filter((pair) => keep(pair, 'assertion', entry.note))
      .map((pair) => assertionTest(pair.name, pair.value, entry.note))
      .filter((line): line is string => line !== null);
    const before = joinScripts(settings.before);
    const after = joinScripts(postLines.join('\n'), settings.after, tests.join('\n'), settings.tests);
    if (before !== undefined) reviewScript('pre-request', before, entry.note, this.context.checkScript);
    if (after !== undefined) reviewScript('post-response', after, entry.note, this.context.checkScript);
    return before === undefined && after === undefined ? undefined : compact<Scripts>({ before, after });
  }

  private body(request: BrunoRequest, headers: readonly NameValue[], note: Note): RequestBody | undefined {
    const convert = (template: string): string => convertTemplate(template, 'bruno', note);
    const body = request.body;
    if (request.type === 'graphql' && body.mode !== 'graphql') {
      note('the GraphQL request has no query');
      return undefined;
    }
    switch (body.mode) {
      case 'none':
        return undefined;
      case 'json':
      case 'text':
      case 'xml':
        return body.text === '' ? undefined : { type: body.mode, text: convert(body.text) };
      case 'sparql':
        note('the SPARQL body is sent as text; add Content-Type: application/sparql-query if the server needs it');
        return { type: 'text', text: convert(body.text) };
      case 'form':
        return {
          type: 'form',
          fields: body.fields.map((pair) => {
            const field = { name: pair.name, value: convert(pair.value) };
            return pair.enabled ? field : { ...field, disabled: true };
          }),
        };
      case 'multipart': {
        const parts: MultipartPart[] = [];
        for (const part of body.parts) {
          const disabled = part.enabled ? {} : { disabled: true };
          const contentType =
            part.contentType === undefined || part.contentType === '' ? {} : { contentType: part.contentType };
          if (part.files === undefined) {
            if (part.contentType !== undefined && part.contentType !== '') {
              note(`the content type of the part "${part.name}" was dropped`);
            }
            parts.push({ name: part.name, value: convert(part.value ?? ''), ...disabled });
            continue;
          }
          for (const path of part.files) {
            const file = fileReference(path, `the file part "${part.name}"`, note);
            if (file !== null) parts.push({ name: part.name, file, ...contentType, ...disabled });
          }
        }
        return { type: 'multipart', parts };
      }
      case 'graphql':
        return body.variables === undefined || body.variables.trim() === ''
          ? { type: 'graphql', query: convert(body.query) }
          : { type: 'graphql', query: convert(body.query), variables: convert(body.variables) };
      case 'file': {
        const selected = body.files.find((file) => file.selected) ?? body.files[0];
        if (body.files.length > 1) note('the file body lists several files; only the selected one was kept');
        const file = selected === undefined ? null : fileReference(selected.path, 'the file body', note);
        if (selected === undefined || file === null) return undefined;
        const contentType =
          selected.contentType ??
          headers.find((h) => h.name.toLowerCase() === 'content-type' && h.disabled !== true)?.value;
        return contentType === undefined || contentType === ''
          ? { type: 'file', file }
          : { type: 'file', file, contentType };
      }
      case 'other':
        note(`the body mode "${body.name}" was not converted`);
        return undefined;
    }
  }
}

function compareSeq(a: number | undefined, b: number | undefined): number {
  return (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function blank(text: string | undefined): string | undefined {
  return text === undefined || text.trim() === '' ? undefined : text;
}

function keep(pair: BrunoPair, what: string, note: Note): boolean {
  if (pair.name === '') return false;
  if (!pair.enabled) note(`the disabled ${what} ${pair.name} was dropped`);
  return pair.enabled;
}

function variableName(name: string, note: Note): string {
  const out = toVariableName(name);
  if (out !== name) note(`variable "${name}" is outside the Janus variable grammar; it was renamed ${out}`);
  return out;
}

function setVarLine(pair: BrunoPair, note: Note): string {
  return `bru.setVar(${JSON.stringify(variableName(pair.name, note))}, ${pair.value.trim()});`;
}

const IDENTIFIER = '[A-Za-z_$][A-Za-z0-9_$]*';
const BODY_PATH = new RegExp(`^res\\.body((?:\\.${IDENTIFIER}|\\[\\d+\\]|\\['[^'\\]]*'\\]|\\["[^"\\]]*"\\])*)$`);
const QUERY_PATH = new RegExp(`^${IDENTIFIER}(?:\\.${IDENTIFIER}|\\[\\d+\\])*$`);

/**
 * The `extract` token for a post-response variable:
 * a plain `res.body…` path or a `res("…")` query that is a plain path; null
 * for any other expression.
 */
export function extractToken(expression: string): string | null {
  const trimmed = expression.trim();
  const body = BODY_PATH.exec(trimmed);
  if (body !== null) {
    const path = (body[1] ?? '').replace(/\["([^"\]]*)"\]/g, "['$1']");
    return `{{$response.body.$${path}}}`;
  }
  const query = /^res\(\s*(["'])(.*)\1\s*\)$/.exec(trimmed)?.[2];
  if (query !== undefined && QUERY_PATH.test(query)) return `{{$response.body.$.${query}}}`;
  return null;
}

/** Bruno's assertion operators and their `chai` form; `{0}` is the left side, `{1}` the operand. */
const OPERATORS: Readonly<Record<string, { readonly args: 0 | 1 | 'list' | 'pair'; readonly chai: string }>> = {
  eq: { args: 1, chai: 'expect({0}).to.equal({1})' },
  neq: { args: 1, chai: 'expect({0}).to.not.equal({1})' },
  gt: { args: 1, chai: 'expect({0}).to.be.greaterThan({1})' },
  gte: { args: 1, chai: 'expect({0}).to.be.at.least({1})' },
  lt: { args: 1, chai: 'expect({0}).to.be.lessThan({1})' },
  lte: { args: 1, chai: 'expect({0}).to.be.at.most({1})' },
  in: { args: 'list', chai: 'expect({0}).to.be.oneOf({1})' },
  notIn: { args: 'list', chai: 'expect({0}).to.not.be.oneOf({1})' },
  contains: { args: 1, chai: 'expect({0}).to.include({1})' },
  notContains: { args: 1, chai: 'expect({0}).to.not.include({1})' },
  length: { args: 1, chai: 'expect({0}).to.have.lengthOf({1})' },
  matches: { args: 1, chai: 'expect({0}).to.match(new RegExp({1}))' },
  notMatches: { args: 1, chai: 'expect({0}).to.not.match(new RegExp({1}))' },
  startsWith: { args: 1, chai: "expect({0}).to.be.a('string').and.satisfy((v) => v.startsWith({1}))" },
  endsWith: { args: 1, chai: "expect({0}).to.be.a('string').and.satisfy((v) => v.endsWith({1}))" },
  between: { args: 'pair', chai: 'expect({0}).to.be.within({1})' },
  isEmpty: { args: 0, chai: 'expect({0}).to.be.empty' },
  isNotEmpty: { args: 0, chai: 'expect({0}).to.not.be.empty' },
  isNull: { args: 0, chai: 'expect({0}).to.be.null' },
  isUndefined: { args: 0, chai: 'expect({0}).to.be.undefined' },
  isDefined: { args: 0, chai: 'expect({0}).to.not.be.undefined' },
  isTruthy: { args: 0, chai: 'expect({0}).to.be.ok' },
  isFalsy: { args: 0, chai: 'expect({0}).to.not.be.ok' },
  isJson: {
    args: 0,
    chai: "expect({0}).to.satisfy((v) => { if (typeof v === 'object' && v !== null) return true; try { JSON.parse(v); return true; } catch { return false; } })",
  },
  isNumber: { args: 0, chai: "expect({0}).to.be.a('number')" },
  isString: { args: 0, chai: "expect({0}).to.be.a('string')" },
  isBoolean: { args: 0, chai: "expect({0}).to.be.a('boolean')" },
  isArray: { args: 0, chai: "expect({0}).to.be.an('array')" },
};

/** A Bruno operand as JavaScript: a number, boolean, null, quoted string, `{{variable}}` or bare text. */
function operand(raw: string): string {
  const value = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(value) || ['true', 'false', 'null', 'undefined'].includes(value)) return value;
  const quoted = /^(["'])(.*)\1$/s.exec(value);
  if (quoted !== null) return JSON.stringify(quoted[2] ?? '');
  if (/^\{\{[^{}]+\}\}$/.test(value)) return `bru.interpolate(${JSON.stringify(value)})`;
  return JSON.stringify(value);
}

function operands(raw: string): string[] {
  return raw
    .trim()
    .replace(/^\[(.*)\]$/s, '$1')
    .split(',')
    .map(operand);
}

/** One `test()` for a Bruno assertion, or null with a note when it cannot be converted. */
export function assertionTest(expression: string, value: string, note: Note): string | null {
  const trimmed = value.trim();
  const space = trimmed.search(/\s/);
  const word = space === -1 ? trimmed : trimmed.slice(0, space);
  const rest = space === -1 ? '' : trimmed.slice(space + 1);
  const known = OPERATORS[word];
  const [operator, argument] = known === undefined ? [OPERATORS.eq, trimmed] : [known, rest];
  if (operator === undefined) return null;
  let rhs = '';
  if (operator.args === 1) rhs = operand(argument);
  else if (operator.args === 'list') rhs = `[${operands(argument).join(', ')}]`;
  else if (operator.args === 'pair') {
    const pair = operands(argument);
    if (pair.length !== 2) {
      note(`the assertion "${expression}: ${value}" needs two bounds and was dropped`);
      return null;
    }
    rhs = pair.join(', ');
  }
  const assertion = operator.chai.replace('{0}', expression.trim()).replace('{1}', rhs);
  return `test(${JSON.stringify(`${expression.trim()}: ${trimmed}`)}, function () {\n  ${assertion};\n});`;
}

function convertEnvironment(environment: BrunoEnvironment, entry: ReportEntry): EnvironmentDraft {
  const vars: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const pair of environment.vars) {
    if (!keep(pair, 'variable', entry.note)) continue;
    const name = variableName(pair.name, entry.note);
    if (pair.secret) {
      secrets[name] = pair.value;
      entry.note(
        pair.value === ''
          ? `the secret ${pair.name} was written to the .local.yaml file with an empty value; fill it in`
          : `the secret ${pair.name} was written to the .local.yaml file`,
      );
      continue;
    }
    if (pair.value.includes('{{')) {
      entry.note(`the value of ${pair.name} contains "{{", which environment values do not render`);
    }
    vars[name] = pair.value;
  }
  return { base: toRunnerName(environment.name, 'environment'), name: environment.name, vars, secrets };
}
