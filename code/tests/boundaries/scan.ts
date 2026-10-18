import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { listWorkspacePackages } from '../workspace-packages.js';
import type { PackageManifest, SourceFile, Workspace } from './check.js';

function listSourceFiles(packageDir: string): SourceFile[] {
  const srcDir = join(packageDir, 'src');
  return readdirSync(srcDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      const path = absolute
        .slice(packageDir.length + 1)
        .split('\\')
        .join('/');
      return { path, contents: readFileSync(absolute, 'utf8') };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Reads the real workspace from disk into the checker's in-memory description. */
export function scanWorkspace(root: string): Workspace {
  return {
    packages: listWorkspacePackages(root).map(({ name, dir }) => {
      const packageDir = join(root, dir);
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PackageManifest;
      return { name, dir, manifest, files: listSourceFiles(packageDir) };
    }),
  };
}
