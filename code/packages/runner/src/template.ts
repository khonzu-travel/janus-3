import { checkJsonPath, parseRequestToken, type DynamicToken, type GrammarContext } from '@janus/core';

import { isVariableName } from './model.js';

/**
 * Templates in request files: `{{name}}` reads a variable,
 * `{{$…}}` is a Janus token, `{{$$…}}` is the literal text `{{$…}}`, and in
 * `extract` `{{$response.…}}` and `{{$request.…}}` read the exchange.
 * Whitespace inside the braces is ignored.
 */

/** Where an `extract` value is read. */
export type ExchangeSource =
  | { readonly from: 'response'; readonly part: 'status' | 'text' | 'timeMs' }
  | { readonly from: 'response'; readonly part: 'header' | 'cookie'; readonly name: string }
  | { readonly from: 'response'; readonly part: 'body'; readonly path: string }
  | { readonly from: 'request'; readonly part: 'url' }
  | { readonly from: 'request'; readonly part: 'header' | 'query' | 'path'; readonly name: string }
  | { readonly from: 'request'; readonly part: 'body'; readonly path: string };

export type TemplateSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'token'; readonly token: DynamicToken; readonly text: string }
  | { readonly kind: 'exchange'; readonly source: ExchangeSource; readonly text: string };

export interface Template {
  readonly segments: readonly TemplateSegment[];
}

export interface TemplateProblem {
  readonly message: string;
  /** UTF-16 offset of the problem in the text. */
  readonly offset: number;
}

export interface ParseTemplateOptions {
  readonly grammar: GrammarContext;
  /** `extract` templates may read the exchange. */
  readonly exchange?: boolean;
}

const cache = new WeakMap<GrammarContext, Map<string, { template: Template; problems: readonly TemplateProblem[] }>>();

/** Parses a template; every problem is returned, and the template keeps the rest. */
export function parseTemplate(
  text: string,
  options: ParseTemplateOptions,
): { readonly template: Template; readonly problems: readonly TemplateProblem[] } {
  let byGrammar = cache.get(options.grammar);
  if (byGrammar === undefined) {
    byGrammar = new Map();
    cache.set(options.grammar, byGrammar);
  }
  const key = `${options.exchange === true ? 'x' : 'r'}:${text}`;
  const cached = byGrammar.get(key);
  if (cached !== undefined) return cached;
  const parsed = scan(text, options);
  if (byGrammar.size > 10_000) byGrammar.clear();
  byGrammar.set(key, parsed);
  return parsed;
}

function scan(text: string, options: ParseTemplateOptions): { template: Template; problems: TemplateProblem[] } {
  const segments: TemplateSegment[] = [];
  const problems: TemplateProblem[] = [];
  let literal = '';
  let index = 0;
  const flush = (): void => {
    if (literal !== '') segments.push({ kind: 'text', text: literal });
    literal = '';
  };
  for (;;) {
    const start = text.indexOf('{{', index);
    if (start === -1) {
      literal += text.slice(index);
      break;
    }
    literal += text.slice(index, start);
    if (text.startsWith('{{$$', start)) {
      literal += '{{$';
      index = start + 4;
      continue;
    }
    const close = text.indexOf('}}', start + 2);
    if (close === -1) {
      // An unclosed "{{" is text: bodies may hold braces of their own.
      literal += text.slice(start);
      break;
    }
    const end = close + 2;
    const raw = text.slice(start, end);
    const inner = text.slice(start + 2, close).trim();
    if (inner.startsWith('$')) {
      const exchange = parseExchange(inner);
      if (exchange !== null) {
        if (typeof exchange === 'string') {
          problems.push({ message: `${raw}: ${exchange}`, offset: start });
        } else if (options.exchange !== true) {
          problems.push({
            message: `${raw} reads the exchange, which only extract entries can do`,
            offset: start,
          });
        } else {
          flush();
          segments.push({ kind: 'exchange', source: exchange, text: raw });
        }
        literal += problems.at(-1)?.offset === start ? raw : '';
        index = end;
        continue;
      }
      const parsed = parseRequestToken(inner.slice(1), options.grammar);
      if (parsed.ok) {
        flush();
        segments.push({ kind: 'token', token: parsed.token, text: raw });
      } else {
        problems.push({ message: `${raw}: ${parsed.message}`, offset: start });
        literal += raw;
      }
      index = end;
      continue;
    }
    if (isVariableName(inner)) {
      flush();
      segments.push({ kind: 'variable', name: inner });
    } else {
      problems.push({
        message: `${raw} is not a variable: a name is a letter or "_" followed by letters, digits, "_", "." or "-", at most 128 bytes; write {{$$ for a literal {{$`,
        offset: start,
      });
      literal += raw;
    }
    index = end;
  }
  flush();
  return { template: Object.freeze({ segments: Object.freeze(segments) }), problems };
}

/** `$response.…` and `$request.…`: the source, why it is not one, or null for another token. */
function parseExchange(inner: string): ExchangeSource | string | null {
  const expression = inner.replace(/\s+/g, '');
  const response = /^\$response(?:\.(.*))?$/s.exec(expression);
  if (response !== null) {
    const rest = response[1] ?? '';
    if (rest === 'status' || rest === 'text' || rest === 'timeMs') return { from: 'response', part: rest };
    const named = /^(header|cookie)\.(.+)$/s.exec(rest);
    if (named !== null) {
      const name = named[2] ?? '';
      const part = named[1] === 'header' ? 'header' : 'cookie';
      return { from: 'response', part, name: part === 'header' ? name.toLowerCase() : name };
    }
    if (rest.startsWith('body.')) return bodySource('response', inner.slice(inner.indexOf('body.') + 5).trim());
    return '$response takes status, header.<name>, cookie.<name>, body.<JSONPath>, text or timeMs';
  }
  const request = /^\$request(?:\.(.*))?$/s.exec(expression);
  if (request !== null) {
    const rest = request[1] ?? '';
    if (rest === 'url') return { from: 'request', part: 'url' };
    const named = /^(header|query|path)\.(.+)$/s.exec(rest);
    if (named !== null) {
      const part = named[1] === 'header' ? 'header' : named[1] === 'query' ? 'query' : 'path';
      const name = named[2] ?? '';
      return { from: 'request', part, name: part === 'header' ? name.toLowerCase() : name };
    }
    if (rest.startsWith('body.')) return bodySource('request', inner.slice(inner.indexOf('body.') + 5).trim());
    return '$request takes header.<name>, query.<name>, path.<name>, body.<JSONPath> or url';
  }
  return null;
}

function bodySource(from: 'response' | 'request', path: string): ExchangeSource | string {
  const problem = checkJsonPath(path);
  if (problem !== null) return problem;
  return from === 'response' ? { from, part: 'body', path } : { from, part: 'body', path };
}

/** The variable names a template reads, in order, without repeats. */
export function templateVariables(template: Template): readonly string[] {
  const names = new Set<string>();
  for (const segment of template.segments) if (segment.kind === 'variable') names.add(segment.name);
  return [...names];
}

/** A value as substituted into text: strings as they are, anything else as compact JSON. */
export function substitutionText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  // A function or symbol has no JSON text.
  const text = JSON.stringify(value) as string | undefined;
  return typeof text === 'string' ? text : '';
}
