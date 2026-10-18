import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { formatStartupReport, requestTokenGrammar } from '@janus/core';
import {
  createSandbox,
  EMPTY_TREE,
  ENVIRONMENTS_DIRECTORY,
  importSources,
  type ImportReportItem,
  type ImportSource,
} from '@janus/runner';

import type { ImportArgs } from './cli.js';
import { loadConfig } from './config.js';
import { RequestStore } from './requests.js';
import type { CommandOutput } from './run-command.js';
import { importedBytes, importedEnvironments, importProblems } from './runner-service.js';

/**
 * `janus import`: converts the sources (section 11), prints
 * the report and, unless `--preview`, writes the collection under
 * `runner.root`. Exit codes follow `janus run`'s.
 */
export async function importCommand(args: ImportArgs, env: CommandOutput): Promise<number> {
  const loaded = await loadConfig(args, env.cwd);
  if (loaded.errors.length > 0) {
    env.stderr(formatStartupReport(loaded.errors, loaded.warnings, { outcome: 'not importing' }));
    return 2;
  }
  const values = loaded.effective.values;
  let sources: ImportSource[];
  try {
    sources = await readSources(
      args.sources.map((source) => resolve(env.cwd, source)),
      values.runner.maxImportBytes,
    );
  } catch (error) {
    env.stderr(`janus: ${error instanceof Error ? error.message : 'the sources cannot be read'}\n`);
    return 1;
  }
  const sandbox = await createSandbox();
  const context = {
    grammar: requestTokenGrammar(values.dynamic.aliases),
    checkScript: (source: string) => sandbox.check(source),
  };
  const result = importSources(
    sources,
    {
      maxBytes: values.runner.maxImportBytes,
      ...(args.into === undefined ? {} : { into: args.into }),
      ...(args.includeStatic ? { includeStatic: true } : {}),
      ...(args.origins.length === 0 ? {} : { origins: args.origins }),
    },
    context.checkScript,
  );
  if (!result.ok) {
    env.stderr(`janus: ${result.code}: ${result.message}\n`);
    return 1;
  }
  const bytes = importedBytes(result.collection, result.files);
  const root = loaded.requests.display.replace(/\/$/, '');
  const destination = `${root}/${result.collection}`;
  const environments = importedEnvironments(result.files);
  env.stdout(
    `${args.preview ? 'Would import' : 'Importing'} ${result.format} "${result.name}" into ${destination} (${String(bytes.size)} ${bytes.size === 1 ? 'file' : 'files'})\n`,
  );
  if (environments.length > 0) {
    // Environments are shared by every collection.
    env.stdout(`Environments into ${root}/${ENVIRONMENTS_DIRECTORY}/: ${environments.join(', ')}\n`);
  }
  env.stdout(formatReport(result.report));
  const problems = importProblems(result.collection, bytes, context);
  for (const problem of problems) env.stderr(`janus: ${problem.path}: ${problem.code}: ${problem.message}\n`);
  if (args.preview) return problems.length > 0 ? 1 : 0;
  if (problems.length > 0) {
    env.stderr('janus: the converted collection would not load; nothing was written\n');
    return 1;
  }
  const errors: string[] = [];
  const store = new RequestStore(
    loaded.requests.absolute,
    context,
    { tree: EMPTY_TREE, errors: [], warnings: [] },
    {
      info: () => undefined,
      error: (_event, fields) => errors.push(String(fields?.['message'] ?? '')),
    },
  );
  const written = await store.writeCollection(result.collection, bytes, args.replace);
  if (written === 'exists') {
    env.stderr(
      `janus: import-destination-exists: ${destination} or an environment it brings exists; pass --replace to overwrite them\n`,
    );
    return 1;
  }
  if (!written.ok) {
    env.stderr(`janus: the collection could not be written\n`);
    return 1;
  }
  env.stdout(`Wrote ${destination}\n`);
  return 0;
}

function formatReport(report: readonly ImportReportItem[]): string {
  let text = '';
  for (const item of report) {
    const where = item.location === '' ? item.file : `${item.file} ${item.location}`;
    text += `  ${item.outcome.padEnd(20)} ${item.name}${item.id === undefined ? '' : ` → ${item.id}`}  (${where})\n`;
    for (const note of item.notes) text += `      - ${note}\n`;
  }
  return text;
}

/** Files are read whole; a folder is read recursively, its files named below the folder's own name. */
async function readSources(paths: readonly string[], maxBytes: number): Promise<ImportSource[]> {
  const sources: ImportSource[] = [];
  let total = 0;
  const add = async (absolute: string, name: string): Promise<void> => {
    const bytes = await readFile(absolute);
    total += bytes.length;
    if (total > maxBytes) throw new Error(`the sources exceed runner.maxImportBytes (${String(maxBytes)} bytes)`);
    sources.push({ name, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
  };
  const walk = async (absolute: string, name: string): Promise<void> => {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) await walk(child, `${name}/${entry.name}`);
      else if (entry.isFile()) await add(child, `${name}/${entry.name}`);
    }
  };
  for (const path of paths) {
    const info = await lstat(path).catch(() => null);
    if (info === null) throw new Error(`"${basename(path)}" does not exist`);
    if (info.isDirectory()) await walk(path, basename(path));
    else if (info.isFile()) await add(path, basename(path));
    else throw new Error(`"${basename(path)}" is not a file or folder`);
  }
  return sources;
}
