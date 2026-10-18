import type { ResolutionOutcome } from '../types/index.js';

/** Where a selected scenario name came from. */
export type SelectionSource = 'caller' | 'request-header' | 'session' | 'config' | 'default';

/** `known` lists at most this many names. */
export const MAX_KNOWN = 50;

export interface UnknownScenario {
  readonly message: string;
  readonly outcome: Extract<ResolutionOutcome, { kind: 'unknown-scenario' }>;
  /** The error envelope's members after `message`. */
  readonly details: Readonly<Record<string, unknown>>;
}

const FROM: Readonly<Record<SelectionSource, string>> = {
  caller: 'the request description',
  'request-header': 'X-Mock-Scenario',
  session: "the session's pin",
  config: 'scenarios.default',
  default: 'the default',
};

/** The `400 unknown-scenario` answer for a name no scenario in the snapshot has. `names` is sorted. */
export function unknownScenario(name: string, source: SelectionSource, names: readonly string[]): UnknownScenario {
  const known = Object.freeze(names.slice(0, MAX_KNOWN));
  const cut = names.length > known.length;
  return {
    message: `no scenario named ${JSON.stringify(name)} (from ${FROM[source]})`,
    outcome: Object.freeze({ kind: 'unknown-scenario', source, known, ...(cut ? { knownCount: names.length } : {}) }),
    details: { source, known, ...(cut ? { knownCount: names.length } : {}) },
  };
}
