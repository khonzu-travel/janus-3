import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useMatch, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router';

import type {
  CollectionNode,
  ContainerNode,
  EnvironmentDetail,
  RequestDocument,
  RequestTree as Tree,
  TreeNode,
} from '../../atlas/runner.js';
import { ExplainIcon, PlusIcon, TrashIcon } from '../../components/icons.js';
import { typing, useFoldKeys } from '../../components/foldKeys.js';
import { MethodBadge } from '../../components/MethodBadge.js';
import { EmptyState } from '../../components/states/EmptyState.js';
import { ErrorState } from '../../components/states/ErrorState.js';
import { LoadingState } from '../../components/states/LoadingState.js';
import { useAtlasSession } from '../../hooks/AtlasSession.js';
import type { AtlasLayoutContext } from '../../layouts/AtlasLayoutContext.js';
import { ResizeHandle, SIDE_PANE, usePaneWidth } from '../../layouts/ResizeHandle.js';
import { useViewport } from '../../layouts/useViewport.js';
import { ScratchRequest } from '../explorer/ExplorerPage.js';
import { explorerKey } from '../explorer/requestState.js';
import { CommandPalette, type Command } from './CommandPalette.js';
import { ContainerView, DeleteContainerDialog, NewFolderDialog, useRunContainer } from './ContainerView.js';
import { ContextMenu, type MenuItem } from './ContextMenu.js';
import { copyId, DeleteEnvironmentDialog, EnvironmentList, EnvironmentView } from './EnvironmentEditor.js';
import { useRequestTree, useRunnerRefresh } from './hooks.js';
import {
  CloseIcon,
  CollapseIcon,
  EnvironmentIcon,
  ExpandIcon,
  FolderIcon,
  ImportIcon,
  NewFolderIcon,
  NewRequestIcon,
  PlayIcon,
  RunsIcon,
} from './icons.js';
import { ImportDialog } from './ImportDialog.js';
import { InspectorShown, InspectorSlot } from './InspectorAside.js';
import { RequestTree } from './RequestTree.js';
import { NameDialog, RequestWorkspace, untitledId } from './RequestWorkspace.js';
import { RunBar, keptSearch, useBarSelection, useRequestsView, type RequestsAbilities } from './RunBar.js';
import { RunList, RunView } from './RunView.js';
import { SaveRequestDialog } from './SaveRequestDialog.js';
import {
  closeMissing,
  closeTab,
  environmentKey,
  moveTab,
  nodeKey,
  openTab,
  restoreTabs,
  setFrontTab,
  openUntitled,
  replaceTab,
  setPanel,
  setTabName,
  untitledName,
  untitledParam,
  updateUntitled,
  useTabState,
  type EditorTab,
} from './tabState.js';
import { leafOf, nextOrdered, parentOf, slug } from './variables.js';

/** The node with this ID and its collection, or null. */
export function findNode(tree: Tree, id: string): { node: TreeNode; collection: CollectionNode } | null {
  const walk = (node: TreeNode): TreeNode | null => {
    if (node.id === id) return node;
    if (node.kind === 'request') return null;
    for (const child of node.children) {
      const found = walk(child);
      if (found !== null) return found;
    }
    return null;
  };
  for (const collection of tree.collections) {
    const node = walk(collection);
    if (node !== null) return { node, collection };
  }
  return null;
}

/** The route's own module, loaded on first visit so the request runner adds nothing to the first load. */
export function Component() {
  return <RequestsPage />;
}

/** `?env=` opens an environment's tab and `?tab=untitled-3` an untitled request's; `?id=` a request, folder or collection's. */
const ENV_PARAM = 'env';
const TAB_PARAM = 'tab';

/** What the address names: the tab to show in front. */
type Addressed =
  | { readonly kind: 'node'; readonly id: string }
  | { readonly kind: 'environment'; readonly id: string }
  | { readonly kind: 'untitled'; readonly number: number }
  /** A "Try it" or shared explanation link: a simulation to open in a new untitled tab. */
  | { readonly kind: 'link'; readonly explore: string }
  | null;

function addressed(search: URLSearchParams): Addressed {
  const id = search.get('id');
  if (id !== null) return { kind: 'node', id };
  const env = search.get(ENV_PARAM);
  if (env !== null) return { kind: 'environment', id: env };
  const tab = /^untitled-([1-9][0-9]{0,5})$/.exec(search.get(TAB_PARAM) ?? '');
  if (tab !== null) return { kind: 'untitled', number: Number(tab[1]) };
  const explore = explorerKey(search);
  return explore === '' ? null : { kind: 'link', explore };
}

/** The address of a tab, keeping the scenario and mode. */
function hrefOf(tab: EditorTab, search: URLSearchParams): string {
  const next = keptSearch(search);
  // An open import dialog stays open while the tab in front changes.
  if (search.has('import')) next.set('import', '1');
  if (tab.kind === 'node') next.set('id', tab.id);
  else if (tab.kind === 'environment') next.set(ENV_PARAM, tab.id);
  else {
    next.set(TAB_PARAM, untitledParam(tab.number));
    if (tab.form === 'explore') for (const [name, value] of new URLSearchParams(tab.explore)) next.append(name, value);
  }
  return `/requests?${next.toString()}`;
}

function sameTab(tab: EditorTab, address: Addressed): boolean {
  if (address === null || address.kind === 'link') return false;
  if (address.kind === 'untitled') return tab.kind === 'untitled' && tab.number === address.number;
  return tab.kind === address.kind && tab.id === address.id;
}

/**
 * `#/requests`: the side panel
 * (collections or environments, the hotbar, foldable), and the editor tabs
 * beside it: requests, folders, collections, environments and untitled
 * requests, each in Explore (what the mock would answer, and why) or Live
 * (send it). `#/requests/runs` lists kept runs and `#/requests/runs/<id>`
 * shows one. `?mode=` names the mode, and `?import=1` opens the Import
 * dialog (the desktop app's File menu uses it).
 */
export function RequestsPage() {
  const { health, scenario } = useOutletContext<AtlasLayoutContext>();
  const { client } = useAtlasSession();
  const refresh = useRunnerRefresh();
  const capability = health.capabilities.runner;
  const abilities: RequestsAbilities = { runner: capability.available, resolve: health.capabilities.resolve };
  const view = useRequestsView(abilities);
  const tree = useRequestTree(capability.available);
  const { tabs, panel, names } = useTabState();
  // From 769 px the side panel sits beside the editor at the endpoint tree's width, resizable; below, above it.
  const beside = useViewport() !== 'narrow';
  const [sideWidth, setSideWidth] = usePaneWidth(SIDE_PANE);
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const { runId } = useParams();
  const onRuns = useMatch({ path: '/requests/runs', end: true }) !== null || runId !== undefined;
  const importing = search.get('import') === '1';
  const [dialog, setDialog] = useState<
    | { readonly kind: 'collection' | 'environment' | 'palette' }
    | { readonly kind: 'folder' | 'delete'; readonly node: ContainerNode }
    | { readonly kind: 'save'; readonly tab: EditorTab; readonly document: RequestDocument }
    | null
  >(null);
  const [failure, setFailure] = useState<Error | null>(null);
  /** The request last moved by dragging, while its Undo shows. */
  const [moved, setMoved] = useState<{ readonly from: string; readonly to: string; readonly name: string } | null>(
    null,
  );
  const [moveFailure, setMoveFailure] = useState<Error | null>(null);
  const [inspectorSlot, setInspectorSlot] = useState<HTMLDivElement | null>(null);
  /** An environment tab whose name to start editing. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const stopRenaming = useCallback(() => {
    setRenaming(null);
  }, []);
  const [deletingEnvironment, setDeletingEnvironment] = useState<EnvironmentDetail | null>(null);
  const [environmentFailure, setEnvironmentFailure] = useState<Error | null>(null);
  const collections = tree.data?.collections ?? [];
  const environments = tree.data?.environments ?? [];
  const address = onRuns ? null : addressed(search);
  const active = tabs.find((tab) => sameTab(tab, address)) ?? null;
  const runContainer = useRunContainer(environments, scenario, view);
  const barSelection = useBarSelection(environments, scenario, view);

  const go = (tab: EditorTab, replace = false): void => {
    void navigate(hrefOf(tab, search), { replace });
  };
  const select = (id: string | null): void => {
    if (id === null) {
      void navigate(`/requests?${keptSearch(search).toString()}`);
      return;
    }
    const next = keptSearch(search);
    next.set('id', id);
    void navigate(`/requests?${next.toString()}`);
  };
  const newRequest = (parent: string | null = null): void => {
    const form = capability.available && (collections.length > 0 || !abilities.resolve) ? 'request' : 'explore';
    const here =
      parent ?? (active?.kind === 'node' && tree.data !== undefined ? containerOf(tree.data, active.id) : null);
    go(openUntitled(form, here));
  };
  const setImporting = (open: boolean): void => {
    const next = new URLSearchParams(search);
    if (open) next.set('import', '1');
    else next.delete('import');
    setSearch(next);
  };
  /** The address of a tab just closed, which must not reopen it before the next address arrives. */
  const closing = useRef<string | null>(null);
  const close = (tab: EditorTab): void => {
    const next = closeTab(tab.key);
    if (active?.key !== tab.key) return;
    closing.current = search.toString();
    if (next !== null) go(next, true);
    else void navigate(`/requests?${keptSearch(search).toString()}`, { replace: true });
  };

  // The address names a tab: open it if it is not open yet.
  const known = tree.data !== undefined;
  const exists = (kind: 'node' | 'environment', id: string): boolean =>
    tree.data === undefined
      ? false
      : kind === 'node'
        ? findNode(tree.data, id) !== null
        : tree.data.environments.some((entry) => entry.id === id);
  const missing =
    address !== null && (address.kind === 'node' || address.kind === 'environment') && known
      ? !exists(address.kind, address.id)
      : false;
  /** The address last acted on: opening a tab re-renders before the new address arrives. */
  const handled = useRef<string | null>(null);
  const here = search.toString();
  useEffect(() => {
    if (closing.current !== null && closing.current !== here) closing.current = null;
    if (onRuns) return;
    const act = (): boolean => {
      if (handled.current === here) return false;
      handled.current = here;
      return true;
    };
    if (known && capability.available) {
      // Startup: the saved items open last time come back, the one in front in front.
      const back = restoreTabs(exists);
      if (back !== null && address === null) {
        if (act()) go(back, true);
        return;
      }
    }
    if (address === null) {
      // Nothing named: the last tab, else a new untitled request.
      const last = tabs.at(-1);
      if (last !== undefined) {
        if (act()) go(last, true);
      } else if ((capability.available ? known : true) && act()) {
        go(openUntitled(capability.available && collections.length > 0 ? 'request' : 'explore', null), true);
      }
      return;
    }
    if (address.kind === 'link') {
      if (act()) go(openUntitled('explore', null, address.explore), true);
      return;
    }
    if (active !== null) {
      // Shown: a later bare address (the Requests link again) must act once more.
      handled.current = here;
      return;
    }
    if (address.kind === 'untitled') {
      // Gone (the page was reloaded, or the link was shared): the request the
      // address describes opens in a new tab, else start over.
      if (!act()) return;
      const explore = explorerKey(search);
      if (explore !== '') go(openUntitled('explore', null, explore), true);
      else void navigate(`/requests?${keptSearch(search).toString()}`, { replace: true });
      return;
    }
    if (closing.current === here) return;
    if (known && !missing) {
      openTab(
        address.kind === 'node'
          ? { kind: 'node', key: nodeKey(address.id), id: address.id }
          : { kind: 'environment', key: environmentKey(address.id), id: address.id },
      );
    }
  });
  // The saved item in front is in front again at startup.
  const frontKey = active === null || active.kind === 'untitled' ? null : active.key;
  useEffect(() => {
    setFrontTab(frontKey);
  }, [frontKey]);
  // Tabs whose file is gone close.
  useEffect(() => {
    if (tree.data === undefined) return;
    const loaded = tree.data;
    closeMissing((tab) =>
      tab.kind === 'node'
        ? findNode(loaded, tab.id) !== null
        : tab.kind === 'environment'
          ? loaded.environments.some((entry) => entry.id === tab.id)
          : true,
    );
  }, [tree.data]);

  /** Copies an environment, sensitive values included, as "<name> copy", and opens the copy. */
  const duplicateEnvironment = (id: string): void => {
    setEnvironmentFailure(null);
    void (async () => {
      const detail = await client.runner.environment(id);
      const copy = copyId(
        id,
        environments.map((entry) => entry.id),
      );
      const { default: _default, ...document } = detail.document;
      await client.runner.saveEnvironment(
        copy,
        { document: { ...document, name: `${document.name ?? id} copy` }, local: detail.local },
        'absent',
      );
      await refresh();
      go({ kind: 'environment', key: environmentKey(copy), id: copy });
    })().catch((error: unknown) => {
      setEnvironmentFailure(error instanceof Error ? error : new Error(String(error)));
    });
  };

  /** Moves the saved request `from` to `to` (a new file there, then the old one deleted); its tab follows. */
  const moveRequest = async (from: string, to: string): Promise<void> => {
    const file = await client.runner.request(from);
    const written = await client.runner.saveRequest(to, file.document, 'absent');
    await client.runner.deleteRequest(from, file.digest);
    moveTab(nodeKey(from), to, { id: to, digest: written.digest ?? '', document: file.document });
    if (active?.kind === 'node' && active.id === from) go({ kind: 'node', key: nodeKey(to), id: to }, true);
    await refresh();
  };
  const dropRequest = (id: string, parent: string): void => {
    if (tree.data === undefined) return;
    const target = findNode(tree.data, parent);
    const request = findNode(tree.data, id);
    if (target === null || target.node.kind === 'request' || request === null) return;
    const siblings = target.node.children.map((node) => node.id);
    const to = `${parent}/${nextOrdered(siblings, leafOf(id).replace(/^\d+-/, ''))}`;
    setMoveFailure(null);
    moveRequest(id, to)
      .then(() => {
        setMoved({ from: id, to, name: request.node.name });
      })
      .catch((error: unknown) => {
        setMoveFailure(error instanceof Error ? error : new Error(String(error)));
      });
  };
  // The Undo shows briefly.
  useEffect(() => {
    if (moved === null) return undefined;
    const timer = window.setTimeout(() => {
      setMoved(null);
    }, 6000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [moved]);
  const undoMove = (): void => {
    if (moved === null) return;
    const { from, to } = moved;
    setMoved(null);
    moveRequest(to, from).catch((error: unknown) => {
      setMoveFailure(error instanceof Error ? error : new Error(String(error)));
    });
  };

  const kind = (node: ContainerNode): string => (node.kind === 'collection' ? 'collection' : 'folder');
  const runDetail = `Live · ${
    environments.find((entry) => entry.id === barSelection.environment)?.name ?? 'No environment'
  }`;
  const menuFor = (node: ContainerNode): MenuItem[] => {
    const start = (explain: boolean): void => {
      setFailure(null);
      runContainer(node.id, explain).catch((error: unknown) => {
        setFailure(error instanceof Error ? error : new Error(String(error)));
      });
    };
    const sendTo = { mock: 'Mock', upstream: 'Upstream', record: 'Record' }[barSelection.sendTo];
    return [
      {
        label: `Run ${kind(node)}`,
        icon: <PlayIcon className="size-3.5" />,
        detail: `${runDetail} · Send to ${sendTo}`,
        disabled: !abilities.runner,
        onSelect: () => {
          start(false);
        },
      },
      {
        label: `Explain ${kind(node)}`,
        icon: <ExplainIcon className="size-3.5" />,
        disabled: !abilities.resolve,
        onSelect: () => {
          start(true);
        },
      },
      {
        label: 'New request here',
        icon: <NewRequestIcon className="size-3.5" />,
        separated: true,
        onSelect: () => {
          newRequest(node.id);
        },
      },
      {
        label: 'New folder',
        icon: <NewFolderIcon className="size-3.5" />,
        onSelect: () => {
          setDialog({ kind: 'folder', node });
        },
      },
      {
        label: `${node.kind === 'collection' ? 'Collection' : 'Folder'} settings`,
        icon: <FolderIcon className="size-3.5" />,
        onSelect: () => {
          select(node.id);
        },
      },
      {
        label: `Delete ${kind(node)}`,
        icon: <TrashIcon className="size-3.5" />,
        danger: true,
        separated: true,
        onSelect: () => {
          setDialog({ kind: 'delete', node });
        },
      },
    ];
  };

  type Action = { key: string; label: string; icon: ReactNode; run: () => void; off?: boolean };
  const importAction = (key: string): Action => ({
    key,
    label: 'Import',
    icon: <ImportIcon className="size-4" />,
    run: () => {
      setImporting(true);
    },
    off: !capability.available,
  });
  // With the environments showing, the hotbar holds only what that list needs.
  const actions: readonly Action[] =
    panel.list === 'environments'
      ? [
          {
            key: '1',
            label: 'New environment',
            icon: <EnvironmentIcon className="size-4" />,
            run: () => {
              setDialog({ kind: 'environment' });
            },
            off: !capability.available,
          },
          importAction('2'),
        ]
      : [
          {
            key: '1',
            label: 'New request',
            icon: <NewRequestIcon className="size-4" />,
            run: () => {
              newRequest();
            },
            off: !abilities.runner && !abilities.resolve,
          },
          {
            key: '2',
            label: 'New collection',
            icon: <NewFolderIcon className="size-4" />,
            run: () => {
              setDialog({ kind: 'collection' });
            },
            off: !capability.available,
          },
          importAction('3'),
          {
            key: '4',
            label: 'Runs',
            icon: <RunsIcon className="size-4" />,
            run: () => {
              void navigate(`/requests/runs?${keptSearch(search).toString()}`);
            },
            off: !capability.available,
          },
        ];

  const commands: Command[] = [
    ...actions.filter((action) => action.off !== true).map((action) => ({ ...action, hint: action.key })),
    ...(panel.list === 'environments'
      ? []
      : [
          {
            label: 'New environment',
            icon: <EnvironmentIcon className="size-3.5" />,
            run: () => {
              setDialog({ kind: 'environment' });
            },
          },
        ]),
    {
      label: panel.collapsed ? 'Show the side panel' : 'Fold the side panel',
      hint: 'Ctrl + [',
      run: () => {
        setPanel({ collapsed: !panel.collapsed });
      },
    },
    {
      label: panel.inspector ? 'Show the inspector' : 'Fold the inspector',
      hint: 'Ctrl + ]',
      run: () => {
        setPanel({ inspector: !panel.inspector });
      },
    },
    ...environments.map((entry) => ({
      label: entry.name,
      hint: 'environment',
      icon: <EnvironmentIcon className="size-3.5" />,
      run: () => {
        go({ kind: 'environment', key: environmentKey(entry.id), id: entry.id });
      },
    })),
    ...collections.flatMap((collection) => commandsFor(collection, '', select)),
  ];

  // Ctrl/Cmd + K anywhere on the tab.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setDialog({ kind: 'palette' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  // Ctrl/⌘ + [ folds the side panel, Ctrl/⌘ + ] the inspector.
  useFoldKeys(
    () => {
      setPanel({ collapsed: !panel.collapsed });
    },
    () => {
      setPanel({ inspector: !panel.inspector });
    },
  );

  const offReason =
    capability.reason === 'non-loopback'
      ? 'This server listens on a non-loopback address. Set runner.allowNonLoopback: true to send requests and keep them here.'
      : 'This Janus server does not run requests.';
  const runnerOff = (
    <EmptyState title="The request runner is off" headingLevel={2}>
      {offReason}
    </EmptyState>
  );

  const tabContent = (tab: EditorTab): ReactNode => {
    const front = tab.key === active?.key;
    if (tab.kind === 'environment') {
      return (
        <EnvironmentView
          id={tab.id}
          environments={environments}
          onDeleted={() => {
            close(tab);
          }}
          onDuplicate={() => {
            duplicateEnvironment(tab.id);
          }}
        />
      );
    }
    if (tab.kind === 'untitled') {
      const sendAs = untitledId(tab, collections);
      if (tab.form === 'explore' || !capability.available || sendAs === null) {
        // The simulation form follows the address, so only the tab in front has one.
        if (!front) return null;
        return (
          <div className="flex min-h-full flex-col">
            <RunBar abilities={abilities} selection={barSelection} />
            {view === 'explore' ? (
              <ScratchRequest
                title={names[tab.key] ?? untitledName(tab.number)}
                renderAt={barSelection.renderAt}
                initialDraft={tab.exploreDraft}
                onDraftChange={(exploreDraft) => {
                  updateUntitled(tab.key, { exploreDraft });
                }}
                onDraftSearch={(explore) => {
                  updateUntitled(tab.key, { explore });
                }}
                {...(capability.available && collections.length > 0
                  ? {
                      onSaveToCollection: (document: RequestDocument) => {
                        setDialog({
                          kind: 'save',
                          tab,
                          document: { ...document, name: names[tab.key] ?? untitledName(tab.number) },
                        });
                      },
                    }
                  : {})}
              />
            ) : (
              <EmptyState title="Live sends saved requests" headingLevel={2}>
                Create a collection to save this request in, or switch to Explore to ask what the mock would answer it.
              </EmptyState>
            )}
          </div>
        );
      }
      const collection = collections.find((entry) => sendAs.startsWith(`${entry.id}/`)) ?? null;
      return (
        <RequestWorkspace
          id={sendAs}
          untitled={tab}
          active={front}
          collection={collection}
          collections={collections}
          environments={environments}
          abilities={abilities}
          view={view}
          topBar={scenario}
          onSelect={select}
          onSaved={(id) => {
            const saved: EditorTab = { kind: 'node', key: nodeKey(id), id };
            replaceTab(tab.key, saved);
            go(saved, true);
          }}
        />
      );
    }
    if (tree.data === undefined) return null;
    const found = findNode(tree.data, tab.id);
    if (found === null) return null;
    if (found.node.kind === 'request') {
      return (
        <RequestWorkspace
          id={found.node.id}
          active={front}
          collection={found.collection}
          collections={collections}
          environments={environments}
          abilities={abilities}
          view={view}
          topBar={scenario}
          onSelect={select}
          onDeleted={() => {
            close(tab);
          }}
        />
      );
    }
    return <ContainerView node={found.node} environments={environments} onSelect={select} onNewRequest={newRequest} />;
  };

  let main: ReactNode;
  if (onRuns && !capability.available) main = runnerOff;
  else if (runId !== undefined) main = <RunView key={runId} id={runId} />;
  else if (onRuns) main = <RunList />;
  else if (missing && address !== null && address.kind !== 'link' && address.kind !== 'untitled') {
    main = (
      <EmptyState title="Not found" headingLevel={2}>
        Nothing named <code className="font-mono text-mono">{address.id}</code> exists. It may have been renamed or
        deleted.
      </EmptyState>
    );
  } else if (active === null) {
    main =
      tree.error !== null && tree.data === undefined ? (
        <ErrorState title="Could not load the requests" error={tree.error} onRetry={() => void tree.refetch()} />
      ) : (
        <LoadingState label="Opening" />
      );
  }

  let list: ReactNode;
  if (!capability.available) {
    list = (
      <RequestTree
        tree={null}
        selected={null}
        off={`Saved requests need the request runner, which is off. ${offReason}`}
        menuFor={menuFor}
      />
    );
  } else if (tree.error !== null && tree.data === undefined) {
    list = <ErrorState title="Could not load the requests" error={tree.error} onRetry={() => void tree.refetch()} />;
  } else if (tree.data === undefined) {
    list = <LoadingState label="Loading the requests" />;
  } else if (panel.list === 'environments') {
    list = (
      <>
        {environmentFailure === null ? null : (
          <ErrorState title="The environment was not changed" error={environmentFailure} />
        )}
        <EnvironmentList
          environments={environments}
          selected={active?.kind === 'environment' ? active.id : null}
          onOpen={(id) => {
            go({ kind: 'environment', key: environmentKey(id), id });
          }}
          onRename={(id) => {
            go({ kind: 'environment', key: environmentKey(id), id });
            // After the menu closes and hands focus back, so the name field keeps it.
            setTimeout(() => {
              setRenaming(environmentKey(id));
            });
          }}
          onDuplicate={duplicateEnvironment}
          onDelete={(id) => {
            setEnvironmentFailure(null);
            client.runner.environment(id).then(setDeletingEnvironment, (error: unknown) => {
              setEnvironmentFailure(error instanceof Error ? error : new Error(String(error)));
            });
          }}
        />
        {deletingEnvironment === null ? null : (
          <DeleteEnvironmentDialog
            detail={deletingEnvironment}
            onClose={() => {
              setDeletingEnvironment(null);
            }}
            onDeleted={() => {
              setDeletingEnvironment(null);
            }}
          />
        )}
      </>
    );
  } else {
    const where = moved === null ? undefined : findNode(tree.data, parentOf(moved.to))?.node.name;
    list = (
      <>
        {moved === null ? null : (
          // A small popup over the filter box, gone after a few seconds or with its X.
          <div
            role="status"
            className="absolute inset-x-2 top-1.5 z-10 flex items-center gap-2 rounded border border-line-strong bg-surface py-1 pr-1 pl-2.5 text-label shadow-md"
          >
            <span className="min-w-0 flex-1 truncate">
              Moved {moved.name} to {where ?? parentOf(moved.to)}.
            </span>
            <button type="button" className="font-medium text-accent hover:underline" onClick={undoMove}>
              Undo
            </button>
            <button
              type="button"
              className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => {
                setMoved(null);
              }}
            >
              <CloseIcon className="size-3" />
            </button>
          </div>
        )}
        {moveFailure === null ? null : <ErrorState title="The request was not moved" error={moveFailure} />}
        <RequestTree
          tree={tree.data}
          selected={active?.kind === 'node' ? active.id : null}
          menuFor={menuFor}
          onMove={dropRequest}
        />
      </>
    );
  }

  const hotbar = (
    <div
      role="toolbar"
      aria-label="Panel actions"
      aria-orientation={panel.collapsed ? 'vertical' : 'horizontal'}
      className={`flex gap-1.5 border-line bg-bg p-2 ${panel.collapsed ? 'flex-col' : 'border-t'}`}
    >
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          disabled={action.off}
          aria-label={action.label}
          aria-keyshortcuts={action.key}
          title={`${action.label} (${action.key})`}
          className={`relative inline-flex min-h-9 flex-1 items-center justify-center rounded border border-line-strong bg-surface text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-50 ${
            panel.collapsed ? 'min-w-9' : ''
          }`}
          onClick={action.run}
        >
          {action.icon}
          <span aria-hidden="true" className="absolute top-0.5 left-1 text-label leading-none text-muted">
            {action.key}
          </span>
        </button>
      ))}
    </div>
  );

  const panelSwitch = (
    <div role="group" aria-label="Side panel" className="inline-flex overflow-hidden rounded border border-line-strong">
      {(
        [
          ['collections', 'Collections', <FolderIcon key="c" className="size-3.5" />],
          ['environments', 'Environments', <EnvironmentIcon key="e" className="size-3.5" />],
        ] as const
      ).map(([list, label, icon], index) => (
        <button
          key={list}
          type="button"
          aria-pressed={panel.list === list}
          aria-label={label}
          title={label}
          className={`inline-flex min-h-6 items-center px-2 text-muted hover:bg-hover hover:text-fg aria-pressed:bg-fg aria-pressed:text-surface focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
            index === 0 ? '' : 'border-l border-line-strong'
          }`}
          onClick={() => {
            setPanel({ list, collapsed: false });
          }}
        >
          {icon}
        </button>
      ))}
    </div>
  );

  return (
    <InspectorSlot value={inspectorSlot}>
      <div className={`min-h-full ${beside ? 'flex' : 'flex flex-col'}`}>
        {/* Keys 1 to 4 run the hotbar while focus is in the panel and not in a field. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <aside
          aria-label="Request collections"
          className={`flex shrink-0 flex-col bg-surface ${
            !beside ? 'border-b border-line' : panel.collapsed ? 'border-r border-line' : ''
          }`}
          style={beside && !panel.collapsed ? { width: sideWidth } : undefined}
          onKeyDown={(event) => {
            if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
            const action = actions.find((entry) => entry.key === event.key);
            if (action !== undefined && action.off !== true) {
              event.preventDefault();
              action.run();
            }
          }}
        >
          {panel.collapsed ? (
            <>
              <div className="border-b border-line p-2">
                <button
                  type="button"
                  className="inline-flex size-9 items-center justify-center rounded text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
                  aria-label="Show the side panel"
                  aria-keyshortcuts="Control+[ Meta+["
                  title="Show the side panel (Ctrl + [)"
                  onClick={() => {
                    setPanel({ collapsed: false });
                  }}
                >
                  <ExpandIcon className="size-4" />
                </button>
              </div>
              {hotbar}
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
                {panelSwitch}
                <span className="font-medium">{panel.list === 'collections' ? 'Collections' : 'Environments'}</span>
                <button
                  type="button"
                  className="ml-auto inline-flex size-6 items-center justify-center rounded text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
                  aria-label="Fold the side panel"
                  aria-keyshortcuts="Control+[ Meta+["
                  title="Fold the side panel (Ctrl + [)"
                  onClick={() => {
                    setPanel({ collapsed: true });
                  }}
                >
                  <CollapseIcon className="size-4" />
                </button>
              </div>
              <div className="relative flex min-h-0 flex-1 flex-col">{list}</div>
              {hotbar}
            </>
          )}
        </aside>
        {beside && !panel.collapsed ? (
          <ResizeHandle spec={SIDE_PANE} width={sideWidth} onResize={setSideWidth} side="start" />
        ) : null}
        <section aria-label="Request runner" className="flex min-w-0 flex-1 flex-col overflow-x-clip bg-bg">
          <EditorTabs
            tabs={tabs}
            active={active}
            tree={tree.data}
            environments={environments}
            hrefOf={(tab) => hrefOf(tab, search)}
            onClose={close}
            onNew={() => {
              newRequest();
            }}
            renaming={renaming}
            onRenaming={stopRenaming}
          />
          {failure === null ? null : <ErrorState title="The run did not start" error={failure} />}
          {main ?? null}
          {tabs.map((tab) => {
            // Every tab stays mounted, so unsaved edits survive moving between tabs and the runs.
            const content = tabContent(tab);
            const hidden = main !== undefined || tab.key !== active?.key;
            return (
              <div key={tab.key} data-editor={tab.key} hidden={hidden} className="min-h-0 flex-1">
                <InspectorShown value={!hidden}>{content}</InspectorShown>
              </div>
            );
          })}
        </section>
        {/* The inspector of the request or run in front, from 1024 px: as tall as the side panel. */}
        {beside ? <div ref={setInspectorSlot} className="flex shrink-0" /> : null}
        {dialog?.kind === 'collection' ? (
          <NameDialog
            title="New collection"
            label="Name"
            submit="Create"
            onClose={() => {
              setDialog(null);
            }}
            onSubmit={async (name) => {
              const id = slug(name);
              await client.runner.saveFolder(id, { name }, 'absent');
              await refresh();
              setDialog(null);
              setPanel({ list: 'collections' });
              select(id);
            }}
          />
        ) : null}
        {dialog?.kind === 'environment' ? (
          <NameDialog
            title="New environment"
            label="Name"
            submit="Create"
            onClose={() => {
              setDialog(null);
            }}
            onSubmit={async (name) => {
              const id = slug(name);
              await client.runner.saveEnvironment(id, { document: { name, vars: {} }, local: null }, 'absent');
              await refresh();
              setDialog(null);
              setPanel({ list: 'environments' });
              go({ kind: 'environment', key: environmentKey(id), id });
            }}
          />
        ) : null}
        {dialog?.kind === 'folder' ? (
          <NewFolderDialog
            parent={dialog.node}
            onClose={() => {
              setDialog(null);
            }}
            onCreated={(id) => {
              setDialog(null);
              select(id);
            }}
          />
        ) : null}
        {dialog?.kind === 'delete' ? (
          <DeleteContainerDialog
            node={dialog.node}
            digest={null}
            onClose={() => {
              setDialog(null);
            }}
            onDeleted={() => {
              setDialog(null);
            }}
          />
        ) : null}
        {dialog?.kind === 'save' ? (
          <SaveRequestDialog
            collections={collections}
            parent={dialog.tab.kind === 'untitled' ? dialog.tab.parent : null}
            document={dialog.document}
            onClose={() => {
              setDialog(null);
            }}
            onSaved={(id) => {
              const saved: EditorTab = { kind: 'node', key: nodeKey(id), id };
              replaceTab(dialog.tab.key, saved);
              setDialog(null);
              go(saved, true);
            }}
          />
        ) : null}
        {dialog?.kind === 'palette' ? (
          <CommandPalette
            commands={commands}
            onClose={() => {
              setDialog(null);
            }}
          />
        ) : null}
        {importing && capability.available ? (
          <ImportDialog
            onClose={() => {
              setImporting(false);
            }}
            onImported={(collection) => {
              void refresh().then(() => {
                select(collection);
              });
            }}
            onOpenRequest={(request) => {
              const next = new URLSearchParams(search);
              next.delete('import');
              void navigate(hrefOf(openUntitled('request', null, '', request), next));
            }}
          />
        ) : null}
      </div>
    </InspectorSlot>
  );
}

/** The open editors as tabs: middle-click or × closes one, + opens an untitled request. */
function EditorTabs({
  tabs,
  active,
  tree,
  environments,
  hrefOf: href,
  onClose,
  onNew,
  renaming,
  onRenaming,
}: {
  readonly tabs: readonly EditorTab[];
  readonly active: EditorTab | null;
  readonly tree: Tree | undefined;
  readonly environments: readonly { readonly id: string; readonly name: string }[];
  readonly hrefOf: (tab: EditorTab) => string;
  readonly onClose: (tab: EditorTab) => void;
  readonly onNew: () => void;
  /** A tab whose name to start editing, asked from outside (the environment list's Rename). */
  readonly renaming: string | null;
  readonly onRenaming: () => void;
}) {
  const { names, dirty } = useTabState();
  const [ownEditing, setEditing] = useState<string | null>(null);
  // A rename asked from outside takes over once its tab is open.
  const editing = renaming !== null && tabs.some((tab) => tab.key === renaming) ? renaming : ownEditing;
  const [menu, setMenu] = useState<{ tab: EditorTab; x: number; y: number } | null>(null);
  const label = (
    tab: EditorTab,
  ): { text: string; icon: ReactNode; italic: boolean; unsaved: boolean; renamable: boolean } => {
    if (tab.kind === 'untitled') {
      return {
        text: names[tab.key] ?? untitledName(tab.number),
        renamable: true,
        icon: tab.form === 'request' ? <MethodBadge method={tab.document.method} short /> : null,
        italic: true,
        unsaved: true,
      };
    }
    if (tab.kind === 'environment') {
      const entry = environments.find((environment) => environment.id === tab.id);
      return {
        text: names[tab.key] ?? entry?.name ?? tab.id,
        renamable: true,
        icon: <EnvironmentIcon className="size-3.5 text-muted" />,
        italic: false,
        unsaved: dirty[tab.key] === true,
      };
    }
    const node = tree === undefined ? null : (findNode(tree, tab.id)?.node ?? null);
    return {
      text: (node?.kind === 'request' ? names[tab.key] : undefined) ?? node?.name ?? tab.id,
      renamable: node?.kind === 'request',
      icon:
        node?.kind === 'request' ? (
          <MethodBadge method={node.method} short />
        ) : (
          <FolderIcon className="size-3.5 text-muted" />
        ),
      italic: false,
      unsaved: dirty[tab.key] === true,
    };
  };
  return (
    <div className="flex items-stretch border-b border-line bg-bg">
      <nav aria-label="Open editors" className="flex min-w-0 overflow-x-auto">
        {tabs.map((tab) => {
          const shown = label(tab);
          const front = tab.key === active?.key;
          return (
            <div
              key={tab.key}
              className={`group flex shrink-0 items-center gap-1 border-r border-line border-t-2 pr-1 pl-2.5 ${
                front ? 'border-t-accent bg-surface' : 'border-t-transparent hover:bg-hover'
              }`}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(tab);
                }
              }}
            >
              {editing === tab.key ? (
                <TabNameInput
                  name={shown.text}
                  onDone={(name) => {
                    setEditing(null);
                    onRenaming();
                    if (name === null || name.trim() === '') return;
                    setTabName(tab.key, name.trim());
                    if (tab.kind === 'untitled') {
                      updateUntitled(tab.key, { document: { ...tab.document, name: name.trim() } });
                    }
                  }}
                />
              ) : (
                <Link
                  to={href(tab)}
                  aria-current={front ? 'page' : undefined}
                  title={shown.renamable ? 'Double-click or F2 to rename' : undefined}
                  className="flex max-w-52 items-center gap-1.5 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                  onDoubleClick={(event) => {
                    if (!shown.renamable) return;
                    event.preventDefault();
                    setEditing(tab.key);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ tab, x: event.clientX, y: event.clientY });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'F2' && shown.renamable) {
                      event.preventDefault();
                      setEditing(tab.key);
                    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                      event.preventDefault();
                      const box = event.currentTarget.getBoundingClientRect();
                      setMenu({ tab, x: box.left, y: box.bottom });
                    }
                  }}
                >
                  {shown.icon}
                  <span className={`truncate ${shown.italic ? 'italic' : ''} ${front ? 'font-medium' : 'text-muted'}`}>
                    {shown.text}
                  </span>
                  {shown.unsaved ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-warn" title="Unsaved changes">
                      <span className="sr-only">, unsaved changes</span>
                    </span>
                  ) : null}
                </Link>
              )}
              <button
                type="button"
                className="inline-flex size-5 items-center justify-center rounded text-muted hover:bg-line hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                aria-label={`Close ${shown.text}`}
                title="Close (middle-click)"
                onClick={() => {
                  onClose(tab);
                }}
              >
                <CloseIcon className="size-3" />
              </button>
            </div>
          );
        })}
      </nav>
      <button
        type="button"
        className="inline-flex w-9 shrink-0 items-center justify-center text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        aria-label="New request"
        title="New request (1)"
        onClick={onNew}
      >
        <PlusIcon className="size-3.5" />
      </button>
      {menu === null ? null : (
        <ContextMenu
          label={`Tab ${label(menu.tab).text}`}
          x={menu.x}
          y={menu.y}
          items={[
            ...(label(menu.tab).renamable
              ? [
                  {
                    label: 'Rename',
                    detail: 'F2',
                    onSelect: () => {
                      setEditing(menu.tab.key);
                    },
                  },
                ]
              : []),
            {
              label: 'Close',
              icon: <CloseIcon className="size-3.5" />,
              onSelect: () => {
                onClose(menu.tab);
              },
            },
          ]}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

/** A tab's name being edited: Enter or leaving keeps it, Escape drops it. */
function TabNameInput({ name, onDone }: { readonly name: string; readonly onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(name);
  const done = useRef(false);
  const finish = (next: string | null): void => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  return (
    <input
      // The input replaces the tab the developer just double-clicked, so it takes focus.
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus
      aria-label="Request name"
      className="my-1 w-40 rounded border border-accent bg-surface px-1.5 py-0.5 text-body text-fg focus-visible:outline-none"
      value={value}
      onFocus={(event) => {
        event.currentTarget.select();
      }}
      onChange={(event) => {
        setValue(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => {
        finish(value);
      }}
    />
  );
}

/** Every request, folder and collection under `node`, for the palette. */
function commandsFor(node: TreeNode, path: string, open: (id: string) => void): Command[] {
  const here = path === '' ? node.name : `${path} / ${node.name}`;
  const own: Command = {
    label: node.name,
    hint: path === '' ? (node.kind === 'collection' ? 'collection' : node.id) : path,
    icon: node.kind === 'request' ? <MethodBadge method={node.method} short /> : <FolderIcon className="size-3.5" />,
    run: () => {
      open(node.id);
    },
  };
  if (node.kind === 'request') return [own];
  return [own, ...node.children.flatMap((child) => commandsFor(child, here, open))];
}

/** The collection or folder a new request from this tab saves to: the node's own, or its parent's. */
function containerOf(tree: Tree, id: string): string | null {
  const found = findNode(tree, id);
  if (found === null) return null;
  return found.node.kind === 'request' ? parentOf(found.node.id) : found.node.id;
}
