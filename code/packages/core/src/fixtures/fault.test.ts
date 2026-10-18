import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

import { utf8Encode } from '../bytes.js';
import { buildSnapshot } from './build.js';
import { parseFault } from './controls.js';
import { drawLatency, readLatency } from './latency.js';
import { snapshotData } from './snapshot.js';

// fault.yaml and scenario latency.

const CONTEXT = { pathParameters: ['orderId'] };

const parseYamlDocument = (text: string) => parseDocument(text).contents;

function parsed(text: string) {
  const result = parseFault(utf8Encode(text), CONTEXT);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.control;
}

function problems(text: string): string[] {
  const result = parseFault(utf8Encode(text), CONTEXT);
  return result.ok ? [] : result.problems.map((problem) => `${problem.code}: ${problem.message}`);
}

function located(text: string) {
  const result = parseFault(utf8Encode(text), CONTEXT);
  return result.ok ? [] : result.problems.map((problem) => problem.position);
}

function build(entries: Readonly<Record<string, string>>) {
  return buildSnapshot(new Map(Object.entries(entries).map(([path, text]) => [path, utf8Encode(text)])));
}

describe('fault.yaml', () => {
  it('reads latency and rules with both fault spellings, every kind and form', () => {
    const control = parsed(
      [
        'latency: { ms: 1500 }',
        'rules:',
        '  - when: { header.x-simulate: reset }',
        '    fault: reset',
        '  - when: { query.page: "3" }',
        '    fault: { truncate: { bytes: 128 } }',
        '  - fault: truncate',
        '  - fault: malformed',
        '  - fault: { malformed: conflicting-length }',
        '  - fault: { malformed: header-line }',
        '  - fault: { malformed: bad-chunk }',
        '  - fault: { malformed: status-line }',
        '  - fault: [timeout, none]',
        '',
      ].join('\n'),
    );
    expect(control.latency).toEqual({ ms: 1500 });
    expect(control.rules.map((rule) => rule.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(control.rules[0]).toMatchObject({ fault: { kind: 'reset' }, steps: null });
    expect(control.rules[0]?.when).toHaveLength(1);
    expect(control.rules[1]?.fault).toEqual({ kind: 'truncate', bytes: 128 });
    expect(control.rules[2]?.fault).toEqual({ kind: 'truncate', bytes: null });
    expect(control.rules[2]?.when).toEqual([]);
    expect(control.rules[3]?.fault).toEqual({ kind: 'malformed', form: 'status-line' });
    expect(control.rules.slice(4, 8).map((rule) => rule.fault)).toEqual([
      { kind: 'malformed', form: 'conflicting-length' },
      { kind: 'malformed', form: 'header-line' },
      { kind: 'malformed', form: 'bad-chunk' },
      { kind: 'malformed', form: 'status-line' },
    ]);
    expect(control.rules[8]).toMatchObject({ fault: null, steps: [{ kind: 'timeout' }, { kind: 'none' }] });
  });

  it('accepts latency alone, rules alone, and a range', () => {
    expect(parsed('latency: { min: 200, max: 800 }\n')).toEqual({ latency: { min: 200, max: 800 }, rules: [] });
    expect(parsed('rules:\n  - fault: reset\n').latency).toBeNull();
  });

  it('refuses an empty file and a file without either key', () => {
    expect(problems('')).toEqual(['invalid-control: fault.yaml is empty; it needs "latency", "rules" or both']);
    expect(problems('{}\n')).toEqual(['invalid-control: fault.yaml needs "latency", "rules" or both']);
  });

  it('allows none only as a step of a sequence', () => {
    expect(problems('rules:\n  - fault: none\n')[0]).toMatch(/^invalid-control: "none" is only allowed/);
    expect(problems('rules:\n  - fault: [none]\n')).toEqual([]);
  });

  it('checks bounds on rules, steps, conditions, bytes and latency', () => {
    const rule = '  - fault: reset\n';
    expect(problems(`rules:\n${rule.repeat(64)}`)).toEqual([]);
    expect(problems(`rules:\n${rule.repeat(65)}`)[0]).toMatch(/"rules" must be a list of 1 to 64 fault rules/);
    expect(problems('rules: []\n')[0]).toMatch(/"rules" must be a list of 1 to 64/);
    expect(problems(`rules:\n  - fault: [${Array(64).fill('reset').join(', ')}]\n`)).toEqual([]);
    expect(problems(`rules:\n  - fault: [${Array(65).fill('reset').join(', ')}]\n`)[0]).toMatch(
      /"fault" must be one fault or a list of 1 to 64/,
    );
    expect(problems('rules:\n  - fault: []\n')[0]).toMatch(/"fault" must be one fault or a list/);
    expect(problems('rules:\n  - fault: { truncate: { bytes: 1073741824 } }\n')).toEqual([]);
    expect(problems('rules:\n  - fault: { truncate: { bytes: 1073741825 } }\n')[0]).toMatch(
      /"bytes" must be an integer from 0 to 1073741824/,
    );
    expect(problems('rules:\n  - fault: { truncate: { bytes: -1 } }\n')).toHaveLength(1);
    expect(problems('rules:\n  - fault: { truncate: { bytes: 1.5 } }\n')).toHaveLength(1);
    expect(problems('latency: { ms: 60001 }\n')[0]).toMatch(/"latency.ms" must be an integer from 0 to 60000/);
    expect(problems('latency: { min: 5, max: 4 }\n')[0]).toMatch(/"latency.min" is greater than "latency.max"/);
    expect(problems('latency: { ms: 1, min: 1, max: 2 }\n')[0]).toMatch(/"latency" must be/);
    expect(problems('latency: 100\n')[0]).toMatch(/"latency" must be/);
    const many = Array.from({ length: 17 }, (_, index) => `header.x-${String(index)}: a`).join(', ');
    expect(problems(`rules:\n  - when: { ${many} }\n    fault: reset\n`)).toHaveLength(1);
  });

  it('refuses unknown faults, forms, keys and options, located by line and column', () => {
    expect(problems('rules:\n  - fault: explode\n')[0]).toMatch(/unknown fault "explode"/);
    expect(located('rules:\n  - fault: explode\n')).toEqual([{ line: 2, column: 12 }]);
    expect(problems('rules:\n  - fault: { malformed: wrong }\n')[0]).toMatch(/"malformed" takes one of status-line/);
    expect(located('rules:\n  - fault: { malformed: wrong }\n')).toEqual([{ line: 2, column: 25 }]);
    expect(problems('rules:\n  - fault: { reset: {} }\n')[0]).toMatch(/"reset" takes no options/);
    expect(problems('rules:\n  - fault: { truncate: { size: 1 } }\n')).toHaveLength(1);
    expect(problems('rules:\n  - when: { header.x: a }\n')[0]).toMatch(/rule 1 needs "fault"/);
    expect(problems('rules:\n  - fault: reset\n    serve: 200\n')[0]).toMatch(/unknown key "serve"/);
    expect(problems('latency: { ms: 1 }\nrule: []\n')[0]).toMatch(/unknown key "rule"/);
    expect(located('latency: { ms: 1 }\nrule: []\n')).toEqual([{ line: 2, column: 1 }]);
  });

  it('checks conditions, including scenario ID literals', () => {
    expect(problems('rules:\n  - when: { path.orderId: "{{$scenario.ids.orderId}}" }\n    fault: reset\n')).toEqual([]);
    expect(problems('rules:\n  - when: { path.cartId: a }\n    fault: reset\n')).toHaveLength(1);
    expect(problems('rules:\n  - when: { nowhere.x: a }\n    fault: reset\n')).toHaveLength(1);
  });

  it('is a control file: not a response, and located in the build', () => {
    const lone = build({ 'default/a/GET/fault.yaml': 'rules:\n  - fault: reset\n' });
    expect(lone.ok).toBe(false);
    if (!lone.ok) expect(lone.errors.map((error) => error.code)).toEqual(['missing-response']);
    const bad = build({ 'default/a/GET/200.json': '{}', 'default/a/GET/fault.yaml': 'rules:\n  - fault: nope\n' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toMatchObject([
        { code: 'invalid-control', path: 'default/a/GET/fault.yaml', line: 2, column: 12 },
      ]);
    }
  });

  it('enters the snapshot version', () => {
    const base = { 'default/a/GET/200.json': '{}' };
    const plain = build(base);
    const faulted = build({ ...base, 'default/a/GET/fault.yaml': 'rules:\n  - fault: reset\n' });
    const delayed = build({ ...base, 'default/flow.yaml': 'latency: { ms: 5 }\n' });
    if (!plain.ok || !faulted.ok || !delayed.ok) throw new Error('invalid');
    expect(new Set([plain.snapshot.version, faulted.snapshot.version, delayed.snapshot.version]).size).toBe(3);
  });
});

describe('latency profiles', () => {
  it('reads both forms and refuses anything else', () => {
    expect(readLatency(parseYamlDocument('{ ms: 0 }'))).toEqual({ ok: true, profile: { ms: 0 } });
    expect(readLatency(parseYamlDocument('{ min: 0, max: 60000 }'))).toEqual({
      ok: true,
      profile: { min: 0, max: 60000 },
    });
    expect(readLatency(parseYamlDocument('{ min: 1 }')).ok).toBe(false);
    expect(readLatency(parseYamlDocument('{ ms: "5" }')).ok).toBe(false);
    expect(readLatency(parseYamlDocument('{ ms: 5, extra: 1 }')).ok).toBe(false);
  });

  it('draws a range deterministically from the seed, method, route and request', () => {
    const profile = { min: 100, max: 900 };
    const input = { seed: 1, method: 'GET', route: '/v1/a', requestDigest: Uint8Array.of(1, 2, 3) };
    const first = drawLatency(profile, input);
    expect(drawLatency(profile, input)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(100);
    expect(first).toBeLessThanOrEqual(900);
    const draws = new Set(
      Array.from({ length: 40 }, (_, seed) => drawLatency(profile, { ...input, seed })).concat(
        drawLatency(profile, { ...input, method: 'POST' }),
        drawLatency(profile, { ...input, route: '/v1/b' }),
        drawLatency(profile, { ...input, requestDigest: Uint8Array.of(9) }),
      ),
    );
    expect(draws.size).toBeGreaterThan(30);
    expect(drawLatency({ min: 7, max: 7 }, input)).toBe(7);
    expect(drawLatency({ ms: 42 }, input)).toBe(42);
  });

  it('reports a bad flow.yaml latency as invalid-flow', () => {
    const result = build({ 'default/a/GET/200.json': '{}', 'default/flow.yaml': 'latency: { ms: -1 }\n' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toMatchObject([{ code: 'invalid-flow', path: 'default/flow.yaml', line: 1 }]);
  });

  it('inherits a scenario’s latency along its chain and lets { ms: 0 } turn it off', () => {
    const result = build({
      'default/a/GET/200.json': '{}',
      'slow/flow.yaml': 'latency: { ms: 300 }\n',
      'slower/flow.yaml': 'extends: slow\n',
      'quiet/flow.yaml': 'extends: slow\nlatency: { ms: 0 }\n',
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const scenarios = snapshotData(result.snapshot).scenarios;
    expect(scenarios.get('default')?.effectiveLatency).toBeNull();
    expect(scenarios.get('slow')?.effectiveLatency).toEqual({ profile: { ms: 300 }, scenario: 'slow' });
    expect(scenarios.get('slower')?.effectiveLatency).toEqual({ profile: { ms: 300 }, scenario: 'slow' });
    expect(scenarios.get('quiet')?.effectiveLatency).toEqual({ profile: { ms: 0 }, scenario: 'quiet' });
  });
});

describe('Access-Control-* in header sidecars', () => {
  const files = new Map([
    ['default/a/GET/200.json', utf8Encode('{}')],
    ['default/a/GET/200.headers.json', utf8Encode('{"Access-Control-Allow-Origin":"*","X-Kept":"1"}')],
  ]);

  it('drops them with cors-header-ignored when fixture CORS is on', () => {
    const on = buildSnapshot(files, { fixtureCors: true });
    if (!on.ok) throw new Error('invalid');
    expect(on.warnings).toMatchObject([
      { code: 'cors-header-ignored', path: 'default/a/GET/200.headers.json', line: 1, column: 2 },
    ]);
    const off = buildSnapshot(files);
    if (!off.ok) throw new Error('invalid');
    expect(off.warnings).toEqual([]);
    expect(on.snapshot.version).not.toBe(off.snapshot.version);
  });
});
