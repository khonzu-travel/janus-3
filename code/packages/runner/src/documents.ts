import { runnerRegistration, type GrammarContext, type StartupErrorCode } from '@janus/core';
import { isMap, isScalar, LineCounter, parseDocument, Scalar, type Document, type Node as YamlNode } from 'yaml';
import * as z from 'zod';

import {
  BODY_TYPES,
  isRunnerName,
  isVariableName,
  METHOD_PATTERN,
  REFUSED_METHODS,
  type EnvironmentDocument,
  type ExtractEntry,
  type FolderDocument,
  type NameValue,
  type RequestBody,
  type RequestDocument,
  type Scripts,
} from './model.js';
import type { ScriptSyntaxProblem } from './sandbox/types.js';
import { parseTemplate } from './template.js';

/**
 * Reading and validating request, folder and environment documents. Pure: the caller supplies the text. Every problem
 * names the file and, for YAML input, the line and column.
 */

export type RequestProblemCode = Extract<
  StartupErrorCode,
  | 'request-invalid'
  | 'request-invalid-name'
  | 'request-invalid-template'
  | 'request-invalid-path-params'
  | 'request-invalid-script'
  | 'request-invalid-extract'
  | 'request-invalid-environment'
>;

export interface RequestProblem {
  readonly code: RequestProblemCode;
  /** The file's path below `runner.root`, "/" separated. */
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  /** For JSON input: where in the document, e.g. `headers[2].value`. */
  readonly pointer?: string;
  readonly message: string;
}

export interface ValidationContext {
  /** The grammar with the configured aliases. */
  readonly grammar: GrammarContext;
  /** Compiles a script without running it; null when it parses. */
  readonly checkScript?: ((source: string) => ScriptSyntaxProblem | null) | undefined;
}

/** A text value: YAML numbers and booleans are read as the text they show. */
const text = z.union([z.string(), z.number(), z.boolean()]).transform(String);
const stringMap = z.record(z.string(), text);
const nameValue = z.strictObject({ name: z.string().min(1), value: text, disabled: z.boolean().optional() });
const scripts = z.strictObject({ before: z.string().optional(), after: z.string().optional() });

const body = z.discriminatedUnion('type', [
  z.strictObject({ type: z.enum(['json', 'text', 'xml']), text: z.string() }),
  z.strictObject({ type: z.literal('form'), fields: z.array(nameValue) }),
  z.strictObject({
    type: z.literal('multipart'),
    parts: z.array(
      z.union([
        z.strictObject({ name: z.string().min(1), value: text, disabled: z.boolean().optional() }),
        z.strictObject({
          name: z.string().min(1),
          file: z.string().min(1),
          contentType: z.string().min(1).optional(),
          disabled: z.boolean().optional(),
        }),
      ]),
    ),
  }),
  z.strictObject({ type: z.literal('file'), file: z.string().min(1), contentType: z.string().min(1).optional() }),
  z.strictObject({ type: z.literal('graphql'), query: z.string(), variables: z.string().optional() }),
]);

const extractEntry = z.union([
  z.string(),
  z.strictObject({
    value: z.string(),
    match: z.string().optional(),
    optional: z.boolean().optional(),
    default: z.unknown().optional(),
  }),
]);

const requestSchema = z.strictObject({
  name: z.string().min(1).max(200),
  method: z.string().min(1),
  url: z.string().min(1),
  pathParams: stringMap.optional(),
  headers: z.array(nameValue).optional(),
  body: body.optional(),
  vars: stringMap.optional(),
  extract: z.record(z.string(), extractEntry).optional(),
  scripts: scripts.optional(),
  route: z.string().min(1).optional(),
  docs: z.string().optional(),
  source: z.strictObject({ format: z.string(), file: z.string(), item: z.string() }).optional(),
});

const folderSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  vars: stringMap.optional(),
  headers: z.array(nameValue).optional(),
  scripts: scripts.optional(),
  stripPrefix: z.string().min(1).optional(),
  cookies: z.boolean().optional(),
  environment: z.string().optional(),
  docs: z.string().optional(),
});

const environmentSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  vars: stringMap.optional(),
  disabled: z.array(z.string()).optional(),
  default: z.boolean().optional(),
});

const localEnvironmentSchema = z.strictObject({ vars: stringMap.optional() });

type Path = readonly (string | number)[];

/** Collects problems for one document, located in YAML when there is YAML. */
class Problems {
  readonly list: RequestProblem[] = [];

  constructor(
    readonly file: string,
    private readonly yaml: { readonly doc: Document; readonly lines: LineCounter } | null,
  ) {}

  add(code: RequestProblemCode, at: Path, message: string, offset?: { line: number; column: number }): void {
    const location = offset ?? this.locate(at);
    this.list.push(
      Object.freeze({
        code,
        path: this.file,
        ...(location === null ? {} : { line: location.line, column: location.column }),
        ...(this.yaml === null && at.length > 0 ? { pointer: pointer(at) } : {}),
        message: at.length > 0 && this.yaml !== null ? `${pointer(at)}: ${message}` : message,
      }),
    );
  }

  /** The 1-based position of the node at `at`, or of its nearest existing parent. */
  locate(at: Path): { line: number; column: number } | null {
    if (this.yaml === null) return null;
    for (let length = at.length; length >= 0; length--) {
      const node = this.yaml.doc.getIn(at.slice(0, length), true) as YamlNode | undefined;
      const start = node?.range?.[0];
      if (start !== undefined) {
        const { line, col } = this.yaml.lines.linePos(start);
        return { line, column: col };
      }
    }
    return null;
  }

  /** The first content line of a scalar, for script line numbers. */
  contentLine(at: Path): number | null {
    if (this.yaml === null) return null;
    const node = this.yaml.doc.getIn(at, true) as YamlNode | undefined;
    if (node === undefined || !isScalar(node) || node.range === undefined || node.range === null) return null;
    const { line } = this.yaml.lines.linePos(node.range[0]);
    const block = node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED;
    return block ? line + 1 : line;
  }
}

function pointer(at: Path): string {
  let out = '';
  for (const part of at) out += typeof part === 'number' ? `[${String(part)}]` : out === '' ? part : `.${part}`;
  return out;
}

export interface ReadResult<T> {
  /** Null when the document cannot be used at all. */
  readonly document: T | null;
  readonly problems: readonly RequestProblem[];
}

/** Parses YAML text into a plain value, or reports why it is not a usable mapping. */
function readYaml(text: string, problems: () => Problems): { value: unknown; problems: Problems } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true, schema: 'core' });
  const collected = new Problems(problems().file, { doc, lines });
  for (const error of doc.errors) {
    const { line, col } = lines.linePos(error.pos[0]);
    collected.add('request-invalid', [], `the YAML does not parse: ${firstLine(error.message)}`, {
      line,
      column: col,
    });
  }
  if (doc.errors.length > 0) return { value: undefined, problems: collected };
  const value: unknown = doc.contents === null ? {} : doc.toJS({ maxAliasCount: 0 });
  if (!isMap(doc.contents) && doc.contents !== null) {
    collected.add('request-invalid', [], 'the document must be a mapping');
    return { value: undefined, problems: collected };
  }
  return { value, problems: collected };
}

function firstLine(message: string): string {
  return message.split('\n')[0] ?? message;
}

/** Reports Zod issues at their paths. */
function structural(problems: Problems, error: z.ZodError): void {
  for (const issue of error.issues) {
    const at = issue.path.filter((part): part is string | number => typeof part !== 'symbol');
    problems.add('request-invalid', at, describeIssue(issue));
  }
}

function describeIssue(issue: z.core.$ZodIssue): string {
  if (issue.code === 'unrecognized_keys')
    return `unknown key${issue.keys.length === 1 ? '' : 's'} ${issue.keys.join(', ')}`;
  if (issue.code === 'invalid_union' && issue.path.at(-1) === 'body') {
    return `body needs a type of ${BODY_TYPES.join(', ')} and that type's members`;
  }
  return issue.message;
}

/** `<name>.request.yaml` text. */
export function readRequestText(text: string, file: string, context: ValidationContext): ReadResult<RequestDocument> {
  const { value, problems } = readYaml(text, () => new Problems(file, null));
  if (value === undefined) return { document: null, problems: problems.list };
  return checkRequest(value, problems, context);
}

/** A request document sent as JSON. */
export function validateRequestValue(
  value: unknown,
  file: string,
  context: ValidationContext,
): ReadResult<RequestDocument> {
  return checkRequest(value, new Problems(file, null), context);
}

function checkRequest(value: unknown, problems: Problems, context: ValidationContext): ReadResult<RequestDocument> {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    structural(problems, parsed.error);
    return { document: null, problems: problems.list };
  }
  const document = stripUndefined(parsed.data) as RequestDocument;
  if (!METHOD_PATTERN.test(document.method)) {
    problems.add('request-invalid', ['method'], `"${document.method}" is not an HTTP method in upper case`);
  } else if (REFUSED_METHODS.has(document.method)) {
    problems.add('request-invalid', ['method'], `${document.method} requests cannot be sent by the runner`);
  }
  checkTemplate(problems, context, ['url'], document.url);
  checkPathParams(problems, context, document);
  checkHeaders(problems, context, ['headers'], document.headers);
  if (document.body !== undefined) checkBody(problems, context, document.body);
  checkVars(problems, context, ['vars'], document.vars);
  checkExtract(problems, context, document.extract);
  checkScripts(problems, context, document.scripts);
  if (document.route !== undefined) {
    const problem = routeProblem(document.route);
    if (problem !== null) problems.add('request-invalid', ['route'], problem);
  }
  return { document, problems: problems.list };
}

/** Why a request's `route` is not a capture route template, or null. */
export function routeProblem(route: string): string | null {
  const registration = runnerRegistration({ method: 'GET', path: route, upstream: 'http://route.invalid' });
  return typeof registration === 'string' ? registration : null;
}

/** `folder.yaml` text. */
export function readFolderText(
  text: string,
  file: string,
  context: ValidationContext,
  collection: boolean,
): ReadResult<FolderDocument> {
  const { value, problems } = readYaml(text, () => new Problems(file, null));
  if (value === undefined) return { document: null, problems: problems.list };
  return checkFolder(value, problems, context, collection);
}

export function validateFolderValue(
  value: unknown,
  file: string,
  context: ValidationContext,
  collection: boolean,
): ReadResult<FolderDocument> {
  return checkFolder(value, new Problems(file, null), context, collection);
}

function checkFolder(
  value: unknown,
  problems: Problems,
  context: ValidationContext,
  collection: boolean,
): ReadResult<FolderDocument> {
  const parsed = folderSchema.safeParse(value ?? {});
  if (!parsed.success) {
    structural(problems, parsed.error);
    return { document: null, problems: problems.list };
  }
  const document = stripUndefined(parsed.data) as FolderDocument;
  if (!collection && document.cookies !== undefined) {
    problems.add('request-invalid', ['cookies'], 'cookies can only be set in a collection’s folder.yaml');
  }
  // A name only; an environment that does not exist yet is a tree warning, not a problem.
  if (document.environment !== undefined) {
    if (!collection) {
      problems.add('request-invalid', ['environment'], 'environment can only be set in a collection’s folder.yaml');
    } else if (!isRunnerName(document.environment)) {
      problems.add(
        'request-invalid',
        ['environment'],
        `"${document.environment}" is not an environment name: lowercase letters and digits in words joined by "-", at most 64 bytes`,
      );
    }
  }
  if (document.stripPrefix !== undefined && !/^\/[^?#]*[^/?#]$/.test(document.stripPrefix)) {
    problems.add(
      'request-invalid',
      ['stripPrefix'],
      'stripPrefix is a path that starts with "/" and does not end with "/"',
    );
  }
  checkHeaders(problems, context, ['headers'], document.headers);
  checkVars(problems, context, ['vars'], document.vars);
  checkScripts(problems, context, document.scripts);
  return { document, problems: problems.list };
}

/** An environment or its `.local.yaml`. */
export function readEnvironmentText(text: string, file: string, local: boolean): ReadResult<EnvironmentDocument> {
  const { value, problems } = readYaml(text, () => new Problems(file, null));
  if (value === undefined) return { document: null, problems: problems.list };
  return checkEnvironment(value, problems, local);
}

export function validateEnvironmentValue(
  value: unknown,
  file: string,
  local: boolean,
): ReadResult<EnvironmentDocument> {
  return checkEnvironment(value, new Problems(file, null), local);
}

function checkEnvironment(value: unknown, problems: Problems, local: boolean): ReadResult<EnvironmentDocument> {
  if (local && typeof value === 'object' && value !== null && Object.hasOwn(value, 'disabled')) {
    problems.add(
      'request-invalid',
      ['disabled'],
      'disabled belongs in the environment’s main file, not its .local.yaml',
    );
    const { disabled: _disabled, ...rest } = value as Record<string, unknown>;
    value = rest;
  }
  const parsed = (local ? localEnvironmentSchema : environmentSchema).safeParse(value ?? {});
  if (!parsed.success) {
    structural(problems, parsed.error);
    return { document: null, problems: problems.list };
  }
  const document = stripUndefined(parsed.data) as EnvironmentDocument;
  for (const name of Object.keys(document.vars ?? {})) {
    if (!isVariableName(name)) problems.add('request-invalid', ['vars', name], variableNameMessage(name));
  }
  // A disabled name no file defines is ignored, since it may live in someone's `.local.yaml`.
  for (const [index, name] of (document.disabled ?? []).entries()) {
    if (!isVariableName(name)) problems.add('request-invalid', ['disabled', index], variableNameMessage(name));
  }
  return { document, problems: problems.list };
}

function variableNameMessage(name: string): string {
  return `"${name}" is not a variable name: a letter or "_" followed by letters, digits, "_", "." or "-", at most 128 bytes`;
}

function checkTemplate(
  problems: Problems,
  context: ValidationContext,
  at: Path,
  value: string,
  code: RequestProblemCode = 'request-invalid-template',
  exchange = false,
): void {
  for (const problem of parseTemplate(value, { grammar: context.grammar, exchange }).problems) {
    problems.add(code, at, problem.message);
  }
}

function checkHeaders(
  problems: Problems,
  context: ValidationContext,
  at: Path,
  headers: readonly NameValue[] | undefined,
): void {
  for (const [index, header] of (headers ?? []).entries()) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header.name)) {
      problems.add('request-invalid', [...at, index, 'name'], `"${header.name}" is not a header name`);
    }
    checkTemplate(problems, context, [...at, index, 'value'], header.value);
  }
}

function checkVars(
  problems: Problems,
  context: ValidationContext,
  at: Path,
  vars: Readonly<Record<string, string>> | undefined,
): void {
  for (const [name, value] of Object.entries(vars ?? {})) {
    if (!isVariableName(name)) problems.add('request-invalid', [...at, name], variableNameMessage(name));
    checkTemplate(problems, context, [...at, name], value);
  }
}

function checkBody(problems: Problems, context: ValidationContext, value: RequestBody): void {
  switch (value.type) {
    case 'json':
    case 'text':
    case 'xml':
      checkTemplate(problems, context, ['body', 'text'], value.text);
      return;
    case 'form':
      for (const [index, field] of value.fields.entries()) {
        checkTemplate(problems, context, ['body', 'fields', index, 'value'], field.value);
      }
      return;
    case 'multipart':
      for (const [index, part] of value.parts.entries()) {
        if ('value' in part) checkTemplate(problems, context, ['body', 'parts', index, 'value'], part.value);
        else checkFilePath(problems, ['body', 'parts', index, 'file'], part.file);
      }
      return;
    case 'file':
      checkFilePath(problems, ['body', 'file'], value.file);
      return;
    case 'graphql':
      checkTemplate(problems, context, ['body', 'query'], value.query);
      if (value.variables !== undefined) checkTemplate(problems, context, ['body', 'variables'], value.variables);
      return;
  }
}

function checkFilePath(problems: Problems, at: Path, file: string): void {
  if (file.startsWith('/') || file.includes('\\') || file.includes('\0') || /^[A-Za-z]:/.test(file)) {
    problems.add('request-invalid', at, 'file paths are relative to the request file, with "/" separators');
  }
}

/** The `:name` segments of a URL template's path. */
export function pathParameterNames(url: string): readonly string[] {
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? '';
  const afterScheme = withoutQuery.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, '');
  const names: string[] = [];
  for (const part of afterScheme.split('/')) {
    const match = /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(part);
    if (match?.[1] !== undefined && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

function checkPathParams(problems: Problems, context: ValidationContext, document: RequestDocument): void {
  const named = pathParameterNames(document.url);
  const given = document.pathParams ?? {};
  for (const name of named) {
    if (!Object.hasOwn(given, name)) {
      problems.add('request-invalid-path-params', ['url'], `the URL has :${name} but pathParams has no ${name}`);
    }
  }
  for (const [name, value] of Object.entries(given)) {
    if (!named.includes(name)) {
      problems.add(
        'request-invalid-path-params',
        ['pathParams', name],
        `pathParams has ${name} but the URL has no :${name} segment`,
      );
    }
    checkTemplate(problems, context, ['pathParams', name], value);
  }
}

function checkExtract(
  problems: Problems,
  context: ValidationContext,
  extract: Readonly<Record<string, ExtractEntry>> | undefined,
): void {
  for (const [name, entry] of Object.entries(extract ?? {})) {
    if (!isVariableName(name)) problems.add('request-invalid-extract', ['extract', name], variableNameMessage(name));
    const value = typeof entry === 'string' ? entry : entry.value;
    const at: Path = typeof entry === 'string' ? ['extract', name] : ['extract', name, 'value'];
    checkTemplate(problems, context, at, value, 'request-invalid-extract', true);
    if (typeof entry !== 'string' && entry.match !== undefined) {
      try {
        new RegExp(entry.match, 'u');
      } catch (error) {
        problems.add(
          'request-invalid-extract',
          ['extract', name, 'match'],
          `match is not a regular expression: ${error instanceof Error ? error.message : 'invalid'}`,
        );
      }
    }
  }
}

function checkScripts(problems: Problems, context: ValidationContext, value: Scripts | undefined): void {
  if (context.checkScript === undefined) return;
  for (const phase of ['before', 'after'] as const) {
    const source = value?.[phase];
    if (source === undefined) continue;
    const problem = context.checkScript(source);
    if (problem === null) continue;
    const first = problems.contentLine(['scripts', phase]);
    problems.add(
      'request-invalid-script',
      ['scripts', phase],
      `the ${phase} script does not compile: ${problem.message} (script line ${String(problem.line)})`,
      first === null ? undefined : { line: first + problem.line - 1, column: problem.column },
    );
  }
}

/** Zod keeps optional keys a document never had as `undefined`; the documents leave them out. */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = stripUndefined(item);
    return out as T;
  }
  return value;
}
