import { describe, expect, it } from 'vitest';

import { utf8Encode } from '../bytes.js';
import { endpointId, fixtureId } from '../ids.js';
import type { FixtureFiles, StartupError } from '../types/index.js';
import { buildSnapshot, MAX_CHAIN } from './build.js';
import { parseFlow } from './flow.js';
import { snapshotData, type RouteNode, type ScenarioData } from './snapshot.js';

const files = (entries: Readonly<Record<string, string>>): FixtureFiles =>
  new Map(Object.entries(entries).map(([path, value]) => [path, utf8Encode(value)]));

function errorsOf(entries: Readonly<Record<string, string>>): readonly StartupError[] {
  const result = buildSnapshot(files(entries));
  if (result.ok) throw new Error('expected startup errors');
  return result.errors;
}

const codesOf = (entries: Readonly<Record<string, string>>): string[] =>
  errorsOf(entries).map((error) => `${error.code} ${error.path}`);

function scenarios(entries: Readonly<Record<string, string>>): ReadonlyMap<string, ScenarioData> {
  const result = buildSnapshot(files(entries));
  if (!result.ok)
    throw new Error(result.errors.map((error) => `${error.code} ${error.path}: ${error.message}`).join('\n'));
  return snapshotData(result.snapshot).scenarios;
}

/** Every route and method of an effective tree with its files: "GET /v1/cart: 200 application/json (default)". */
function treeOf(scenario: ScenarioData | undefined): string[] {
  const out: string[] = [];
  const visit = (node: RouteNode): void => {
    const path = `/${node.segments.map((segment) => (segment.kind === 'param' ? `{${segment.name}}` : segment.value)).join('/')}`;
    for (const [method, stored] of [...node.methods].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const groups = [...(stored.fallback === null ? [] : [stored.fallback]), ...stored.localized];
      const reps = groups.flatMap((group) =>
        group.representations.map(
          (response) =>
            `${String(response.status)}${response.locale === null ? '' : ` [${response.locale}]`} ${response.mediaType ?? 'bodyless'} (${response.scenario})`,
        ),
      );
      out.push(`${method} ${path}: ${reps.join(', ')}`);
    }
    for (const child of [...node.children.keys()].sort()) visit(node.children.get(child) as RouteNode);
    if (node.param !== null) visit(node.param.node);
  };
  if (scenario !== undefined) visit(scenario.root);
  return out;
}

function findMethod(scenario: ScenarioData | undefined, path: readonly string[]): RouteNode | undefined {
  let node = scenario?.root;
  for (const segment of path) node = node?.children.get(segment) ?? node?.param?.node;
  return node;
}

const BASE = {
  'default/v1/cart/GET/200.json': '{"items":[]}',
  'default/v1/payments/POST/201.json': '{"id":"pay_1"}',
  'default/v1/payments/POST/201.headers.json': '{"Location":"/v1/payments/pay_1"}',
};

describe('flow.yaml', () => {
  const parse = (text: string) => parseFlow(utf8Encode(text));
  const problems = (text: string): string[] => {
    const result = parse(text);
    return result.ok ? [] : result.problems.map((problem) => `${problem.code}: ${problem.message}`);
  };

  it('reads every key', () => {
    const result = parse(
      [
        'description: Two items in a guest cart.',
        'extends: guest-checkout',
        'ids:',
        '  cartId: cart_multi_1',
        '  orderId: "42"',
        'overrides:',
        '  - /v1/cart/GET',
        '  - /GET',
        'removes:',
        '  - /v1/orders/POST/409.json',
        '  - /v1/orders/POST/accepts.yaml',
      ].join('\n'),
    );
    expect(result).toMatchObject({
      ok: true,
      flow: {
        description: 'Two items in a guest cart.',
        extends: 'guest-checkout',
        ids: [
          { name: 'cartId', value: 'cart_multi_1' },
          { name: 'orderId', value: '42' },
        ],
        overrides: [{ value: '/v1/cart/GET' }, { value: '/GET' }],
        removes: [{ value: '/v1/orders/POST/409.json' }, { value: '/v1/orders/POST/accepts.yaml' }],
      },
    });
  });

  it('treats an empty file as declaring nothing', () => {
    expect(parse('')).toMatchObject({ ok: true, flow: { extends: null, ids: [], overrides: [], removes: [] } });
    expect(parse('# only a comment\n')).toMatchObject({ ok: true, flow: { extends: null } });
  });

  it('rejects invalid values with their positions', () => {
    expect(parse('description: 3')).toMatchObject({
      ok: false,
      problems: [
        { code: 'invalid-flow', message: '"description" must be a string', position: { line: 1, column: 14 } },
      ],
    });
    expect(problems(`description: ${'x'.repeat(1001)}`)).toEqual([
      'invalid-flow: "description" is longer than 1000 characters',
    ]);
    expect(problems(`description: ${'x'.repeat(1000)}`)).toEqual([]);
    expect(problems('extends: Guest')[0]).toMatch(/^invalid-flow: "extends" must be a scenario name/);
    expect(problems(`extends: ${'a'.repeat(65)}`)[0]).toMatch(/at most 64 bytes/);
    expect(problems('extends: [a]')).toEqual(['invalid-flow: "extends" must be a scenario name']);
    expect(problems('ids: [a]')).toEqual(['invalid-flow: "ids" must be a mapping of names to string values']);
    expect(problems('ids:\n  1abc: x')[0]).toMatch(/"ids" names must start with a letter/);
    expect(problems(`ids:\n  ${'a'.repeat(65)}: x`)[0]).toMatch(/"ids" names must start with a letter/);
    expect(problems('ids:\n  cartId: ""')).toEqual([
      'invalid-flow: "ids.cartId" must be a string of 1 to 256 characters',
    ]);
    expect(problems('ids:\n  cartId: 42')).toEqual([
      'invalid-flow: "ids.cartId" must be a string of 1 to 256 characters',
    ]);
    expect(problems(`ids:\n  cartId: ${'x'.repeat(257)}`)).toHaveLength(1);
    expect(problems('overrides: /v1/cart/GET')[0]).toMatch(/"overrides" must be a list/);
    expect(problems('overrides: [v1/cart/GET]')[0]).toMatch(/"overrides" entry must be an endpoint key/);
    expect(problems('overrides: [/v1/cart/get]')[0]).toMatch(/"overrides" entry must be an endpoint key/);
    expect(problems('overrides: [/v1//GET]')[0]).toMatch(/"overrides" entry must be an endpoint key/);
    expect(problems('removes: [/v1/cart/GET]')[0]).toMatch(/"removes" entry must be a file key/);
    expect(problems('removes: [/200.json]')[0]).toMatch(/"removes" entry must be a file key/);
  });

  it('rejects duplicate entries in either list', () => {
    expect(problems('overrides: [/a/GET, /a/GET]')).toEqual([
      'duplicate-scenario-reference: "overrides" lists "/a/GET" more than once',
    ]);
    expect(problems('removes: [/a/GET/200.json, /a/GET/200.json]')).toEqual([
      'duplicate-scenario-reference: "removes" lists "/a/GET/200.json" more than once',
    ]);
  });

  it('rejects unknown keys and applies the YAML rules', () => {
    expect(problems('extend: default')[0]).toMatch(/^invalid-flow: unknown key "extend" in flow.yaml/);
    expect(problems('description: a\ndescription: b')[0]).toMatch(/^invalid-flow: duplicate key/);
    expect(problems('a: &x 1\nb: *x')).toContain('invalid-flow: aliases are not allowed in flow.yaml');
    expect(problems('description: !custom x')).toEqual(['invalid-flow: custom tag "!custom" is not allowed']);
    expect(problems('- a')).toEqual(['invalid-flow: flow.yaml must be a mapping of scenario settings']);
    expect(problems('a: [')[0]).toMatch(/^invalid-flow: invalid YAML/);
    expect(problems('---\na: 1\n---\nb: 2')[0]).toMatch(/^invalid-flow: invalid YAML/);
  });
});

describe('scenario names and graph', () => {
  it('accepts names matching the grammar and rejects the rest', () => {
    expect(scenarios({ ...BASE, 'a-1/GET/204': '', '9/GET/204': '' }).size).toBe(3);
    expect(
      codesOf({ ...BASE, 'Staging/GET/204': '', 'a--b/GET/204': '', '-a/GET/204': '', 'a_b/GET/204': '' }),
    ).toEqual([
      'invalid-scenario-name -a',
      'invalid-scenario-name Staging',
      'invalid-scenario-name a--b',
      'invalid-scenario-name a_b',
    ]);
    expect(codesOf({ ...BASE, [`${'a'.repeat(65)}/GET/204`]: '' })).toEqual([
      `invalid-scenario-name ${'a'.repeat(65)}`,
    ]);
    expect(scenarios({ ...BASE, [`${'a'.repeat(64)}/GET/204`]: '' }).size).toBe(2);
  });

  it('reports top-level names that differ only by case', () => {
    expect(codesOf({ ...BASE, 'Default/GET/204': '' })).toEqual([
      'case-conflict Default',
      'invalid-scenario-name Default',
    ]);
  });

  it('allows at most 256 scenarios', () => {
    const tree: Record<string, string> = { ...BASE };
    for (let index = 0; index < 255; index++) tree[`s${String(index)}/flow.yaml`] = '';
    expect(buildSnapshot(files(tree)).ok).toBe(true);
    tree['s255/flow.yaml'] = '';
    expect(codesOf(tree)).toEqual(['too-many-scenarios ']);
  });

  it('allows only flow.yaml directly in a scenario directory', () => {
    expect(codesOf({ ...BASE, 'child/notes.md': '' })).toEqual(['misplaced-file child/notes.md']);
    expect(scenarios({ ...BASE, 'child/flow.yaml': '', 'child/.DS_Store': '' }).get('child')?.parent).toBe('default');
  });

  it('defaults the parent to default, and default to none', () => {
    const all = scenarios({
      ...BASE,
      'a/GET/204': '',
      'b/flow.yaml': 'extends: a',
      'default/flow.yaml': 'ids: {x: y}',
    });
    expect(all.get('default')).toMatchObject({ parent: null, chain: ['default'] });
    expect(all.get('a')).toMatchObject({ parent: 'default', chain: ['a', 'default'] });
    expect(all.get('b')).toMatchObject({ parent: 'a', chain: ['b', 'a', 'default'] });
  });

  it('reports unknown parents, extends in default, cycles and deep chains', () => {
    expect(errorsOf({ ...BASE, 'a/flow.yaml': 'extends: missing' })).toEqual([
      expect.objectContaining({
        code: 'unknown-parent-scenario',
        path: 'a/flow.yaml',
        line: 1,
        column: 10,
        token: 'missing',
      }),
    ]);
    expect(codesOf({ ...BASE, 'default/flow.yaml': 'extends: a', 'a/GET/204': '' })).toEqual([
      'invalid-flow default/flow.yaml',
    ]);
    expect(codesOf({ ...BASE, 'a/flow.yaml': 'extends: a' })).toEqual(['scenario-cycle a/flow.yaml']);
    const cycle = errorsOf({
      ...BASE,
      'a/flow.yaml': 'extends: c',
      'b/flow.yaml': 'extends: a',
      'c/flow.yaml': 'extends: b',
      'd/flow.yaml': 'extends: c',
    });
    expect(cycle).toEqual([
      expect.objectContaining({
        code: 'scenario-cycle',
        path: 'a/flow.yaml',
        message: 'the scenarios "a", "b", "c" extend each other in a cycle',
      }),
    ]);

    const chain: Record<string, string> = { ...BASE };
    for (let index = 1; index < MAX_CHAIN; index++) {
      chain[`s${String(index)}/flow.yaml`] = index === 1 ? '' : `extends: s${String(index - 1)}`;
    }
    expect(scenarios(chain).get(`s${String(MAX_CHAIN - 1)}`)?.chain).toHaveLength(MAX_CHAIN);
    chain[`s${String(MAX_CHAIN)}/flow.yaml`] = `extends: s${String(MAX_CHAIN - 1)}`;
    chain[`s${String(MAX_CHAIN + 1)}/flow.yaml`] = `extends: s${String(MAX_CHAIN)}`;
    expect(codesOf(chain)).toEqual([`scenario-chain-too-deep s${String(MAX_CHAIN)}/flow.yaml`]);
  });

  it('reports an unknown scenarios.default', () => {
    const result = buildSnapshot(files(BASE), { defaultScenario: 'missing' });
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'unknown-default-scenario', token: 'missing' }] });
    expect(buildSnapshot(files({ ...BASE, 'a/GET/204': '' }), { defaultScenario: 'a' }).ok).toBe(true);
  });
});

describe('effective trees', () => {
  it('inherits everything a child does not declare', () => {
    const all = scenarios({ ...BASE, 'child/flow.yaml': 'description: nothing differs' });
    expect(treeOf(all.get('child'))).toEqual(treeOf(all.get('default')));
    expect(all.get('child')?.description).toBe('nothing differs');
  });

  it('replaces by representation key regardless of spelling, keeping other representations', () => {
    const all = scenarios({
      'default/v1/cart/GET/200.json': '{}',
      'default/v1/cart/GET/200.xml': '<a/>',
      'default/v1/cart/GET/200_[fr].json': '{}',
      'child/v1/cart/GET/200_{application-json}.json': '{"child":true}',
    });
    expect(treeOf(all.get('child'))).toEqual([
      'GET /v1/cart: 200 application/json (child), 200 application/xml (default), 200 [fr] application/json (default)',
    ]);
  });

  it('lets sidecars travel with their response files', () => {
    const all = scenarios({
      ...BASE,
      'default/v1/payments/POST/201.xml': '<a/>',
      'replace/v1/payments/POST/201.json': '{"id":"pay_2"}',
      'replace/v1/payments/POST/201.headers.json': '{"Location":"/v1/payments/pay_2"}',
      'keep/flow.yaml': 'removes: [/v1/payments/POST/201.json]',
    });
    const header = (scenario: string, mediaType: string) => {
      const stored = findMethod(all.get(scenario), ['v1', 'payments'])?.methods.get('POST');
      return stored?.fallback?.representations.find((response) => response.mediaType === mediaType)?.headers[
        'location'
      ];
    };
    expect(header('replace', 'application/json')).toEqual(['/v1/payments/pay_2']);
    expect(header('replace', 'application/xml')).toEqual(['/v1/payments/pay_1']);
    expect(header('keep', 'application/xml')).toEqual(['/v1/payments/pay_1']);
  });

  it('does not let a replacing response inherit the replaced file’s sidecar', () => {
    const all = scenarios({
      'default/v1/a/GET/200.json': '{}',
      'default/v1/a/GET/200.headers.json': '{"X-Parent":"1"}',
      'child/v1/a/GET/200.json': '{"c":1}',
    });
    const response = findMethod(all.get('child'), ['v1', 'a'])?.methods.get('GET')?.fallback?.representations[0];
    expect(response?.headers['x-parent']).toBeUndefined();
  });

  it('drops a parent sidecar whose responses are all removed, and needs a child sidecar to have its own response', () => {
    expect(
      scenarios({
        ...BASE,
        'child/flow.yaml': 'removes: [/v1/payments/POST/201.json]',
        'child/v1/payments/POST/202.json': '{}',
      }).get('child'),
    ).toBeDefined();
    expect(codesOf({ ...BASE, 'child/v1/cart/GET/200.headers.json': '{"X-A":"1"}' })).toEqual([
      'orphan-header-sidecar child/v1/cart/GET/200.headers.json',
    ]);
  });

  it('applies overrides, then removes, then own files', () => {
    const all = scenarios({
      'default/v1/orders/POST/201.json': '{}',
      'default/v1/orders/POST/accepts.yaml': 'accepts: [application/json]',
      'default/v1/orders/GET/200.json': '[]',
      'default/v1/orders/DELETE/204': '',
      'child/flow.yaml': 'overrides: [/v1/orders/POST]\nremoves: [/v1/orders/GET/200.json]',
      'child/v1/orders/POST/409.json': '{}',
      'child/v1/orders/GET/404.json': '{}',
    });
    expect(treeOf(all.get('child'))).toEqual([
      'DELETE /v1/orders: 204 bodyless (default)',
      'GET /v1/orders: 404 application/json (child)',
      'POST /v1/orders: 409 application/json (child)',
    ]);
    expect(findMethod(all.get('child'), ['v1', 'orders'])?.methods.get('POST')?.accepts).toBeNull();
  });

  it('removes a method with overrides and no own files, and the route with its last method', () => {
    const all = scenarios({
      ...BASE,
      'default/v1/cart/DELETE/204': '',
      'a/flow.yaml': 'overrides: [/v1/cart/GET]',
      'b/flow.yaml': 'overrides: [/v1/cart/GET, /v1/cart/DELETE]',
    });
    expect(treeOf(all.get('a'))).toContain('DELETE /v1/cart: 204 bodyless (default)');
    expect(treeOf(all.get('a')).some((line) => line.startsWith('GET /v1/cart'))).toBe(false);
    expect(treeOf(all.get('b')).some((line) => line.includes('/v1/cart'))).toBe(false);
    expect(all.get('b')?.routeCount).toBe(1);
  });

  it('removes accepts.yaml, and an own accepts.yaml replaces the inherited one', () => {
    const all = scenarios({
      'default/v1/a/POST/201.json': '{}',
      'default/v1/a/POST/accepts.yaml': 'accepts: [application/json]',
      'open/flow.yaml': 'removes: [/v1/a/POST/accepts.yaml]',
      'xml/v1/a/POST/accepts.yaml': 'accepts: [application/xml]',
    });
    const accepts = (name: string) => findMethod(all.get(name), ['v1', 'a'])?.methods.get('POST');
    expect(accepts('open')?.accepts).toBeNull();
    expect(accepts('xml')).toMatchObject({ accepts: { mediaTypes: ['application/xml'] }, acceptsScenario: 'xml' });
    expect(accepts('default')).toMatchObject({ acceptsScenario: 'default' });
  });

  it('adds routes and methods the parent does not have', () => {
    const all = scenarios({ ...BASE, 'child/v1/extra/{id}/PUT/204': '' });
    expect(treeOf(all.get('child'))).toContain('PUT /v1/extra/{id}: 204 bodyless (child)');
    expect(treeOf(all.get('default')).some((line) => line.includes('extra'))).toBe(false);
  });

  it('merges ids down the chain, the nearest value winning', () => {
    const all = scenarios({
      ...BASE,
      'default/flow.yaml': 'ids: {cartId: cart_1, userId: user_1}',
      'a/flow.yaml': 'ids: {cartId: cart_a, paymentId: pay_a}',
      'b/flow.yaml': 'extends: a\nids: {paymentId: pay_b}',
    });
    expect(all.get('b')?.ids).toEqual([
      { name: 'cartId', value: 'cart_a', from: 'a' },
      { name: 'paymentId', value: 'pay_b', from: 'b' },
      { name: 'userId', value: 'user_1', from: 'default' },
    ]);
  });
});

describe('scenario references', () => {
  it('reports entries that change nothing', () => {
    expect(errorsOf({ ...BASE, 'child/flow.yaml': 'overrides: [/v1/missing/GET]' })).toEqual([
      expect.objectContaining({
        code: 'stale-scenario-reference',
        path: 'child/flow.yaml',
        line: 1,
        token: '/v1/missing/GET',
      }),
    ]);
    expect(codesOf({ ...BASE, 'child/flow.yaml': 'removes: [/v1/cart/GET/404.json]' })).toEqual([
      'stale-scenario-reference child/flow.yaml',
    ]);
    // Removes are checked after overrides: an emptied directory has nothing left to remove.
    expect(
      codesOf({ ...BASE, 'child/flow.yaml': 'overrides: [/v1/cart/GET]\nremoves: [/v1/cart/GET/200.json]' }),
    ).toEqual(['stale-scenario-reference child/flow.yaml']);
    // A file a grandparent removed is not in the parent's effective tree.
    expect(
      codesOf({
        ...BASE,
        'a/flow.yaml': 'removes: [/v1/cart/GET/200.json]',
        'b/flow.yaml': 'extends: a\nremoves: [/v1/cart/GET/200.json]',
      }),
    ).toEqual(['stale-scenario-reference b/flow.yaml']);
    // A sidecar is not a file key.
    expect(codesOf({ ...BASE, 'child/flow.yaml': 'removes: [/v1/payments/POST/201.headers.json]' })).toEqual([
      'stale-scenario-reference child/flow.yaml',
    ]);
  });

  it('reports removing a file the scenario defines itself', () => {
    expect(
      codesOf({ ...BASE, 'child/flow.yaml': 'removes: [/v1/cart/GET/200.json]', 'child/v1/cart/GET/200.json': '{}' }),
    ).toEqual(['contradictory-scenario-reference child/flow.yaml']);
    expect(
      codesOf({
        ...BASE,
        'child/flow.yaml': 'removes: [/v1/cart/GET/200.json]',
        'child/v1/cart/GET/200_{application-json}.json': '{}',
      }),
    ).toEqual(['contradictory-scenario-reference child/flow.yaml']);
  });

  it('reports duplicate entries', () => {
    expect(codesOf({ ...BASE, 'child/flow.yaml': 'overrides: [/v1/cart/GET, /v1/cart/GET]' })).toEqual([
      'duplicate-scenario-reference child/flow.yaml',
    ]);
  });

  it('lets removes answer 404 where the parent answers 200', () => {
    expect(codesOf({ ...BASE, 'child/v1/cart/GET/404.json': '{}' })).toEqual(['multiple-responses child/v1/cart/GET']);
    const all = scenarios({
      ...BASE,
      'child/flow.yaml': 'removes: [/v1/cart/GET/200.json]',
      'child/v1/cart/GET/404.json': '{}',
    });
    expect(treeOf(all.get('child'))).toContain('GET /v1/cart: 404 application/json (child)');
  });
});

describe('per-scenario validation', () => {
  it('names the scenario and every contributing file', () => {
    expect(errorsOf({ ...BASE, 'child/v1/cart/GET/404.json': '{}' })).toEqual([
      expect.objectContaining({
        code: 'multiple-responses',
        path: 'child/v1/cart/GET',
        message: expect.stringContaining('default/v1/cart/GET/200.json, 404.json') as unknown,
      }),
    ]);
  });

  it('reports a parent file that breaks only a descendant against the descendant', () => {
    const errors = errorsOf({
      'default/v1/a/GET/200.json': '{}',
      'mid/v1/a/GET/200.xml': '<a/>',
      'leaf/flow.yaml': 'extends: mid\nremoves: [/v1/a/GET/200.json]',
      'leaf/v1/a/GET/404.txt': 'gone',
    });
    expect(errors.map((error) => `${error.code} ${error.path}`)).toEqual(['multiple-responses leaf/v1/a/GET']);
  });

  it('reports an inherited problem once, for the nearest scenario to default that has it', () => {
    expect(
      codesOf({
        'default/GET/204': '',
        'a/v1/%41/GET/204': '',
        'a/v1/A/GET/204': '',
        'b/flow.yaml': 'extends: a',
        'c/flow.yaml': 'extends: b',
      }),
    ).toEqual(['duplicate-route a/v1/%41']);
    expect(codesOf({ 'default/GET/204': '', 'a/v1/Get/204': '', 'b/flow.yaml': 'extends: a' })).toEqual([
      'invalid-method a/v1/Get',
    ]);
    expect(codesOf({ 'default/GET/204': '', 'a/v1/x.json/GET/204': '{', 'b/v1/x.json/GET/204': 'x' })).toEqual([
      'invalid-bodyless a/v1/x.json/GET/204',
      'invalid-bodyless b/v1/x.json/GET/204',
    ]);
  });

  it('reports a route conflict a child creates with an inherited spelling', () => {
    expect(codesOf({ 'default/v1/A/GET/204': '', 'child/v1/%41/POST/204': '' })).toEqual([
      'duplicate-route child/v1/%41',
    ]);
    expect(codesOf({ 'default/v1/{a}/GET/204': '', 'child/v1/{b}/POST/204': '' })).toEqual([
      'multiple-template-children child/v1',
    ]);
  });

  it('reports every scenario’s errors in one run, and keeps a valid tree only when all are valid', () => {
    expect(
      codesOf({
        ...BASE,
        'a/v1/x/GET/200.json': '{',
        'b/flow.yaml': 'removes: [/nope/GET/200.json]',
      }),
    ).toEqual(['invalid-json a/v1/x/GET/200.json', 'stale-scenario-reference b/flow.yaml']);
  });
});

describe('shadowed files', () => {
  const shadowedOf = (all: ReadonlyMap<string, ScenarioData>, scenario: string, path: string[], method: string) =>
    findMethod(all.get(scenario), path)?.shadowed.get(method) ?? [];
  const id = (
    scenario: string,
    method: string,
    template: string[],
    mediaType: string | null,
    locale: string | null = null,
  ) => fixtureId(endpointId(scenario, method, template), locale, mediaType);

  it('lists replaced, overridden and removed files across a three-level chain, nearest holder first, once each', () => {
    const all = scenarios({
      'default/v1/a/GET/200.json': '{}',
      'default/v1/a/GET/200.xml': '<a/>',
      'default/v1/a/GET/200.txt': 'a',
      'mid/v1/a/GET/200.json': '{"mid":1}',
      'mid/flow.yaml': 'removes: [/v1/a/GET/200.xml]',
      'leaf/flow.yaml': 'extends: mid\noverrides: [/v1/a/GET]',
      'leaf/v1/a/GET/200.csv': 'a,b',
    });
    const template = ['v1', 'a'];
    expect(shadowedOf(all, 'default', template, 'GET')).toEqual([]);
    expect(shadowedOf(all, 'mid', template, 'GET')).toEqual([
      { scenario: 'default', fixtureId: id('default', 'GET', template, 'application/json'), by: 'replaced' },
      { scenario: 'default', fixtureId: id('default', 'GET', template, 'application/xml'), by: 'removes' },
    ]);
    expect(shadowedOf(all, 'leaf', template, 'GET')).toEqual([
      { scenario: 'mid', fixtureId: id('mid', 'GET', template, 'application/json'), by: 'overrides' },
      { scenario: 'default', fixtureId: id('default', 'GET', template, 'application/json'), by: 'replaced' },
      { scenario: 'default', fixtureId: id('default', 'GET', template, 'text/plain'), by: 'overrides' },
      { scenario: 'default', fixtureId: id('default', 'GET', template, 'application/xml'), by: 'removes' },
    ]);
  });
});

describe('identities', () => {
  it('keeps every default endpoint and fixture ID, and the version of a tree with only default', () => {
    const before = buildSnapshot(files(BASE));
    const after = buildSnapshot(files({ ...BASE, 'child/v1/cart/GET/200.json': '{"c":1}' }));
    if (!before.ok || !after.ok) throw new Error('expected valid trees');
    expect(treeOf(snapshotData(after.snapshot).scenarios.get('default'))).toEqual(
      treeOf(snapshotData(before.snapshot).scenarios.get('default')),
    );
    const idOf = (snapshot: typeof before.snapshot, scenario: string) =>
      findMethod(snapshotData(snapshot).scenarios.get(scenario), ['v1', 'cart'])?.methods.get('GET')?.fallback
        ?.representations[0]?.id;
    expect(idOf(after.snapshot, 'default')).toBe(idOf(before.snapshot, 'default'));
    expect(idOf(before.snapshot, 'default')).toBe(
      fixtureId(endpointId('default', 'GET', ['v1', 'cart']), null, 'application/json'),
    );
    expect(after.snapshot.version).not.toBe(before.snapshot.version);
  });

  it('gives an inherited file its holder’s fixture ID in every scenario', () => {
    const all = scenarios({ ...BASE, 'a/flow.yaml': '', 'b/flow.yaml': 'extends: a' });
    const ids = ['default', 'a', 'b'].map(
      (name) => findMethod(all.get(name), ['v1', 'cart'])?.methods.get('GET')?.fallback?.representations[0]?.id,
    );
    expect(new Set(ids).size).toBe(1);
  });

  it('changes the version when only a scenario declaration changes', () => {
    const version = (extra: Record<string, string>) => {
      const result = buildSnapshot(files({ ...BASE, ...extra }));
      return result.ok ? result.snapshot.version : '';
    };
    expect(version({ 'a/flow.yaml': 'description: one' })).not.toBe(version({ 'a/flow.yaml': 'description: two' }));
    expect(version({ 'a/flow.yaml': 'ids: {x: "1"}' })).not.toBe(version({ 'a/flow.yaml': 'ids: {x: "2"}' }));
    expect(version({ 'a/flow.yaml': '' })).not.toBe(version({ 'b/flow.yaml': '' }));
  });
});
