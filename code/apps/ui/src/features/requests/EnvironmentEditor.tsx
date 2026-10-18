import { useEffect, useState } from 'react';

import { ContextMenu } from './ContextMenu.js';

import { AtlasError } from '../../atlas/client.js';
import type { AtlasClient } from '../../atlas/client.js';
import type { EnvironmentDetail, EnvironmentEntry } from '../../atlas/runner.js';
import {
  buttonClass,
  iconButtonClass,
  primaryIconButtonClass,
  removableRowClass,
  removeIconButtonClass,
} from '../../components/buttonClass.js';
import { ClearListIcon, PlusIcon, SaveIcon, TrashIcon } from '../../components/icons.js';
import { ErrorState } from '../../components/states/ErrorState.js';
import { LoadingState } from '../../components/states/LoadingState.js';
import { useAtlasSession } from '../../hooks/AtlasSession.js';
import { inputClass } from './fields.js';
import { useEnvironmentDetail, useRunnerRefresh } from './hooks.js';
import { CopyIcon, EnvironmentIcon, EyeIcon, EyeOffIcon, MoreIcon, StarIcon } from './icons.js';
import { environmentKey, setTabDirty, setTabName, useTabState } from './tabState.js';
import { ConfirmDialog } from './RequestWorkspace.js';
import { EmptyState } from '../../components/states/EmptyState.js';

interface Row {
  readonly name: string;
  readonly value: string;
  /** Sensitive: written to `<name>.local.yaml`, which stays out of git, and shown as dots. */
  readonly local: boolean;
  /** Kept in the file but not used (`disabled`). */
  readonly enabled: boolean;
}

function rowsOf(detail: EnvironmentDetail): Row[] {
  const local = detail.local?.vars ?? {};
  const disabled = new Set(detail.document.disabled ?? []);
  const rows: Row[] = Object.entries(detail.document.vars ?? {})
    .filter(([name]) => !Object.hasOwn(local, name))
    .map(([name, value]) => ({ name, value, local: false, enabled: !disabled.has(name) }));
  for (const [name, value] of Object.entries(local))
    rows.push({ name, value, local: true, enabled: !disabled.has(name) });
  return rows;
}

/**
 * The environments in the side panel: shared by every collection. Each has a
 * menu (right-click, the Menu key, Shift + F10, or its ⋯ button) to rename,
 * duplicate or delete it.
 */
export function EnvironmentList({
  environments,
  selected,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
}: {
  readonly environments: readonly EnvironmentEntry[];
  /** The environment whose tab is in front, if any. */
  readonly selected: string | null;
  readonly onOpen: (id: string) => void;
  /** Opens its tab with the name being edited. */
  readonly onRename: (id: string) => void;
  readonly onDuplicate: (id: string) => void;
  readonly onDelete: (id: string) => void;
}) {
  const [menu, setMenu] = useState<{ entry: EnvironmentEntry; x: number; y: number } | null>(null);
  const openMenu = (entry: EnvironmentEntry, element: Element, at?: { x: number; y: number }): void => {
    const box = element.getBoundingClientRect();
    setMenu({ entry, x: at?.x ?? box.left + 16, y: at?.y ?? box.bottom });
  };
  return (
    <nav aria-label="Environments" className="flex min-h-0 flex-col">
      {environments.length === 0 ? (
        <EmptyState title="No environments yet" headingLevel={null}>Environments you create or import show here.</EmptyState>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {environments.map((entry) => (
            <li
              key={entry.id}
              className={`group flex items-center hover:bg-hover ${entry.id === selected ? 'bg-accent-soft' : ''}`}
            >
              <button
                type="button"
                aria-current={entry.id === selected ? 'page' : undefined}
                aria-haspopup="menu"
                className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-2 pl-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                onClick={() => {
                  onOpen(entry.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openMenu(entry, event.currentTarget, { x: event.clientX, y: event.clientY });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                    event.preventDefault();
                    openMenu(entry, event.currentTarget);
                  } else if (event.key === 'F2') {
                    event.preventDefault();
                    onRename(entry.id);
                  }
                }}
              >
                <EnvironmentIcon className="size-3.5 text-muted" />
                <span className="truncate">{entry.name}</span>
                {entry.default === true ? (
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-muted">
                    <StarIcon className="size-3 fill-current" />
                    Default
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-surface hover:text-fg focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent"
                aria-label={`More for ${entry.name}`}
                title="More (right-click, Shift + F10)"
                aria-haspopup="menu"
                onClick={(event) => {
                  openMenu(entry, event.currentTarget);
                }}
              >
                <MoreIcon className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {menu === null ? null : (
        <ContextMenu
          label={menu.entry.name}
          x={menu.x}
          y={menu.y}
          items={[
            {
              label: 'Rename',
              detail: 'F2',
              onSelect: () => {
                onRename(menu.entry.id);
              },
            },
            {
              label: 'Duplicate',
              icon: <CopyIcon className="size-3.5" />,
              onSelect: () => {
                onDuplicate(menu.entry.id);
              },
            },
            {
              label: 'Delete',
              icon: <TrashIcon className="size-3.5" />,
              danger: true,
              separated: true,
              onSelect: () => {
                onDelete(menu.entry.id);
              },
            },
          ]}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </nav>
  );
}

/** A free ID for a copy of the environment `id`: `<id>-copy`, then `<id>-copy-2`, and so on. */
export function copyId(id: string, taken: readonly string[]): string {
  let next = `${id}-copy`;
  for (let n = 2; taken.includes(next); n++) next = `${id}-copy-${String(n)}`;
  return next;
}

/**
 * An environment in its own editor tab:
 * name and value per variable, a checkbox to use it or keep it unused,
 * and an eye that marks it Sensitive, which moves the value into the
 * environment's `.local.yaml` and shows it as dots.
 */
export function EnvironmentView({
  id,
  environments,
  onDeleted,
  onDuplicate,
}: {
  readonly id: string;
  /** Every environment, to unmark the old default when this one becomes it. */
  readonly environments: readonly EnvironmentEntry[];
  readonly onDeleted: () => void;
  readonly onDuplicate: () => void;
}) {
  const detail = useEnvironmentDetail(id);
  const [deleting, setDeleting] = useState(false);
  if (detail.error !== null && detail.data === undefined) {
    return (
      <ErrorState title="Could not open the environment" error={detail.error} onRetry={() => void detail.refetch()} />
    );
  }
  if (detail.data?.id !== id) return <LoadingState label="Opening the environment" />;
  const data = detail.data;
  return (
    <div className="flex min-h-full flex-col">
      <EnvironmentTable
        key={data.id}
        detail={data}
        environments={environments}
        onDelete={() => {
          setDeleting(true);
        }}
        onDuplicate={onDuplicate}
      />
      {deleting ? (
        <DeleteEnvironmentDialog
          detail={data}
          onClose={() => {
            setDeleting(false);
          }}
          onDeleted={() => {
            setDeleting(false);
            onDeleted();
          }}
        />
      ) : null}
    </div>
  );
}

/** Asks before deleting an environment's file and its `.local.yaml`. */
export function DeleteEnvironmentDialog({
  detail,
  onClose,
  onDeleted,
}: {
  readonly detail: EnvironmentDetail;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}) {
  const { client } = useAtlasSession();
  const refresh = useRunnerRefresh();
  return (
    <ConfirmDialog
      title={`Delete environment ${detail.document.name ?? detail.id}?`}
      confirm="Delete"
      onClose={onClose}
      onConfirm={async () => {
        await client.runner.deleteEnvironment(detail.id, detail.digest);
        await refresh();
        onDeleted();
      }}
    >
      <p>This deletes the environment’s file and its .local.yaml.</p>
    </ConfirmDialog>
  );
}

/** Writes an environment's files back with `default` set or dropped, keeping the rest as on disk. */
async function writeDefault(client: AtlasClient, detail: EnvironmentDetail, on: boolean): Promise<void> {
  const { default: _old, ...document } = detail.document;
  await client.runner.saveEnvironment(
    detail.id,
    { document: on ? { ...document, default: true } : document, local: detail.local },
    { digest: detail.digest },
  );
}

/**
 * Makes `detail` the default environment, or stops it being one. The old
 * default is unmarked after the new one is marked, so a failure in between
 * leaves two, of which the tree's first wins, rather than none.
 */
async function setDefault(
  client: AtlasClient,
  detail: EnvironmentDetail,
  environments: readonly EnvironmentEntry[],
  on: boolean,
): Promise<void> {
  await writeDefault(client, detail, on);
  if (!on) return;
  for (const entry of environments) {
    if (entry.id === detail.id || entry.default !== true) continue;
    await writeDefault(client, await client.runner.environment(entry.id), false);
  }
}

function EnvironmentTable({
  detail,
  environments,
  onDelete,
  onDuplicate,
}: {
  readonly detail: EnvironmentDetail;
  readonly environments: readonly EnvironmentEntry[];
  readonly onDelete: () => void;
  readonly onDuplicate: () => void;
}) {
  const { client } = useAtlasSession();
  const refresh = useRunnerRefresh();
  const { names } = useTabState();
  const tabKey = environmentKey(detail.id);
  const [rows, setRows] = useState<readonly Row[]>(() => rowsOf(detail));
  const [base, setBase] = useState(detail);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);
  const [status, setStatus] = useState('');
  // The file changed (a save here, or on disk): show it, unless there are unsaved edits.
  const [shown, setShown] = useState(detail);
  if (shown !== detail) {
    setShown(detail);
    if (JSON.stringify(rows) === JSON.stringify(rowsOf(base))) {
      setRows(rowsOf(detail));
      setBase(detail);
    } else if (detail.digest !== base.digest) setConflict(true);
  }
  // The name is edited on the environment's tab (double-click it, F2, or the list's menu), as an unsaved change.
  const savedName = base.document.name ?? base.id;
  const name = names[tabKey] ?? savedName;
  const dirty = JSON.stringify(rows) !== JSON.stringify(rowsOf(base)) || name !== savedName;
  // The tab shows a dot while there are unsaved changes.
  useEffect(() => {
    setTabDirty(tabKey, dirty);
  }, [tabKey, dirty]);
  const change = (index: number, patch: Partial<Row>): void => {
    setRows(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };
  const isDefault = detail.document.default === true;
  const save = async (expected = base.digest): Promise<void> => {
    if (saving) return;
    setSaving(true);
    const shared: Record<string, string> = {};
    const local: Record<string, string> = {};
    const disabled: string[] = [];
    for (const row of rows) {
      if (row.name === '') continue;
      (row.local ? local : shared)[row.name] = row.value;
      if (!row.enabled) disabled.push(row.name);
    }
    setFailure(null);
    const body = {
      document: {
        ...(detail.document.name === undefined && name === detail.id ? {} : { name }),
        vars: shared,
        ...(disabled.length === 0 ? {} : { disabled }),
        ...(detail.document.default === true ? { default: true } : {}),
      },
      local: Object.keys(local).length === 0 ? null : { vars: local },
    };
    try {
      const written = await client.runner.saveEnvironment(detail.id, body, { digest: expected });
      setBase({ ...detail, ...body, digest: written.digest ?? expected });
      setTabName(tabKey, name);
      setConflict(false);
      setStatus('Saved.');
      await refresh();
    } catch (error) {
      if (error instanceof AtlasError && error.details.code === 'request-changed') {
        setConflict(true);
        await refresh();
      } else setFailure(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setSaving(false);
    }
  };
  return (
    // Ctrl/Cmd + S saves from any field; the wrapper is not itself interactive.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          if (dirty && !conflict && !saving) void save();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-4 py-2">
        <h2 className="flex items-center gap-2 font-medium">
          <EnvironmentIcon className="size-4 text-muted" />
          {name}
        </h2>
        <code className="font-mono text-mono text-faint">requests/environments/{detail.id}.yaml</code>
        <span role="status" className="text-muted">
          {dirty ? 'Unsaved changes' : status}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            className={`${iconButtonClass} ${isDefault ? 'text-accent' : ''}`}
            aria-label="Default environment"
            aria-pressed={isDefault}
            title={
              isDefault
                ? 'The default environment: picked until you pick another. Click to have no default.'
                : 'Make this the default environment: picked until you pick another.'
            }
            onClick={() => {
              setFailure(null);
              setDefault(client, detail, environments, !isDefault).then(
                async () => {
                  setStatus(isDefault ? 'No longer the default.' : 'Now the default environment.');
                  await refresh();
                },
                async (error: unknown) => {
                  setFailure(error instanceof Error ? error : new Error(String(error)));
                  await refresh();
                },
              );
            }}
          >
            <StarIcon className={`size-3.5 ${isDefault ? 'fill-current' : ''}`} />
          </button>
          <button
            type="button"
            className={iconButtonClass}
            aria-label="Duplicate environment"
            title="Duplicate environment"
            onClick={onDuplicate}
          >
            <CopyIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className={iconButtonClass}
            aria-label="Delete environment"
            title="Delete environment"
            onClick={onDelete}
          >
            <TrashIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className={primaryIconButtonClass}
            disabled={!dirty || conflict || saving}
            aria-label="Save environment"
            aria-keyshortcuts="Control+S Meta+S"
            title="Save environment (Ctrl + S)"
            onClick={() => void save()}
          >
            <SaveIcon className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="px-4 py-3">
        <div className="mb-1 flex items-center gap-1.5">
          <h3 className="font-medium">Variables</h3>
          <div className="ml-auto flex items-center gap-1.5">
            {rows.length === 0 ? null : (
              <button
                type="button"
                className={iconButtonClass}
                aria-label="Clear all variables"
                title="Clear all variables"
                onClick={() => {
                  setRows([]);
                }}
              >
                <ClearListIcon className="size-3.5" />
              </button>
            )}
            <button
              type="button"
              className={iconButtonClass}
              aria-label="Add variable"
              title="Add variable"
              onClick={() => {
                setRows([...rows, { name: '', value: '', local: false, enabled: true }]);
              }}
            >
              <PlusIcon className="size-3.5" />
            </button>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="text-muted">No variables yet.</p>
        ) : (
          <table className="data-table w-full">
            <caption className="sr-only">Environment variables</caption>
            <thead>
              <tr>
                <th scope="col" className="w-8">
                  <span className="sr-only">Use</span>
                </th>
                <th scope="col">Name</th>
                <th scope="col">Value</th>
                <th scope="col" className="w-px">
                  <span className="sr-only">Sensitive and remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const label = row.name === '' ? `row ${String(index + 1)}` : row.name;
                const off = row.enabled ? '' : 'text-faint line-through';
                return (
                  <tr key={index} className={removableRowClass}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Use ${label}`}
                        checked={row.enabled}
                        onChange={(event) => {
                          change(index, { enabled: event.target.checked });
                        }}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Name, ${label}`}
                        className={`${inputClass} ${off}`}
                        value={row.name}
                        spellCheck={false}
                        onChange={(event) => {
                          change(index, { name: event.target.value });
                        }}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Value, ${label}`}
                        type={row.local ? 'password' : 'text'}
                        autoComplete="off"
                        className={`${inputClass} ${off}`}
                        value={row.value}
                        spellCheck={false}
                        onChange={(event) => {
                          change(index, { value: event.target.value });
                        }}
                      />
                    </td>
                    <td>
                      {/* One cell keeps the eye and the trash side by side at any width. */}
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          className={`${iconButtonClass} ${row.local ? 'border-warn bg-warn-soft text-warn' : ''}`}
                          aria-label={`Sensitive, ${label}`}
                          aria-pressed={row.local}
                          title={
                            row.local
                              ? `Sensitive: shown as dots and kept in ${detail.id}.local.yaml, out of git. Click to show it and keep it in ${detail.id}.yaml.`
                              : `Click to mark it Sensitive: shown as dots and kept in ${detail.id}.local.yaml, out of git.`
                          }
                          onClick={() => {
                            change(index, { local: !row.local });
                          }}
                        >
                          {row.local ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                        </button>
                        <button
                          type="button"
                          data-remove=""
                          className={removeIconButtonClass}
                          aria-label={`Remove ${label}`}
                          title="Remove"
                          onClick={() => {
                            setRows(rows.filter((_row, at) => at !== index));
                          }}
                        >
                          <TrashIcon className="size-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-muted">
          Sensitive values are written to <code className="font-mono text-mono">{detail.id}.local.yaml</code>; add{' '}
          <code className="font-mono text-mono">*.local.yaml</code> to your{' '}
          <code className="font-mono text-mono">.gitignore</code>. Unticked variables stay in the file but are not used.
        </p>
      </div>
      {conflict ? (
        <section role="alert" className="mx-4 my-2 border-l-2 border-warn bg-warn-soft px-3 py-2">
          <h3 className="font-medium">The environment changed on disk</h3>
          <p>Your edit is still here. Use the file’s latest values, or explicitly replace them with your edit.</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={saving}
              onClick={() => {
                setRows(rowsOf(detail));
                setBase(detail);
                setConflict(false);
                setFailure(null);
              }}
            >
              Use file
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={saving || detail.digest === base.digest}
              onClick={() => void save(detail.digest)}
            >
              Keep my edit
            </button>
          </div>
        </section>
      ) : null}
      {failure === null ? null : <ErrorState title="The environment was not saved" error={failure} />}
    </div>
  );
}
