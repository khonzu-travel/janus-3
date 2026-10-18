import { fileDigest } from '@janus/core';

import {
  readEnvironmentText,
  readFolderText,
  readRequestText,
  type RequestProblem,
  type ValidationContext,
} from './documents.js';
import {
  ENVIRONMENTS_DIRECTORY,
  FOLDER_FILE,
  isRunnerName,
  LOCAL_SUFFIX,
  MAX_FOLDER_DEPTH,
  REQUEST_SUFFIX,
  type EnvironmentDocument,
  type FolderDocument,
  type RequestDocument,
} from './model.js';

/**
 * The request snapshot: every collection, folder,
 * request and environment under `runner.root`, validated together and
 * replaced as a whole. It never affects what Janus serves. Environments are
 * shared by every collection: they live in `environments/` directly under
 * the root, which is therefore never a collection.
 */

export interface RequestNode {
  readonly kind: 'request';
  /** The path below `runner.root` without the suffix, e.g. `checkout/payments/010-pay`. */
  readonly id: string;
  /** The file's path below `runner.root`. */
  readonly file: string;
  readonly document: RequestDocument;
  readonly digest: string;
}

export interface FolderNode {
  readonly kind: 'folder' | 'collection';
  readonly id: string;
  /** The display name: `folder.yaml`'s `name`, else the directory name. */
  readonly name: string;
  readonly document: FolderDocument;
  /** The digest of `folder.yaml`, or null when there is none. */
  readonly digest: string | null;
  /** Requests and folders in run order: by name, compared by byte. */
  readonly children: readonly (FolderNode | RequestNode)[];
}

export interface EnvironmentEntry {
  /** The file name without `.yaml`. */
  readonly id: string;
  readonly document: EnvironmentDocument;
  readonly local: EnvironmentDocument | null;
  /** Over both files: changes when either changes. */
  readonly digest: string;
}

export interface CollectionNode extends FolderNode {
  readonly kind: 'collection';
}

export type TreeNode = FolderNode | RequestNode;

export interface RequestTree {
  readonly collections: readonly CollectionNode[];
  /** The shared environments, by ID. */
  readonly environments: readonly EnvironmentEntry[];
  /** Every request, folder and collection by ID. */
  readonly nodes: ReadonlyMap<string, TreeNode>;
  /** Changes whenever any file of the tree changes. */
  readonly version: string;
}

/** What the filesystem reader found: files by path below the root, and every directory. */
export interface RequestTreeFiles {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly directories: ReadonlySet<string>;
}

export interface RequestTreeWarning {
  /**
   * `requests-collection-environments`: a collection's own `environments/`,
   * no longer read; `requests-unknown-environment`: a collection's preferred
   * environment that does not exist.
   */
  readonly code: 'requests-unknown-file' | 'requests-collection-environments' | 'requests-unknown-environment';
  readonly path: string;
  readonly message: string;
}

export interface BuildRequestTreeResult {
  readonly tree: RequestTree;
  readonly errors: readonly RequestProblem[];
  readonly warnings: readonly RequestTreeWarning[];
}

export const EMPTY_TREE: RequestTree = Object.freeze({
  collections: Object.freeze([]),
  environments: Object.freeze([]),
  nodes: new Map(),
  version: fileDigest(new Uint8Array()),
});

/** Builds and validates the tree; with errors, the tree holds what did validate. */
export function buildRequestTree(input: RequestTreeFiles, context: ValidationContext): BuildRequestTreeResult {
  const errors: RequestProblem[] = [];
  const warnings: RequestTreeWarning[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const textOf = (path: string, bytes: Uint8Array): string | null => {
    try {
      return decoder.decode(bytes);
    } catch {
      errors.push({ code: 'request-invalid', path, message: 'the file is not valid UTF-8' });
      return null;
    }
  };
  const unknown = (path: string, message: string): void => {
    warnings.push({ code: 'requests-unknown-file', path, message });
  };

  // Group entries by their parent directory.
  const children = new Map<string, { files: string[]; directories: string[] }>();
  const entry = (directory: string) => {
    let found = children.get(directory);
    if (found === undefined) {
      found = { files: [], directories: [] };
      children.set(directory, found);
    }
    return found;
  };
  for (const path of input.files.keys()) entry(parentOf(path)).files.push(baseOf(path));
  for (const path of input.directories) entry(parentOf(path)).directories.push(baseOf(path));

  const nodes = new Map<string, TreeNode>();

  const folder = (id: string, depth: number, collection: boolean): FolderNode | null => {
    const name = baseOf(id);
    if (!isRunnerName(name)) {
      errors.push({
        code: 'request-invalid-name',
        path: id,
        message: `"${name}" is not a valid ${collection ? 'collection' : 'folder'} name: lowercase letters and digits in words joined by "-", at most 64 bytes`,
      });
      return null;
    }
    if (depth > MAX_FOLDER_DEPTH) {
      errors.push({
        code: 'request-invalid-name',
        path: id,
        message: `folders nest at most ${String(MAX_FOLDER_DEPTH)} deep below a collection`,
      });
      return null;
    }
    const contents = children.get(id) ?? { files: [], directories: [] };
    let document: FolderDocument = {};
    let digest: string | null = null;
    const items: TreeNode[] = [];
    for (const file of contents.files) {
      const path = `${id}/${file}`;
      const bytes = input.files.get(path);
      if (bytes === undefined) continue;
      if (file === FOLDER_FILE) {
        const text = textOf(path, bytes);
        if (text === null) continue;
        const read = readFolderText(text, path, context, collection);
        errors.push(...read.problems);
        if (read.document !== null) document = read.document;
        digest = fileDigest(bytes);
        continue;
      }
      if (file.endsWith(REQUEST_SUFFIX)) {
        const base = file.slice(0, -REQUEST_SUFFIX.length);
        if (!isRunnerName(base)) {
          errors.push({
            code: 'request-invalid-name',
            path,
            message: `"${base}" is not a valid request name: lowercase letters and digits in words joined by "-", at most 64 bytes`,
          });
          continue;
        }
        const text = textOf(path, bytes);
        if (text === null) continue;
        const read = readRequestText(text, path, context);
        errors.push(...read.problems);
        if (read.document === null) continue;
        const node: RequestNode = Object.freeze({
          kind: 'request',
          id: `${id}/${base}`,
          file: path,
          document: read.document,
          digest: fileDigest(bytes),
        });
        items.push(node);
        nodes.set(node.id, node);
        continue;
      }
      // Body files sit beside requests; anything else is reported but harmless.
      if (!isReferencedBody(path, input))
        unknown(path, 'the file is not a request, folder.yaml or a body a request names');
    }
    for (const directory of contents.directories) {
      const path = `${id}/${directory}`;
      // Environments moved to the root; deeper `environments` folders are ordinary folders.
      if (collection && directory === ENVIRONMENTS_DIRECTORY) {
        warnings.push({
          code: 'requests-collection-environments',
          path,
          message: `environments are shared by every collection now and this directory is not read; move its files to ${ENVIRONMENTS_DIRECTORY}/ directly under the requests root`,
        });
        continue;
      }
      const child = folder(path, depth + 1, false);
      if (child !== null) items.push(child);
    }
    items.sort((a, b) => compareBytes(baseOf(a.id), baseOf(b.id)));
    const node: FolderNode = Object.freeze({
      kind: collection ? 'collection' : 'folder',
      id,
      name: document.name ?? name,
      document,
      digest,
      children: Object.freeze(items),
    });
    nodes.set(id, node);
    return node;
  };

  const readEnvironments = (): EnvironmentEntry[] => {
    const directory = ENVIRONMENTS_DIRECTORY;
    const contents = children.get(directory);
    if (contents === undefined) return [];
    for (const sub of contents.directories) unknown(`${directory}/${sub}`, 'environments holds only environment files');
    const found: EnvironmentEntry[] = [];
    const files = new Set(contents.files);
    for (const file of [...files].sort(compareBytes)) {
      const path = `${directory}/${file}`;
      if (file.endsWith(LOCAL_SUFFIX)) {
        const base = file.slice(0, -LOCAL_SUFFIX.length);
        if (!files.has(`${base}.yaml`)) {
          errors.push({
            code: 'request-invalid-environment',
            path,
            message: `${file} has no ${base}.yaml beside it; a .local.yaml only overrides an environment`,
          });
        }
        continue;
      }
      if (!file.endsWith('.yaml')) {
        unknown(path, 'environments holds only <name>.yaml and <name>.local.yaml files');
        continue;
      }
      const base = file.slice(0, -'.yaml'.length);
      if (!isRunnerName(base)) {
        errors.push({
          code: 'request-invalid-name',
          path,
          message: `"${base}" is not a valid environment name: lowercase letters and digits in words joined by "-", at most 64 bytes`,
        });
        continue;
      }
      const bytes = input.files.get(path);
      const text = bytes === undefined ? null : textOf(path, bytes);
      if (bytes === undefined || text === null) continue;
      const read = readEnvironmentText(text, path, false);
      errors.push(...read.problems);
      let local: EnvironmentDocument | null = null;
      const localPath = `${directory}/${base}${LOCAL_SUFFIX}`;
      const localBytes = input.files.get(localPath);
      if (localBytes !== undefined) {
        const localText = textOf(localPath, localBytes);
        if (localText !== null) {
          const readLocal = readEnvironmentText(localText, localPath, true);
          errors.push(...readLocal.problems);
          local = readLocal.document;
        }
      }
      if (read.document === null) continue;
      found.push(
        Object.freeze({
          id: base,
          document: read.document,
          local,
          digest: environmentDigest(bytes, localBytes ?? null),
        }),
      );
    }
    return found;
  };

  const collections: CollectionNode[] = [];
  const top = children.get('') ?? { files: [], directories: [] };
  for (const file of top.files)
    unknown(file, 'files directly under the requests root are not read; put requests in a collection');
  const environments = top.directories.includes(ENVIRONMENTS_DIRECTORY) ? readEnvironments() : [];
  const environmentIds = new Set(environments.map((environment) => environment.id));
  for (const name of [...top.directories].sort(compareBytes)) {
    if (name === ENVIRONMENTS_DIRECTORY) continue;
    const base = folder(name, 0, true);
    if (base === null) continue;
    const collection: CollectionNode = Object.freeze({ ...base, kind: 'collection' as const });
    nodes.set(name, collection);
    collections.push(collection);
    const preferred = base.document.environment;
    if (preferred !== undefined && !environmentIds.has(preferred)) {
      warnings.push({
        code: 'requests-unknown-environment',
        path: `${name}/${FOLDER_FILE}`,
        message: `the collection prefers the environment "${preferred}", which does not exist in ${ENVIRONMENTS_DIRECTORY}/`,
      });
    }
  }

  return {
    tree: Object.freeze({
      collections: Object.freeze(collections),
      environments: Object.freeze(environments),
      nodes,
      version: treeVersion(input),
    }),
    errors,
    warnings,
  };
}

/**
 * The values an environment gives a run: `.local.yaml`
 * laid over the main file, without the variables `disabled` names.
 */
export function environmentValues(entry: EnvironmentEntry): Readonly<Record<string, string>> {
  const disabled = new Set(entry.document.disabled ?? []);
  return Object.fromEntries(
    Object.entries({ ...entry.document.vars, ...entry.local?.vars }).filter(([name]) => !disabled.has(name)),
  );
}

/** The digest an environment's `If-Match` compares: both files, in order. */
export function environmentDigest(main: Uint8Array, local: Uint8Array | null): string {
  const encoder = new TextEncoder();
  const header = encoder.encode(`janus-environment/1\n${String(main.length)}\n`);
  const parts = [
    header,
    main,
    encoder.encode(`\n${local === null ? '-' : String(local.length)}\n`),
    local ?? new Uint8Array(),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return fileDigest(joined);
}

function treeVersion(input: RequestTreeFiles): string {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const path of [...input.files.keys()].sort(compareBytes)) {
    parts.push(encoder.encode(`${path}\n${fileDigest(input.files.get(path) ?? new Uint8Array())}\n`));
  }
  for (const path of [...input.directories].sort(compareBytes)) parts.push(encoder.encode(`${path}/\n`));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return fileDigest(joined).slice('sha256:'.length, 'sha256:'.length + 16);
}

/** True when a request in the same directory names the file as its body or a multipart part. */
function isReferencedBody(path: string, input: RequestTreeFiles): boolean {
  const directory = parentOf(path);
  const name = baseOf(path);
  for (const [other, bytes] of input.files) {
    if (parentOf(other) !== directory || !other.endsWith(REQUEST_SUFFIX)) continue;
    const text = new TextDecoder().decode(bytes);
    if (text.includes(name)) return true;
  }
  return false;
}

export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Byte order of UTF-8 names; names are ASCII by grammar, so code units suffice. */
export function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The folders from the collection down to a node's parent, collection first. */
export function folderChain(tree: RequestTree, id: string): readonly FolderNode[] {
  const parts = id.split('/');
  const chain: FolderNode[] = [];
  for (let length = 1; length < parts.length; length++) {
    const node = tree.nodes.get(parts.slice(0, length).join('/'));
    if (node === undefined || node.kind === 'request') return chain;
    chain.push(node);
  }
  return chain;
}

/** Every request below a folder or collection, depth first in name order. */
export function requestsBelow(node: TreeNode): readonly RequestNode[] {
  if (node.kind === 'request') return [node];
  return node.children.flatMap(requestsBelow);
}

/** The collection a node belongs to. */
export function collectionOf(tree: RequestTree, id: string): CollectionNode | null {
  const node = tree.nodes.get(id.split('/')[0] ?? '');
  return node?.kind === 'collection' ? (node as CollectionNode) : null;
}
