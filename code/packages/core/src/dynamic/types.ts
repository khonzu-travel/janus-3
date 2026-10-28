/** The token model. Parsed once when the snapshot is built; rendered per request. */

export type TokenCategory = 'clock' | 'request' | 'generator' | 'context';

/** Offset units. `mo` and `y` are calendar units; the rest are exact durations. */
export type Unit = 'ms' | 's' | 'min' | 'h' | 'd' | 'w' | 'mo' | 'y';

export type Snap = 'startOfDay' | 'endOfDay' | 'startOfMonth' | 'endOfMonth';

export type ClockStep =
  { readonly kind: 'add'; readonly amount: number; readonly unit: Unit } | { readonly kind: 'snap'; readonly to: Snap };

export type PatternField =
  'yyyy' | 'yy' | 'MM' | 'M' | 'dd' | 'd' | 'HH' | 'H' | 'mm' | 'ss' | 'SSS' | 'EEE' | 'MMM' | 'XXX';

export type PatternPart =
  { readonly kind: 'literal'; readonly text: string } | { readonly kind: 'field'; readonly field: PatternField };

export type FormatSpec =
  | { readonly kind: 'date' | 'datetime' | 'time' | 'unix' | 'unixMillis' | 'http' }
  | { readonly kind: 'pattern'; readonly parts: readonly PatternPart[] }
  /** The default for `now` without a zone: RFC 3339 in UTC. */
  | { readonly kind: 'utc' };

export type ArithmeticOperator = '+' | '-' | '*' | '/';

/**
 * Arithmetic on a request value. `date(…)` reads an RFC 3339 date or
 * date-time and applies clock steps; `num(…)` reads a number and applies
 * operations with literal operands, `*` and `/` before `+` and `-`.
 */
export type RequestTransform =
  | {
      readonly kind: 'date';
      readonly steps: readonly ClockStep[];
      /** The token's `@zone`, or null for the value's own offset (a date-time) or `dynamic.timezone` (a date). */
      readonly zone: string | null;
      /** The token's format, or null for the value's own shape. */
      readonly format: FormatSpec | null;
    }
  | {
      readonly kind: 'num';
      readonly operations: readonly { readonly operator: ArithmeticOperator; readonly operand: number }[];
    };

export type JsonScalar = string | number | boolean | null;

export type GeneratorSpec =
  | { readonly kind: 'uuid' | 'ulid' | 'randomBool' }
  | { readonly kind: 'randomInt'; readonly min: number; readonly max: number }
  | { readonly kind: 'randomFrom'; readonly values: readonly JsonScalar[] }
  | { readonly kind: 'faker'; readonly module: string; readonly method: string };

export type TokenSpec =
  | {
      readonly category: 'clock';
      readonly start: 'now' | 'today';
      /** Alias expansion first, then the token's own offsets, left to right. */
      readonly steps: readonly ClockStep[];
      /** The token's `@zone`, or null for `dynamic.timezone`. */
      readonly zone: string | null;
      readonly format: FormatSpec;
    }
  | {
      readonly category: 'request';
      readonly source: 'path' | 'query' | 'header' | 'body' | 'method';
      /** Parameter, query or lower-cased header name, or the JSONPath; "" for `method`. */
      readonly name: string;
      /** `date(…)` or `num(…)` around the value; absent when it is copied as it is. */
      readonly transform?: RequestTransform;
    }
  | { readonly category: 'generator'; readonly generator: GeneratorSpec; readonly unique: boolean }
  /** The selected scenario and the caller's sequence position. */
  | {
      readonly category: 'context';
      readonly source: 'scenario-name' | 'scenario-id' | 'sequence-position';
      /** The id name for `scenario-id`; "" otherwise. */
      readonly name: string;
    };

export interface DynamicToken {
  /** The expression with insignificant whitespace removed, e.g. `today+14d`. Part of the derivation key. */
  readonly expression: string;
  readonly spec: TokenSpec;
}

/** One piece of a scanned string: literal text (escapes already applied) or a token. */
export type Segment =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'token';
      readonly token: DynamicToken;
      /** UTF-16 offsets of `{{$ … }}` in the source string. */
      readonly start: number;
      readonly end: number;
      /** 0-based ordinal of this token within its string. */
      readonly ordinal: number;
      /**
       * The token's location for its derivation key: container
       * kind, then JSON Pointer and ordinal, body byte offset, or header name,
       * value index and byte offset. Unique within a fixture.
       */
      readonly location: readonly (string | number)[];
    };

/** A string that contains tokens or `{{$$` escapes, so it is rendered rather than replayed. */
export interface Template {
  readonly segments: readonly Segment[];
  /** Number of token segments. */
  readonly tokens: number;
}

export type DynamicErrorCode =
  | 'unknown-dynamic-token'
  | 'invalid-dynamic-token'
  | 'unknown-timezone'
  | 'unknown-path-parameter'
  | 'impure-faker-path';

export interface DynamicProblem {
  readonly code: DynamicErrorCode;
  readonly message: string;
  /** UTF-16 offset of the token in the scanned string. */
  readonly offset: number;
  /** The token as written, `{{$ … }}`. */
  readonly token: string;
}
