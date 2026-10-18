import { isMap, isScalar, isSeq, LineCounter, parseDocument, visit, type Node as YamlNode } from 'yaml';

import { utf8DecodeStrict } from '../bytes.js';
import type { TextPosition } from './json.js';
import { readLatency, type LatencyProfile } from './latency.js';

/** The optional file that declares a scenario's parent and difference. */
export const FLOW_FILE_NAME = 'flow.yaml';

/** A scenario name: lowercase words of letters and digits joined by single hyphens. */
export const SCENARIO_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SCENARIO_NAME_BYTES = 64;

/** True for a valid scenario name of at most 64 bytes. */
export function isScenarioName(name: string): boolean {
  return SCENARIO_NAME.test(name) && name.length <= MAX_SCENARIO_NAME_BYTES;
}

const ID_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_DESCRIPTION = 1000;
const MAX_ID_VALUE = 256;
const KEYS = ['description', 'extends', 'ids', 'latency', 'overrides', 'removes'] as const;
const TOKEN_LIMIT = 64;

/** One `overrides` or `removes` entry, with where it is written. */
export interface FlowReference {
  readonly value: string;
  readonly position: TextPosition | undefined;
}

/** A parsed `flow.yaml`. Every list keeps file order. */
export interface Flow {
  readonly description: string | null;
  /** The parent named by `extends`, or null when the file has none. */
  readonly extends: string | null;
  readonly extendsPosition: TextPosition | undefined;
  readonly ids: readonly { readonly name: string; readonly value: string }[];
  readonly overrides: readonly FlowReference[];
  readonly removes: readonly FlowReference[];
  /** Null inherits the parent's. */
  readonly latency: LatencyProfile | null;
}

export interface FlowProblem {
  /** `duplicate-scenario-reference` for a repeated list entry; every other problem is `invalid-flow`. */
  readonly code: 'invalid-flow' | 'duplicate-scenario-reference';
  readonly message: string;
  readonly position?: TextPosition;
  readonly token?: string;
}

export type FlowResult =
  { readonly ok: true; readonly flow: Flow } | { readonly ok: false; readonly problems: readonly FlowProblem[] };

/** The flow of a scenario without `flow.yaml`. */
export const EMPTY_FLOW: Flow = Object.freeze({
  description: null,
  extends: null,
  extendsPosition: undefined,
  ids: Object.freeze([]),
  overrides: Object.freeze([]),
  removes: Object.freeze([]),
  latency: null,
});

/**
 * Parses `flow.yaml` with the YAML rules (one document, no anchors, aliases
 * or custom tags, no duplicate keys).
 * References are checked for shape here; whether they name anything is
 * checked against the parent's effective tree.
 */
export function parseFlow(bytes: Uint8Array): FlowResult {
  const text = utf8DecodeStrict(bytes);
  if (text === null) return { ok: false, problems: [{ code: 'invalid-flow', message: 'the file is not valid UTF-8' }] };
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true, schema: 'core' });
  const position = (offset: number | undefined): { position?: TextPosition } => {
    if (offset === undefined) return {};
    const { line, col } = lines.linePos(offset);
    return { position: { line, column: col } };
  };
  const at = (node: YamlNode | null | undefined): { position?: TextPosition } => position(node?.range?.[0]);
  const tokenOf = (node: YamlNode | null | undefined): { token?: string } => {
    if (!isScalar(node) || node.range === undefined || node.range === null) return {};
    const source = text.slice(node.range[0], node.range[1]);
    return source.length <= TOKEN_LIMIT && !source.includes('\n') ? { token: source } : {};
  };

  const problems: FlowProblem[] = [];
  for (const error of doc.errors) {
    const message = error.code === 'DUPLICATE_KEY' ? 'duplicate key' : 'invalid YAML';
    problems.push({
      code: 'invalid-flow',
      message: `${message}: ${firstLine(error.message)}`,
      ...position(error.pos[0]),
    });
  }
  if (problems.length > 0) return { ok: false, problems };

  visit(doc, {
    Alias(_key, node) {
      problems.push({ code: 'invalid-flow', message: 'aliases are not allowed in flow.yaml', ...at(node) });
    },
    Node(_key, node) {
      if (node.anchor !== undefined) {
        problems.push({
          code: 'invalid-flow',
          message: 'anchors are not allowed in flow.yaml',
          ...at(node),
          token: `&${node.anchor}`,
        });
      }
      if (node.tag !== undefined && !node.tag.startsWith('tag:yaml.org,2002:')) {
        problems.push({
          code: 'invalid-flow',
          message: `custom tag "${node.tag}" is not allowed`,
          ...at(node),
          token: node.tag,
        });
      }
    },
  });
  if (problems.length > 0) return { ok: false, problems };

  const root = doc.contents;
  if (root === null || (isScalar(root) && root.value === null)) return { ok: true, flow: EMPTY_FLOW };
  if (!isMap(root)) {
    return {
      ok: false,
      problems: [{ code: 'invalid-flow', message: 'flow.yaml must be a mapping of scenario settings', ...at(root) }],
    };
  }

  let description: string | null = null;
  let parent: string | null = null;
  let parentPosition: TextPosition | undefined;
  const ids: { name: string; value: string }[] = [];
  let overrides: FlowReference[] = [];
  let removes: FlowReference[] = [];
  let latency: LatencyProfile | null = null;

  for (const pair of root.items) {
    const keyNode = pair.key as YamlNode | null;
    const value = (pair.value ?? null) as YamlNode | null;
    const name = isScalar(keyNode) ? String(keyNode.value) : null;
    const scalar = isScalar(value) && typeof value.value === 'string' ? value.value : null;
    switch (name) {
      case 'description':
        if (scalar === null)
          problems.push({ code: 'invalid-flow', message: '"description" must be a string', ...at(value ?? keyNode) });
        else if (codePoints(scalar) > MAX_DESCRIPTION) {
          problems.push({
            code: 'invalid-flow',
            message: `"description" is longer than ${String(MAX_DESCRIPTION)} characters`,
            ...at(value),
          });
        } else description = scalar;
        break;
      case 'extends':
        if (scalar === null) {
          problems.push({
            code: 'invalid-flow',
            message: '"extends" must be a scenario name',
            ...at(value ?? keyNode),
            ...tokenOf(value),
          });
        } else if (!isScenarioName(scalar)) {
          problems.push({
            code: 'invalid-flow',
            message: `"extends" must be a scenario name: lowercase letters and digits in words joined by "-", at most ${String(MAX_SCENARIO_NAME_BYTES)} bytes`,
            ...at(value),
            ...tokenOf(value),
          });
        } else {
          parent = scalar;
          parentPosition = at(value).position;
        }
        break;
      case 'ids':
        if (value === null || (isScalar(value) && value.value === null)) break;
        if (!isMap(value)) {
          problems.push({
            code: 'invalid-flow',
            message: '"ids" must be a mapping of names to string values',
            ...at(value),
          });
          break;
        }
        for (const entry of value.items) {
          const idKey = entry.key as YamlNode | null;
          const idValue = (entry.value ?? null) as YamlNode | null;
          const idName = isScalar(idKey) ? String(idKey.value) : '';
          if (!ID_NAME.test(idName)) {
            problems.push({
              code: 'invalid-flow',
              message:
                '"ids" names must start with a letter and contain only letters, digits and "_", at most 64 characters',
              ...at(idKey),
              ...tokenOf(idKey),
            });
            continue;
          }
          const text = isScalar(idValue) && typeof idValue.value === 'string' ? idValue.value : null;
          if (text === null || text.length === 0 || codePoints(text) > MAX_ID_VALUE) {
            problems.push({
              code: 'invalid-flow',
              message: `"ids.${idName}" must be a string of 1 to ${String(MAX_ID_VALUE)} characters`,
              ...at(idValue ?? idKey),
            });
            continue;
          }
          ids.push({ name: idName, value: text });
        }
        break;
      case 'latency': {
        const read = readLatency(value);
        if (read.ok) latency = read.profile;
        else problems.push({ code: 'invalid-flow', message: read.message, ...at(value ?? keyNode), ...tokenOf(value) });
        break;
      }
      case 'overrides':
        overrides = references('overrides', value, 'endpoint', problems, at, tokenOf);
        break;
      case 'removes':
        removes = references('removes', value, 'file', problems, at, tokenOf);
        break;
      default:
        problems.push({
          code: 'invalid-flow',
          message: `unknown key ${name === null ? '' : `"${name}" `}in flow.yaml; expected ${KEYS.join(', ')}`,
          ...at(keyNode),
          ...tokenOf(keyNode),
        });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    flow: Object.freeze({
      description,
      extends: parent,
      extendsPosition: parentPosition,
      ids: Object.freeze(ids.map((id) => Object.freeze(id))),
      overrides: Object.freeze(overrides),
      removes: Object.freeze(removes),
      latency,
    }),
  };
}

const METHOD = /^[!#$%&'*+\-.^_`|~0-9A-Z]*[A-Z][!#$%&'*+\-.^_`|~0-9A-Z]*$/;

/**
 * Splits an endpoint key (`/v1/cart/GET`) or file key (`/v1/cart/GET/200.json`)
 * into the method directory below the scenario root and the file name.
 */
export function splitReference(
  value: string,
  kind: 'endpoint' | 'file',
): { readonly dir: string; readonly file: string | null } | null {
  if (!value.startsWith('/')) return null;
  const parts = value.slice(1).split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  if (kind === 'file') {
    const file = parts.pop();
    if (file === undefined || parts.length === 0) return null;
    if (!METHOD.test(parts[parts.length - 1] ?? '')) return null;
    return { dir: parts.join('/'), file };
  }
  if (!METHOD.test(parts[parts.length - 1] ?? '')) return null;
  return { dir: parts.join('/'), file: null };
}

function references(
  key: 'overrides' | 'removes',
  value: YamlNode | null,
  kind: 'endpoint' | 'file',
  problems: FlowProblem[],
  at: (node: YamlNode | null | undefined) => { position?: TextPosition },
  tokenOf: (node: YamlNode | null | undefined) => { token?: string },
): FlowReference[] {
  if (value === null || (isScalar(value) && value.value === null)) return [];
  const example = kind === 'endpoint' ? '/v1/cart/GET' : '/v1/cart/GET/200.json';
  if (!isSeq(value)) {
    problems.push({ code: 'invalid-flow', message: `"${key}" must be a list such as [${example}]`, ...at(value) });
    return [];
  }
  const out: FlowReference[] = [];
  const seen = new Set<string>();
  for (const item of value.items as (YamlNode | null)[]) {
    const text = isScalar(item) && typeof item.value === 'string' ? item.value : null;
    if (text === null || splitReference(text, kind) === null) {
      const what =
        kind === 'endpoint'
          ? 'an endpoint key: the directory names from the scenario root and the method, with a leading "/"'
          : 'a file key: an endpoint key followed by a response file name or accepts.yaml';
      problems.push({
        code: 'invalid-flow',
        message: `"${key}" entry must be ${what}, e.g. ${example}`,
        ...at(item),
        ...tokenOf(item),
      });
      continue;
    }
    if (seen.has(text)) {
      problems.push({
        code: 'duplicate-scenario-reference',
        message: `"${key}" lists "${text}" more than once`,
        ...at(item),
        ...tokenOf(item),
      });
      continue;
    }
    seen.add(text);
    out.push(Object.freeze({ value: text, position: at(item).position }));
  }
  return out;
}

/** Length in Unicode code points, the characters the limits count. */
function codePoints(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) index++;
    count++;
  }
  return count;
}

function firstLine(message: string): string {
  const first = message.split('\n')[0] ?? message;
  return (first.charAt(0).toLowerCase() + first.slice(1)).replace(/[.:]\s*$/, '');
}
