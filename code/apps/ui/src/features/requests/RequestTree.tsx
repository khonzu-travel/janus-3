import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import type { ContainerNode, RequestTree as Tree, TreeNode } from '../../atlas/runner.js';
import { MethodBadge } from '../../components/MethodBadge.js';
import { ContextMenu, type MenuItem } from './ContextMenu.js';
import { filterBoxClass } from '../../components/listRows.js';
import { EmptyState } from '../../components/states/EmptyState.js';
import { MoreIcon } from './icons.js';
import { keptSearch } from './RunBar.js';
import { parentOf } from './variables.js';

/** The node and its descendants that match `text`, or null; a container that matches keeps all of its own. */
function filtered(node: TreeNode, text: string): TreeNode | null {
  const matches = `${node.name} ${node.id} ${node.kind === 'request' ? node.method : ''}`.toLowerCase().includes(text);
  if (node.kind === 'request') return matches ? node : null;
  if (matches) return node;
  const children = node.children.map((child) => filtered(child, text)).filter((child) => child !== null);
  return children.length === 0 ? null : { ...node, children };
}

/**
 * The tree of collections, folders and requests, with each
 * request's method, filtered by text. Each entry is a link that opens it in
 * an editor tab. A collection or folder has a menu (right-click, the Menu
 * key, Shift + F10, or its ⋯ button) that runs it. A request dragged onto
 * another collection or folder (or onto a request in one) moves there.
 */
export function RequestTree({
  tree,
  selected,
  off,
  menuFor,
  onMove,
}: {
  /** Null when the request runner is off. */
  readonly tree: Tree | null;
  /** The node whose tab is in front. */
  readonly selected: string | null;
  /** Why there is no tree, when `tree` is null. */
  readonly off?: string;
  readonly menuFor: (node: ContainerNode) => readonly MenuItem[];
  /** A request was dropped on the collection or folder `parent`. */
  readonly onMove?: (id: string, parent: string) => void;
}) {
  const filterId = useId();
  const [text, setText] = useState('');
  const [menu, setMenu] = useState<{ node: ContainerNode; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [search] = useSearchParams();
  const kept = keptSearch(search);
  const query = text.trim().toLowerCase();
  const all = tree?.collections ?? [];
  const collections = query === '' ? all : all.map((node) => filtered(node, query)).filter((node) => node !== null);
  const href = (id: string): string => {
    const next = new URLSearchParams(kept);
    next.set('id', id);
    return `/requests?${next.toString()}`;
  };
  const openMenu = (node: ContainerNode, element: Element, at?: { x: number; y: number }): void => {
    const box = element.getBoundingClientRect();
    setMenu({ node, x: at?.x ?? box.left + 16, y: at?.y ?? box.bottom });
  };

  const render = (node: TreeNode, depth: number) => {
    const current = node.id === selected;
    const container = node.kind === 'request' ? null : node;
    // Where a request dropped on this row goes: the row itself, or the folder a request row sits in.
    const into = container === null ? parentOf(node.id) : container.id;
    const drop = onMove === undefined || dragging === null || parentOf(dragging) === into ? null : dragging;
    const entry = (
      <Link
        to={href(node.id)}
        aria-current={current ? 'page' : undefined}
        aria-haspopup={container === null ? undefined : 'menu'}
        className={`flex min-w-0 flex-1 items-center gap-2 py-1 pr-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
          node.kind === 'request' ? '' : 'font-medium'
        }`}
        style={{ paddingLeft: `${String(0.75 + depth * 0.875)}rem` }}
        draggable={node.kind === 'request' && onMove !== undefined ? true : undefined}
        onDragStart={(event) => {
          if (node.kind !== 'request' || onMove === undefined) return;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', node.id);
          setDragging(node.id);
        }}
        onDragEnd={() => {
          setDragging(null);
          setOver(null);
        }}
        onContextMenu={(event) => {
          if (container === null) return;
          event.preventDefault();
          openMenu(container, event.currentTarget, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (container === null) return;
          if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
            event.preventDefault();
            openMenu(container, event.currentTarget);
          }
        }}
      >
        {node.kind === 'request' ? (
          <span className="w-12 shrink-0">
            <MethodBadge method={node.method} short />
          </span>
        ) : null}
        <span className="truncate">{node.name}</span>
        {node.kind === 'collection' ? <span className="sr-only"> (collection)</span> : null}
        {node.kind === 'folder' ? <span className="sr-only"> (folder)</span> : null}
      </Link>
    );
    return (
      <li key={node.id}>
        <div
          className={`group flex items-center hover:bg-hover ${current ? 'bg-accent-soft' : ''} ${
            container !== null && over === container.id ? 'outline-2 -outline-offset-2 outline-accent' : ''
          }`}
          onDragOver={(event) => {
            if (drop === null) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setOver(into);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
          }}
          onDrop={(event) => {
            if (drop === null || onMove === undefined) return;
            event.preventDefault();
            setDragging(null);
            setOver(null);
            onMove(drop, into);
          }}
        >
          {entry}
          {container === null ? null : (
            <button
              type="button"
              className="mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-surface hover:text-fg focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent"
              aria-label={`More for ${container.name}`}
              title="More (right-click, Shift + F10)"
              aria-haspopup="menu"
              onClick={(event) => {
                openMenu(container, event.currentTarget);
              }}
            >
              <MoreIcon className="size-3.5" />
            </button>
          )}
        </div>
        {node.kind === 'request' || node.children.length === 0 ? null : (
          <ul>{node.children.map((child) => render(child, depth + 1))}</ul>
        )}
      </li>
    );
  };

  return (
    <nav aria-label="Requests" className="flex min-h-0 flex-1 flex-col">
      {tree === null ? (
        <p className="p-3 text-muted">{off}</p>
      ) : (
        <>
          <div className="border-b border-line p-2">
            <label htmlFor={filterId} className="sr-only">
              Filter requests
            </label>
            <input
              id={filterId}
              type="search"
              className={`${filterBoxClass} w-full`}
              placeholder="Filter requests"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
          </div>
          {collections.length === 0 ? (
            all.length === 0 ? (
              <EmptyState title="No collections yet" headingLevel={null}>Create one (key 2), or import one (key 3).</EmptyState>
            ) : (
              <EmptyState title="Nothing matches" headingLevel={null}>No request or collection matches this filter.</EmptyState>
            )
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto py-1">{collections.map((node) => render(node, 0))}</ul>
          )}
          {tree.problems.length === 0 ? null : (
            <details className="border-t border-line p-3">
              <summary className="cursor-pointer text-bad">
                {tree.problems.length} {tree.problems.length === 1 ? 'file has a problem' : 'files have problems'}
              </summary>
              <ul className="mt-1 grid gap-1">
                {tree.problems.map((problem, index) => (
                  <li key={index}>
                    <code className="font-mono text-mono">
                      {problem.path}
                      {problem.line === undefined ? '' : `:${String(problem.line)}`}
                    </code>{' '}
                    {problem.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {menu === null ? null : (
        <ContextMenu
          label={menu.node.name}
          x={menu.x}
          y={menu.y}
          items={menuFor(menu.node)}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </nav>
  );
}
