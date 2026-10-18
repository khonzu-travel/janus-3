import {
  ENVIRONMENTS_DIRECTORY,
  FOLDER_FILE,
  LOCAL_SUFFIX,
  MAX_FOLDER_DEPTH,
  REQUEST_SUFFIX,
  type FolderDocument,
  type RequestDocument,
} from '../model.js';
import { positionedNames, uniqueNames } from './names.js';
import type { ImportedFile, ImportReportItem } from './types.js';

/**
 * The tree every importer builds before files are named:
 * folders and requests in source order, path names given at the end with
 * position prefixes, the folder depth limit applied, and the report.
 */

/** One source item's report entry, filled in while it is converted. */
export class ReportEntry {
  readonly notes: string[] = [];
  id: string | undefined;
  skipped = false;

  constructor(
    readonly file: string,
    readonly location: string,
    readonly name: string,
  ) {}

  /** Adds a note once. */
  readonly note = (message: string): void => {
    if (!this.notes.includes(message)) this.notes.push(message);
  };

  skip(message: string): void {
    this.skipped = true;
    this.note(message);
  }

  toItem(): ImportReportItem {
    const outcome = this.skipped ? 'skipped' : this.notes.length > 0 ? 'converted-with-notes' : 'converted';
    const item = {
      file: this.file,
      location: this.location,
      name: this.name,
      outcome,
      notes: [...this.notes],
    } as const;
    return this.id === undefined || this.skipped ? item : { ...item, id: this.id };
  }
}

/** The report, in source order. */
export class Report {
  readonly entries: ReportEntry[] = [];

  entry(file: string, location: string, name: string): ReportEntry {
    const entry = new ReportEntry(file, location, name);
    this.entries.push(entry);
    return entry;
  }

  items(): ImportReportItem[] {
    return this.entries.map((entry) => entry.toItem());
  }
}

export interface RequestDraft {
  readonly kind: 'request';
  /** The path name before its position prefix. */
  readonly base: string;
  readonly document: RequestDocument;
  readonly report: ReportEntry;
  /** A body that is written to a file beside the request; the document's `body` is set when it is named. */
  readonly bodyFile?: { readonly bytes: Uint8Array; readonly contentType?: string };
}

export interface FolderDraft {
  readonly kind: 'folder';
  readonly base: string;
  readonly document: FolderDocument;
  readonly children: Draft[];
  readonly report: ReportEntry | null;
}

export type Draft = RequestDraft | FolderDraft;

export interface EnvironmentDraft {
  readonly base: string;
  readonly name: string;
  readonly vars: Readonly<Record<string, string>>;
  /** Values written to `<name>.local.yaml`. */
  readonly secrets: Readonly<Record<string, string>>;
}

/** Strips undefined members, so optional keys are absent rather than undefined. */
export function compact<T extends object>(value: { readonly [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as T;
}

/** A record, or undefined when it has no entries. */
export function nonEmpty<T>(value: Readonly<Record<string, T>>): Readonly<Record<string, T>> | undefined {
  return Object.keys(value).length === 0 ? undefined : value;
}

/** A list, or undefined when it is empty. */
export function nonEmptyList<T>(value: readonly T[]): readonly T[] | undefined {
  return value.length === 0 ? undefined : value;
}

/**
 * Names every draft and returns the files. The collection's own settings go
 * to its `folder.yaml`; folders deeper than the limit are flattened into the
 * deepest allowed folder with a note.
 */
export function emitFiles(root: FolderDraft, environments: readonly EnvironmentDraft[]): ImportedFile[] {
  const files: ImportedFile[] = [];
  emitFolder(root, '', 0, files);
  const names = uniqueNames(environments.map((environment) => environment.base));
  environments.forEach((environment, index) => {
    const base = `${ENVIRONMENTS_DIRECTORY}/${names[index] ?? environment.base}`;
    files.push({
      path: `${base}.yaml`,
      kind: 'environment',
      document: compact({ name: environment.name, vars: environment.vars }),
    });
    if (Object.keys(environment.secrets).length > 0) {
      files.push({ path: `${base}${LOCAL_SUFFIX}`, kind: 'environment', document: { vars: environment.secrets } });
    }
  });
  return files;
}

function emitFolder(folder: FolderDraft, directory: string, depth: number, files: ImportedFile[]): void {
  if (Object.keys(folder.document).length > 0) {
    files.push({ path: `${directory}${FOLDER_FILE}`, kind: 'folder', document: folder.document });
  }
  const children = depth >= MAX_FOLDER_DEPTH ? flatten(folder) : folder.children;
  const names = positionedNames(children.map((child) => child.base));
  children.forEach((child, index) => {
    const name = names[index] ?? child.base;
    if (child.kind === 'folder') {
      if (child.report !== null) child.report.id = `${directory}${name}`;
      emitFolder(child, `${directory}${name}/`, depth + 1, files);
      return;
    }
    child.report.id = `${directory}${name}`;
    let document = child.document;
    if (child.bodyFile !== undefined) {
      const file = `${name}.body.bin`;
      const { contentType } = child.bodyFile;
      document = {
        ...document,
        body: contentType === undefined ? { type: 'file', file } : { type: 'file', file, contentType },
      };
      files.push({ path: `${directory}${file}`, kind: 'body', bytes: child.bodyFile.bytes });
    }
    files.push({ path: `${directory}${name}${REQUEST_SUFFIX}`, kind: 'request', document: order(document) });
  });
}

/** The requests of every folder below `folder`, in order, each noted as moved. */
function flatten(folder: FolderDraft): Draft[] {
  const out: Draft[] = [];
  const target = folder.document.name ?? folder.base;
  const visit = (draft: Draft, trail: readonly string[]): void => {
    if (draft.kind === 'request') {
      if (trail.length > 0) {
        draft.report.note(
          `folder "${trail.join(' / ')}" is deeper than ${String(MAX_FOLDER_DEPTH)} levels; the request was moved into "${target}"`,
        );
      }
      out.push(draft);
      return;
    }
    const name = draft.document.name ?? draft.base;
    const settings = Object.keys(draft.document).filter((key) => key !== 'name');
    draft.report?.note(
      `the folder is deeper than ${String(MAX_FOLDER_DEPTH)} levels; its requests were moved into "${target}"` +
        (settings.length > 0 ? ` and its ${settings.join(', ')} were not kept` : ''),
    );
    for (const child of draft.children) visit(child, [...trail, name]);
  };
  for (const child of folder.children) visit(child, []);
  return out;
}

const REQUEST_KEYS: readonly (keyof RequestDocument)[] = [
  'name',
  'method',
  'url',
  'pathParams',
  'headers',
  'body',
  'vars',
  'extract',
  'scripts',
  'route',
  'docs',
  'source',
];

/** The document with its keys in the order. */
function order(document: RequestDocument): RequestDocument {
  const out: Record<string, unknown> = {};
  for (const key of REQUEST_KEYS) if (document[key] !== undefined) out[key] = document[key];
  return out as unknown as RequestDocument;
}
