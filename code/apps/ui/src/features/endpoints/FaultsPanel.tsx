import type { WireFaults } from '../../atlas/wire.js';
import { Collapsible } from '../../components/Collapsible.js';
import type { Sentence } from './controlSentences.js';
import { faultSentences } from './faultSentences.js';

/**
 * The method's `fault.yaml` as plain sentences: its latency,
 * then each rule, with the scenario the file comes from.
 */
export function FaultsPanel({ faults, scenario }: { readonly faults: WireFaults; readonly scenario: string }) {
  const { latency, rules, sequences } = faultSentences(faults);
  const render = (sentence: Sentence) =>
    sentence.map((part, index) =>
      part.kind === 'code' ? (
        <code key={index} className="font-mono text-mono">
          {part.text}
        </code>
      ) : (
        <span key={index}>{part.kind === 'text' ? part.text : part.identity}</span>
      ),
    );
  return (
    <Collapsible
      title="Faults"
      framed={false}
      className="border-b border-line px-4 pt-2.5 pb-3"
      detail={<span className="text-faint">what a real request’s connection gets, before any response is chosen</span>}
    >
      <div className="mt-1.5 space-y-1 text-body text-fg">
        <p className="text-label text-muted">
          From <code>{faults.file}</code> in scenario {faults.scenario}
          {faults.inherited && faults.scenario !== scenario ? `, inherited by ${scenario}` : ''}.
        </p>
        {latency === null ? null : <p>{render(latency)}</p>}
        {rules.length === 0 ? null : (
          <ol aria-label="Fault rules" className="list-decimal space-y-0.5 pl-5">
            {rules.map((rule, index) => (
              <li key={index}>{render(rule)}</li>
            ))}
          </ol>
        )}
        {rules.length === 0 ? null : (
          <p className="text-muted">If no rule matches, the request is answered normally.</p>
        )}
        {sequences ? (
          <p className="text-label text-muted">
            Each session keeps its own step; requests without a session always get the first step.
          </p>
        ) : null}
        <p className="text-label text-muted">Explore describes these faults; it never performs them.</p>
      </div>
    </Collapsible>
  );
}
