/**
 * The request file model: request, folder and environment
 * documents as they are written in YAML, and the loaded request tree.
 */

/** A header, form field or similar name–value row; `disabled` keeps it in the file without sending it. */
export interface NameValue {
  readonly name: string;
  /** A template. */
  readonly value: string;
  readonly disabled?: boolean;
}

/** One part of a `multipart` body: a text value or a file. */
export type MultipartPart =
  | { readonly name: string; readonly value: string; readonly disabled?: boolean }
  | { readonly name: string; readonly file: string; readonly contentType?: string; readonly disabled?: boolean };

/** A request body. */
export type RequestBody =
  | { readonly type: 'json' | 'text' | 'xml'; readonly text: string }
  | { readonly type: 'form'; readonly fields: readonly NameValue[] }
  | { readonly type: 'multipart'; readonly parts: readonly MultipartPart[] }
  | { readonly type: 'file'; readonly file: string; readonly contentType?: string }
  | { readonly type: 'graphql'; readonly query: string; readonly variables?: string };

export type BodyType = RequestBody['type'];

export const BODY_TYPES: readonly BodyType[] = Object.freeze([
  'json',
  'text',
  'xml',
  'form',
  'multipart',
  'file',
  'graphql',
]);

/** An `extract` entry: a template, or the long form. */
export type ExtractEntry =
  | string
  | {
      readonly value: string;
      readonly match?: string;
      readonly optional?: boolean;
      /** Any JSON value; implies `optional`. */
      readonly default?: unknown;
    };

export interface Scripts {
  readonly before?: string;
  readonly after?: string;
}

/** Where an imported request came from; informational only. */
export interface RequestSource {
  readonly format: string;
  readonly file: string;
  readonly item: string;
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
  readonly source?: RequestSource;
}

/** `folder.yaml`; `cookies` and `environment` only at a collection. */
export interface FolderDocument {
  readonly name?: string;
  readonly vars?: Readonly<Record<string, string>>;
  readonly headers?: readonly NameValue[];
  readonly scripts?: Scripts;
  readonly stripPrefix?: string;
  readonly cookies?: boolean;
  /** The collection's preferred environment: the UI picks it; runs ignore it. */
  readonly environment?: string;
  readonly docs?: string;
}

/**
 * `environments/<name>.yaml` directly under `runner.root`, or its
 * `.local.yaml`. Values are plain strings. `disabled` is only
 * allowed in the main file.
 */
export interface EnvironmentDocument {
  readonly name?: string;
  readonly vars?: Readonly<Record<string, string>>;
  /** Variables, from either file, kept but not used when resolving. */
  readonly disabled?: readonly string[];
  /**
   * The default environment: the UI picks it until another is
   * picked or a collection prefers one; runs ignore it. Only in the main file.
   */
  readonly default?: boolean;
}

/** Collection, folder, request and environment names in paths. */
export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_NAME_BYTES = 64;
/** Folders nest at most this deep below a collection. */
export const MAX_FOLDER_DEPTH = 8;

export const REQUEST_SUFFIX = '.request.yaml';
export const FOLDER_FILE = 'folder.yaml';
/** The shared environments directory directly under `runner.root`; never a collection. */
export const ENVIRONMENTS_DIRECTORY = 'environments';
export const LOCAL_SUFFIX = '.local.yaml';

/** True for a valid path name. */
export function isRunnerName(name: string): boolean {
  return name.length <= MAX_NAME_BYTES && NAME_PATTERN.test(name);
}

/** True for a request, folder or collection ID: names joined by "/", within the depth limit. */
export function isRunnerId(id: string): boolean {
  const parts = id.split('/');
  return parts.length >= 1 && parts.length <= MAX_FOLDER_DEPTH + 2 && parts.every(isRunnerName);
}

/** A variable name. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
export const MAX_VARIABLE_BYTES = 128;

export function isVariableName(name: string): boolean {
  return name.length <= MAX_VARIABLE_BYTES && VARIABLE_NAME.test(name);
}

/** Methods a request may not use. */
export const REFUSED_METHODS: ReadonlySet<string> = new Set(['CONNECT', 'TRACE']);

/** An HTTP method token in upper case. */
export const METHOD_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Z]+$/;
