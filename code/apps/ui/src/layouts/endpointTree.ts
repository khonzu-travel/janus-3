import type { EndpointItem } from '../atlas/client.js';

/**
 * The inventory as a tree of path segments: `/v1/products/p-1` sits under
 * `v1` → `products` → `p-1`. Each node holds the endpoints whose path ends
 * exactly there, then its child segments, both in inventory order.
 */
export interface EndpointTreeNode {
  /** The path up to and including this segment; `/` for the root. */
  readonly path: string;
  /** This node's segment; empty for the root. */
  readonly segment: string;
  /** Segments from the root: 0 for the root, 1 for `/v1`, 2 for `/v1/products`. */
  readonly depth: number;
  readonly endpoints: EndpointItem[];
  readonly children: EndpointTreeNode[];
  /** Every endpoint at or below this node. */
  count: number;
  /** Every folder below this node: with all of them open, its contents take `count + folders` rows. */
  folders: number;
}

/** Folders down to this depth start expanded: `/v1` and `/v1/products` show, `/v1/products/p-1` waits. */
export const DEFAULT_EXPANDED_DEPTH = 2;

export function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** Each segment of an endpoint's path with the path up to it, computed once per item. */
const foldersOf = new WeakMap<EndpointItem, readonly (readonly [path: string, segment: string])[]>();

function folders(item: EndpointItem): readonly (readonly [string, string])[] {
  let cached = foldersOf.get(item);
  if (cached === undefined) {
    let path = '';
    cached = segmentsOf(item.path).map((segment) => {
      path = `${path}/${segment}`;
      return [path, segment] as const;
    });
    foldersOf.set(item, cached);
  }
  return cached;
}

/** Each built tree's nodes from the root to each endpoint's folder, for pruning. */
const chainsOf = new WeakMap<EndpointTreeNode, ReadonlyMap<EndpointItem, readonly EndpointTreeNode[]>>();

const newNode = (path: string, segment: string, depth: number): EndpointTreeNode => ({
  path,
  segment,
  depth,
  endpoints: [],
  children: [],
  count: 0,
  folders: 0,
});

/** Builds the tree in time linear in the items, with each item's path work cached. */
export function buildEndpointTree(items: readonly EndpointItem[]): EndpointTreeNode {
  const root = newNode('/', '', 0);
  const byPath = new Map<string, EndpointTreeNode>();
  const chains = new Map<EndpointItem, readonly EndpointTreeNode[]>();
  for (const item of items) {
    const chain = [root];
    let node = root;
    node.count++;
    for (const [path, segment] of folders(item)) {
      let child = byPath.get(path);
      if (child === undefined) {
        child = newNode(path, segment, node.depth + 1);
        byPath.set(path, child);
        node.children.push(child);
        for (const above of chain) above.folders++;
      }
      child.count++;
      chain.push(child);
      node = child;
    }
    node.endpoints.push(item);
    chains.set(item, chain);
  }
  chainsOf.set(root, chains);
  return root;
}

/**
 * The tree of `root` with only the endpoints in `keep`, in inventory order:
 * the tree `buildEndpointTree` would build from them. It copies only the
 * folders on the way to a kept endpoint, found from the chains recorded when
 * `root` was built, so it never visits the folders filtered out and does no
 * path work: the search filters on every keystroke.
 */
export function pruneTree(root: EndpointTreeNode, keep: readonly EndpointItem[]): EndpointTreeNode {
  const chains = chainsOf.get(root);
  if (chains === undefined) return buildEndpointTree(keep);
  const top = newNode(root.path, root.segment, root.depth);
  const copies = new Map<EndpointTreeNode, EndpointTreeNode>([[root, top]]);
  // The copies on the way to the last kept endpoint, and its chain: consecutive
  // endpoints mostly share folders, which then need no lookup.
  const path = [top];
  let previous: readonly EndpointTreeNode[] = [root];
  for (const item of keep) {
    const chain = chains.get(item);
    if (chain === undefined) continue;
    let at = 1;
    while (at < chain.length && chain[at] === previous[at]) at++;
    path.length = at;
    for (; at < chain.length; at++) {
      const original = chain[at] as EndpointTreeNode;
      let copy = copies.get(original);
      if (copy === undefined) {
        copy = newNode(original.path, original.segment, original.depth);
        copies.set(original, copy);
        path[at - 1]?.children.push(copy);
        for (const above of path) above.folders++;
      }
      path.push(copy);
    }
    for (const node of path) node.count++;
    path[path.length - 1]?.endpoints.push(item);
    previous = chain;
  }
  return top;
}

/** The folder paths that must be open for an endpoint at `path` to show: `/v1`, `/v1/products`, … */
export function folderPathsTo(path: string): string[] {
  const segments = segmentsOf(path);
  return segments.map((_, index) => `/${segments.slice(0, index + 1).join('/')}`);
}

/** One rendered line of the tree: a folder or an endpoint, with its depth for indentation. */
export type TreeRow =
  | {
      readonly kind: 'folder';
      readonly node: EndpointTreeNode;
      readonly expanded: boolean;
      /** False for a top-level group with a single endpoint, which is never collapsed. */
      readonly collapsible: boolean;
      readonly count: number;
    }
  | { readonly kind: 'endpoint'; readonly item: EndpointItem; readonly depth: number };

/** Which folders are open, and how many rows each node's contents take. */
export interface TreeLayout {
  /** Rows below the root: the length of the flattened tree. */
  readonly total: number;
  readonly open: ReadonlySet<EndpointTreeNode>;
  /** Rows inside each open node, not counting its own folder row. */
  readonly size: ReadonlyMap<EndpointTreeNode, number>;
  /**
   * Open folders whose every folder below is open too: their contents take
   * `count + folders` rows, and nothing below them is in `open` or `size`.
   */
  readonly whole: ReadonlySet<EndpointTreeNode>;
}

/** Top-level groups with a single endpoint are never collapsed. */
const isCollapsible = (node: EndpointTreeNode): boolean => !(node.depth === 1 && node.count === 1);

/**
 * Decides which folders are open and counts rows, visiting folders only: an
 * endpoint list counts by its length. It runs whenever the filter changes, so
 * it never allocates a row. `isWhole`, when given, says that
 * every folder below an open folder is open, as while searching: that folder
 * is counted from its totals and not visited.
 */
export function layoutTree(
  root: EndpointTreeNode,
  isExpanded: (node: EndpointTreeNode, count: number) => boolean,
  isWhole?: (node: EndpointTreeNode) => boolean,
): TreeLayout {
  const open = new Set<EndpointTreeNode>();
  const size = new Map<EndpointTreeNode, number>();
  const whole = new Set<EndpointTreeNode>();
  const visit = (node: EndpointTreeNode): number => {
    let rows = node.endpoints.length;
    for (const child of node.children) {
      rows++;
      if (!isCollapsible(child) || isExpanded(child, child.count)) {
        if (isWhole?.(child) === true) {
          whole.add(child);
          rows += child.count + child.folders;
        } else {
          open.add(child);
          rows += visit(child);
        }
      }
    }
    size.set(node, rows);
    return rows;
  };
  return { total: visit(root), open, size, whole };
}

/**
 * Rows `first` to `last` (exclusive) of the laid-out tree, in display order:
 * each folder's own endpoints, then its child folders, recursing only into
 * open ones and skipping whole folders before `first`.
 */
export function treeRows(root: EndpointTreeNode, layout: TreeLayout, first = 0, last = Infinity): TreeRow[] {
  const rows: TreeRow[] = [];
  let index = 0;
  const visit = (node: EndpointTreeNode, inWhole: boolean): void => {
    const { endpoints } = node;
    for (let at = Math.max(0, first - index); at < endpoints.length && index + at < last; at++) {
      const item = endpoints[at];
      if (item !== undefined) rows.push({ kind: 'endpoint', item, depth: node.depth });
    }
    index += endpoints.length;
    for (const child of node.children) {
      if (index >= last) return;
      const whole = inWhole || layout.whole.has(child);
      const expanded = whole || layout.open.has(child);
      if (index >= first) {
        rows.push({ kind: 'folder', node: child, expanded, collapsible: isCollapsible(child), count: child.count });
      }
      index++;
      if (expanded) {
        const inside = whole ? child.count + child.folders : (layout.size.get(child) ?? 0);
        if (index + inside <= first) index += inside;
        else visit(child, whole);
      }
    }
  };
  visit(root, false);
  return rows;
}

/** The whole tree as the rows that are visible, in display order. */
export function flattenTree(
  root: EndpointTreeNode,
  isExpanded: (node: EndpointTreeNode, count: number) => boolean,
): TreeRow[] {
  return treeRows(root, layoutTree(root, isExpanded));
}
