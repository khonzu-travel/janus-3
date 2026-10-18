import { useId, useState } from 'react';

import type { CollectionNode, ContainerNode, RequestDocument } from '../../atlas/runner.js';
import { buttonClass, primaryButtonClass } from '../../components/buttonClass.js';
import { ErrorState } from '../../components/states/ErrorState.js';
import { useAtlasSession } from '../../hooks/AtlasSession.js';
import { Dialog } from './Dialog.js';
import { inputClass, selectClass } from './fields.js';
import { useRunnerRefresh } from './hooks.js';
import { nextOrdered, slug } from './variables.js';

/** Every collection and folder, depth first, with its path of names for the "Save to" list. */
function containers(collections: readonly CollectionNode[]): { node: ContainerNode; label: string }[] {
  const all: { node: ContainerNode; label: string }[] = [];
  const visit = (node: ContainerNode, path: string): void => {
    const label = path === '' ? node.name : `${path} / ${node.name}`;
    all.push({ node, label });
    for (const child of node.children) if (child.kind !== 'request') visit(child, label);
  };
  for (const collection of collections) visit(collection, '');
  return all;
}

/**
 * Saves an untitled request to a collection or folder:
 * its name and where it goes. The request keeps everything it was
 * given, headers included.
 */
export function SaveRequestDialog({
  collections,
  parent,
  document,
  onClose,
  onSaved,
}: {
  readonly collections: readonly CollectionNode[];
  /** The collection or folder picked at first; the first collection when null or gone. */
  readonly parent: string | null;
  readonly document: RequestDocument;
  readonly onClose: () => void;
  readonly onSaved: (id: string) => void;
}) {
  const { client } = useAtlasSession();
  const refresh = useRunnerRefresh();
  const nameId = useId();
  const parentId = useId();
  const options = containers(collections);
  const [name, setName] = useState(document.name);
  const [target, setTarget] = useState(
    options.find((option) => option.node.id === parent)?.node.id ?? options[0]?.node.id ?? '',
  );
  const [failure, setFailure] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    const container = options.find((option) => option.node.id === target)?.node;
    if (container === undefined) return;
    const id = `${container.id}/${nextOrdered(
      container.children.map((child) => child.id),
      slug(name),
    )}`;
    await client.runner.saveRequest(id, { ...document, name }, 'absent');
    await refresh();
    onSaved(id);
  };

  return (
    <Dialog title="Save to collection" onClose={onClose}>
      {options.length === 0 ? (
        <div className="grid gap-3 px-4 py-3">
          <p>There is no collection to save to yet. Create one first: New collection is key 2 in the panel.</p>
          <div className="flex justify-end">
            <button type="button" className={buttonClass} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <form
          className="grid gap-3 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() === '' || saving) return;
            setSaving(true);
            setFailure(null);
            save()
              .catch((error: unknown) => {
                setFailure(error instanceof Error ? error : new Error(String(error)));
              })
              .finally(() => {
                setSaving(false);
              });
          }}
        >
          <div>
            <label htmlFor={nameId} className="block text-muted">
              Name
            </label>
            <input
              id={nameId}
              className={inputClass}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </div>
          <div>
            <label htmlFor={parentId} className="block text-muted">
              Save to
            </label>
            <select
              id={parentId}
              className={`${selectClass} w-full`}
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
              }}
            >
              {options.map((option) => (
                <option key={option.node.id} value={option.node.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {failure === null ? null : <ErrorState title="The request was not saved" error={failure} />}
          <div className="flex justify-end gap-2">
            <button type="button" className={buttonClass} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={primaryButtonClass} disabled={name.trim() === '' || saving}>
              Save
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
