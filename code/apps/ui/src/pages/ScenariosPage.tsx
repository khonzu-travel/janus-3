import { useRef, useState, type KeyboardEvent } from 'react';
import { Link, useOutletContext } from 'react-router';

import type { Scenario } from '../atlas/client.js';
import { EmptyState } from '../components/states/EmptyState.js';
import { HelpTip } from '../components/HelpTip.js';
import { ChevronRightIcon } from '../components/icons.js';
import { pageToolbarClass } from '../components/listRows.js';
import { linkClass } from '../components/buttonClass.js';
import { LoadingState } from '../components/states/LoadingState.js';
import type { AtlasLayoutContext } from '../layouts/AtlasLayoutContext.js';
import { ResizeHandle, SIDE_PANE, usePaneWidth } from '../layouts/ResizeHandle.js';
import { useViewport } from '../layouts/useViewport.js';
import { useChangeScenario } from '../scenarios/ScenarioSelector.js';
import { withScenario } from '../scenarios/selection.js';
import { latencyText } from '../features/endpoints/faultSentences.js';

/**
 * `#/scenarios`: the inheritance graph as a tree, `default` at
 * the root, and the details of the selected scenario. Selecting a node selects
 * that scenario everywhere.
 */
export function ScenariosPage() {
  const { health, scenarios, scenario } = useOutletContext<AtlasLayoutContext>();
  const change = useChangeScenario(health);
  // From 769 px the tree sits beside the details at the endpoint tree's width, resizable; below, above them.
  const beside = useViewport() !== 'narrow';
  const [treeWidth, setTreeWidth] = usePaneWidth(SIDE_PANE);
  if (!scenario.supported) {
    return (
      <EmptyState title="No scenarios" headingLevel={2}>
        This server predates scenarios, so it serves only <code>default</code>.
      </EmptyState>
    );
  }
  if (scenarios === undefined) return <LoadingState label="Loading scenarios" />;
  const selected = scenarios.items.find((item) => item.name === scenario.name);
  // Two panes, like the endpoints view: the tree on the left, the details beside it.
  return (
    <section aria-labelledby="scenarios-title" className="flex min-h-full flex-col bg-surface">
      <div className={pageToolbarClass}>
        <div className="flex items-center gap-1">
          <h2 id="scenarios-title" className="font-medium">
            Scenarios
          </h2>
          <HelpTip label="About scenarios">
            Each scenario inherits its parent’s files and replaces or removes some of them. Requests with no scenario
            get <code className="font-mono text-mono text-fg">{scenarios.configuredDefault}</code>.
          </HelpTip>
        </div>
      </div>
      <div className={`flex min-h-0 flex-1 ${beside ? '' : 'flex-col'}`}>
        <div
          className={`shrink-0 bg-bg py-1 ${beside ? '' : 'border-b border-line'}`}
          style={beside ? { width: treeWidth } : undefined}
        >
          <ScenarioTree items={scenarios.items} selected={scenario.name} onSelect={change} />
        </div>
        {beside ? <ResizeHandle spec={SIDE_PANE} width={treeWidth} onResize={setTreeWidth} side="start" /> : null}
        <div className="min-w-0 flex-1">
          {selected === undefined ? (
            <p className="px-4 py-3 text-muted">Scenario {scenario.name} is not in this snapshot.</p>
          ) : (
            <ScenarioDetails scenario={selected} configured={health.configuredDefaultScenario} />
          )}
        </div>
      </div>
    </section>
  );
}

interface TreeNode {
  readonly scenario: Scenario;
  readonly children: readonly TreeNode[];
  readonly level: number;
  readonly parent: string | null;
}

function buildTree(items: readonly Scenario[]): TreeNode[] {
  const childrenOf = new Map<string | null, Scenario[]>();
  for (const item of items) {
    const list = childrenOf.get(item.extends) ?? [];
    list.push(item);
    childrenOf.set(item.extends, list);
  }
  const build = (parent: string | null, level: number): TreeNode[] =>
    (childrenOf.get(parent) ?? []).map((item) => ({
      scenario: item,
      children: build(item.name, level + 1),
      level,
      parent,
    }));
  return build(null, 1);
}

/** The nodes a keyboard user can reach, in display order: children of collapsed nodes are skipped. */
function visibleNodes(roots: readonly TreeNode[], collapsed: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (node: TreeNode) => {
    out.push(node);
    if (!collapsed.has(node.scenario.name)) node.children.forEach(visit);
  };
  roots.forEach(visit);
  return out;
}

/**
 * A WAI-ARIA tree view: one tab stop, arrow keys move between nodes, Right
 * and Left open, close and move between levels, Home and End jump, and Enter
 * or Space selects.
 */
function ScenarioTree({
  items,
  selected,
  onSelect,
}: {
  readonly items: readonly Scenario[];
  readonly selected: string;
  readonly onSelect: (name: string) => void;
}) {
  const roots = buildTree(items);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState(selected);
  const refs = useRef(new Map<string, HTMLLIElement>());
  const visible = visibleNodes(roots, collapsed);
  // The tab stop is the focused node while it is visible, else the selected one, else the first.
  const tabStop = visible.some((node) => node.scenario.name === focused)
    ? focused
    : visible.some((node) => node.scenario.name === selected)
      ? selected
      : (visible[0]?.scenario.name ?? '');

  const moveTo = (name: string | undefined) => {
    if (name === undefined) return;
    setFocused(name);
    refs.current.get(name)?.focus();
  };
  const toggle = (name: string, open: boolean) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (open) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, node: TreeNode) => {
    const index = visible.findIndex((entry) => entry.scenario.name === node.scenario.name);
    const name = node.scenario.name;
    const open = node.children.length > 0 && !collapsed.has(name);
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        moveTo(visible[index + 1]?.scenario.name);
        break;
      case 'ArrowUp':
        moveTo(visible[index - 1]?.scenario.name);
        break;
      case 'Home':
        moveTo(visible[0]?.scenario.name);
        break;
      case 'End':
        moveTo(visible[visible.length - 1]?.scenario.name);
        break;
      case 'ArrowRight':
        if (node.children.length === 0) break;
        if (open) moveTo(node.children[0]?.scenario.name);
        else toggle(name, true);
        break;
      case 'ArrowLeft':
        if (open) toggle(name, false);
        else moveTo(node.parent ?? undefined);
        break;
      case 'Enter':
      case ' ':
        onSelect(name);
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const render = (node: TreeNode) => {
    const name = node.scenario.name;
    const hasChildren = node.children.length > 0;
    const open = hasChildren && !collapsed.has(name);
    return (
      <li
        key={name}
        ref={(element) => {
          if (element === null) refs.current.delete(name);
          else refs.current.set(name, element);
        }}
        role="treeitem"
        aria-level={node.level}
        aria-selected={name === selected}
        aria-expanded={hasChildren ? open : undefined}
        tabIndex={name === tabStop ? 0 : -1}
        onKeyDown={(event) => {
          onKeyDown(event, node);
        }}
        onFocus={(event) => {
          if (event.target === event.currentTarget) setFocused(name);
        }}
        onClick={(event) => {
          event.stopPropagation();
          setFocused(name);
          onSelect(name);
        }}
        className="cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <span
          className={`flex min-h-6 items-center gap-1.5 py-0.5 pr-2.5 hover:bg-hover ${
            name === selected ? 'bg-accent-soft font-medium shadow-[inset_2px_0_0_var(--accent)]' : ''
          }`}
          style={{ paddingLeft: `${String(0.5 + (node.level - 1) * 0.875)}rem` }}
        >
          {hasChildren ? (
            <ChevronRightIcon
              className={`size-3 shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`}
            />
          ) : (
            <span className="size-3 shrink-0" aria-hidden="true" />
          )}
          {name}
        </span>
        {open ? <ul role="group">{node.children.map(render)}</ul> : null}
      </li>
    );
  };

  return (
    <ul role="tree" aria-label="Scenario inheritance" className="font-mono text-mono">
      {roots.map(render)}
    </ul>
  );
}

function ScenarioDetails({ scenario, configured }: { readonly scenario: Scenario; readonly configured: string }) {
  const inventory = (own: boolean): string => {
    const next = withScenario(new URLSearchParams(), scenario.name, configured);
    if (own) next.set('own', '1');
    const text = next.toString();
    return `/endpoints${text === '' ? '' : `?${text}`}`;
  };
  return (
    <section aria-labelledby="scenario-details-title" className="min-w-0 space-y-3 px-4 py-3">
      <h3 id="scenario-details-title" className="font-mono text-title font-medium">
        {scenario.name}
      </h3>
      <p>{scenario.description ?? <span className="text-muted">No description.</span>}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        <dt className="text-muted">Inherits</dt>
        <dd>{scenario.chain.length <= 1 ? 'Nothing: the root scenario' : scenario.chain.slice(1).join(' → ')}</dd>
        <dt className="text-muted">Endpoints</dt>
        <dd>
          <Link to={inventory(true)} className={linkClass}>
            {scenario.endpoints.own} own
          </Link>
          {', '}
          {scenario.endpoints.inherited} inherited,{' '}
          <Link to={inventory(false)} className={linkClass}>
            {scenario.endpoints.total} in all
          </Link>
        </dd>
        {/* The scenario's own latency, and the one it uses along its chain. */}
        <dt className="text-muted">Latency</dt>
        <dd>
          {scenario.latency.effective === null
            ? 'None from flow.yaml'
            : `${latencyText(scenario.latency.effective.profile)} before the first byte${
                scenario.latency.effective.scenario === scenario.name
                  ? ', from its flow.yaml'
                  : `, inherited from ${scenario.latency.effective.scenario}`
              }`}
        </dd>
      </dl>
      <div>
        <h4 className={subheadingClass}>
          IDs <span className={countClass}>{scenario.ids.length}</span>
        </h4>
        {scenario.ids.length === 0 ? (
          <p className="text-muted">None.</p>
        ) : (
          <table className="data-table mt-1 max-w-xl [&_td]:px-0 [&_td]:pr-4 [&_th]:px-0 [&_th]:pr-4">
            <caption className="sr-only">Effective IDs and the scenario each comes from</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Value</th>
                <th scope="col">From</th>
              </tr>
            </thead>
            <tbody>
              {scenario.ids.map((id) => (
                <tr key={id.name}>
                  <th scope="row" className="font-mono text-mono font-normal">
                    {id.name}
                  </th>
                  <td className="font-mono text-mono">{id.value}</td>
                  <td>{id.from}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <ReferenceList title="Overrides" entries={scenario.overrides} />
      <ReferenceList title="Removes" entries={scenario.removes} />
    </section>
  );
}

function ReferenceList({ title, entries }: { readonly title: string; readonly entries: readonly string[] }) {
  return (
    <div>
      <h4 className={subheadingClass}>
        {title} <span className={countClass}>{entries.length}</span>
      </h4>
      {entries.length === 0 ? (
        <p className="text-muted">None.</p>
      ) : (
        <ul className="mt-1 space-y-0.5 font-mono text-mono">
          {entries.map((entry) => (
            <li key={entry} className="break-all">
              {entry}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const subheadingClass = 'text-label font-medium tracking-[0.06em] text-faint uppercase';
const countClass = 'font-normal tracking-normal text-faint normal-case';
