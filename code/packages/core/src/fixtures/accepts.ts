import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node as YamlNode } from 'yaml';

import { utf8DecodeStrict } from '../bytes.js';
import { parseMediaType } from '../http/media-type.js';
import type { TextPosition } from './json.js';

/** The request media types a method accepts. */
export interface AcceptsPolicy {
  /** `type/subtype` as written, in file order. */
  readonly mediaTypes: readonly string[];
  /** The type assumed for a body sent without `Content-Type`, or null to refuse it. */
  readonly allowMissingContentType: string | null;
}

export interface AcceptsProblem {
  readonly message: string;
  readonly position?: TextPosition;
  readonly token?: string;
}

export type AcceptsResult =
  | { readonly ok: true; readonly policy: AcceptsPolicy }
  | { readonly ok: false; readonly problems: readonly AcceptsProblem[] };

export const ACCEPTS_FILE_NAME = 'accepts.yaml';

const KEYS = ['accepts', 'allowMissingContentType'];
const TOKEN_LIMIT = 64;

/**
 * Parses and validates an `accepts.yaml` file: a mapping with a non-empty
 * `accepts` list of parameterless, non-wildcard media types and an optional
 * `allowMissingContentType` naming one of them. Every problem is located.
 */
export function parseAccepts(bytes: Uint8Array): AcceptsResult {
  const text = utf8DecodeStrict(bytes);
  if (text === null) return failure([{ message: 'the file is not valid UTF-8' }]);
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true, schema: 'core' });
  const at = (node: YamlNode | null | undefined): { position?: TextPosition } => {
    const offset = node?.range?.[0];
    if (offset === undefined) return {};
    const { line, col } = lines.linePos(offset);
    return { position: { line, column: col } };
  };
  const tokenOf = (node: YamlNode | null | undefined): { token?: string } => {
    if (!isScalar(node) || node.range === undefined || node.range === null) return {};
    const source = text.slice(node.range[0], node.range[1]);
    return source.length <= TOKEN_LIMIT && !source.includes('\n') ? { token: source } : {};
  };

  if (doc.errors.length > 0) {
    return failure(
      doc.errors.map((error) => {
        const { line, col } = lines.linePos(error.pos[0]);
        const message = error.code === 'DUPLICATE_KEY' ? 'duplicate key' : 'invalid YAML';
        return { message: `${message}: ${firstLine(error.message)}`, position: { line, column: col } };
      }),
    );
  }
  const root = doc.contents;
  if (!isMap(root)) {
    return failure([{ message: 'accepts.yaml must be a mapping with an "accepts" list', ...at(root) }]);
  }

  const problems: AcceptsProblem[] = [];
  let acceptsNode: YamlNode | null = null;
  let missingNode: YamlNode | null = null;
  let hasAccepts = false;
  for (const pair of root.items) {
    const key = pair.key as YamlNode | null;
    const name = isScalar(key) ? String(key.value) : null;
    if (name === 'accepts') {
      hasAccepts = true;
      acceptsNode = pair.value ?? null;
    } else if (name === 'allowMissingContentType') {
      missingNode = pair.value ?? null;
    } else {
      problems.push({
        message: `unknown key ${name === null ? '' : `"${name}" `}in accepts.yaml; expected ${KEYS.join(' or ')}`,
        ...at(key),
        ...tokenOf(key),
      });
    }
  }
  if (!hasAccepts) problems.push({ message: 'accepts.yaml needs an "accepts" list of media types', ...at(root) });

  const mediaTypes: string[] = [];
  if (hasAccepts) {
    if (!isSeq(acceptsNode) || acceptsNode.items.length === 0) {
      problems.push({ message: '"accepts" must be a non-empty list of media types', ...at(acceptsNode ?? root) });
    } else {
      const seen = new Set<string>();
      for (const item of acceptsNode.items as (YamlNode | null)[]) {
        const value = isScalar(item) && typeof item.value === 'string' ? item.value : null;
        const problem = value === null ? 'is not a string' : mediaTypeProblem(value);
        if (problem !== null) {
          problems.push({ message: `"accepts" entry ${problem}`, ...at(item), ...tokenOf(item) });
          continue;
        }
        const written = (value ?? '').trim();
        const key = written.toLowerCase();
        if (seen.has(key)) {
          problems.push({ message: `"accepts" lists "${written}" more than once`, ...at(item), ...tokenOf(item) });
          continue;
        }
        seen.add(key);
        mediaTypes.push(written);
      }
    }
  }

  let allowMissingContentType: string | null = null;
  if (missingNode !== null) {
    const value = isScalar(missingNode) && typeof missingNode.value === 'string' ? missingNode.value.trim() : null;
    const match = value === null ? undefined : mediaTypes.find((entry) => entry.toLowerCase() === value.toLowerCase());
    if (match === undefined) {
      problems.push({
        message: '"allowMissingContentType" must be one of the media types listed in "accepts"',
        ...at(missingNode),
        ...tokenOf(missingNode),
      });
    } else {
      allowMissingContentType = match;
    }
  }

  if (problems.length > 0) return failure(problems);
  return {
    ok: true,
    policy: Object.freeze({ mediaTypes: Object.freeze(mediaTypes), allowMissingContentType }),
  };
}

/** Why a value is not a bare `type/subtype`, or null when it is one. */
function mediaTypeProblem(value: string): string | null {
  const parsed = parseMediaType(value);
  if (parsed === null) return `"${value.slice(0, TOKEN_LIMIT)}" is not a media type such as application/json`;
  if (parsed.type === '*' || parsed.subtype === '*') return `"${value}" is a wildcard; list each media type`;
  if (parsed.parameters.length > 0 || value.includes(';')) {
    return `"${value}" has parameters; list the type and subtype only (parameters such as charset are ignored)`;
  }
  return null;
}

function failure(problems: readonly AcceptsProblem[]): AcceptsResult {
  return { ok: false, problems };
}

function firstLine(message: string): string {
  const first = message.split('\n')[0] ?? message;
  return (first.charAt(0).toLowerCase() + first.slice(1)).replace(/[.:]\s*$/, '');
}
