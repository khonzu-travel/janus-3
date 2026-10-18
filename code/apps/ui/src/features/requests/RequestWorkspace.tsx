import { useEffect, useId, useRef, useState } from 'react';

import { AtlasError } from '../../atlas/client.js';
import type {
  CollectionNode,
  ContainerNode,
  CurrentFile,
  EnvironmentEntry,
  RequestDetail,
  RequestDocument,
  RunnerProblem,
  TreeNode,
} from '../../atlas/runner.js';
import { decodeRequestDocument } from '../../atlas/runner.js';
import type { ScenarioSelection } from '../../scenarios/selection.js';
import {
  buttonClass,
  iconButtonClass,
  primaryButtonClass,
  primaryIconButtonClass,
} from '../../components/buttonClass.js';
import { ExplainIcon, SaveIcon, SendIcon, TrashIcon } from '../../components/icons.js';
import { Tabs } from '../../components/Tabs.js';
import { ErrorState } from '../../components/states/ErrorState.js';
import { LoadingState } from '../../components/states/LoadingState.js';
import { useAtlasSession } from '../../hooks/AtlasSession.js';
import { Dialog } from './Dialog.js';
import { hasScenarioHeader, selectClass } from './fields.js';
import { useEnvironmentDetail, useRequestDetail, useRun, useRunnerRefresh } from './hooks.js';
import { CopyIcon, MoveIcon, PanelBottomIcon, PanelRightIcon } from './icons.js';
import { RequestEditor } from './RequestEditor.js';
import { InspectorSplit, inspectorToolClass } from './InspectorAside.js';
import { useResponseBeside } from './storedFlag.js';
import { RequestInspector } from './RequestInspector.js';
import { RunBar, useBarSelection, type RequestsAbilities } from './RunBar.js';
import { SaveRequestDialog } from './SaveRequestDialog.js';
import { StepDetails } from './StepDetails.js';
import {
  carryVariables,
  nodeKey,
  noteStarted,
  pickEnvironment,
  rememberDraft,
  setCurrentHeaders,
  setTabDirty,
  setTabName,
  untitledParam,
  updateUntitled,
  useTabState,
  type RequestsView,
  type UntitledTab,
} from './tabState.js';
import { leafOf, nextOrdered, parentOf, resolve, scopesFor, templateParts } from './variables.js';
import { EmptyState } from '../../components/states/EmptyState.js';

interface Base {
  readonly id: string;
  readonly digest: string;
  readonly document: RequestDocument;
  /** When this editor saved it (ms): a copy of the file loaded before then is older than the save. */
  readonly savedAt?: number;
}

type Conflict = { readonly current: CurrentFile | null };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * A request open in an editor tab:
 * the bar, the editor, Save with its conflict view, Send (Live) or
 * Explain (Explore) without saving, the response, and the inspector saying
 * why. An untitled request is edited the same way; its first Save asks where
 * it goes, and until then it sends as a request of that folder.
 */
export function RequestWorkspace({
  id,
  untitled,
  active,
  collection,
  collections,
  environments,
  abilities,
  view,
  topBar,
  onSelect,
  onSaved,
  onDeleted,
}: {
  /** The request's ID; for an untitled request, the ID it sends as. */
  readonly id: string;
  readonly untitled?: UntitledTab;
  /** The tab is in front: only then does it set the headers a new request copies. */
  readonly active: boolean;
  readonly collection: CollectionNode | null;
  /** Every collection, for an untitled request's Save. */
  readonly collections: readonly CollectionNode[];
  readonly environments: readonly EnvironmentEntry[];
  readonly abilities: RequestsAbilities;
  readonly view: RequestsView;
  /** The scenario in the top bar. */
  readonly topBar: ScenarioSelection;
  readonly onSelect: (id: string | null) => void;
  /** An untitled request was saved as `id`. */
  readonly onSaved?: (id: string) => void;
  /** The request was deleted: the caller closes its tab, as if another tab had been picked. */
  readonly onDeleted?: () => void;
}) {
  const { client } = useAtlasSession();
  const refresh = useRunnerRefresh();
  const detail = useRequestDetail(untitled === undefined ? id : null);
  const { vars, names, drafts, panel } = useTabState();
  const tabKey = untitled?.key ?? nodeKey(id);
  const [responseBeside, setResponseBeside] = useResponseBeside();
  const [resultTab, setResultTab] = useState<'response' | 'explanation'>('response');
  const tabName = names[tabKey];
  const selection = useBarSelection(environments, topBar, view);
  const environmentDetail = useEnvironmentDetail(untitled === undefined ? null : selection.environment);
  const [base, setBase] = useState<Base | null>(() => drafts[tabKey]?.base ?? null);
  const [ownDraft, setOwnDraft] = useState<RequestDocument | null>(() => drafts[tabKey]?.document ?? null);
  const draft = untitled === undefined ? ownDraft : untitled.document;
  const setDraft = (document: RequestDocument): void => {
    if (untitled === undefined) setOwnDraft(document);
    else updateUntitled(untitled.key, { document });
  };
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<readonly RunnerProblem[]>([]);
  const [failure, setFailure] = useState<Error | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [notice, setNotice] = useState('');
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'move' | 'delete' | 'save' | null>(null);
  const run = useRun(runId);

  const dirty = untitled !== undefined || (draft !== null && base !== null && !same(draft, base.document));
  // Worth a warning before the page unloads: an untitled request only once something beyond its name and the copied headers is set.
  const unsaved = untitled !== undefined ? draft !== null && !blankUntitled(draft) : dirty;
  // A saved request's tab shows a dot while it holds unsaved changes (untitled tabs always show one).
  const changed = untitled === undefined && dirty;
  useEffect(() => {
    setTabDirty(tabKey, changed);
  }, [tabKey, changed]);
  useEffect(() => {
    if (untitled === undefined && base !== null && ownDraft !== null) {
      rememberDraft(tabKey, { base, document: ownDraft });
    }
  }, [untitled, tabKey, base, ownDraft]);
  // An untitled request has no file: no folders above it are known, and the picked environment is read alone.
  const loaded: RequestDetail | undefined =
    untitled !== undefined
      ? {
          id,
          digest: '',
          document: untitled.document,
          folders: [],
          environments:
            environmentDetail.data === undefined
              ? []
              : [
                  {
                    id: environmentDetail.data.id,
                    name: environmentDetail.data.document.name ?? environmentDetail.data.id,
                    vars: environmentVars(environmentDetail.data.document, environmentDetail.data.local),
                  },
                ],
        }
      : detail.data?.id === id
        ? detail.data
        : undefined;
  // A new file, or the file changed on disk while there is nothing unsaved: show what is on disk. Only a settled copy
  // loaded after this editor's last save counts: one shown while a fresh one loads, or the copy from before the save,
  // is stale, and adopting it would undo the save and leave a digest the server refuses on the next save or delete.
  const settled = !detail.isFetching && (base?.savedAt === undefined || detail.dataUpdatedAt > base.savedAt);
  if (
    untitled === undefined &&
    loaded !== undefined &&
    (base === null || base.id !== id || (loaded.digest !== base.digest && !dirty && settled))
  ) {
    setBase({ id, digest: loaded.digest, document: loaded.document });
    setDraft(loaded.document);
    if (base?.id !== id) {
      setProblems([]);
      setFailure(null);
      setConflict(null);
      setRunId(null);
      setNotice('');
    }
  }

  // A request is renamed on its tab: the tab's name and the draft's follow each other.
  const draftName = draft?.name;
  useEffect(() => {
    if (draftName !== undefined) setTabName(tabKey, draftName);
  }, [tabKey, draftName]);
  // A new name given on a saved request's tab becomes an unsaved change (an untitled tab renames its document itself).
  const [seenName, setSeenName] = useState(tabName);
  if (tabName !== seenName) {
    setSeenName(tabName);
    if (untitled === undefined && tabName !== undefined && ownDraft !== null && tabName !== ownDraft.name) {
      setOwnDraft({ ...ownDraft, name: tabName });
    }
  }

  // The run variables a send ends with carry into the next send.
  const finished = run.data?.state === 'finished' ? run.data : null;
  useEffect(() => {
    if (finished !== null) carryVariables(finished.id, finished.vars);
  }, [finished]);

  // A new request starts with the headers of the request in front, as edited.
  useEffect(() => {
    if (active && draft !== null) setCurrentHeaders(draft.headers ?? []);
  }, [active, draft]);

  // Opening a request picks its collection's preferred environment, when it names one.
  const preferred = loaded?.folders[0]?.document.environment;
  useEffect(() => {
    if (preferred !== undefined && environments.some((entry) => entry.id === preferred)) pickEnvironment(preferred);
    // Only when the request opens: a later pick in the bar stands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferred]);

  // Leaving with unsaved changes asks first, as a browser tab close does.
  useEffect(() => {
    if (!unsaved) return undefined;
    const onUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [unsaved]);

  if (detail.error !== null && loaded === undefined) {
    return <ErrorState title="Could not open the request" error={detail.error} onRetry={() => void detail.refetch()} />;
  }
  if (draft === null || loaded === undefined || (untitled === undefined && base?.id !== id)) {
    return <LoadingState label="Opening the request" />;
  }
  const blocked = hasScenarioHeader(draft.headers ?? []);

  const scopes = scopesFor(loaded, draft, selection.environment, vars);
  const origin = originOf(draft.url, scopes);

  const save = async (expect: { readonly digest: string } | 'absent', document: RequestDocument): Promise<void> => {
    if (untitled !== undefined) {
      setDialog('save');
      return;
    }
    setSaving(true);
    setProblems([]);
    setFailure(null);
    try {
      const written = await client.runner.saveRequest(id, document, expect);
      setBase({ id, digest: written.digest ?? '', document, savedAt: Date.now() });
      setConflict(null);
      setNotice('Saved.');
      void refresh();
    } catch (error) {
      if (error instanceof AtlasError && error.details.code === 'request-changed') {
        setConflict({ current: error.details.current ?? null });
      } else if (error instanceof AtlasError && error.details.problems !== undefined) {
        setProblems(error.details.problems);
      } else {
        setFailure(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      setSaving(false);
    }
  };

  const send = async (): Promise<void> => {
    if (blocked || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setProblems([]);
    setFailure(null);
    setNotice('');
    try {
      const started = await client.runner.startRun({
        target: { id, request: draft },
        mode: selection.mode,
        // Only a picked scenario: it fills in for a request without its own X-Mock-Scenario.
        ...(selection.scenario === null ? {} : { scenario: selection.scenario }),
        ...(selection.environment === null ? {} : { environment: selection.environment }),
        ...(selection.mode === 'explain' && selection.renderAt.trim() !== '' ? { now: selection.renderAt.trim() } : {}),
        vars,
      });
      // A simulation sets no variables, so it carries none.
      if (selection.mode !== 'explain') noteStarted(started);
      setRunId(started);
    } catch (error) {
      if (error instanceof AtlasError && error.details.problems !== undefined) setProblems(error.details.problems);
      else setFailure(error instanceof Error ? error : new Error(String(error)));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  const saveVariable = (name: string, template: string): void => {
    const extract = draft.extract ?? {};
    let unique = name;
    for (let n = 2; Object.hasOwn(extract, unique); n++) unique = `${name}${String(n)}`;
    setDraft({ ...draft, extract: { ...extract, [unique]: template } });
    setNotice(`Added "${unique}" to Extract. Rename it there if you like, then save.`);
  };

  const step = run.data?.steps[0];
  const running = starting || run.data?.state === 'running' || (runId !== null && run.data === undefined);
  const explore = selection.view === 'explore';
  const action = explore ? 'Explain' : 'Send';
  const done = step !== undefined && step.outcome !== 'running' && step.outcome !== 'pending' ? step : null;
  const resultMode = run.data?.mode ?? selection.mode;

  const saveButton = (
    <button
      type="button"
      className={iconButtonClass}
      disabled={!dirty || saving}
      aria-disabled={!dirty || saving}
      aria-label={saving ? 'Saving' : untitled === undefined ? 'Save' : 'Save to collection'}
      aria-keyshortcuts="Control+S Meta+S"
      title={untitled === undefined ? 'Save (Ctrl + S)' : 'Save to collection (Ctrl + S)'}
      onClick={() => void save(base === null ? 'absent' : { digest: base.digest }, draft)}
    >
      <SaveIcon className="size-3.5" />
    </button>
  );
  const actions = (
    <button
      type="button"
      className={primaryIconButtonClass}
      disabled={running || blocked}
      aria-label={running ? (explore ? 'Explaining' : 'Sending') : action}
      aria-keyshortcuts="Control+Enter Meta+Enter"
      title={blocked ? 'Remove the X-Mock-Scenario header first' : `${action} (Ctrl + Enter)`}
      onClick={() => void send()}
    >
      {explore ? <ExplainIcon className="size-3.5" /> : <SendIcon className="size-3.5" />}
    </button>
  );

  const tools = (
    <div className="flex items-center gap-1.5">
      {untitled === undefined ? (
        <>
          <button
            type="button"
            className={iconButtonClass}
            aria-label="Duplicate"
            title="Duplicate"
            onClick={() => {
              const parent = parentOf(id);
              const siblings = childrenOf(collection, parent).map((node) => node.id);
              const copy = `${parent}/${nextOrdered(siblings, leafOf(id).replace(/^\d+-/, ''))}`;
              void client.runner
                .saveRequest(copy, { ...draft, name: `${draft.name} copy` }, 'absent')
                .then(() =>
                  refresh().then(() => {
                    onSelect(copy);
                  }),
                )
                .catch((error: unknown) => {
                  setFailure(error instanceof Error ? error : new Error(String(error)));
                });
            }}
          >
            <CopyIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className={iconButtonClass}
            aria-label="Delete"
            title="Delete"
            onClick={() => {
              setDialog('delete');
            }}
          >
            <TrashIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className={iconButtonClass}
            aria-label="Move"
            title="Move"
            onClick={() => {
              setDialog('move');
            }}
          >
            <MoveIcon className="size-3.5" />
          </button>
        </>
      ) : null}
    </div>
  );

  // With the response in the right pane, it shares it with the explanation as two tabs; folded, it stays under the request.
  const moved = responseBeside && !panel.inspector;
  const explanation =
    runId === null || done === null ? (
      <p className="px-3.5 py-3 text-muted">
        {explore ? 'Explain' : 'Send'} the request to see the response and why it is what it is.
      </p>
    ) : (
      <RequestInspector mode={resultMode} runId={runId} step={done} />
    );
  const responseSection = (
    <section aria-label="Response" className={moved ? '' : 'border-t border-line'}>
      {runId === null ? (
        <EmptyState title="No response yet" headingLevel={null}>
          {explore
            ? 'Explain asks what the mock would answer the request as edited, and why. Nothing is sent or saved.'
            : 'Send runs the request as edited, without saving it. The response shows here.'}
        </EmptyState>
      ) : done === null ? (
        run.error === null ? (
          <LoadingState label={resultMode === 'explain' ? 'Explaining' : 'Sending'} />
        ) : (
          <ErrorState title="Could not read the result" error={run.error} />
        )
      ) : (
        <StepDetails step={done} mode={resultMode} onSaveVariable={saveVariable} />
      )}
    </section>
  );

  return (
    // Ctrl/Cmd + S saves and Ctrl/Cmd + Enter sends from any field; the wrapper is not itself interactive.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="flex min-h-full flex-col"
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || (event.target as Element).closest('[role="dialog"]') !== null) return;
        if (event.key === 'Enter' && !running) {
          event.preventDefault();
          void send();
        } else if (event.key.toLowerCase() === 's') {
          event.preventDefault();
          if (dirty && !saving) void save(base === null ? 'absent' : { digest: base.digest }, draft);
        }
      }}
    >
      <RunBar abilities={abilities} selection={selection} origin={origin} />
      <InspectorSplit
        className="flex-1"
        tools={
          <button
            type="button"
            className={inspectorToolClass}
            aria-pressed={responseBeside}
            aria-label="Show the response in this pane"
            title="Show the response in this pane"
            onClick={() => {
              setResponseBeside(!responseBeside);
            }}
          >
            {responseBeside ? <PanelBottomIcon className="size-4" /> : <PanelRightIcon className="size-4" />}
          </button>
        }
        aside={
          moved ? (
            <Tabs
              label="Response and explanation"
              tabs={
                [
                  { key: 'response', label: 'Response' },
                  { key: 'explanation', label: 'Explanation' },
                ] as const
              }
              selected={resultTab}
              onSelect={setResultTab}
            >
              {resultTab === 'response' ? responseSection : explanation}
            </Tabs>
          ) : (
            explanation
          )
        }
      >
        {/* The tab names the request; the heading is for screen readers and focus after navigation. */}
        <h2 className="sr-only">
          {draft.method} {draft.name === '' ? leafOf(id) : draft.name}
        </h2>
        <p role="status" aria-live="polite" className="px-4 empty:hidden">
          {notice}
        </p>
        {failure === null ? null : <ErrorState title="The request was not saved or sent" error={failure} />}
        {problems.length === 0 ? null : <ProblemList problems={problems} />}
        {conflict === null ? null : (
          <ConflictView
            mine={draft}
            current={conflict.current}
            onKeepMine={() =>
              void save(conflict.current === null ? 'absent' : { digest: conflict.current.digest }, draft)
            }
            onUseFile={(document, digest) => {
              setBase({ id, digest, document });
              setDraft(document);
              setConflict(null);
            }}
          />
        )}
        <RequestEditor
          draft={draft}
          onChange={setDraft}
          scopes={scopes}
          actions={actions}
          save={saveButton}
          tools={tools}
        />
        {moved ? null : responseSection}
      </InspectorSplit>
      {dialog === 'save' ? (
        <SaveRequestDialog
          collections={collections}
          parent={untitled?.parent ?? null}
          document={draft}
          onClose={() => {
            setDialog(null);
          }}
          onSaved={(saved) => {
            setDialog(null);
            onSaved?.(saved);
          }}
        />
      ) : null}
      {dialog === 'move' && base !== null ? (
        <MoveDialog
          id={id}
          collection={collection}
          onClose={() => {
            setDialog(null);
          }}
          onMove={async (parent) => {
            const siblings = childrenOf(collection, parent).map((node) => node.id);
            const target = `${parent}/${nextOrdered(siblings, leafOf(id).replace(/^\d+-/, ''))}`;
            await client.runner.saveRequest(target, base.document, 'absent');
            await client.runner.deleteRequest(id, base.digest);
            await refresh();
            setDialog(null);
            onSelect(target);
          }}
        />
      ) : null}
      {dialog === 'delete' && base !== null ? (
        <ConfirmDialog
          title={`Delete ${draft.name === '' ? id : draft.name}?`}
          confirm="Delete"
          onClose={() => {
            setDialog(null);
          }}
          onConfirm={async () => {
            await client.runner.deleteRequest(id, base.digest);
            await refresh();
            setDialog(null);
            if (onDeleted !== undefined) onDeleted();
            else onSelect(parentOf(id));
          }}
        >
          <p>
            This deletes <code className="font-mono text-mono">{id}.request.yaml</code>
            {dirty ? ', and your unsaved changes' : ''}.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** The ID an untitled request sends as: a request of its folder, or of the first collection. */
export function untitledId(tab: UntitledTab, collections: readonly CollectionNode[]): string | null {
  const parent = tab.parent ?? collections[0]?.id ?? null;
  return parent === null ? null : `${parent}/${untitledParam(tab.number)}`;
}

/** An environment's values with its `.local.yaml` laid over, leaving out disabled ones. */
export function environmentVars(
  document: { readonly vars?: Readonly<Record<string, string>>; readonly disabled?: readonly string[] },
  local: { readonly vars?: Readonly<Record<string, string>> } | null,
): Record<string, string> {
  const vars: Record<string, string> = { ...document.vars, ...local?.vars };
  for (const name of document.disabled ?? []) Reflect.deleteProperty(vars, name);
  return vars;
}

/** The origin a URL goes to once its variables resolve, or null. */
function originOf(url: string, scopes: ReturnType<typeof scopesFor>): string | null {
  let text = '';
  for (const part of templateParts(url)) {
    if (part.kind === 'text') text += part.text;
    else if (part.kind === 'variable') {
      const found = resolve(part.name, scopes);
      if (!found.defined) return null;
      text += found.value;
    } else return null;
  }
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** The direct children of a collection or folder. */
export function childrenOf(collection: CollectionNode | null, id: string): readonly TreeNode[] {
  if (collection === null) return [];
  const find = (node: TreeNode): readonly TreeNode[] | null => {
    if (node.kind === 'request') return null;
    if (node.id === id) return node.children;
    for (const child of node.children) {
      const found = find(child);
      if (found !== null) return found;
    }
    return null;
  };
  return find(collection) ?? [];
}

export function containersOf(collection: CollectionNode | null): ContainerNode[] {
  const out: ContainerNode[] = [];
  const walk = (node: TreeNode): void => {
    if (node.kind === 'request') return;
    out.push(node);
    node.children.forEach(walk);
  };
  if (collection !== null) walk(collection);
  return out;
}

export function ProblemList({ problems }: { readonly problems: readonly RunnerProblem[] }) {
  return (
    <section role="alert" aria-label="Problems" className="mx-4 mt-2 border-l-2 border-bad bg-bad-soft px-3 py-2">
      <p className="font-medium">The request has problems:</p>
      <ul className="mt-1 list-disc pl-5">
        {problems.map((problem, index) => (
          <li key={index}>
            {problem.pointer === undefined ? null : <code className="font-mono text-mono">{problem.pointer}</code>}{' '}
            {problem.message} <span className="text-muted">({problem.code})</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A save that got `412`: the file's current version beside
 * the edit, and which to keep.
 */
function ConflictView({
  mine,
  current,
  onKeepMine,
  onUseFile,
}: {
  readonly mine: RequestDocument;
  readonly current: CurrentFile | null;
  readonly onKeepMine: () => void;
  readonly onUseFile: (document: RequestDocument, digest: string) => void;
}) {
  let theirs: RequestDocument | null = null;
  if (current !== null) {
    try {
      theirs = decodeRequestDocument(current.document, 'current');
    } catch {
      theirs = null;
    }
  }
  return (
    <section
      aria-labelledby="conflict-title"
      className="mx-4 mt-2 rounded border border-warn bg-warn-soft/40 px-3 py-2"
    >
      <h3 id="conflict-title" className="font-medium">
        The file changed since you opened it
      </h3>
      <p className="text-muted">
        {current === null
          ? 'It was deleted. Keep your edit to write it again.'
          : 'Compare the two and keep one. Keeping yours replaces the file.'}
      </p>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <figure className="min-w-0">
          <figcaption className="text-muted">Your edit</figcaption>
          <pre tabIndex={0} className="max-h-80 overflow-auto rounded bg-surface p-2 font-mono text-mono">
            {JSON.stringify(mine, null, 2)}
          </pre>
        </figure>
        <figure className="min-w-0">
          <figcaption className="text-muted">The file now</figcaption>
          <pre tabIndex={0} className="max-h-80 overflow-auto rounded bg-surface p-2 font-mono text-mono">
            {current === null ? '(deleted)' : JSON.stringify(current.document, null, 2)}
          </pre>
        </figure>
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" className={primaryButtonClass} onClick={onKeepMine}>
          Keep my edit
        </button>
        {theirs === null || current === null ? null : (
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              onUseFile(theirs, current.digest);
            }}
          >
            Use the file’s version
          </button>
        )}
      </div>
    </section>
  );
}

function MoveDialog({
  id,
  collection,
  onClose,
  onMove,
}: {
  readonly id: string;
  readonly collection: CollectionNode | null;
  readonly onClose: () => void;
  readonly onMove: (parent: string) => Promise<void>;
}) {
  const selectId = useId();
  const options = containersOf(collection).filter((node) => node.id !== parentOf(id));
  const [parent, setParent] = useState(options[0]?.id ?? '');
  const [failure, setFailure] = useState<Error | null>(null);
  return (
    <Dialog title="Move request" onClose={onClose}>
      <form
        className="grid gap-3 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (parent === '') return;
          onMove(parent).catch((error: unknown) => {
            setFailure(error instanceof Error ? error : new Error(String(error)));
          });
        }}
      >
        {options.length === 0 ? (
          <p className="text-muted">This collection has no other folder to move it to.</p>
        ) : (
          <div>
            <label htmlFor={selectId} className="block text-muted">
              Move to
            </label>
            <select
              id={selectId}
              className={selectClass}
              value={parent}
              onChange={(event) => {
                setParent(event.target.value);
              }}
            >
              {options.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.id}
                </option>
              ))}
            </select>
          </div>
        )}
        {failure === null ? null : <ErrorState title="The request was not moved" error={failure} />}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryButtonClass} disabled={options.length === 0}>
            Move
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ConfirmDialog({
  title,
  confirm,
  onClose,
  onConfirm,
  children,
}: {
  readonly title: string;
  readonly confirm: string;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void>;
  readonly children: React.ReactNode;
}) {
  const [failure, setFailure] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="grid gap-3 px-4 py-3">
        {children}
        {failure === null ? null : <ErrorState title="That did not work" error={failure} />}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onConfirm().catch((error: unknown) => {
                setBusy(false);
                setFailure(error instanceof Error ? error : new Error(String(error)));
              });
            }}
          >
            {confirm}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** A name for something new: the text typed becomes the display name and, as a slug, the file name. */
export function NameDialog({
  title,
  label,
  initial = '',
  submit,
  onClose,
  onSubmit,
}: {
  readonly title: string;
  readonly label: string;
  readonly initial?: string;
  readonly submit: string;
  readonly onClose: () => void;
  readonly onSubmit: (name: string) => Promise<void>;
}) {
  const inputId = useId();
  const [name, setName] = useState(initial);
  const [failure, setFailure] = useState<Error | null>(null);
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="grid gap-3 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === '') return;
          onSubmit(name.trim()).catch((error: unknown) => {
            setFailure(error instanceof Error ? error : new Error(String(error)));
          });
        }}
      >
        <div>
          <label htmlFor={inputId} className="block text-muted">
            {label}
          </label>
          <input
            id={inputId}
            className="w-full rounded border border-line-strong bg-surface px-2 py-0.5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        {failure === null ? null : <ErrorState title="That did not work" error={failure} />}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryButtonClass}>
            {submit}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** A new untitled request as it opened: GET, no URL, and nothing set but its name and headers. */
function blankUntitled(document: RequestDocument): boolean {
  return (
    document.method === 'GET' &&
    document.url === '' &&
    Object.keys(document).every((key) => key === 'name' || key === 'method' || key === 'url' || key === 'headers')
  );
}
