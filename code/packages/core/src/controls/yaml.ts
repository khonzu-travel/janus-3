import { isScalar, LineCounter, parseDocument, visit, type Node as YamlNode } from 'yaml';

import { utf8DecodeStrict } from '../bytes.js';
import type { TextPosition } from '../fixtures/json.js';
import type { StartupErrorCode } from '../types/index.js';

/** One located problem in a control file. Most are `invalid-control`. */
export interface ControlProblem {
  readonly code: StartupErrorCode;
  readonly message: string;
  readonly position?: TextPosition;
  readonly token?: string;
}

/** The longest scalar quoted back as an error's token. */
const TOKEN_LIMIT = 64;

/** Positions and source text of a parsed control file, for locating problems. */
export class YamlSource {
  readonly #text: string;
  readonly #lines: LineCounter;

  constructor(text: string, lines: LineCounter) {
    this.#text = text;
    this.#lines = lines;
  }

  /** The node's start as a 1-based line and column. */
  at(node: YamlNode | null | undefined): { position?: TextPosition } {
    const offset = node?.range?.[0];
    if (offset === undefined) return {};
    const { line, col } = this.#lines.linePos(offset);
    return { position: { line, column: col } };
  }

  /** A short scalar as written, for an error's token. */
  token(node: YamlNode | null | undefined): { token?: string } {
    const source = this.source(node);
    return source !== null && source.length <= TOKEN_LIMIT && !source.includes('\n') ? { token: source } : {};
  }

  /** A scalar's text exactly as written, quotes included, or null. */
  source(node: YamlNode | null | undefined): string | null {
    if (!isScalar(node) || node.range === undefined || node.range === null) return null;
    return this.#text.slice(node.range[0], node.range[1]);
  }

  /** Builds an `invalid-control` problem at `node`. */
  problem(
    node: YamlNode | null | undefined,
    message: string,
    code: StartupErrorCode = 'invalid-control',
  ): ControlProblem {
    return { code, message, ...this.at(node), ...this.token(node) };
  }
}

export type YamlParse =
  | { readonly ok: true; readonly root: YamlNode | null; readonly source: YamlSource }
  | { readonly ok: false; readonly problems: readonly ControlProblem[] };

/**
 * Parses a control file : UTF-8, one
 * document, no anchors, aliases or custom tags, and no duplicate keys.
 */
export function parseControlYaml(bytes: Uint8Array, file: string): YamlParse {
  const text = utf8DecodeStrict(bytes);
  if (text === null)
    return { ok: false, problems: [{ code: 'invalid-control', message: 'the file is not valid UTF-8' }] };
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false, uniqueKeys: true, schema: 'core' });
  const source = new YamlSource(text, lines);
  const problems: ControlProblem[] = [];
  for (const error of doc.errors) {
    const { line, col } = lines.linePos(error.pos[0]);
    const kind = error.code === 'DUPLICATE_KEY' ? 'duplicate key' : 'invalid YAML';
    problems.push({
      code: 'invalid-control',
      message: `${kind}: ${firstLine(error.message)}`,
      position: { line, column: col },
    });
  }
  if (problems.length > 0) return { ok: false, problems };
  visit(doc, {
    Alias(_key, node) {
      problems.push({ code: 'invalid-control', message: `aliases are not allowed in ${file}`, ...source.at(node) });
    },
    Node(_key, node) {
      if (node.anchor !== undefined) {
        problems.push({
          code: 'invalid-control',
          message: `anchors are not allowed in ${file}`,
          ...source.at(node),
          token: `&${node.anchor}`,
        });
      }
      if (node.tag !== undefined && !node.tag.startsWith('tag:yaml.org,2002:')) {
        problems.push({
          code: 'invalid-control',
          message: `custom tag "${node.tag}" is not allowed`,
          ...source.at(node),
          token: node.tag,
        });
      }
    },
  });
  if (problems.length > 0) return { ok: false, problems };
  const root = doc.contents as YamlNode | null;
  return { ok: true, root: isScalar(root) && root.value === null ? null : root, source };
}

function firstLine(message: string): string {
  const first = message.split('\n')[0] ?? message;
  return (first.charAt(0).toLowerCase() + first.slice(1)).replace(/[.:]\s*$/, '');
}
