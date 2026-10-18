import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  visit,
  type Document,
  type Node as YamlNode,
} from 'yaml';

import { expandAliases } from '../dynamic/grammar.js';
import { compileRegistrations, type RecordingEndpoint } from '../recording/registrations.js';
import { sortStartupProblems } from '../errors/startup.js';
import { suggest } from '../suggest.js';
import type { StartupError, StartupErrorCode, StartupWarning } from '../types/index.js';
import {
  CONFIG_DEFAULTS,
  configFileSchema,
  KNOWN_KEYS,
  SECTIONS,
  SETTING_KEYS,
  SETTINGS,
  type ConfigFile,
  type SettingKey,
} from './schema.js';

export interface ParseConfigInput {
  /** YAML text; empty string for "no file". */
  readonly text: string;
  /** Display name used in error locations, e.g. "janus.config.yaml". Never an absolute path over HTTP. */
  readonly sourceName: string;
}

/** 1-based line and column of a setting's value in the file. */
export interface ConfigLocation {
  readonly line: number;
  readonly column: number;
}

export type ConfigLocations = Readonly<Partial<Record<SettingKey, ConfigLocation>>>;

export type ParseConfigResult =
  | {
      readonly ok: true;
      readonly config: ConfigFile;
      readonly warnings: readonly StartupWarning[];
      /** Where each setting the file sets is written, for `mergeConfig` and reports. */
      readonly locations: ConfigLocations;
    }
  | {
      readonly ok: false;
      readonly errors: readonly StartupError[];
      /** The settings that did validate, so the server can still find the fixture root. */
      readonly partial: ConfigFile;
      readonly locations: ConfigLocations;
    };

/** Tags the YAML 1.2 core schema defines; any other tag is a custom tag, which is an error. */
const CORE_TAGS = new Set(
  ['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map((name) => `tag:yaml.org,2002:${name}`).concat('!'),
);
/** Plain YAML integers: decimal, octal, or hexadecimal, never a float such as `4010.0`. */
const INTEGER_LITERAL = /^[-+]?(?:[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/;
const TOKEN_LIMIT = 64;

interface Entry {
  readonly path: readonly string[];
  readonly key: YamlNode;
  readonly value: YamlNode | null;
}

/**
 * Turns configuration text into a validated `ConfigFile`, or every located
 * problem it contains. Pure: no file or environment access.
 */
export function parseConfig(input: ParseConfigInput): ParseConfigResult {
  const { text, sourceName } = input;
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true, schema: 'core' });
  const errors: StartupError[] = [];

  const at = (offset: number): ConfigLocation => {
    const { line, col } = lines.linePos(offset);
    return { line, column: col };
  };
  const report = (
    code: StartupErrorCode,
    message: string,
    offset: number | undefined,
    extra: { token?: string | undefined; key?: string | undefined } = {},
  ): void => {
    errors.push(
      Object.freeze({
        code,
        source: 'config' as const,
        path: sourceName,
        ...(offset === undefined ? {} : at(offset)),
        ...(extra.token === undefined ? {} : { token: extra.token }),
        ...(extra.key === undefined ? {} : { key: extra.key }),
        message,
      }),
    );
  };

  const entries = collectEntries(doc);
  const tokenOf = (node: YamlNode | null | undefined): string | undefined => {
    const range = node?.range;
    if (range === undefined || range === null || !(isScalar(node) || isAlias(node))) return undefined;
    const source = text.slice(range[0], range[1]);
    return source.length <= TOKEN_LIMIT && !source.includes('\n') ? source : undefined;
  };

  // 1. YAML syntax. A syntax error makes the rest of the document unreliable;
  // a duplicated or custom-tagged value is only unusable itself.
  let fatal = false;
  const blocked = new Set<string>();
  for (const error of doc.errors) {
    const [start, end] = error.pos;
    if (error.code === 'DUPLICATE_KEY') {
      const entry = entries.find((candidate) => candidate.key.range?.[0] === start);
      const name = entry?.path.at(-1) ?? text.slice(start, end);
      if (entry !== undefined) blocked.add(entry.path.join('.'));
      report('config-duplicate-key', `duplicate key "${name}"; each key may appear only once per mapping`, start, {
        token: name,
        key: entry?.path.join('.'),
      });
      continue;
    }
    fatal = true;
    const token = text.slice(start, end);
    report('config-invalid-yaml', `invalid YAML: ${sentence(error.message)}`, start, {
      token: token.length > 0 && token.length <= TOKEN_LIMIT && !token.includes('\n') ? token : undefined,
    });
  }

  // 2. Custom tags (`!env`, `!!js/function`) are never resolved.
  visit(doc, {
    Node(_key, node) {
      if (node.tag === undefined || CORE_TAGS.has(node.tag)) return;
      const entry = entries.find((candidate) => candidate.value === node || candidate.key === node);
      if (entry === undefined) fatal = true;
      else blocked.add(entry.path.join('.'));
      const tag = node.tag.startsWith('tag:yaml.org,2002:') ? `!!${node.tag.slice(18)}` : node.tag;
      // Point at the tag itself, which precedes the node's own range.
      const start = node.range?.[0];
      const written = start === undefined ? -1 : text.lastIndexOf(tag, start);
      report('config-invalid-yaml', `custom tag "${tag}" is not allowed`, written === -1 ? start : written, {
        token: tag,
      });
    },
  });

  // 3. The document must be a mapping, or empty.
  const contents = doc.contents;
  const empty = contents === null || (isScalar(contents) && contents.value === null);
  if (!empty && !isMap(contents)) {
    fatal = true;
    report(
      'config-invalid-yaml',
      `the configuration must be a mapping of settings, not ${isSeq(contents) ? 'a list' : 'a single value'}`,
      contents.range[0],
    );
  }

  const locations: Partial<Record<SettingKey, ConfigLocation>> = {};
  if (fatal) return failure(errors, {}, locations);

  let raw: unknown = {};
  if (!empty) {
    try {
      raw = doc.toJS({ maxAliasCount: 100 });
    } catch (error) {
      // An alias that expands too far (a "billion laughs" document) has no better location than the start.
      report(
        'config-invalid-yaml',
        `invalid YAML: ${sentence(error instanceof Error ? error.message : String(error))}`,
        0,
      );
      return failure(errors, {}, locations);
    }
  }
  const entryAt = (path: readonly (string | number | symbol)[]): Entry | undefined =>
    entries.find((entry) => sameKeyPath(entry.path, path));

  // 4. Schema: unknown keys and invalid values, each located at its key or value.
  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      // An unknown key inside a list item (a registration) makes the item invalid.
      if (issue.code === 'unrecognized_keys' && !issue.path.some((part) => typeof part === 'number')) {
        const parent = issue.path.map(String);
        for (const name of issue.keys) {
          const entry = entryAt([...parent, name]);
          const where = parent.length === 0 ? '' : ` under "${parent.join('.')}"`;
          const suggestion = suggest(name, KNOWN_KEYS[parent.join('.')] ?? []);
          report(
            'config-unknown-key',
            `unknown key "${name}"${where}${suggestion === null ? '' : `; did you mean "${suggestion}"?`}`,
            entry?.key.range?.[0],
            { token: name, key: [...parent, name].join('.') },
          );
        }
        continue;
      }
      const issueKey = issue.path.map(String).join('.');
      const unknown = issue.code === 'unrecognized_keys' ? issue.keys : [];
      // A list item's issue is reported at its setting, quoting the item.
      const key = SETTING_KEYS.find((setting) => issueKey.startsWith(`${setting}.`)) ?? issueKey;
      const entry = entryAt(key.split('.'));
      const node = entry?.value ?? entry?.key;
      const value = valueAt(raw, issue.path);
      // A zone that is not an IANA zone has its own code.
      const code =
        key === 'dynamic.timezone' && typeof value === 'string' ? 'unknown-timezone' : 'config-invalid-value';
      const message =
        unknown.length > 0
          ? `expected ${SETTINGS[key as SettingKey].expected}, got an entry with the unknown key "${unknown[0] ?? ''}"`
          : invalidValueMessage(key, value);
      report(code, message, node?.range?.[0], {
        token: tokenOf(entry?.value),
        key,
      });
    }
  }

  // 5. Integers must be written as integers, and record where each setting is.
  const partial: Record<string, Record<string, unknown>> = {};
  for (const key of SETTING_KEYS) {
    const path = key.split('.');
    const entry = entryAt(path);
    if (entry === undefined) continue;
    const valueNode = entry.value ?? entry.key;
    if (valueNode.range) locations[key] = at(valueNode.range[0]);
    const value = valueAt(raw, path);
    const spec = SETTINGS[key];
    if (!spec.schema.safeParse(value).success || isBlocked(path, blocked)) continue;
    if (spec.integer === true && typeof value === 'number') {
      const literal = tokenOf(resolveAlias(doc, entry.value));
      if (literal === undefined || !INTEGER_LITERAL.test(literal)) {
        report(
          'config-invalid-value',
          `expected ${spec.expected}, got ${literal ?? 'a value that is not a plain integer'}`,
          valueNode.range?.[0],
          {
            token: literal,
            key,
          },
        );
        continue;
      }
    }
    setPath(partial, path, value);
  }

  // 6. Custom aliases must expand to clock values without cycles or shadowing.
  const aliases = partial['dynamic']?.['aliases'];
  if (typeof aliases === 'object' && aliases !== null) {
    for (const problem of expandAliases(aliases as Record<string, string>).problems) {
      const entry = entryAt(['dynamic', 'aliases', problem.name]);
      report('invalid-alias', problem.message, entry?.key.range?.[0], { token: problem.name, key: 'dynamic.aliases' });
    }
  }

  // 7. Registrations must be valid templates and upstreams, and must not overlap.
  const endpoints = partial['recording']?.['endpoints'];
  if (Array.isArray(endpoints)) {
    const list = entryAt(['recording', 'endpoints'])?.value ?? null;
    const resolved = resolveAlias(doc, list);
    for (const problem of compileRegistrations(endpoints as RecordingEndpoint[]).problems) {
      const item = isSeq(resolved) ? (resolved.items[problem.index] as YamlNode | undefined) : undefined;
      report(problem.code, problem.message, item?.range?.[0] ?? list?.range?.[0], { key: 'recording.endpoints' });
    }
  }

  // 8. Settings checked against each other, located at the setting the file names.
  const limits = partial['limits'];
  const decoded = limits?.['maxDecodedBodyBytes'] ?? CONFIG_DEFAULTS.limits.maxDecodedBodyBytes;
  const received = limits?.['maxBodyBytes'] ?? CONFIG_DEFAULTS.limits.maxBodyBytes;
  if (typeof decoded === 'number' && typeof received === 'number' && decoded < received) {
    const key: SettingKey =
      limits?.['maxDecodedBodyBytes'] === undefined ? 'limits.maxBodyBytes' : 'limits.maxDecodedBodyBytes';
    const entry = entryAt(key.split('.'));
    report(
      'config-invalid-value',
      `limits.maxDecodedBodyBytes (${String(decoded)}) must be at least limits.maxBodyBytes (${String(received)})`,
      (entry?.value ?? entry?.key)?.range?.[0],
      { token: tokenOf(entry?.value), key },
    );
  }
  const fixtureCors = (partial['cors'] as Record<string, Record<string, unknown> | undefined> | undefined)?.[
    'fixtures'
  ];
  const fixtureOrigins = fixtureCors?.['origins'];
  if (fixtureCors?.['credentials'] === true && Array.isArray(fixtureOrigins) && fixtureOrigins.includes('*')) {
    const entry = entryAt(['cors', 'fixtures', 'credentials']);
    report(
      'config-invalid-value',
      'cors.fixtures.credentials cannot be true with cors.fixtures.origins ["*"]: browsers refuse a wildcard origin with credentials',
      (entry?.value ?? entry?.key)?.range?.[0],
      { token: tokenOf(entry?.value), key: 'cors.fixtures.credentials' },
    );
  }

  if (errors.length > 0) return failure(errors, partial, locations);
  const config: ConfigFile = parsed.success ? (parsed.data as ConfigFile) : {};
  return { ok: true, config: deepFreeze(config), warnings: Object.freeze([]), locations: Object.freeze(locations) };
}

function failure(errors: readonly StartupError[], partial: ConfigFile, locations: ConfigLocations): ParseConfigResult {
  return {
    ok: false,
    errors: sortStartupProblems(errors),
    partial: deepFreeze(partial),
    locations: Object.freeze(locations),
  };
}

/** Every mapping entry in the document with its key path, including nested mappings. */
function collectEntries(doc: Document): Entry[] {
  const out: Entry[] = [];
  const walk = (node: unknown, path: readonly string[]): void => {
    if (isAlias(node)) {
      walk(node.resolve(doc), path);
      return;
    }
    if (!isMap(node)) return;
    for (const pair of node.items) {
      const keyNode = pair.key as YamlNode | null;
      if (keyNode === null || !isScalar(keyNode)) continue;
      const entryPath = [...path, String(keyNode.value)];
      const value = (pair.value ?? null) as YamlNode | null;
      out.push({ path: entryPath, key: keyNode, value });
      // Settings are at most three levels deep; the bound also stops alias cycles.
      if (path.length < 4) walk(value, entryPath);
    }
  };
  walk(doc.contents, []);
  return out;
}

function resolveAlias(doc: Document, node: YamlNode | null): YamlNode | null {
  return isAlias(node) ? ((node.resolve(doc) as YamlNode | undefined) ?? null) : node;
}

function sameKeyPath(a: readonly string[], b: readonly (string | number | symbol)[]): boolean {
  return a.length === b.length && a.every((part, index) => part === String(b[index]));
}

function valueAt(root: unknown, path: readonly (string | number | symbol)[]): unknown {
  let value = root;
  for (const part of path) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[String(part)];
  }
  return value;
}

function setPath(root: Record<string, Record<string, unknown>>, path: readonly string[], value: unknown): void {
  let node: Record<string, unknown> = root;
  for (const part of path.slice(0, -1)) {
    const child = node[part];
    node = typeof child === 'object' && child !== null ? (child as Record<string, unknown>) : (node[part] = {});
  }
  const last = path.at(-1);
  if (last !== undefined) node[last] = value;
}

/** A setting is unusable when it, or the section holding it, is duplicated or custom-tagged. */
function isBlocked(path: readonly string[], blocked: ReadonlySet<string>): boolean {
  return path.some((_part, index) => blocked.has(path.slice(0, index + 1).join('.')));
}

function invalidValueMessage(key: string, value: unknown): string {
  const expected =
    (SETTINGS as Readonly<Record<string, { expected: string } | undefined>>)[key]?.expected ??
    SECTIONS[key] ??
    (key === '$schema' ? 'a string' : 'a valid value');
  const hint =
    typeof value === 'string' &&
    /^\s*\d/.test(value) &&
    (SETTINGS as Record<string, { integer?: boolean }>)[key]?.integer === true
      ? '; size suffixes are not supported, write the number of bytes'
      : '';
  return `expected ${expected}, got ${describeValue(value)}${hint}`;
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  const shown = JSON.stringify(value);
  return shown.length > TOKEN_LIMIT ? `${shown.slice(0, TOKEN_LIMIT)}…` : shown;
}

/** "Tabs are not allowed as indentation." → "tabs are not allowed as indentation". */
function sentence(message: string): string {
  const first = message.split('\n')[0] ?? message;
  return (first.charAt(0).toLowerCase() + first.slice(1)).replace(/[.:]\s*$/, '');
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
