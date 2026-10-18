import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router';

import { AtlasError } from '../../atlas/client.js';
import type { ContainerNode, EnvironmentEntry, FolderDetail, FolderDocument } from '../../atlas/runner.js';
import type { ScenarioSelection } from '../../scenarios/selection.js';
import { SCENARIO_NAME } from '../../atlas/wire.js';
import type { AtlasLayoutContext } from '../../layouts/AtlasLayoutContext.js';
import { useChangeScenario } from '../../scenarios/ScenarioSelector.js';
import { iconButtonClass, primaryIconButtonClass } from '../../components/buttonClass.js';
import { SaveIcon, TrashIcon } from '../../components/icons.js';
import { ErrorState } from '../../components/states/ErrorState.js';
import { LoadingState } from '../../components/states/LoadingState.js';
import { useAtlasSession } from '../../hooks/AtlasSession.js';
import { useSnapshotFeed } from '../../hooks/SnapshotFeed.js';
import { inputClass, MapTable, NameValueTable, selectClass, TextArea } from './fields.js';
import { useRunnerRefresh } from './hooks.js';
import { FolderIcon, NewFolderIcon, NewRequestIcon } from './icons.js';
import { ScriptsEditor } from './RequestEditor.js';
import { ConfirmDialog, NameDialog, ProblemList } from './RequestWorkspace.js';
import { useBarSelection } from './RunBar.js';
import { noteStarted, useTabState, type RequestsView } from './tabState.js';
import { nextOrdered, slug, withEntry } from './variables.js';

/** Runs a collection or folder with the bar's choices and opens the run (the tree's menu: Run, Explain). */
export function useRunContainer(
  environments: readonly EnvironmentEntry[],
  topBar: ScenarioSelection,
  view: RequestsView,
): (id: string, explain: boolean) => Promise<void> {
  const { client } = useAtlasSession();
  const navigate = useNavigate();
  const selection = useBarSelection(environments, topBar, view);
  const { vars } = useTabState();
  return async (id, explain) => {
    const mode = explain ? 'explain' : selection.sendTo;
    const started = await client.runner.startRun({
      target: { id },
      mode,
      // Only a picked scenario: it fills in for requests without their own X-Mock-Scenario.
      ...(selection.scenario === null ? {} : { scenario: selection.scenario }),
      ...(selection.environment === null ? {} : { environment: selection.environment }),
      ...(mode === 'explain' && selection.renderAt.trim() !== '' ? { now: selection.renderAt.trim() } : {}),
      vars,
    });
    if (mode !== 'explain') noteStarted(started);
    void navigate(`/requests/runs/${started}`);
  };
}

/**
 * A collection or folder in its own editor tab: its
 * `folder.yaml` settings, which every request below inherits, with New
 * request, New folder and Delete. Running it is on the tree's menu.
 */
export function ContainerView({
  node,
  environments,
  onSelect,
  onNewRequest,
}: {
  readonly node: ContainerNode;
  readonly environments: readonly EnvironmentEntry[];
  readonly onSelect: (id: string | null) => void;
  /** Opens an untitled request that saves here. */
  readonly onNewRequest: (parent: string) => void;
}) {
  const { client, generation } = useAtlasSession();
  const { requestsCount } = useSnapshotFeed();
  const refresh = useRunnerRefresh();
  const [dialog, setDialog] = useState<'folder' | 'delete' | null>(null);
  const folder = useQuery<FolderDetail>({
    queryKey: ['atlas', generation, 'runner', 'folder', node.id, requestsCount],
    placeholderData: (previous) => (previous?.id === node.id ? previous : undefined),
    queryFn: ({ signal }) => client.runner.folder(node.id, signal),
  });
  const kind = node.kind === 'collection' ? 'collection' : 'folder';
  const requestCount = countRequests(node);

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-4 py-2">
        <h2 className="flex items-center gap-2 font-medium">
          <FolderIcon className="size-4 text-muted" />
          {node.name}
        </h2>
        <code className="font-mono text-mono text-faint">{node.id}</code>
        <span className="text-muted">
          {requestCount} {requestCount === 1 ? 'request' : 'requests'}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            className={iconButtonClass}
            aria-label="New request here"
            title="New request here"
            onClick={() => {
              onNewRequest(node.id);
            }}
          >
            <NewRequestIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className={iconButtonClass}
            aria-label="New folder"
            title="New folder"
            onClick={() => {
              setDialog('folder');
            }}
          >
            <NewFolderIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className={iconButtonClass}
            aria-label={`Delete ${kind}`}
            title={`Delete ${kind}`}
            onClick={() => {
              setDialog('delete');
            }}
          >
            <TrashIcon className="size-3.5" />
          </button>
        </div>
      </div>
      {folder.error !== null ? (
        <ErrorState title={`Could not open the ${kind}`} error={folder.error} />
      ) : folder.data === undefined ? (
        <LoadingState label={`Opening the ${kind}`} />
      ) : (
        <FolderSettings key={folder.data.id} detail={folder.data} environments={environments} />
      )}
      {dialog === 'folder' ? (
        <NewFolderDialog
          parent={node}
          onClose={() => {
            setDialog(null);
          }}
          onCreated={(id) => {
            setDialog(null);
            onSelect(id);
          }}
        />
      ) : null}
      {dialog === 'delete' ? (
        <DeleteContainerDialog
          node={node}
          digest={folder.data?.digest ?? null}
          onClose={() => {
            setDialog(null);
          }}
          onDeleted={() => {
            setDialog(null);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** Names a new folder in a collection or folder and creates it. */
export function NewFolderDialog({
  parent,
  onClose,
  onCreated,
}: {
  readonly parent: ContainerNode;
  readonly onClose: () => void;
  readonly onCreated: (id: string) => void;
}) {
  const { client } = useAtlasSession();
  const refresh = useRunnerRefresh();
  return (
    <NameDialog
      title={`New folder in ${parent.name}`}
      label="Name"
      submit="Create"
      onClose={onClose}
      onSubmit={async (name) => {
        const id = `${parent.id}/${nextOrdered(
          parent.children.map((child) => child.id),
          slug(name),
        )}`;
        await client.runner.saveFolder(id, { name }, 'absent');
        await refresh();
        onCreated(id);
      }}
    />
  );
}

/** Deletes an empty collection or folder; `digest` is its `folder.yaml`'s, null when it has none. */
export function DeleteContainerDialog({
  node,
  digest,
  onClose,
  onDeleted,
}: {
  readonly node: ContainerNode;
  readonly digest: string | null;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}) {
  const { client } = useAtlasSession();
  const refresh = useRunnerRefresh();
  const kind = node.kind === 'collection' ? 'collection' : 'folder';
  return (
    <ConfirmDialog
      title={`Delete ${node.name}?`}
      confirm="Delete"
      onClose={onClose}
      onConfirm={async () => {
        await client.runner.deleteFolder(node.id, digest);
        await refresh();
        onDeleted();
      }}
    >
      <p>Only an empty {kind} can be deleted: delete or move its requests and folders first.</p>
    </ConfirmDialog>
  );
}

function countRequests(node: ContainerNode): number {
  let total = 0;
  for (const child of node.children) total += child.kind === 'request' ? 1 : countRequests(child);
  return total;
}

/** `folder.yaml`: the display name, variables, headers, scripts and docs every request below inherits. */
function FolderSettings({
  detail,
  environments,
}: {
  readonly detail: FolderDetail;
  readonly environments: readonly EnvironmentEntry[];
}) {
  const { client } = useAtlasSession();
  const refresh = useRunnerRefresh();
  const nameId = useId();
  const environmentId = useId();
  const { health } = useOutletContext<AtlasLayoutContext>();
  const changeScenario = useChangeScenario(health);
  const [draft, setDraft] = useState<FolderDocument>(detail.document);
  const [failure, setFailure] = useState<Error | null>(null);
  const [status, setStatus] = useState('');
  // The file changed (a save here, or on disk): show it, unless there are unsaved edits.
  const [shown, setShown] = useState(detail);
  if (shown !== detail) {
    setShown(detail);
    if (JSON.stringify(draft) === JSON.stringify(shown.document)) setDraft(detail.document);
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(detail.document);
  const set = <K extends keyof FolderDocument>(key: K, value: FolderDocument[K] | undefined): void => {
    setDraft(withEntry(draft, key, value));
  };
  const save = async (): Promise<void> => {
    setFailure(null);
    try {
      await client.runner.saveFolder(detail.id, draft, detail.digest === null ? 'absent' : { digest: detail.digest });
      setStatus('Saved.');
      await refresh();
    } catch (error) {
      setFailure(error instanceof Error ? error : new Error(String(error)));
      if (error instanceof AtlasError && error.details.code === 'request-changed') await refresh();
    }
  };
  return (
    // Ctrl/Cmd + S saves from any field; the wrapper is not itself interactive.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      aria-label={detail.kind === 'collection' ? 'Collection settings' : 'Folder settings'}
      className="px-4 py-3"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          if (dirty) void save();
        }
      }}
    >
      <div className="mb-3 flex items-center gap-2">
        <h3 className="font-medium">{detail.kind === 'collection' ? 'Collection settings' : 'Folder settings'}</h3>
        <span className="text-muted">inherited by every request below</span>
        <span role="status" className="text-muted">
          {dirty ? 'Unsaved changes' : status}
        </span>
        <button
          type="button"
          className={`${primaryIconButtonClass} ml-auto`}
          disabled={!dirty}
          aria-label="Save settings"
          aria-keyshortcuts="Control+S Meta+S"
          title="Save settings (Ctrl + S)"
          onClick={() => void save()}
        >
          <SaveIcon className="size-3.5" />
        </button>
      </div>
      <div className="grid gap-4">
        <div className="max-w-md">
          <label htmlFor={nameId} className="block text-muted">
            Display name
          </label>
          <input
            id={nameId}
            className={inputClass}
            value={draft.name ?? ''}
            onChange={(event) => {
              set('name', event.target.value);
            }}
          />
        </div>
        {detail.kind === 'collection' ? (
          <div className="max-w-md">
            <label htmlFor={environmentId} className="block text-muted">
              Preferred environment
            </label>
            <select
              id={environmentId}
              className={`${selectClass} w-full`}
              value={draft.environment ?? ''}
              onChange={(event) => {
                set('environment', event.target.value === '' ? undefined : event.target.value);
              }}
            >
              <option value="">None</option>
              {environments.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
              {draft.environment === undefined ||
              environments.some((entry) => entry.id === draft.environment) ? null : (
                <option value={draft.environment}>{draft.environment} (missing)</option>
              )}
            </select>
            <p className="mt-0.5 text-muted">Opening a request in this collection picks it in the bar.</p>
          </div>
        ) : null}
        <div>
          <h4 className="mb-1 text-muted">Variables</h4>
          <MapTable
            caption="Folder variables"
            entries={draft.vars ?? {}}
            scopes={null}
            addLabel="Add variable"
            clearLabel="Clear all variables"
            onChange={(vars) => {
              set('vars', vars);
            }}
          />
        </div>
        <div>
          <h4 className="mb-1 text-muted">Headers</h4>
          <NameValueTable
            caption="Folder headers"
            rows={draft.headers ?? []}
            scopes={null}
            addLabel="Add header"
            clearLabel="Clear all headers"
            scenarioHeader={{
              // The top bar picks the scenario: drop the header, and pick its value there when it names one.
              onUse: (value, index) => {
                set(
                  'headers',
                  (draft.headers ?? []).filter((_row, at) => at !== index),
                );
                if (SCENARIO_NAME.test(value)) changeScenario(value);
              },
            }}
            onChange={(headers) => {
              set('headers', headers);
            }}
          />
        </div>
        <ScriptsEditor
          scripts={draft.scripts ?? {}}
          onChange={(scripts) => {
            set('scripts', scripts);
          }}
        />
        <TextArea
          label="Docs"
          value={draft.docs ?? ''}
          onChange={(docs) => {
            set('docs', docs);
          }}
        />
        {failure === null ? null : <ErrorState title="The settings were not saved" error={failure} />}
        {failure instanceof AtlasError && failure.details.problems !== undefined ? (
          <ProblemList problems={failure.details.problems} />
        ) : null}
      </div>
    </section>
  );
}
