import type { Report, EnvironmentDraft, FolderDraft } from './tree.js';
import type {
  CheckScript,
  ImportErrorCode,
  ImportOptions,
  ImportOrigin,
  ImportSource,
  ImportTransaction,
} from './types.js';

/** What every format converter receives. */
export interface ImportContext {
  readonly sources: readonly ImportSource[];
  readonly options: ImportOptions;
  readonly checkScript: CheckScript | undefined;
  readonly report: Report;
}

/** A converter's output before files are named, or why the import is refused. */
export type Converted =
  | {
      readonly ok: true;
      /** The collection's display name from the source. */
      readonly name: string;
      readonly root: FolderDraft;
      readonly environments: readonly EnvironmentDraft[];
      readonly origins?: readonly ImportOrigin[];
      readonly transactions?: readonly ImportTransaction[];
    }
  | { readonly ok: false; readonly code: ImportErrorCode; readonly message: string };

export function refuse(code: ImportErrorCode, message: string): Converted {
  return { ok: false, code, message };
}
