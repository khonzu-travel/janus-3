import { ENVIRONMENTS_DIRECTORY, isRunnerName } from '../model.js';
import { convertBruno } from './bruno.js';
import {
  BRUNO_MARKERS,
  BRUNO_YAML_MARKERS,
  collectionSources,
  readBruCollection,
  readYamlCollection,
} from './bruno-read.js';
import type { Converted, ImportContext } from './context.js';
import { detect } from './detect.js';
import { toRunnerName } from './names.js';
import { convertPostman, isPostmanCollection, isPostmanEnvironment, type JsonSource } from './postman.js';
import { convertTraffic, readCharles, readHar } from './traffic.js';
import { baseName, isRecord, record } from './text.js';
import { emitFiles, Report } from './tree.js';
import type { ImportFormat, ImportOptions, ImportResult, ImportSource } from './types.js';
import { expandZip, isZip } from './zip.js';

export type {
  CheckScript,
  ImportedFile,
  ImportErrorCode,
  ImportFormat,
  ImportItemOutcome,
  ImportOptions,
  ImportOrigin,
  ImportReportItem,
  ImportResult,
  ImportSource,
  ImportTransaction,
} from './types.js';
export { FAKER_TABLE, dynamicToken } from './template.js';
export { MAX_ZIP_ENTRIES, ZIP_EXPANSION_FACTOR } from './zip.js';

/** The expansion bound {@link detectFormat} uses for a zip, which has no `maxBytes` of its own. */
const DETECT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Converts sources into a new collection's files and a report. Pure: nothing is written and no
 * script is run; `checkScript` only
 * compiles imported scripts so a syntax problem can be noted.
 */
export function importSources(
  sources: readonly ImportSource[],
  options: ImportOptions,
  /** Compiles a script without running it; returns its syntax problem or null. */
  checkScript?: (source: string) => { message: string; line: number; column: number } | null,
): ImportResult {
  if (sources.length === 0) return { ok: false, code: 'import-invalid', message: 'nothing to import' };
  const total = sources.reduce((sum, source) => sum + source.bytes.length, 0);
  if (total > options.maxBytes) {
    return {
      ok: false,
      code: 'import-too-large',
      message: `the sources hold ${String(total)} bytes; runner.maxImportBytes allows ${String(options.maxBytes)}`,
    };
  }
  if (options.into !== undefined && !isRunnerName(options.into)) {
    return {
      ok: false,
      code: 'import-invalid',
      message: `"${options.into}" is not a valid collection name: use lower-case letters, digits and single hyphens, up to 64 bytes`,
    };
  }
  const expanded = expand(sources, options.maxBytes);
  if (!expanded.ok) return expanded;
  const detection = detect(expanded.sources);
  if (detection.kind !== 'format') {
    return { ok: false, code: 'import-unsupported-format', message: detection.message };
  }
  const context: ImportContext = { sources: expanded.sources, options, checkScript, report: new Report() };
  const converted = convert(detection.format, detection.json, expanded.name, context);
  if (!converted.ok) return converted;
  const collection = options.into ?? toRunnerName(converted.name, 'imported');
  if (collection === ENVIRONMENTS_DIRECTORY) {
    return {
      ok: false,
      code: 'import-invalid',
      message: `"${ENVIRONMENTS_DIRECTORY}" holds the shared environments and cannot be a collection; import into another name`,
    };
  }
  const files = emitFiles(converted.root, converted.environments);
  return {
    ok: true,
    format: detection.format,
    collection,
    name: converted.name,
    files,
    report: context.report.items(),
    ...(converted.origins === undefined ? {} : { origins: converted.origins }),
    ...(converted.transactions === undefined ? {} : { transactions: converted.transactions }),
  };
}

/** The format of the sources, or null when they are not an importable export. */
export function detectFormat(sources: readonly ImportSource[]): ImportFormat | null {
  const expanded = expand(sources, DETECT_MAX_BYTES);
  if (!expanded.ok) return null;
  const detection = detect(expanded.sources);
  return detection.kind === 'format' ? detection.format : null;
}

type Expanded =
  | { readonly ok: true; readonly sources: readonly ImportSource[]; readonly name: string }
  | Extract<ImportResult, { ok: false }>;

/** Expands a single zip source; `name` is the import's fallback name. */
function expand(sources: readonly ImportSource[], maxBytes: number): Expanded {
  const [first] = sources;
  const fallback = (source: ImportSource | undefined): string =>
    baseName(source?.name ?? '').replace(/\.[A-Za-z0-9]+$/, '') || 'imported';
  if (sources.length === 1 && first !== undefined && isZip(first.bytes)) {
    const zip = expandZip(first, maxBytes);
    return zip.ok ? { ok: true, sources: zip.sources, name: fallback(first) } : zip;
  }
  if (sources.some((source) => isZip(source.bytes))) {
    return { ok: false, code: 'import-invalid', message: 'a zip archive must be imported on its own' };
  }
  const directory = first?.name.includes('/') === true ? (first.name.split('/')[0] ?? '') : '';
  return { ok: true, sources, name: directory === '' ? fallback(first) : directory };
}

function convert(
  format: ImportFormat,
  json: ReadonlyMap<string, unknown>,
  fallbackName: string,
  context: ImportContext,
): Converted {
  const { sources, report } = context;
  switch (format) {
    case 'postman': {
      const collections: JsonSource[] = [];
      const environments: JsonSource[] = [];
      for (const source of sources) {
        const value = json.get(source.name);
        if (isPostmanCollection(value)) collections.push({ file: source.name, json: value });
        else if (isPostmanEnvironment(value)) environments.push({ file: source.name, json: value });
        else report.entry(source.name, '', source.name).skip('the file is not a Postman collection or environment');
      }
      return convertPostman(collections, environments, context);
    }
    case 'bruno':
      return convertBruno(readBruCollection(collectionSources(sources, BRUNO_MARKERS), fallbackName), 'bruno', context);
    case 'bruno-yaml':
      return convertBruno(
        readYamlCollection(collectionSources(sources, BRUNO_YAML_MARKERS), fallbackName),
        'bruno-yaml',
        context,
      );
    case 'charles':
    case 'har': {
      const [main, ...rest] = sources.filter((source) => {
        const value = json.get(source.name);
        return format === 'charles' ? Array.isArray(value) : isRecord(value) && isRecord(value.log);
      });
      if (main === undefined) return { ok: false, code: 'import-invalid', message: 'no session among the sources' };
      if (rest.length > 0) {
        return {
          ok: false,
          code: 'import-invalid',
          message: `import one ${format === 'har' ? 'HAR file' : 'Charles session'} at a time`,
        };
      }
      for (const source of sources) {
        if (source !== main) report.entry(source.name, '', source.name).skip('the file is not part of the session');
      }
      const value = json.get(main.name);
      const transactions =
        format === 'charles' ? readCharles(value as readonly unknown[]) : readHar(record(record(value).log));
      const name = baseName(main.name).replace(/\.[A-Za-z0-9]+$/, '') || 'imported';
      return convertTraffic(transactions, format, main.name, name, context);
    }
  }
}
