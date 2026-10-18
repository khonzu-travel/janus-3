import type {
  PromotionLocation,
  PromotionNote,
  PromotionRefusal,
  PromotionRewrite,
  PromotionSuggestion,
} from '../../atlas/wire.js';

/** Where a finding is, in words: "at /id", "on line 3", "in the Location header". */
export function where(location: PromotionLocation): string {
  if (location.pointer !== undefined) return location.pointer === '' ? 'as the whole body' : `at ${location.pointer}`;
  if (location.line !== undefined) return `on line ${String(location.line)}`;
  if (location.header !== undefined) return `in the ${location.header} header`;
  return 'in the response';
}

const TIER_TEXT = {
  exact: 'exact: it filled a path parameter or was named',
  inferred: 'inferred from a member of the same name; check it',
} as const;

export function rewriteSentence(rewrite: PromotionRewrite): string {
  return `${idTokenText(rewrite.id)} replaces the captured value ${where(rewrite)} (${TIER_TEXT[rewrite.tier]}).`;
}

export function suggestionSentence(suggestion: PromotionSuggestion): string {
  return `The value of ${suggestion.id} also appears inside other text ${where(suggestion)}; it was left as captured.`;
}

const REFUSAL_TEXT: Readonly<Record<string, (id: string) => string>> = {
  'id-undeclared': (id) =>
    `The path parameter ${id} is not an ID the scenario declares, so its value was left as captured`,
  'id-too-short': (id) => `The value bound to ${id} is shorter than 4 characters, so it was not searched for`,
  'id-conflict': (id) =>
    `${id} was bound to more than one value, or shares its value with another ID, so it was not used`,
  'id-not-string': (id) => `The value of ${id} appears as a JSON number or boolean; a token would change its type`,
  'id-in-key': (id) => `The value of ${id} appears as a JSON object key, which is never rewritten`,
  'id-in-binary-body': (id) => `The body is neither JSON nor text, so ${id} was not looked for in it`,
};

export function refusalSentence(refusal: PromotionRefusal): string {
  const text = REFUSAL_TEXT[refusal.code]?.(refusal.id) ?? `${refusal.id} was not rewritten (${refusal.code})`;
  const located =
    refusal.pointer === undefined && refusal.line === undefined && refusal.header === undefined
      ? ''
      : ` ${where(refusal)}`;
  return `${text}${located}.`;
}

const NOTE_TEXT: Readonly<Record<string, string>> = {
  'existing-headers-kept':
    'The scenario already had a header file for this response; it was kept, and the captured headers were not written.',
  'edited-before-promotion': 'Edited before it was promoted.',
};

export function noteSentence(note: PromotionNote): string {
  return NOTE_TEXT[note.code] ?? note.message;
}

export function idTokenText(id: string): string {
  return `{{$scenario.ids.${id}}}`;
}
