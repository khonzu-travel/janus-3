import type { LatencyProfile, MalformedForm, WireFault, WireFaults } from '../../atlas/wire.js';
import { describeCondition, type Part, type Sentence } from './controlSentences.js';

/**
 * Plain sentences for a method's `fault.yaml`, in the
 * plain-sentence style. Built only from the `faults` resource.
 */

const text = (value: string): Part => ({ kind: 'text', text: value });
const code = (value: string): Part => ({ kind: 'code', text: value });

const MALFORMED: Readonly<Record<MalformedForm, string>> = {
  'status-line': 'send a response whose status line is not valid HTTP',
  'header-line': 'send a response with a header line that has no colon',
  'conflicting-length': 'send a response with two conflicting Content-Length headers',
  'bad-chunk': 'send a response with a broken chunked body',
};

/** What a fault does to the connection: "reset the connection". */
export function describeFault(fault: WireFault): Sentence {
  switch (fault.kind) {
    case 'reset':
      return [text('reset the connection')];
    case 'timeout':
      return [text('hold the connection open without answering')];
    case 'truncate':
      return fault.bytes === null
        ? [text('cut the response off halfway through its body')]
        : [text(`cut the response off after ${String(fault.bytes)} ${fault.bytes === 1 ? 'byte' : 'bytes'} of body`)];
    case 'malformed':
      return [text(MALFORMED[fault.form ?? 'status-line'])];
    case 'none':
      return [text('answer normally')];
  }
}

/** "1500 ms", or "between 200 and 800 ms". */
export function latencyText(profile: LatencyProfile): string {
  return profile.ms !== undefined
    ? `${String(profile.ms)} ms`
    : `between ${String(profile.min)} and ${String(profile.max)} ms`;
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];

/** A fault sequence: "reset the connection on the first request, then answer normally". */
function sequence(faults: readonly WireFault[]): Part[] {
  if (faults.length === 1) return [...describeFault(faults[0] ?? { kind: 'none', bytes: null, form: null })];
  return faults.flatMap((fault, index) => {
    const last = index === faults.length - 1;
    const ordinal = ORDINALS[index] ?? `${String(index + 1)}th`;
    return [
      ...(index === 0 ? [] : [text(last ? ', then ' : ', ')]),
      ...describeFault(fault),
      ...(last ? [] : [text(` on the ${ordinal} request`)]),
    ];
  });
}

function capitalize(sentence: Part[]): Part[] {
  const [first, ...rest] = sentence;
  if (first?.kind !== 'text') return sentence;
  return [text(first.text.charAt(0).toUpperCase() + first.text.slice(1)), ...rest];
}

export interface FaultSentences {
  readonly latency: Sentence | null;
  readonly rules: readonly Sentence[];
  /** True when a rule is a fault sequence: each session keeps its own step. */
  readonly sequences: boolean;
}

export function faultSentences(faults: WireFaults): FaultSentences {
  return {
    latency:
      faults.latency === null
        ? null
        : faults.latency.ms === 0
          ? [text('No delay: requests answer at once, whatever the scenario or server sets.')]
          : [text('Every request waits '), code(latencyText(faults.latency)), text(' before the first byte.')],
    rules: faults.rules.map((rule, index) => {
      const what = sequence(rule.fault);
      if (rule.when.length === 0) {
        return index === 0 ? [...capitalize(what), text('.')] : [text('Otherwise, '), ...what, text('.')];
      }
      const conditions = rule.when.flatMap((condition, at) => [
        ...(at === 0 ? [] : [text(' and ')]),
        ...describeCondition(condition),
      ]);
      return [text('When '), ...conditions, text(', '), ...what, text('.')];
    }),
    sequences: faults.rules.some((rule) => rule.fault.length > 1),
  };
}
