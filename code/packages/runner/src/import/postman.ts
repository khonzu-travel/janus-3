import {
  METHOD_PATTERN,
  REFUSED_METHODS,
  type FolderDocument,
  type MultipartPart,
  type NameValue,
  type RequestBody,
  type Scripts,
} from '../model.js';
import { applyAuth, NO_AUTH_SCOPE, type AuthScope, type SourceAuth } from './auth.js';
import { refuse, type Converted, type ImportContext } from './context.js';
import { toRunnerName, toVariableName } from './names.js';
import { joinScripts, reviewScript } from './scripts.js';
import { convertTemplate, type Note } from './template.js';
import { baseName, isRecord, list, record, text, type JsonRecord } from './text.js';
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
 * Postman Collection v2.0 and v2.1 and Postman environment files. The versions differ in `url`
 * (v2.0 may write a string, and its
 * `host` and `path` may be strings) and in auth (v2.0 keys each auth type's
 * values by name; v2.1 lists `{ key, value, type }`); both are read.
 */

export interface JsonSource {
  readonly file: string;
  readonly json: JsonRecord;
}

/** True for a Postman v2 collection: an `info` object (v2.0 and v2.1 carry the schema there) and `item`. */
export function isPostmanCollection(json: unknown): json is JsonRecord {
  return isRecord(json) && Array.isArray(json.item) && isRecord(json.info);
}

/** True for a Postman environment or globals export. */
export function isPostmanEnvironment(json: unknown): json is JsonRecord {
  return isRecord(json) && Array.isArray(json.values) && ('_postman_variable_scope' in json || 'name' in json);
}

/** A Postman v1 collection (`requests` and `order`), which is refused. */
export function isPostmanV1(json: unknown): boolean {
  return isRecord(json) && Array.isArray(json.requests) && !Array.isArray(json.item);
}

export function convertPostman(
  collections: readonly JsonSource[],
  environments: readonly JsonSource[],
  context: ImportContext,
): Converted {
  const [collection, ...others] = collections;
  if (collection === undefined) return refuse('import-unsupported-format', 'no Postman collection among the sources');
  if (others.length > 0) {
    return refuse('import-invalid', 'import one Postman collection at a time, with any number of environment files');
  }
  const converter = new PostmanConverter(collection.file, context);
  const root = converter.collection(collection.json);
  const envs = environments
    .map((source) => convertEnvironment(source, context))
    .filter((env): env is EnvironmentDraft => env !== null);
  return { ok: true, name: root.document.name ?? 'imported', root, environments: envs };
}

class PostmanConverter {
  constructor(
    private readonly file: string,
    private readonly context: ImportContext,
  ) {}

  collection(json: JsonRecord): FolderDraft {
    const info = record(json.info);
    const name = text(info.name) ?? baseName(this.file).replace(/\.json$/i, '');
    const entry = this.context.report.entry(this.file, '', name);
    const { document, scope } = this.folderSettings(json, name, entry, NO_AUTH_SCOPE, description(info.description));
    const children = this.items(list(json.item), 'item', scope);
    return { kind: 'folder', base: '', document, children, report: entry };
  }

  private items(items: readonly unknown[], path: string, scope: AuthScope): Draft[] {
    const drafts: Draft[] = [];
    items.forEach((value, index) => {
      const item = record(value);
      const location = `${path}[${String(index)}]`;
      const name = text(item.name) ?? '';
      const entry = this.context.report.entry(this.file, location, name);
      if (Array.isArray(item.item)) {
        const { document, scope: inner } = this.folderSettings(item, name, entry, scope, description(item.description));
        const children = this.items(item.item as readonly unknown[], `${location}.item`, inner);
        drafts.push({ kind: 'folder', base: toRunnerName(name, 'folder'), document, children, report: entry });
        return;
      }
      if (item.request === undefined) {
        entry.skip('the item has neither a request nor items');
        return;
      }
      const draft = this.request(item, name, location, entry, scope);
      if (draft !== null) drafts.push(draft);
    });
    return drafts;
  }

  private folderSettings(
    item: JsonRecord,
    name: string,
    entry: ReportEntry,
    inherited: AuthScope,
    docs: string | undefined,
  ): { document: FolderDocument; scope: AuthScope } {
    const auth = item.auth === undefined || item.auth === null ? { type: 'inherit' as const } : readAuth(item.auth);
    const applied = applyAuth(auth, inherited, 'postman', name, entry.note);
    if (applied.query !== null && auth.type !== 'inherit') {
      entry.note(`the API key query parameter "${applied.query.name}" is added to each request below that inherits it`);
    }
    if (item.protocolProfileBehavior !== undefined) entry.note('protocolProfileBehavior settings were dropped');
    const document = compact<FolderDocument>({
      name: name === '' ? undefined : name,
      vars: variables(item.variable, entry.note),
      headers: nonEmptyList(applied.headers),
      scripts: this.scripts(item.event, entry),
      docs,
    });
    return { document, scope: applied.scope };
  }

  private request(
    item: JsonRecord,
    name: string,
    location: string,
    entry: ReportEntry,
    scope: AuthScope,
  ): Draft | null {
    const request: JsonRecord = typeof item.request === 'string' ? { url: item.request } : record(item.request);
    const note = entry.note;
    const method = (text(request.method) ?? 'GET').toUpperCase();
    if (!METHOD_PATTERN.test(method) || REFUSED_METHODS.has(method)) {
      entry.skip(`the method ${method} cannot be sent by Janus`);
      return null;
    }
    const url = readUrl(request.url, note);
    const absolute = absoluteUrl(convertTemplate(url.raw, 'postman', note));
    if (url.raw.trim() === '' || absolute === null) {
      entry.skip(url.raw.trim() === '' ? 'the request has no URL' : `the URL ${url.raw} is not an http or https URL`);
      return null;
    }
    if (absolute.added) note('the URL had no scheme; http:// was added, as Postman assumes');
    let finalUrl = absolute.url;
    const pathValues = Object.fromEntries(
      url.variables.map(([key, value]) => [key, convertTemplate(value, 'postman', note)]),
    );
    const pathParams = reconcilePathParams(finalUrl, pathValues, note);

    const auth =
      request.auth === undefined || request.auth === null ? { type: 'inherit' as const } : readAuth(request.auth);
    const applied = applyAuth(auth, scope, 'postman', name, note);
    if (applied.query !== null) {
      finalUrl = appendQuery(finalUrl, applied.query.name, applied.query.value);
      if (auth.type === 'inherit' && scope.query !== null) {
        note(
          `the API key query parameter "${scope.query.name}" inherited from "${scope.query.from}" was added to the URL`,
        );
      }
    }
    const headers = [...readHeaders(request.header, note), ...applied.headers];
    if (request.protocolProfileBehavior !== undefined || item.protocolProfileBehavior !== undefined) {
      note('protocolProfileBehavior settings were dropped');
    }
    const document = compact({
      name,
      method,
      url: finalUrl,
      pathParams,
      headers: nonEmptyList(headers),
      body: readBody(request.body, headers, note),
      vars: variables(item.variable, note),
      scripts: this.scripts(item.event, entry),
      docs: description(request.description) ?? description(item.description),
      source: { format: 'postman', file: this.file, item: location },
    });
    return { kind: 'request', base: toRunnerName(name, 'request'), document, report: entry };
  }

  private scripts(events: unknown, entry: ReportEntry): Scripts | undefined {
    const before: string[] = [];
    const after: string[] = [];
    for (const value of list(events)) {
      const event = record(value);
      const listen = text(event.listen);
      const script = record(event.script);
      const exec = Array.isArray(script.exec)
        ? script.exec.map((line) => text(line) ?? '').join('\n')
        : (text(script.exec) ?? '');
      if (exec.trim() === '') continue;
      if (event.disabled === true) {
        entry.note(`a disabled ${listen ?? 'unknown'} script was dropped`);
        continue;
      }
      if (listen === 'prerequest') before.push(exec);
      else if (listen === 'test') after.push(exec);
      else entry.note(`a script for the "${listen ?? ''}" event was dropped`);
    }
    const scripts = compact<Scripts>({ before: joinScripts(...before), after: joinScripts(...after) });
    if (scripts.before !== undefined) reviewScript('pre-request', scripts.before, entry.note, this.context.checkScript);
    if (scripts.after !== undefined) reviewScript('test', scripts.after, entry.note, this.context.checkScript);
    return scripts.before === undefined && scripts.after === undefined ? undefined : scripts;
  }
}

/** A `description`: a string, or `{ content }`. */
function description(value: unknown): string | undefined {
  const docs = text(value) ?? text(record(value).content);
  return docs === undefined || docs.trim() === '' ? undefined : docs;
}

/** Collection, folder or item `variable` rows as `vars`. */
function variables(value: unknown, note: Note): Readonly<Record<string, string>> | undefined {
  const vars: Record<string, string> = {};
  for (const row of list(value)) {
    const variable = record(row);
    const key = text(variable.key) ?? text(variable.id);
    if (key === undefined || key === '') continue;
    const name = toVariableName(key);
    if (name !== key) note(`variable "${key}" is outside the Janus variable grammar; it was renamed ${name}`);
    if (variable.disabled === true) {
      note(`the disabled variable ${key} was dropped`);
      continue;
    }
    const raw =
      text(variable.value) ??
      (variable.value === undefined || variable.value === null ? '' : JSON.stringify(variable.value));
    vars[name] = convertTemplate(raw, 'postman', note);
  }
  return nonEmpty(vars);
}

/** Auth in v2.0 (`{ bearer: { token } }`) or v2.1 (`{ bearer: [{ key, value }] }`) form. */
export function readAuth(value: unknown): SourceAuth {
  const auth = record(value);
  const type = text(auth.type) ?? 'noauth';
  const raw = auth[type];
  const values: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const row of raw as readonly unknown[]) {
      const key = text(record(row).key);
      if (key !== undefined) values[key] = text(record(row).value) ?? '';
    }
  } else {
    for (const [key, member] of Object.entries(record(raw))) values[key] = text(member) ?? '';
  }
  switch (type) {
    case 'noauth':
      return { type: 'none' };
    case 'inherit':
      return { type: 'inherit' };
    case 'bearer':
      return { type: 'bearer', token: values.token ?? '' };
    case 'basic':
      return { type: 'basic', username: values.username ?? '', password: values.password ?? '' };
    case 'apikey':
      return {
        type: 'apikey',
        key: values.key ?? '',
        value: values.value ?? '',
        in: values.in === 'query' ? 'query' : 'header',
      };
    default:
      return { type: 'other', name: type };
  }
}

interface PostmanUrl {
  readonly raw: string;
  readonly variables: readonly (readonly [string, string])[];
}

/** `url` as a string or `{ raw, protocol, host, port, path, query, hash, variable }`. */
function readUrl(value: unknown, note: Note): PostmanUrl {
  if (typeof value === 'string') return { raw: value, variables: [] };
  const url = record(value);
  const variables: [string, string][] = [];
  for (const row of list(url.variable)) {
    const variable = record(row);
    const key = text(variable.key) ?? text(variable.id);
    if (key !== undefined) variables.push([key, text(variable.value) ?? '']);
  }
  const query = list(url.query).map(record);
  for (const param of query) {
    if (param.disabled === true) {
      note(`the disabled query parameter ${text(param.key) ?? ''} was dropped; Janus keeps the query in the URL`);
    }
  }
  const raw = text(url.raw);
  if (raw !== undefined) return { raw, variables };
  // No raw: rebuild it from the parts.
  const host = Array.isArray(url.host) ? url.host.map((part) => text(part) ?? '').join('.') : (text(url.host) ?? '');
  const path = Array.isArray(url.path) ? url.path.map((part) => text(part) ?? '').join('/') : (text(url.path) ?? '');
  const protocol = text(url.protocol);
  const port = text(url.port);
  const enabled = query
    .filter((param) => param.disabled !== true)
    .map((param) => {
      const key = text(param.key) ?? '';
      const val = param.value === null || param.value === undefined ? null : (text(param.value) ?? '');
      return val === null ? key : `${key}=${val}`;
    });
  const rebuilt =
    (protocol === undefined ? '' : `${protocol}://`) +
    host +
    (port === undefined ? '' : `:${port}`) +
    (path === '' ? '' : `/${path.replace(/^\//, '')}`) +
    (enabled.length > 0 ? `?${enabled.join('&')}` : '') +
    (text(url.hash) === undefined ? '' : `#${text(url.hash) ?? ''}`);
  return { raw: rebuilt, variables };
}

/** `header` as rows `{ key, value, disabled }` or, in v2.0, a `Name: value` string. */
function readHeaders(value: unknown, note: Note): NameValue[] {
  const rows: { key: string; value: string; disabled: boolean }[] = [];
  if (typeof value === 'string') {
    for (const line of value.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon > 0)
        rows.push({ key: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim(), disabled: false });
    }
  } else {
    for (const row of list(value)) {
      const header = record(row);
      const key = text(header.key) ?? '';
      if (key === '') continue;
      rows.push({ key, value: text(header.value) ?? '', disabled: header.disabled === true });
      if (description(header.description) !== undefined) note(`the description of the header ${key} was dropped`);
    }
  }
  return rows.map((row) => {
    const header = { name: row.key, value: convertTemplate(row.value, 'postman', note) };
    return row.disabled ? { ...header, disabled: true } : header;
  });
}

function contentTypeOf(headers: readonly NameValue[]): string {
  const header = headers.find((h) => h.name.toLowerCase() === 'content-type' && h.disabled !== true);
  return header?.value.toLowerCase() ?? '';
}

/** A file reference from an export: the file is not in it, so the request reads its base name beside itself. */
export function fileReference(src: string, what: string, note: Note): string | null {
  const file = baseName(src);
  if (file === '') {
    note(`${what} names no file and was dropped`);
    return null;
  }
  note(`${what} refers to ${src}, which is not in the export; copy it beside the request as ${file}`);
  return file;
}

function readBody(value: unknown, headers: readonly NameValue[], note: Note): RequestBody | undefined {
  if (!isRecord(value)) return undefined;
  const mode = text(value.mode);
  if (mode === undefined) return undefined;
  if (value.disabled === true) {
    note('the body is disabled in Postman and was not imported');
    return undefined;
  }
  const convert = (template: string): string => convertTemplate(template, 'postman', note);
  switch (mode) {
    case 'raw': {
      const raw = text(value.raw) ?? '';
      if (raw === '') return undefined;
      const language = text(record(record(value.options).raw).language);
      const contentType = contentTypeOf(headers);
      const type =
        language === 'json' || (language === undefined && /json/.test(contentType))
          ? 'json'
          : language === 'xml' || (language === undefined && /xml/.test(contentType))
            ? 'xml'
            : 'text';
      return { type, text: convert(raw) };
    }
    case 'urlencoded': {
      const fields = list(value.urlencoded)
        .map(record)
        .map((row) => {
          const field = { name: text(row.key) ?? '', value: convert(text(row.value) ?? '') };
          return row.disabled === true ? { ...field, disabled: true } : field;
        });
      return { type: 'form', fields };
    }
    case 'formdata': {
      const parts: MultipartPart[] = [];
      for (const row of list(value.formdata).map(record)) {
        const name = text(row.key) ?? '';
        const disabled = row.disabled === true ? { disabled: true } : {};
        const contentType = text(row.contentType);
        if (row.type === 'file') {
          const sources = Array.isArray(row.src) ? row.src.map((src) => text(src) ?? '') : [text(row.src) ?? ''];
          for (const src of sources) {
            const file = fileReference(src, `the file part "${name}"`, note);
            if (file === null) continue;
            parts.push({
              name,
              file,
              ...(contentType === undefined || contentType === '' ? {} : { contentType }),
              ...disabled,
            });
          }
        } else {
          if (contentType !== undefined && contentType !== '')
            note(`the content type of the part "${name}" was dropped`);
          parts.push({ name, value: convert(text(row.value) ?? ''), ...disabled });
        }
      }
      return { type: 'multipart', parts };
    }
    case 'file': {
      const file = fileReference(text(record(value.file).src) ?? '', 'the file body', note);
      if (file === null) return undefined;
      const contentType = contentTypeOf(headers);
      return contentType === '' ? { type: 'file', file } : { type: 'file', file, contentType };
    }
    case 'graphql': {
      const graphql = record(value.graphql);
      const variables = text(graphql.variables);
      const query = convert(text(graphql.query) ?? '');
      return variables === undefined || variables.trim() === ''
        ? { type: 'graphql', query }
        : { type: 'graphql', query, variables: convert(variables) };
    }
    default:
      note(`the body mode "${mode}" was not converted`);
      return undefined;
  }
}

function convertEnvironment(source: JsonSource, context: ImportContext): EnvironmentDraft | null {
  const { json, file } = source;
  const name = text(json.name) ?? baseName(file).replace(/(\.postman_environment)?\.json$/i, '');
  const entry = context.report.entry(file, '', name);
  if (json._postman_variable_scope === 'globals') {
    entry.skip('Postman globals are not part of a collection and are not imported');
    return null;
  }
  const vars: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  list(json.values).forEach((row) => {
    const variable = record(row);
    const key = text(variable.key) ?? '';
    if (key === '') return;
    const varName = toVariableName(key);
    if (varName !== key)
      entry.note(`variable "${key}" is outside the Janus variable grammar; it was renamed ${varName}`);
    if (variable.enabled === false) {
      entry.note(`the disabled variable ${key} was dropped`);
      return;
    }
    const value = text(variable.value) ?? '';
    if (value.includes('{{')) entry.note(`the value of ${key} contains "{{", which environment values do not render`);
    if (variable.type === 'secret') {
      secrets[varName] = value;
      entry.note(
        value === ''
          ? `the secret ${key} was written to the .local.yaml file with an empty value; fill it in`
          : `the secret ${key} was written to the .local.yaml file`,
      );
    } else {
      vars[varName] = value;
    }
  });
  return { base: toRunnerName(name, 'environment'), name, vars, secrets };
}
