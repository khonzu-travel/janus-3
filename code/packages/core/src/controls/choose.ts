import type { Rule } from '../fixtures/controls.js';
import {
  holds,
  literalText,
  MISSING,
  referenceValue,
  type Condition,
  type Reference,
  type RequestFacts,
} from './conditions.js';
import type { JsonScalar } from '../dynamic/types.js';

/**
 * Rule, page and sequence evaluation. Pure: positions come
 * in, and nothing here stores or advances one.
 */

/** The first rule whose conditions all hold, and how many rules were evaluated. */
export function firstMatchingRule(
  rules: readonly Rule[],
  facts: RequestFacts,
): { readonly rule: Rule | null; readonly tried: number } {
  let tried = 0;
  for (const rule of rules) {
    tried++;
    if (rule.when.every((condition) => holds(condition, facts))) return { rule, tried };
  }
  return { rule: null, tried };
}

/**
 * The page key a reference's value looks up: its text, with a
 * body number or string compared by its JSON text without quotes. MISSING
 * when the request has no value; null when no key can match it.
 */
export function pageText(reference: Reference, facts: RequestFacts): string | null | typeof MISSING {
  const value = referenceValue(reference, facts);
  if (value === MISSING) return MISSING;
  if (typeof value === 'string') return value;
  if (reference.source === 'body' && typeof value === 'number') return JSON.stringify(value);
  return null;
}

/**
 * What identifies a sequence across a reload: its parsed steps
 * and, for a rule sequence, the rule's number and conditions. Comments,
 * formatting and the supplying scenario do not change it.
 */
export function sequenceSignature(steps: readonly string[], rule: Rule | null): string {
  return JSON.stringify(
    rule === null ? ['sequence', steps] : ['rule', rule.number, rule.when.map(describeCondition), steps],
  );
}

/** A condition as Atlas shows it: operands as written in the control file. */
export interface ConditionDescription {
  readonly reference: string;
  readonly test: 'equals' | 'in' | 'present' | 'range' | 'matchesETag';
  readonly value?: JsonScalar;
  readonly values?: readonly JsonScalar[];
  readonly present?: boolean;
  readonly bounds?: Readonly<Partial<Record<'gt' | 'gte' | 'lt' | 'lte', number>>>;
  readonly tag?: string;
}

export function describeCondition(condition: Condition): ConditionDescription {
  const { reference, test } = condition;
  switch (test.kind) {
    case 'equals':
      return { reference: reference.text, test: 'equals', value: literalText(test.literal) };
    case 'in':
      return { reference: reference.text, test: 'in', values: test.literals.map((literal) => literalText(literal)) };
    case 'present':
      return { reference: reference.text, test: 'present', present: test.present };
    case 'range':
      return { reference: reference.text, test: 'range', bounds: { ...test.bounds } };
    case 'matchesETag':
      return { reference: reference.text, test: 'matchesETag', tag: test.written };
  }
}

/**
 * The expected side of a failing `expect.yaml` condition: the
 * test as written, with a scenario ID resolved. Never the request's value.
 */
export function expectedOf(condition: Condition, scenarioIds: ReadonlyMap<string, string>): unknown {
  const { test } = condition;
  switch (test.kind) {
    case 'equals':
      return literalText(test.literal, scenarioIds);
    case 'in':
      return { in: test.literals.map((literal) => literalText(literal, scenarioIds)) };
    case 'present':
      return { present: test.present };
    case 'range':
      return { ...test.bounds };
    case 'matchesETag':
      return { matchesETag: test.written };
  }
}
