import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { WireCondition, WireFault, WireFaults, WireTrace, WireTransportTrace } from '../atlas/wire.js';
import { decodeEndpoint, decodeExplanation, decodeScenarios } from '../atlas/wire.js';
import { sentenceText } from './endpoints/controlSentences.js';
import { FaultsPanel } from './endpoints/FaultsPanel.js';
import { describeFault, faultSentences, latencyText } from './endpoints/faultSentences.js';
import { explain } from './explorer/Explanation.js';

// Faults, latency and the Transport stage in the UI.

const header = (name: string, value: string): WireCondition => ({
  reference: `header.${name}`,
  test: 'equals',
  value,
  values: undefined,
  present: undefined,
  bounds: undefined,
  tag: undefined,
});

const fault = (kind: WireFault['kind'], extra: Partial<WireFault> = {}): WireFault => ({
  kind,
  bytes: null,
  form: null,
  ...extra,
});

const FAULTS: WireFaults = {
  file: '/v1/payments/POST/fault.yaml',
  scenario: 'flaky-network',
  inherited: false,
  latency: { min: 200, max: 800 },
  rules: [
    { when: [header('x-simulate', 'reset')], fault: [fault('reset')] },
    { when: [header('x-simulate', 'cut')], fault: [fault('truncate', { bytes: 128 })] },
    { when: [], fault: [fault('timeout'), fault('none')] },
  ],
};

describe('fault sentences', () => {
  it('describes every kind and form', () => {
    expect(
      [
        fault('reset'),
        fault('timeout'),
        fault('truncate'),
        fault('truncate', { bytes: 1 }),
        fault('truncate', { bytes: 128 }),
        fault('malformed', { form: 'status-line' }),
        fault('malformed', { form: 'header-line' }),
        fault('malformed', { form: 'conflicting-length' }),
        fault('malformed', { form: 'bad-chunk' }),
        fault('none'),
      ].map((item) => sentenceText(describeFault(item))),
    ).toEqual([
      'reset the connection',
      'hold the connection open without answering',
      'cut the response off halfway through its body',
      'cut the response off after 1 byte of body',
      'cut the response off after 128 bytes of body',
      'send a response whose status line is not valid HTTP',
      'send a response with a header line that has no colon',
      'send a response with two conflicting Content-Length headers',
      'send a response with a broken chunked body',
      'answer normally',
    ]);
  });

  it('turns each rule, a sequence and the latency into sentences', () => {
    const sentences = faultSentences(FAULTS);
    expect(sentences.rules.map((rule) => sentenceText(rule))).toEqual([
      'When header x-simulate is reset, reset the connection.',
      'When header x-simulate is cut, cut the response off after 128 bytes of body.',
      'Otherwise, hold the connection open without answering on the first request, then answer normally.',
    ]);
    expect(sentenceText(sentences.latency ?? [])).toBe(
      'Every request waits between 200 and 800 ms before the first byte.',
    );
    expect(sentences.sequences).toBe(true);
    const lone = faultSentences({ ...FAULTS, latency: { ms: 0 }, rules: [{ when: [], fault: [fault('reset')] }] });
    expect(lone.rules.map((rule) => sentenceText(rule))).toEqual(['Reset the connection.']);
    expect(sentenceText(lone.latency ?? [])).toMatch(/^No delay/);
    expect(latencyText({ ms: 1500 })).toBe('1500 ms');
  });
});

describe('the Faults panel', () => {
  it('names the file and scenario, the latency and each rule', () => {
    render(<FaultsPanel faults={FAULTS} scenario="flaky-network" />);
    const panel = screen.getByRole('region', { name: 'Faults' });
    expect(panel.textContent).toContain('From /v1/payments/POST/fault.yaml in scenario flaky-network.');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3);
    expect(panel.textContent).toContain('Each session keeps its own step');
  });

  it('says when the file is inherited', () => {
    render(<FaultsPanel faults={{ ...FAULTS, inherited: true }} scenario="slow" />);
    expect(screen.getByRole('region', { name: 'Faults' }).textContent).toContain(
      'in scenario flaky-network, inherited by slow.',
    );
  });
});

describe('the wire decoders', () => {
  it('reads faults, the matrix column, the inventory badge and scenario latency, defaulting for older servers', () => {
    const base = {
      snapshotVersion: 'aaaaaaaaaaaaaaaa',
      id: 'ep_0000000000000001',
      scenario: 'default',
      method: 'POST',
      path: '/v1/payments',
      pathParameters: [],
      fixtures: [],
      origin: 'own',
    };
    expect(decodeEndpoint(base, '').faults).toBeNull();
    const decoded = decodeEndpoint(
      {
        ...base,
        faults: {
          file: '/v1/payments/POST/fault.yaml',
          scenario: 'default',
          inherited: false,
          latency: { ms: 5 },
          rules: [
            {
              when: [],
              fault: [
                { kind: 'malformed', form: 'bad-chunk' },
                { kind: 'truncate', bytes: 3 },
              ],
            },
          ],
        },
      },
      '',
    );
    expect(decoded.faults?.rules[0]?.fault).toEqual([
      { kind: 'malformed', bytes: null, form: 'bad-chunk' },
      { kind: 'truncate', bytes: 3, form: null },
    ]);
    const scenarios = decodeScenarios(
      {
        snapshotVersion: 'aaaaaaaaaaaaaaaa',
        configuredDefault: 'default',
        items: [
          {
            name: 'default',
            description: null,
            extends: null,
            chain: ['default'],
            ids: [],
            overrides: [],
            removes: [],
            endpoints: { own: 0, inherited: 0, total: 0 },
            endpointsHref: 'endpoints',
          },
        ],
      },
      '',
    );
    expect(scenarios.items[0]?.latency).toEqual({ own: null, effective: null });
  });
});

const TRANSPORT: WireTransportTrace = {
  latency: { ms: 300, source: 'scenario', scenario: 'flaky-network', profile: { ms: 300 } },
  fault: { kind: 'timeout', rule: 1, step: 2, bytes: null, form: null },
  rulesTried: 1,
  faultSequence: { position: 2, steps: 3, advanced: false, notAdvancedBecause: 'simulation' },
  performed: false,
  requestCodings: ['gzip'],
  responseCoding: null,
  cors: null,
};

describe('the explorer’s Transport stage', () => {
  const explanation = (transport: WireTransportTrace, kind: string, fault: string | null) =>
    decodeExplanation(
      {
        snapshotVersion: 'aaaaaaaaaaaaaaaa',
        response: null,
        trace: {
          snapshotVersion: 'aaaaaaaaaaaaaaaa',
          normalizedPath: '/v1/orders',
          outcome: { kind, ...(fault === null ? {} : { fault }) },
          route: { template: '/v1/orders', params: {} },
          transport,
        },
        fixture: null,
        notes: ['faults and latency are described, not performed'],
      },
      '',
    );

  it('reports the delay, the rule and step, and the no-response outcome', () => {
    const decoded = explanation(TRANSPORT, 'fault', 'timeout');
    const trace: WireTrace = decoded.trace;
    expect(trace.transport).toEqual(TRANSPORT);
    const steps = explain(trace, null);
    const transport = steps.find((step) => step.title === 'Transport');
    expect(transport?.state).toBe('failed');
    render(<div>{transport?.detail}</div>);
    const text = document.body.textContent;
    expect(text).toContain('wait 300 ms before the first byte');
    expect(text).toContain('Fault rule 1, step 2 of 3');
    expect(text).toContain('held open without an answer');
    expect(text).toContain('Request codings removed: gzip');
    expect(text).toContain('Described, not performed.');
    const outcome = steps.find((step) => step.title === 'Outcome');
    expect(outcome?.state).toBe('passed');
  });

  it('notes no delay and no matching rule', () => {
    const decoded = explanation(
      { ...TRANSPORT, latency: null, fault: null, faultSequence: null, requestCodings: [], responseCoding: 'br' },
      'matched',
      null,
    );
    const step = explain(decoded.trace, 200).find((item) => item.title === 'Transport');
    expect(step?.state).toBe('info');
    render(<div>{step?.detail}</div>);
    expect(document.body.textContent).toContain('No delay. No fault rule matched.');
    expect(document.body.textContent).toContain('Response coding: br.');
  });
});
