import { isMap, isScalar, isSeq, type Node as YamlNode, type Pair } from 'yaml';

import {
  parseConditions,
  parseReference,
  type Condition,
  type ConditionContext,
  type Reference,
} from '../controls/conditions.js';
import { parseControlYaml, type ControlProblem, type YamlSource } from '../controls/yaml.js';
import type { TextPosition } from './json.js';
import { ACCEPTS_FILE_NAME } from './accepts.js';
import { readLatency, type LatencyProfile } from './latency.js';
import type { MalformedForm } from '../types/index.js';

/** The control files. */
export const VARIANTS_FILE_NAME = 'variants.yaml';
export const PAGES_FILE_NAME = 'pages.yaml';
export const SEQUENCE_FILE_NAME = 'sequence.yaml';
export const EXPECT_FILE_NAME = 'expect.yaml';
export const FAULT_FILE_NAME = 'fault.yaml';

/** Every file of a method directory that is not a response: inherited and replaced whole. */
export const CONTROL_FILE_NAMES: ReadonlySet<string> = new Set([
  ACCEPTS_FILE_NAME,
  VARIANTS_FILE_NAME,
  PAGES_FILE_NAME,
  SEQUENCE_FILE_NAME,
  EXPECT_FILE_NAME,
  FAULT_FILE_NAME,
]);

/** Limits. */
export const MAX_RULES = 64;
export const MAX_STEPS = 64;
export const MAX_PAGES = 256;
export const MAX_PAGE_KEY = 256;

/** `200` or `200.empty`, as a control file names an identity. */
const IDENTITY = /^(\d{3})(?:\.([a-z0-9]+(?:-[a-z0-9]+)*))?$/;

/** An identity named in a control file, located for `unknown-identity`. */
export interface IdentityReference {
  readonly identity: string;
  readonly position: TextPosition | undefined;
  readonly token: string;
}

export interface Rule {
  /** 1-based, in file order. */
  readonly number: number;
  readonly when: readonly Condition[];
  /** The identity a plain rule serves; null for a rule sequence. */
  readonly serve: string | null;
  /** A rule sequence's steps; null for a plain rule. */
  readonly steps: readonly string[] | null;
}

export interface RulesControl {
  readonly rules: readonly Rule[];
}

export interface PagesControl {
  readonly by: Reference;
  /** Page key → identity, in file order. */
  readonly pages: readonly (readonly [string, string])[];
  readonly whenAbsent: string | null;
  readonly otherwise: string | null;
}

export interface SequenceControl {
  readonly steps: readonly string[];
}

export interface ExpectControl {
  readonly expect: readonly Condition[];
  readonly onMismatch: string | null;
}

export const MALFORMED_FORMS: readonly MalformedForm[] = Object.freeze([
  'status-line',
  'header-line',
  'conflicting-length',
  'bad-chunk',
]);

/** The largest `truncate.bytes`. */
export const MAX_TRUNCATE_BYTES = 1_073_741_824;

/** One fault, or `none`, which only a fault sequence's step may be. */
export type Fault =
  | { readonly kind: 'reset' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'truncate'; readonly bytes: number | null }
  | { readonly kind: 'malformed'; readonly form: MalformedForm }
  | { readonly kind: 'none' };

export interface FaultRule {
  /** 1-based, in file order. */
  readonly number: number;
  /** Empty for a rule without `when`, which matches every request. */
  readonly when: readonly Condition[];
  /** A single fault; null for a fault sequence. */
  readonly fault: Fault | null;
  /** A fault sequence's steps; null for a single fault. */
  readonly steps: readonly Fault[] | null;
}

export interface FaultControl {
  readonly latency: LatencyProfile | null;
  readonly rules: readonly FaultRule[];
}

export type ControlResult<T> =
  | { readonly ok: true; readonly control: T; readonly identities: readonly IdentityReference[] }
  | { readonly ok: false; readonly problems: readonly ControlProblem[] };

/** Reads a mapping's members, reporting keys outside `allowed`. */
function members(
  root: YamlNode | null,
  source: YamlSource,
  file: string,
  allowed: readonly string[],
  problems: ControlProblem[],
): Map<string, { key: YamlNode | null; value: YamlNode | null }> | null {
  if (!isMap(root)) {
    problems.push(
      source.problem(root, `${file} must be a mapping with ${allowed.map((key) => `"${key}"`).join(', ')}`),
    );
    return null;
  }
  const out = new Map<string, { key: YamlNode | null; value: YamlNode | null }>();
  for (const pair of root.items as Pair<YamlNode | null, YamlNode | null>[]) {
    const name = isScalar(pair.key) ? String(pair.key.value) : null;
    if (name === null || !allowed.includes(name)) {
      problems.push(
        source.problem(
          pair.key,
          `unknown key ${name === null ? '' : `"${name}" `}in ${file}; expected ${allowed.map((key) => `"${key}"`).join(' or ')}`,
        ),
      );
      continue;
    }
    out.set(name, { key: pair.key, value: pair.value });
  }
  return out;
}

/** An identity reference: `200` or `200.empty`, written as a number or a string. */
function identityReference(
  node: YamlNode | null | undefined,
  source: YamlSource,
  problems: ControlProblem[],
  out: IdentityReference[],
): string | null {
  const written = isScalar(node)
    ? typeof node.value === 'number'
      ? (source.source(node) ?? String(node.value))
      : typeof node.value === 'string'
        ? node.value
        : null
    : null;
  if (written === null || !IDENTITY.test(written)) {
    problems.push(source.problem(node, 'an identity is a status, optionally with a variant name: 200 or 200.empty'));
    return null;
  }
  out.push({ identity: written, position: source.at(node).position, token: written });
  return written;
}

function identityList(
  node: YamlNode | null | undefined,
  what: string,
  source: YamlSource,
  problems: ControlProblem[],
  out: IdentityReference[],
): string[] | null {
  if (!isSeq(node) || node.items.length === 0 || node.items.length > MAX_STEPS) {
    problems.push(source.problem(node, `"${what}" must be a list of 1 to ${String(MAX_STEPS)} identities`));
    return null;
  }
  const steps: string[] = [];
  for (const item of node.items as (YamlNode | null)[]) {
    const identity = identityReference(item, source, problems, out);
    if (identity !== null) steps.push(identity);
  }
  return steps.length === node.items.length ? steps : null;
}

/** Parses `variants.yaml`. */
export function parseVariants(bytes: Uint8Array, context: ConditionContext): ControlResult<RulesControl> {
  const parsed = parseControlYaml(bytes, VARIANTS_FILE_NAME);
  if (!parsed.ok) return parsed;
  const { root, source } = parsed;
  const problems: ControlProblem[] = [];
  const identities: IdentityReference[] = [];
  const top = members(root, source, VARIANTS_FILE_NAME, ['rules'], problems);
  const list = top?.get('rules');
  const rules: Rule[] = [];
  if (top !== null && list === undefined) problems.push(source.problem(root, 'variants.yaml needs a "rules" list'));
  else if (list !== undefined) {
    if (!isSeq(list.value) || list.value.items.length === 0 || list.value.items.length > MAX_RULES) {
      problems.push(
        source.problem(list.value ?? list.key, `"rules" must be a list of 1 to ${String(MAX_RULES)} rules`),
      );
    } else {
      (list.value.items as (YamlNode | null)[]).forEach((item, index) => {
        const rule = members(item, source, `rule ${String(index + 1)}`, ['when', 'serve'], problems);
        if (rule === null) return;
        const when = rule.get('when');
        const serve = rule.get('serve');
        if (when === undefined || serve === undefined) {
          problems.push(source.problem(item, `rule ${String(index + 1)} needs "when" and "serve"`));
          return;
        }
        const conditions = parseConditions(when.value, source, context, 'when', problems);
        let served: string | null = null;
        let steps: string[] | null = null;
        if (isSeq(serve.value)) steps = identityList(serve.value, 'serve', source, problems, identities);
        else served = identityReference(serve.value, source, problems, identities);
        if (conditions === null || (served === null && steps === null)) return;
        rules.push(
          Object.freeze({
            number: index + 1,
            when: conditions,
            serve: served,
            steps: steps === null ? null : Object.freeze(steps),
          }),
        );
      });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, control: Object.freeze({ rules: Object.freeze(rules) }), identities };
}

/** Parses `pages.yaml`. */
export function parsePages(bytes: Uint8Array, context: ConditionContext): ControlResult<PagesControl> {
  const parsed = parseControlYaml(bytes, PAGES_FILE_NAME);
  if (!parsed.ok) return parsed;
  const { root, source } = parsed;
  const problems: ControlProblem[] = [];
  const identities: IdentityReference[] = [];
  const top = members(root, source, PAGES_FILE_NAME, ['by', 'whenAbsent', 'pages', 'otherwise'], problems);
  if (top === null) return { ok: false, problems };

  let by: Reference | null = null;
  const byEntry = top.get('by');
  if (byEntry === undefined)
    problems.push(source.problem(root, 'pages.yaml needs "by", the reference holding the page'));
  else {
    const text = isScalar(byEntry.value) && typeof byEntry.value.value === 'string' ? byEntry.value.value : null;
    if (text === null)
      problems.push(source.problem(byEntry.value ?? byEntry.key, '"by" must be a reference such as query.page'));
    else if (text === 'contentType') problems.push(source.problem(byEntry.value, '"by" cannot be contentType'));
    else by = parseReference(text, byEntry.value, source, context, problems);
  }

  const pages: [string, string][] = [];
  const pagesEntry = top.get('pages');
  if (pagesEntry === undefined)
    problems.push(source.problem(root, 'pages.yaml needs "pages", a mapping of keys to identities'));
  else if (
    !isMap(pagesEntry.value) ||
    pagesEntry.value.items.length === 0 ||
    pagesEntry.value.items.length > MAX_PAGES
  ) {
    problems.push(
      source.problem(
        pagesEntry.value ?? pagesEntry.key,
        `"pages" must be a mapping of 1 to ${String(MAX_PAGES)} keys to identities`,
      ),
    );
  } else {
    for (const pair of pagesEntry.value.items as Pair<YamlNode | null, YamlNode | null>[]) {
      const key = isScalar(pair.key) && typeof pair.key.value === 'string' ? pair.key.value : null;
      if (key === null || key === '' || key.length > MAX_PAGE_KEY || key.includes('{{$')) {
        const written = source.source(pair.key);
        problems.push(
          source.problem(
            pair.key,
            `a page key is a non-empty string of at most ${String(MAX_PAGE_KEY)} characters${written === null || key !== null ? '' : `; write '${written}'`}`,
          ),
        );
        continue;
      }
      const identity = identityReference(pair.value, source, problems, identities);
      if (identity !== null) pages.push([key, identity]);
    }
  }

  let whenAbsent: string | null = null;
  const absent = top.get('whenAbsent');
  if (absent !== undefined) {
    const key = isScalar(absent.value) && typeof absent.value.value === 'string' ? absent.value.value : null;
    if (key === null || !pages.some(([page]) => page === key)) {
      problems.push(
        source.problem(absent.value ?? absent.key, '"whenAbsent" must be a key of "pages", written as a string'),
      );
    } else whenAbsent = key;
  }
  let otherwise: string | null = null;
  const fallback = top.get('otherwise');
  if (fallback !== undefined) otherwise = identityReference(fallback.value, source, problems, identities);

  if (problems.length > 0 || by === null) return { ok: false, problems };
  return {
    ok: true,
    control: Object.freeze({
      by,
      pages: Object.freeze(pages.map((entry) => Object.freeze(entry))),
      whenAbsent,
      otherwise,
    }),
    identities,
  };
}

/** Parses `sequence.yaml`. */
export function parseSequence(bytes: Uint8Array): ControlResult<SequenceControl> {
  const parsed = parseControlYaml(bytes, SEQUENCE_FILE_NAME);
  if (!parsed.ok) return parsed;
  const { root, source } = parsed;
  const problems: ControlProblem[] = [];
  const identities: IdentityReference[] = [];
  const top = members(root, source, SEQUENCE_FILE_NAME, ['steps'], problems);
  const entry = top?.get('steps');
  let steps: string[] | null = null;
  if (top !== null && entry === undefined) problems.push(source.problem(root, 'sequence.yaml needs a "steps" list'));
  else if (entry !== undefined) steps = identityList(entry.value, 'steps', source, problems, identities);
  if (problems.length > 0 || steps === null) return { ok: false, problems };
  return { ok: true, control: Object.freeze({ steps: Object.freeze(steps) }), identities };
}

/** Parses `expect.yaml`. */
export function parseExpect(bytes: Uint8Array, context: ConditionContext): ControlResult<ExpectControl> {
  const parsed = parseControlYaml(bytes, EXPECT_FILE_NAME);
  if (!parsed.ok) return parsed;
  const { root, source } = parsed;
  const problems: ControlProblem[] = [];
  const identities: IdentityReference[] = [];
  const top = members(root, source, EXPECT_FILE_NAME, ['expect', 'onMismatch'], problems);
  if (top === null) return { ok: false, problems };
  const entry = top.get('expect');
  let expect: readonly Condition[] | null = null;
  if (entry === undefined) problems.push(source.problem(root, 'expect.yaml needs an "expect" mapping of conditions'));
  else expect = parseConditions(entry.value, source, context, 'expect', problems);
  let onMismatch: string | null = null;
  const mismatch = top.get('onMismatch');
  if (mismatch !== undefined) onMismatch = identityReference(mismatch.value, source, problems, identities);
  if (problems.length > 0 || expect === null) return { ok: false, problems };
  return { ok: true, control: Object.freeze({ expect, onMismatch }), identities };
}

/** Parses `fault.yaml`. */
export function parseFault(bytes: Uint8Array, context: ConditionContext): ControlResult<FaultControl> {
  const parsed = parseControlYaml(bytes, FAULT_FILE_NAME);
  if (!parsed.ok) return parsed;
  const { root, source } = parsed;
  const problems: ControlProblem[] = [];
  if (root === null || (isScalar(root) && root.value === null)) {
    return { ok: false, problems: [source.problem(root, 'fault.yaml is empty; it needs "latency", "rules" or both')] };
  }
  const top = members(root, source, FAULT_FILE_NAME, ['latency', 'rules'], problems);
  if (top === null) return { ok: false, problems };
  if (top.size === 0 && problems.length === 0) {
    problems.push(source.problem(root, 'fault.yaml needs "latency", "rules" or both'));
  }

  let latency: LatencyProfile | null = null;
  const latencyEntry = top.get('latency');
  if (latencyEntry !== undefined) {
    const read = readLatency(latencyEntry.value);
    if (read.ok) latency = read.profile;
    else problems.push(source.problem(latencyEntry.value ?? latencyEntry.key, read.message));
  }

  const rules: FaultRule[] = [];
  const list = top.get('rules');
  if (list !== undefined) {
    if (!isSeq(list.value) || list.value.items.length === 0 || list.value.items.length > MAX_RULES) {
      problems.push(
        source.problem(list.value ?? list.key, `"rules" must be a list of 1 to ${String(MAX_RULES)} fault rules`),
      );
    } else {
      (list.value.items as (YamlNode | null)[]).forEach((item, index) => {
        const name = `rule ${String(index + 1)}`;
        const rule = members(item, source, name, ['when', 'fault'], problems);
        if (rule === null) return;
        const faultEntry = rule.get('fault');
        if (faultEntry === undefined) {
          problems.push(source.problem(item, `${name} needs "fault"`));
          return;
        }
        const whenEntry = rule.get('when');
        const conditions =
          whenEntry === undefined ? [] : parseConditions(whenEntry.value, source, context, 'when', problems);
        let fault: Fault | null = null;
        let steps: Fault[] | null = null;
        const value = faultEntry.value;
        if (isSeq(value)) {
          if (value.items.length === 0 || value.items.length > MAX_STEPS) {
            problems.push(source.problem(value, `"fault" must be one fault or a list of 1 to ${String(MAX_STEPS)}`));
            return;
          }
          const parsedSteps = (value.items as (YamlNode | null)[]).map((step) =>
            parseOneFault(step, true, source, problems),
          );
          if (parsedSteps.every((step): step is Fault => step !== null)) steps = parsedSteps;
        } else fault = parseOneFault(value, false, source, problems);
        if (conditions === null || (fault === null && steps === null)) return;
        rules.push(
          Object.freeze({
            number: index + 1,
            when: conditions,
            fault,
            steps: steps === null ? null : Object.freeze(steps),
          }),
        );
      });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, control: Object.freeze({ latency, rules: Object.freeze(rules) }), identities: [] };
}

const FAULT_NAMES = '"reset", "timeout", "truncate" or "malformed"';

/** One fault: a name, or a mapping with one key for `truncate` and `malformed`. */
function parseOneFault(
  node: YamlNode | null | undefined,
  inSequence: boolean,
  source: YamlSource,
  problems: ControlProblem[],
): Fault | null {
  const fail = (at: YamlNode | null | undefined, message: string): null => {
    problems.push(source.problem(at, message));
    return null;
  };
  if (isScalar(node) && typeof node.value === 'string') {
    switch (node.value) {
      case 'reset':
      case 'timeout':
        return Object.freeze({ kind: node.value });
      case 'truncate':
        return Object.freeze({ kind: 'truncate', bytes: null });
      case 'malformed':
        return Object.freeze({ kind: 'malformed', form: 'status-line' });
      case 'none':
        return inSequence
          ? Object.freeze({ kind: 'none' })
          : fail(node, '"none" is only allowed as a step of a fault sequence, e.g. fault: [reset, none]');
      default:
        return fail(node, `unknown fault "${node.value}"; use ${FAULT_NAMES}${inSequence ? ', or "none"' : ''}`);
    }
  }
  if (!isMap(node) || node.items.length !== 1) {
    return fail(node, `a fault is ${FAULT_NAMES}, { truncate: { bytes: N } } or { malformed: <form> }`);
  }
  const pair = node.items[0] as Pair<YamlNode | null, YamlNode | null>;
  const kind = isScalar(pair.key) ? String(pair.key.value) : '';
  const option = pair.value;
  if (kind === 'truncate') {
    const bytesEntry =
      isMap(option) && option.items.length === 1 ? (option.items[0] as Pair<YamlNode | null, YamlNode | null>) : null;
    const key = bytesEntry !== null && isScalar(bytesEntry.key) ? String(bytesEntry.key.value) : null;
    const bytes = bytesEntry !== null && isScalar(bytesEntry.value) ? bytesEntry.value.value : undefined;
    if (key !== 'bytes') return fail(option ?? pair.key, '"truncate" takes { bytes: N }');
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0 || bytes > MAX_TRUNCATE_BYTES) {
      return fail(bytesEntry?.value, `"bytes" must be an integer from 0 to ${String(MAX_TRUNCATE_BYTES)}`);
    }
    return Object.freeze({ kind: 'truncate', bytes });
  }
  if (kind === 'malformed') {
    const form = isScalar(option) && typeof option.value === 'string' ? option.value : null;
    if (form === null || !(MALFORMED_FORMS as readonly string[]).includes(form)) {
      return fail(option ?? pair.key, `"malformed" takes one of ${MALFORMED_FORMS.join(', ')}`);
    }
    return Object.freeze({ kind: 'malformed', form: form as MalformedForm });
  }
  if (kind === 'reset' || kind === 'timeout' || kind === 'none') {
    return fail(pair.key, `"${kind}" takes no options; write it as a name`);
  }
  return fail(pair.key, `unknown fault "${kind}"; use ${FAULT_NAMES}`);
}
