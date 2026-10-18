import { unzipSync } from 'fflate';

import type { ImportErrorCode, ImportSource } from './types.js';

/**
 * Expands a zip source with the limits: at most
 * {@link MAX_ZIP_ENTRIES} entries, at most four times `maxBytes` expanded, and
 * no links or names that resolve outside the archive. The central directory
 * is read first, so nothing is inflated from an archive that breaks a rule.
 */

export const MAX_ZIP_ENTRIES = 10_000;
export const ZIP_EXPANSION_FACTOR = 4;

export type ZipResult =
  | { readonly ok: true; readonly sources: ImportSource[] }
  | { readonly ok: false; readonly code: ImportErrorCode; readonly message: string };

/** True when the bytes start like a zip archive. */
export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05) && bytes[3] === bytes[2] + 1
  );
}

interface CentralEntry {
  readonly name: string;
  readonly size: number;
  readonly link: boolean;
  readonly encrypted: boolean;
}

const invalid = (message: string): ZipResult => ({ ok: false, code: 'import-invalid', message });
const tooLarge = (message: string): ZipResult => ({ ok: false, code: 'import-too-large', message });

/** Archive noise that is never part of a collection. */
function ignored(name: string): boolean {
  return name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name);
}

/** Why an entry name resolves outside the archive, or null when it is safe. */
function unsafeName(name: string): string | null {
  if (name.includes('\\')) return 'contains a backslash';
  if (name.includes('\0')) return 'contains a NUL character';
  if (name.startsWith('/')) return 'is an absolute path';
  if (/^[A-Za-z]:/.test(name)) return 'starts with a drive letter';
  if (name.split('/').some((part) => part === '..')) return 'contains a ".." segment';
  return null;
}

export function expandZip(zip: ImportSource, maxBytes: number): ZipResult {
  const central = readCentralDirectory(zip.bytes);
  if (typeof central === 'string') return invalid(`${zip.name} is not a readable zip archive: ${central}`);
  if (central.length > MAX_ZIP_ENTRIES) {
    return tooLarge(
      `${zip.name} holds ${String(central.length)} entries; at most ${String(MAX_ZIP_ENTRIES)} are allowed`,
    );
  }
  const limit = maxBytes * ZIP_EXPANSION_FACTOR;
  let total = 0;
  for (const entry of central) {
    const unsafe = unsafeName(entry.name);
    if (unsafe !== null)
      return invalid(`${zip.name}: the entry "${entry.name}" ${unsafe}, so it resolves outside the archive`);
    if (entry.link) return invalid(`${zip.name}: the entry "${entry.name}" is a symbolic link; links are not allowed`);
    if (entry.encrypted) return invalid(`${zip.name}: the entry "${entry.name}" is encrypted`);
    total += entry.size;
    if (total > limit) {
      return tooLarge(`${zip.name} expands to more than ${String(limit)} bytes (four times runner.maxImportBytes)`);
    }
  }
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip.bytes, { filter: (file) => !ignored(file.name) });
  } catch (error) {
    return invalid(
      `${zip.name} is not a readable zip archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let expanded = 0;
  const sources: ImportSource[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    expanded += bytes.length;
    if (expanded > limit) {
      return tooLarge(`${zip.name} expands to more than ${String(limit)} bytes (four times runner.maxImportBytes)`);
    }
    sources.push({ name, bytes });
  }
  return { ok: true, sources };
}

/** The central directory's entries, or why it cannot be read. ZIP64 archives are refused. */
function readCentralDirectory(bytes: Uint8Array): CentralEntry[] | string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end === -1) return 'no end of central directory record';
  const count = view.getUint16(end + 10, true);
  const offset = view.getUint32(end + 16, true);
  if (count === 0xffff || offset === 0xffffffff) return 'ZIP64 archives are not supported';
  const decoder = new TextDecoder();
  const entries: CentralEntry[] = [];
  let at = offset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
      return 'a central directory entry is damaged';
    const madeBy = view.getUint16(at + 4, true) >> 8;
    const flags = view.getUint16(at + 8, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const external = view.getUint32(at + 38, true);
    if (at + 46 + nameLength > bytes.length) return 'a central directory entry is damaged';
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (size === 0xffffffff) return 'ZIP64 archives are not supported';
    // Unix hosts (3) keep the file mode in the high 16 bits of the external attributes.
    const mode = external >>> 16;
    const link = madeBy === 3 && (mode & 0o170000) === 0o120000;
    entries.push({ name, size, link, encrypted: (flags & 1) !== 0 });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
