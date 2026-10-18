import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { build, type Rolldown } from 'vite';

// The size budgets: builds the UI and fails when the initial
// JavaScript or CSS, gzipped at level 9 file by file and summed, is too large.

const ROOT = join(import.meta.dirname, '..');
const KIB = 1024;
const BUDGETS = { js: 200 * KIB, css: 30 * KIB } as const;

const gzipped = (bytes: Uint8Array | string): number => gzipSync(bytes, { level: 9 }).length;
const kib = (bytes: number): string => `${(bytes / KIB).toFixed(1)} KiB`;

const result = await build({ root: ROOT, configFile: join(ROOT, 'vite.config.ts'), logLevel: 'warn' });
if (!('output' in result) && !Array.isArray(result)) throw new Error('expected a build, not a watcher');
const outputs = Array.isArray(result) ? result : [result];
const chunks = new Map<string, Rolldown.OutputChunk>();
for (const item of outputs.flatMap((output) => output.output)) {
  if (item.type === 'chunk') chunks.set(item.fileName, item);
}

// Initial JavaScript: the entry chunks and everything they import statically,
// the module-preload helper included; dynamic imports are lazy.
const initial = new Set<string>();
const pending = [...chunks.values()].filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName);
for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
  if (initial.has(name)) continue;
  initial.add(name);
  pending.push(...(chunks.get(name)?.imports ?? []));
}

// Initial CSS: every stylesheet index.html links.
const dist = join(ROOT, 'dist');
const html = await readFile(join(dist, 'index.html'), 'utf8');
const stylesheets = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)].map(
  ([tag]) => /\bhref="(?:\.\/)?([^"]+)"/.exec(tag)?.[1] ?? '',
);

const report = async (label: string, files: readonly string[], budget: number): Promise<boolean> => {
  let total = 0;
  for (const file of files) {
    const size = gzipped(await readFile(join(dist, file)));
    total += size;
    console.log(`  ${file}  ${kib(size)}`);
  }
  const ok = total <= budget;
  console.log(`${ok ? 'ok' : 'FAIL'}  initial ${label}: ${kib(total)} of ${kib(budget)}\n`);
  return ok;
};
const js = await report('JavaScript', [...initial].sort(), BUDGETS.js);
const css = await report('CSS', stylesheets, BUDGETS.css);
if (!js || !css) process.exitCode = 1;
