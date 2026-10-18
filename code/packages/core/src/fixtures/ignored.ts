/**
 * The one allowlist of editor and operating-system files that fixture loading
 * ignores wherever they appear. They never become routes, and
 * they never make a directory count as a method directory.
 *
 * - exact names: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.gitkeep`, `.keep`
 * - macOS resource forks: `._*`
 * - editor backups and swap files: `*~`, `.*.swp`, `.*.swo`
 * - Janus's own temporary write files: `.janus-*.tmp`
 */
export const IGNORED_FILE_NAMES: readonly string[] = ['.DS_Store', 'Thumbs.db', 'desktop.ini', '.gitkeep', '.keep'];

/** A file the fixture writer creates before renaming it into place. */
export function isJanusTemporaryFile(name: string): boolean {
  return name.startsWith('.janus-') && name.endsWith('.tmp') && name.length > '.janus-.tmp'.length;
}

export function isIgnoredFileName(name: string): boolean {
  if (IGNORED_FILE_NAMES.includes(name)) return true;
  if (isJanusTemporaryFile(name)) return true;
  if (name.startsWith('._')) return true;
  if (name.endsWith('~')) return true;
  return name.startsWith('.') && (name.endsWith('.swp') || name.endsWith('.swo'));
}
