import type { EnvironmentDocument, FolderDocument, RequestDocument } from '../model.js';

/**
 * The import pipeline's contract. Importers are pure: they
 * take source bytes and return the files a new collection would hold and a
 * report. The server writes the files; nothing here touches the filesystem.
 */

/** One source file. For a folder import, `name` is its path below the folder, with "/" separators. */
export interface ImportSource {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export type ImportFormat = 'postman' | 'bruno' | 'bruno-yaml' | 'charles' | 'har';

export interface ImportOptions {
  /** The collection's directory name; derived from the source's name when absent. */
  readonly into?: string;
  /** Charles and HAR: keep static assets (images, fonts, stylesheets, scripts). */
  readonly includeStatic?: boolean;
  /** Charles and HAR: only these origins, e.g. `https://api.example.com`. All when absent. */
  readonly origins?: readonly string[];
  /** Charles and HAR: only these 1-based transaction positions. All when absent. */
  readonly positions?: readonly number[];
  /** `runner.maxImportBytes`: the bound on input and on a zip's entries (four times this expanded). */
  readonly maxBytes: number;
}

export type ImportItemOutcome = 'converted' | 'converted-with-notes' | 'skipped';

/** One source item in the report. */
export interface ImportReportItem {
  /** Where the item is in its source: the file name and a path inside it, e.g. `checkout.json` `item[0].item[2]`. */
  readonly file: string;
  readonly location: string;
  /** The item's name in its source, e.g. the Postman request name. */
  readonly name: string;
  readonly outcome: ImportItemOutcome;
  /** Each note says what changed or was lost. */
  readonly notes: readonly string[];
  /** The request or folder ID written for it, below the collection; absent when skipped. */
  readonly id?: string;
}

/**
 * A document the import will write, by its path below the new collection;
 * environments, shared by every collection, by their path below `runner.root`
 * (`environments/<name>.yaml`).
 */
export type ImportedFile =
  | { readonly path: string; readonly kind: 'request'; readonly document: RequestDocument }
  | { readonly path: string; readonly kind: 'folder'; readonly document: FolderDocument }
  | { readonly path: string; readonly kind: 'environment'; readonly document: EnvironmentDocument }
  /** A request body file (Charles and HAR bodies that are not UTF-8 text). */
  | { readonly path: string; readonly kind: 'body'; readonly bytes: Uint8Array };

/** Charles and HAR previews: each origin and transaction, for the include filters. */
export interface ImportOrigin {
  readonly origin: string;
  readonly variable: string;
  readonly transactions: number;
}

export interface ImportTransaction {
  /** 1-based position in the source. */
  readonly position: number;
  readonly method: string;
  readonly url: string;
  readonly origin: string;
  /** True when it is a static asset, excluded unless `includeStatic`. */
  readonly static: boolean;
  /** True when it passes the filters and is converted. */
  readonly included: boolean;
}

export type ImportErrorCode = 'import-unsupported-format' | 'import-invalid' | 'import-too-large';

export type ImportResult =
  | {
      readonly ok: true;
      readonly format: ImportFormat;
      /** The collection's directory name. */
      readonly collection: string;
      /** The collection's display name from the source. */
      readonly name: string;
      readonly files: readonly ImportedFile[];
      readonly report: readonly ImportReportItem[];
      readonly origins?: readonly ImportOrigin[];
      readonly transactions?: readonly ImportTransaction[];
    }
  | { readonly ok: false; readonly code: ImportErrorCode; readonly message: string };

/** Compiles a script without running it; returns its syntax problem or null. */
export type CheckScript = (
  source: string,
) => { readonly message: string; readonly line: number; readonly column: number } | null;
