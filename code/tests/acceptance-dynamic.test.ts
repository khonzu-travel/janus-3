import { execFile, spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The dynamic values acceptance journey, HTTP and CLI steps, against examples/data. The browser
// step is in tests/e2e/dynamic.spec.ts.

const workspace = resolve(import.meta.dirname, '..');
const BIN = join(workspace, 'apps/server/src/bin.ts');
const TSX = join(workspace, 'node_modules/tsx/dist/esm/index.mjs');
const DATA = join(workspace, 'examples/data');
const run = promisify(execFile);

let proc: ReturnType<typeof spawn>;
const output = { stdout: '', stderr: '' };
let url: string;

beforeAll(async () => {
  proc = spawn(
    process.execPath,
    [
      '--import',
      TSX,
      '--conditions=@janus/source',
      BIN,
      'serve',
      '--no-config',
      '--data',
      DATA,
      '--port',
      '0',
      '--seed',
      '42',
    ],
    { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stdout?.setEncoding('utf8').on('data', (chunk: string) => (output.stdout += chunk));
  proc.stderr?.setEncoding('utf8').on('data', (chunk: string) => (output.stderr += chunk));
  for (let i = 0; i < 300; i++) {
    const found = /listening on (\S+)/.exec(output.stdout)?.[1];
    if (found !== undefined) {
      url = found;
      return;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`janus did not start:\n${output.stdout}\n${output.stderr}`);
});

afterAll(() => {
  if (proc.exitCode === null) proc.kill('SIGKILL');
});

const order = async (id: string, now: string): Promise<{ text: string; headers: Headers }> => {
  const response = await fetch(`${url}/v1/orders/${id}`, { headers: { 'x-mock-now': now } });
  expect(response.status).toBe(200);
  return { text: await response.text(), headers: response.headers };
};

describe('dynamic values and the clock (acceptance)', () => {
  it('logs the seed it serves with', () => {
    expect(output.stdout).toContain('janus seed seed=42 source=cli');
  });

  it('answers the same request with identical bytes', async () => {
    const first = await order('o-1', '2026-01-01T00:00:00Z');
    const second = await order('o-1', '2026-01-01T00:00:00Z');
    expect(second.text).toBe(first.text);
    expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
    expect(first.headers.get('x-mock-nondeterministic')).toBeNull();
    expect(JSON.parse(first.text)).toMatchObject({
      id: 'o-1',
      placedAt: '2026-01-01T00:00:00Z',
      restockDate: '2026-01-15',
      note: 'Deliver by Thu 8 Jan; {{$today}} is written literally',
    });
    expect(first.headers.get('expires')).toBe('Fri, 02 Jan 2026 00:00:00 GMT');
  });

  it('generates different values for another path parameter', async () => {
    const one = JSON.parse((await order('o-1', '2026-01-01T00:00:00Z')).text) as Record<string, unknown>;
    const two = JSON.parse((await order('o-2', '2026-01-01T00:00:00Z')).text) as Record<string, unknown>;
    expect(two['id']).toBe('o-2');
    expect(two['reference']).not.toBe(one['reference']);
    expect(typeof two['quantity']).toBe('number');
  });

  it('shifts dates with another X-Mock-Now', async () => {
    const shifted = JSON.parse((await order('o-1', '2026-06-30T12:00:00+02:00')).text) as Record<string, unknown>;
    expect(shifted).toMatchObject({ placedAt: '2026-06-30T10:00:00Z', restockDate: '2026-07-14' });
  });

  it('reports the clock and seed, and marks live-clock responses nondeterministic', async () => {
    const clock = (await (await fetch(`${url}/_janus/clock`)).json()) as Record<string, unknown>;
    expect(clock).toMatchObject({ mode: 'live', source: 'wall-clock', timezone: 'UTC', seed: 42, seedSource: 'cli' });
    const live = await fetch(`${url}/v1/orders/o-1`);
    expect(live.headers.get('x-mock-nondeterministic')).toBe('true');
  });

  it('echoes the request body and renders text bodies', async () => {
    const created = await fetch(`${url}/v1/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mock-now': '2026-01-01T00:00:00Z' },
      body: JSON.stringify({ customer: { name: 'Ada' }, lines: [1, 2] }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      customer: { name: 'Ada' },
      lines: [1, 2],
      createdAt: '2026-01-01T00:00:00Z',
    });
    const receipt = await fetch(`${url}/v1/receipt?customer=Ada`, {
      headers: { 'x-mock-now': '2026-01-01T00:00:00Z' },
    });
    expect(await receipt.text()).toMatch(
      /^Receipt 01KDVDNA00[0-9A-Z]{16}\nIssued 01\/01\/2026 01:00 \+01:00 for Ada\n$/,
    );
  });

  it('rejects a misspelt token at load with its location and a suggestion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'janus-dynamic-'));
    try {
      await cp(DATA, join(root, 'data'), { recursive: true });
      const file = join(root, 'data/default/v1/orders/{orderId}/GET/200.json');
      await writeFile(file, (await readFile(file, 'utf8')).replace('{{$today+14d}}', '{{$tommorow}}'));
      const failure = await run(
        process.execPath,
        ['--import', TSX, '--conditions=@janus/source', BIN, 'validate', '--no-config', '--data', join(root, 'data')],
        { cwd: workspace },
      ).then(
        () => null,
        (error: unknown) => error as { code: number; stderr: string },
      );
      expect(failure?.code).toBe(1);
      expect(failure?.stderr).toContain(
        `default/v1/orders/{orderId}/GET/200.json:9:19: unknown dynamic value "tommorow"; did you mean "tomorrow"? [unknown-dynamic-token]`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
