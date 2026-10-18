import type { RequestDetail, RequestDocument } from '../../atlas/runner.js';

/**
 * Template helpers for the editor: where `{{name}}` variables
 * are in a text, and which scope a name's value would come from.
 */

export type TemplatePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'variable'; readonly text: string; readonly name: string }
  | { readonly kind: 'token'; readonly text: string };

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Splits a template into text, `{{name}}` variables and `{{$…}}` tokens; malformed braces stay text. */
export function templateParts(text: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let at = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const inner = (match[1] ?? '').trim();
    const kind = inner.startsWith('$') ? 'token' : VARIABLE.test(inner) ? 'variable' : null;
    if (kind === null) continue;
    if (match.index > at) parts.push({ kind: 'text', text: text.slice(at, match.index) });
    parts.push(kind === 'variable' ? { kind, text: match[0], name: inner } : { kind, text: match[0] });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push({ kind: 'text', text: text.slice(at) });
  return parts;
}

export function variableNames(text: string): string[] {
  return templateParts(text).flatMap((part) => (part.kind === 'variable' ? [part.name] : []));
}

/** Where a variable's value comes from, or that nothing defines it. */
export type Resolution =
  { readonly defined: true; readonly value: string; readonly scope: string } | { readonly defined: false };

export interface Scopes {
  /** Run variables carried in this tab. */
  readonly run: Readonly<Record<string, unknown>>;
  readonly request: Readonly<Record<string, string>>;
  /** The selected environment's values, `.local.yaml` merged; null when none is selected. */
  readonly environment: { readonly name: string; readonly vars: Readonly<Record<string, string>> } | null;
  /** Nearest folder first, out to the collection. */
  readonly folders: readonly { readonly name: string; readonly vars: Readonly<Record<string, string>> }[];
  /** Names `extract` sets in this request: defined once it runs. */
  readonly extracted: readonly string[];
}

export function scopesFor(
  detail: RequestDetail | undefined,
  draft: RequestDocument,
  environment: string | null,
  run: Readonly<Record<string, unknown>>,
): Scopes {
  const env = detail?.environments.find((entry) => entry.id === environment) ?? null;
  return {
    run,
    request: draft.vars ?? {},
    environment: env === null ? null : { name: env.name, vars: env.vars },
    folders: [...(detail?.folders ?? [])]
      .reverse()
      .map((folder) => ({ name: folder.name, vars: folder.document.vars ?? {} })),
    extracted: Object.keys(draft.extract ?? {}),
  };
}

export function resolve(name: string, scopes: Scopes): Resolution {
  if (Object.hasOwn(scopes.run, name) && scopes.run[name] !== null) {
    return { defined: true, value: display(scopes.run[name]), scope: 'run variable' };
  }
  const request = scopes.request[name];
  if (request !== undefined) return { defined: true, value: request, scope: 'request variable' };
  const environment = scopes.environment?.vars[name];
  if (environment !== undefined && scopes.environment !== null) {
    return { defined: true, value: environment, scope: `environment ${scopes.environment.name}` };
  }
  for (const folder of scopes.folders) {
    const value = folder.vars[name];
    if (value !== undefined) return { defined: true, value, scope: `folder ${folder.name}` };
  }
  return { defined: false };
}

/** A variable's value as text: strings as they are, everything else as compact JSON. */
export function display(value: unknown): string {
  if (typeof value === 'string') return value;
  const text = JSON.stringify(value) as string | undefined;
  return text ?? '';
}

/** The `:name` segments of a URL's path. */
export function pathParamNames(url: string): string[] {
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? '';
  const afterOrigin = withoutQuery.replace(/^[a-z]+:\/\/[^/]*/i, '');
  const names: string[] = [];
  for (const segment of afterOrigin.split('/')) {
    const match = /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(segment);
    if (match?.[1] !== undefined && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/** A name for a new file from what the person typed: "Create cart" → `create-cart`. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

/** The next ordered file name among siblings: `030-name` after `020-…`. */
export function nextOrdered(siblings: readonly string[], name: string): string {
  let highest = 0;
  for (const id of siblings) {
    const leaf = id.slice(id.lastIndexOf('/') + 1);
    const number = /^(\d+)-/.exec(leaf)?.[1];
    if (number !== undefined) highest = Math.max(highest, Number(number));
  }
  const width = Math.max(3, String(highest + 10).length);
  return `${String(highest + 10).padStart(width, '0')}-${name === '' ? 'request' : name}`;
}

/** A variable name for a saved value: the last key of a path or a header name, in camelCase. */
export function variableNameFor(source: string): string {
  const last =
    source
      .split(/[.[\]$]+/)
      .filter((part) => part !== '' && !/^\d+$/.test(part))
      .at(-1) ?? 'value';
  const words = last.split(/[^A-Za-z0-9]+/).filter((word) => word !== '');
  const name = words
    .map((word, index) =>
      index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join('');
  return /^[A-Za-z_]/.test(name) ? name : `v${name}`;
}

/** A JSONPath for a key below `parent`, in the dotted form where the key allows it. */
export function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${String(key)}]`;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

export function parentOf(id: string): string {
  const at = id.lastIndexOf('/');
  return at === -1 ? '' : id.slice(0, at);
}

export function leafOf(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

/** `record` with `key` set to `value`, or without `key` when the value is empty (so files stay minimal). */
export function withEntry<T extends object>(record: T, key: string, value: unknown): T {
  const empty =
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0);
  const rest = Object.entries(record).filter(([name]) => name !== key);
  return Object.fromEntries(empty ? rest : [...rest, [key, value]]) as T;
}
