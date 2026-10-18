import { expandAliases, parseExpression, type ClockExpansion, type GrammarContext } from './grammar.js';
import { generate, TokenRandom, type Generated } from './random.js';
import { evaluateClock, formatClock } from './time.js';
import type { DynamicToken } from './types.js';

/**
 * Tokens in request files: the clock and generator
 * bases only. Clock tokens read the wall clock and generators always draw
 * fresh entropy, so `:unique` changes nothing. Request and context bases have
 * no meaning in a request.
 */

/** The grammar for request files: the built-in aliases and the configured `dynamic.aliases`. */
export function requestTokenGrammar(aliases: Readonly<Record<string, string>>): GrammarContext {
  const expanded = expandAliases(aliases);
  const map = new Map<string, ClockExpansion>(expanded.aliases);
  return Object.freeze({ aliases: map, pathParameters: null });
}

export type RequestTokenParse =
  { readonly ok: true; readonly token: DynamicToken } | { readonly ok: false; readonly message: string };

/** Parses the text between `{{$` and `}}`; request and context values are refused. */
export function parseRequestToken(inner: string, grammar: GrammarContext): RequestTokenParse {
  const parsed = parseExpression(inner, grammar);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const { spec } = parsed.token;
  if (spec.category === 'request' || spec.category === 'context') {
    return {
      ok: false,
      message: `{{$${parsed.token.expression}}} reads an incoming request, which a request file does not have; use a variable or the clock and generator values`,
    };
  }
  return { ok: true, token: parsed.token };
}

export interface RequestTokenEnvironment {
  /** The wall clock, in epoch milliseconds. */
  readonly now: number;
  /** `dynamic.timezone`. */
  readonly timezone: string;
  readonly randomBytes: (count: number) => Uint8Array;
}

/**
 * Evaluates a token parsed by `parseRequestToken`: a string, or a number for
 * `:unix` and `:unixMillis`, or a generator's JSON value. Throws a
 * `RangeError` when the value cannot be computed.
 */
export function evaluateRequestToken(token: DynamicToken, env: RequestTokenEnvironment): Generated {
  const { spec } = token;
  if (spec.category === 'clock') {
    const zone = spec.zone ?? env.timezone;
    return formatClock(evaluateClock(spec.start, spec.steps, zone, env.now), spec.format, zone);
  }
  if (spec.category === 'generator') return generate(spec.generator, new TokenRandom(env.randomBytes(32)), env.now);
  throw new RangeError(`{{$${token.expression}}} has no value in a request`);
}
