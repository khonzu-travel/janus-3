import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { Endpoint, FixtureItem } from '../atlas/client.js';
import type { WireControls, WireTrace } from '../atlas/wire.js';
import { ControlsPanel } from './endpoints/ControlsPanel.js';
import { controlSentences, sentenceText } from './endpoints/controlSentences.js';
import { explain } from './explorer/Explanation.js';

// Choosing between responses in the UI.

const CONTROLS: WireControls = {
  rules: {
    scenario: 'default',
    items: [
      {
        when: [
          {
            reference: 'path.orderId',
            test: 'equals',
            value: 'ord-missing',
            values: undefined,
            present: undefined,
            bounds: undefined,
            tag: undefined,
          },
        ],
        serve: '404.missing',
        steps: null,
      },
      {
        when: [
          {
            reference: 'header.x-tier',
            test: 'in',
            value: undefined,
            values: ['gold', 'platinum'],
            present: undefined,
            bounds: undefined,
            tag: undefined,
          },
          {
            reference: 'body.$.quantity',
            test: 'range',
            value: undefined,
            values: undefined,
            present: undefined,
            bounds: { gt: undefined, gte: 1, lt: undefined, lte: 10 },
            tag: undefined,
          },
        ],
        serve: '200.priority',
        steps: null,
      },
      {
        when: [
          {
            reference: 'query.express',
            test: 'equals',
            value: 'true',
            values: undefined,
            present: undefined,
            bounds: undefined,
            tag: undefined,
          },
        ],
        serve: null,
        steps: ['202.pending', '200.shipped'],
      },
      {
        when: [
          {
            reference: 'header.if-none-match',
            test: 'matchesETag',
            value: undefined,
            values: undefined,
            present: undefined,
            bounds: undefined,
            tag: '"o-v2"',
          },
          {
            reference: 'cookie.cart',
            test: 'present',
            value: undefined,
            values: undefined,
            present: false,
            bounds: undefined,
            tag: undefined,
          },
        ],
        serve: '304.fresh',
        steps: null,
      },
    ],
  },
  pages: null,
  sequence: { scenario: 'default', steps: ['202.pending', '202.pending', '200'] },
  expect: {
    scenario: 'payment-declined',
    conditions: [
      {
        reference: 'header.idempotency-key',
        test: 'present',
        value: undefined,
        values: undefined,
        present: true,
        bounds: undefined,
        tag: undefined,
      },
      {
        reference: 'body.$.amount.currency',
        test: 'equals',
        value: 'EUR',
        values: undefined,
        present: undefined,
        bounds: undefined,
        tag: undefined,
      },
    ],
    onMismatch: '400.unexpected-payment',
  },
  idempotent: true,
};

const PAGES: WireControls = {
  rules: null,
  pages: {
    scenario: 'default',
    by: 'query.page',
    pages: [
      { key: '1', identity: '200' },
      { key: '2', identity: '200.page-2' },
    ],
    whenAbsent: '1',
    otherwise: '200.empty',
  },
  sequence: null,
  expect: null,
  idempotent: false,
};

describe('control sentences', () => {
  it('reads every rule, test and step as a sentence', () => {
    const sentences = controlSentences(CONTROLS);
    expect(sentences.rules?.items.map((item) => sentenceText(item, true))).toEqual([
      'If path parameter orderId is ord-missing, respond with **404.missing**.',
      'If header x-tier is one of gold or platinum and body field $.quantity is a number at least 1 and at most 10, respond with **200.priority**.',
      'If query parameter express is true, respond with **202.pending**, then **200.shipped** for every later matching request.',
      'If header if-none-match matches the entity tag "o-v2" and cookie cart is missing, respond with **304.fresh**.',
    ]);
    expect(sentenceText(sentences.rules?.otherwise ?? [])).toBe('Otherwise, the next control decides.');
    expect(sentences.sequence?.items.map((item) => sentenceText(item, true))).toEqual([
      'First request: **202.pending**',
      'Next: **202.pending**',
      'and then **200** for every later request.',
    ]);
    expect(sentences.expect?.items.map((item) => sentenceText(item, true))).toEqual([
      'The request must have header idempotency-key.',
      'The request must have body field $.amount.currency that is EUR.',
      'Otherwise, respond with **400.unexpected-payment**.',
    ]);
    expect(sentenceText(sentences.idempotent ?? [])).toBe(
      'Retried requests with the same Idempotency-Key are replayed.',
    );
  });

  it('reads pages with whenAbsent and otherwise, and plain fall-through for rules alone', () => {
    const pages = controlSentences(PAGES).pages;
    expect(pages?.notes.map((note) => sentenceText(note, true))).toEqual([
      'If query parameter page is missing, use page 1.',
      'For any other value, respond with **200.empty**.',
    ]);
    const alone = controlSentences({ ...CONTROLS, sequence: null });
    expect(sentenceText(alone.rules?.otherwise ?? [])).toBe('Otherwise, respond with the plain responses.');
  });
});

const fixture = (id: string, identity: string): FixtureItem => {
  const [status, variant] = identity.split('.');
  return {
    id,
    status: Number(status),
    variant: variant ?? null,
    identity,
    mediaType: 'application/json',
    wireContentType: 'application/json',
    locale: null,
    byteLength: 2,
    headers: [],
    digest: null,
    promotion: null,
    sidecar: null,
    holder: 'default',
    origin: 'own',
    detailUrl: `http://janus.test/_janus/fixtures/${id}?at=aaaaaaaaaaaaaaaa`,
  };
};

const ENDPOINT: Endpoint = {
  snapshotVersion: 'aaaaaaaaaaaaaaaa',
  id: 'ep_0000000000000001',
  scenario: 'default',
  method: 'GET',
  path: '/v1/orders/{orderId}',
  pathParameters: ['orderId'],
  fixtures: [fixture('fx_0000000000000001', '200'), fixture('fx_0000000000000002', '404.missing')],
  representationGroups: [],
  accepts: null,
  origin: 'own',
  matrix: null,
  controls: CONTROLS,
  faults: null,
};

function renderPanel(controls: WireControls) {
  const router = createMemoryRouter(
    [{ path: '*', element: <ControlsPanel endpoint={ENDPOINT} controls={controls} search="" /> }],
    { initialEntries: ['/'] },
  );
  render(<RouterProvider router={router} />);
}

describe('the Controls panel', () => {
  it('lists each control with its scenario and links identities to their responses', () => {
    renderPanel(CONTROLS);
    const panel = screen.getByRole('region', { name: 'Controls' });
    const rules = within(panel).getByRole('list', { name: 'Rules' });
    expect(within(rules).getAllByRole('listitem')).toHaveLength(4);
    expect(within(panel).getByText('payment-declined', { exact: false }).textContent).toContain('expect.yaml');
    const link = within(rules).getByRole('link', { name: 'Response 404.missing' });
    expect(link.getAttribute('href')).toBe('/endpoints/ep_0000000000000001/fixtures/fx_0000000000000002');
    // An identity with no representation here is named, not linked.
    expect(within(rules).queryByRole('link', { name: 'Response 304.fresh' })).toBeNull();
    expect(within(panel).getByRole('list', { name: 'Steps' }).textContent).toContain('for every later request');
  });

  it('shows pages as a table of keys and responses', () => {
    renderPanel(PAGES);
    const table = screen.getByRole('table', { name: 'Responses by query parameter page' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual(['query parameter pageResponse', '1200', '2200.page-2']);
  });
});

const trace = (patch: Partial<WireTrace>): WireTrace => ({
  snapshotVersion: 'aaaaaaaaaaaaaaaa',
  normalizedPath: '/v1/orders/ord-1',
  scenario: 'default',
  selection: null,
  resolvedFrom: null,
  shadowed: [],
  shadowedCount: null,
  session: null,
  outcome: {
    kind: 'matched',
    allowed: null,
    axis: null,
    available: null,
    accepted: null,
    reason: null,
    token: null,
    source: null,
    known: null,
    failed: null,
    registration: null,
    upstream: null,
    forwardedHeaders: null,
    fault: null,
  },
  route: { template: '/v1/orders/{orderId}', params: { orderId: 'ord-1' }, considered: [] },
  negotiation: null,
  headers: null,
  render: null,
  choice: null,
  expect: null,
  sequence: null,
  replay: null,
  transport: null,
  ...patch,
});

describe('explorer decisions', () => {
  const step = (steps: ReturnType<typeof explain>, title: string) => {
    const found = steps.find((entry) => entry.title === title);
    if (found === undefined) throw new Error(`no step ${title}`);
    render(<div>{found.detail}</div>);
    const text = document.body.textContent;
    document.body.innerHTML = '';
    return { state: found.state, text };
  };

  it('explains the rule, the sequence position and the replay', () => {
    const steps = explain(
      trace({
        choice: { identity: '202.pending', by: 'rule', rule: 3, page: null, step: 1, rulesTried: 3 },
        sequence: { rule: 3, position: 1, steps: 2, advanced: false, notAdvancedBecause: 'simulation' },
        replay: { outcome: 'would-replay' },
      }),
      202,
    );
    expect(step(steps, 'Response choice')).toEqual({
      state: 'passed',
      text: 'Chose 202.pending by a rule in variants.yaml (rule 3), step 1.Rules tried: 3, the last of them matched.',
    });
    expect(step(steps, 'Sequence').text).toBe(
      "Rule 3's sequence is at step 1 of 2. It did not advance: a simulation changes no session.",
    );
    expect(step(steps, 'Replay').state).toBe('info');
  });

  it('explains pages and failed expectations by reference only', () => {
    const paged = explain(
      trace({
        choice: {
          identity: '200',
          by: 'page',
          rule: null,
          page: { key: '1', via: 'whenAbsent' },
          step: null,
          rulesTried: 0,
        },
      }),
      200,
    );
    expect(step(paged, 'Response choice').text).toContain('whenAbsent used page 1');
    const failed = explain(
      trace({
        outcome: { ...trace({}).outcome, kind: 'expectation-failed', failed: ['body.$.amount.currency'] },
        expect: { passed: false, failed: ['body.$.amount.currency'] },
      }),
      422,
    );
    expect(step(failed, 'Expectations')).toEqual({
      state: 'failed',
      text: 'Failing conditions: body.$.amount.currency.',
    });
  });
});
