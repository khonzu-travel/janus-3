import type { RangeBound, Scalar, WireCondition, WireControls } from '../../atlas/wire.js';

/**
 * Plain sentences for an endpoint's control files. Built only
 * from the `controls` resource: the UI evaluates nothing.
 *
 * A sentence is a list of parts so a view can render code, identities (as
 * links) and text differently while tests read the text.
 */
export type Part =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'identity'; readonly identity: string };

export type Sentence = readonly Part[];

const text = (value: string): Part => ({ kind: 'text', text: value });
const code = (value: string): Part => ({ kind: 'code', text: value });
const identity = (value: string): Part => ({ kind: 'identity', identity: value });

/** The plain text of a sentence, identities in bold as `**200.empty**`. */
export function sentenceText(sentence: Sentence, bold = false): string {
  return sentence
    .map((part) => (part.kind === 'identity' ? (bold ? `**${part.identity}**` : part.identity) : part.text))
    .join('');
}

/** "query parameter `status`", "header `X-Tier`", "body field `$.amount`", "the content type". */
export function describeReference(reference: string): Sentence {
  if (reference === 'contentType') return [text('the content type')];
  const dot = reference.indexOf('.');
  const source = reference.slice(0, dot);
  const name = reference.slice(dot + 1);
  const label: Readonly<Record<string, string>> = {
    path: 'path parameter ',
    query: 'query parameter ',
    header: 'header ',
    cookie: 'cookie ',
    body: 'body field ',
  };
  return [text(label[source] ?? `${source} `), code(name)];
}

function literal(value: Scalar): Part {
  return typeof value === 'string' ? code(value) : code(JSON.stringify(value));
}

function list(values: readonly Scalar[]): Part[] {
  return values.flatMap((value, index) => [
    ...(index === 0 ? [] : [text(index === values.length - 1 ? ' or ' : ', ')]),
    literal(value),
  ]);
}

const BOUND_WORDS: Readonly<Record<RangeBound, string>> = {
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
};

/** One condition: "query parameter `status` is `shipped`". */
export function describeCondition(condition: WireCondition): Sentence {
  const subject = describeReference(condition.reference);
  switch (condition.test) {
    case 'equals':
      return [...subject, text(' is '), literal(condition.value ?? null)];
    case 'in':
      return [...subject, text(' is one of '), ...list(condition.values ?? [])];
    case 'present':
      return [...subject, text(condition.present === false ? ' is missing' : ' is present')];
    case 'range': {
      const bounds = (['gt', 'gte', 'lt', 'lte'] as const).flatMap((bound) => {
        const value = condition.bounds?.[bound];
        return value === undefined ? [] : [`${BOUND_WORDS[bound]} ${String(value)}`];
      });
      return [...subject, text(` is a number ${bounds.join(' and ')}`)];
    }
    case 'matchesETag':
      return [...subject, text(' matches the entity tag '), code(condition.tag ?? '')];
  }
}

function conditions(list: readonly WireCondition[]): Part[] {
  return list.flatMap((condition, index) => [...(index === 0 ? [] : [text(' and ')]), ...describeCondition(condition)]);
}

function steps(names: readonly string[], ending: string): Part[] {
  return [
    ...names.flatMap((name, index) => [...(index === 0 ? [] : [text(', then ')]), identity(name)]),
    text(names.length > 1 ? ` ${ending}` : ''),
  ];
}

export interface ControlSentences {
  /** A numbered list: one sentence per rule, then the fall-through line. */
  readonly rules: {
    readonly scenario: string;
    readonly items: readonly Sentence[];
    readonly otherwise: Sentence;
  } | null;
  readonly pages: {
    readonly scenario: string;
    readonly by: Sentence;
    readonly rows: readonly { readonly key: string; readonly identity: string }[];
    readonly notes: readonly Sentence[];
  } | null;
  readonly sequence: { readonly scenario: string; readonly items: readonly Sentence[] } | null;
  readonly expect: { readonly scenario: string; readonly items: readonly Sentence[] } | null;
  readonly idempotent: Sentence | null;
}

/** Every control of an endpoint as sentences. */
export function controlSentences(controls: WireControls, idempotencyHeader = 'Idempotency-Key'): ControlSentences {
  const nextDecides = controls.pages !== null || controls.sequence !== null;
  return {
    rules:
      controls.rules === null
        ? null
        : {
            scenario: controls.rules.scenario,
            items: controls.rules.items.map((rule) => [
              text('If '),
              ...conditions(rule.when),
              text(', respond with '),
              ...(rule.steps === null
                ? [identity(rule.serve ?? '')]
                : steps(rule.steps, 'for every later matching request')),
              text('.'),
            ]),
            otherwise: nextDecides
              ? [text('Otherwise, the next control decides.')]
              : [text('Otherwise, respond with the plain responses.')],
          },
    pages:
      controls.pages === null
        ? null
        : {
            scenario: controls.pages.scenario,
            by: describeReference(controls.pages.by),
            rows: controls.pages.pages,
            notes: [
              controls.pages.whenAbsent === null
                ? [
                    text('If '),
                    ...describeReference(controls.pages.by),
                    text(' is missing, the plain responses answer.'),
                  ]
                : [
                    text('If '),
                    ...describeReference(controls.pages.by),
                    text(' is missing, use page '),
                    code(controls.pages.whenAbsent),
                    text('.'),
                  ],
              controls.pages.otherwise === null
                ? [text('For any other value, the plain responses answer.')]
                : [text('For any other value, respond with '), identity(controls.pages.otherwise), text('.')],
            ],
          },
    sequence:
      controls.sequence === null
        ? null
        : {
            scenario: controls.sequence.scenario,
            items: controls.sequence.steps.map((step, index, all) =>
              index === all.length - 1 && all.length > 1
                ? [text('and then '), identity(step), text(' for every later request.')]
                : [text(index === 0 ? 'First request: ' : 'Next: '), identity(step)],
            ),
          },
    expect:
      controls.expect === null
        ? null
        : {
            scenario: controls.expect.scenario,
            items: [
              ...controls.expect.conditions.map((condition): Sentence => [
                text('The request must have '),
                ...expectation(condition),
                text('.'),
              ]),
              controls.expect.onMismatch === null
                ? [text('Otherwise, respond with '), code('422 expectation-failed'), text('.')]
                : [text('Otherwise, respond with '), identity(controls.expect.onMismatch), text('.')],
            ],
          },
    idempotent: controls.idempotent
      ? [text('Retried requests with the same '), code(idempotencyHeader), text(' are replayed.')]
      : null,
  };
}

/** "header `Idempotency-Key`", or "body field `$.currency` that is `EUR`": the subject of an expectation. */
function expectation(condition: WireCondition): Sentence {
  const subject = describeReference(condition.reference);
  if (condition.test === 'present') return condition.present === false ? [...subject, text(' missing')] : subject;
  return [...subject, text(' that'), ...describeCondition(condition).slice(subject.length)];
}
