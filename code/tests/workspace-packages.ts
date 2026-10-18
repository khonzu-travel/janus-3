import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkspacePackageLocation {
  /** Package name from its manifest, e.g. "@janus/core". */
  readonly name: string;
  /** Directory relative to the workspace root, with forward slashes, e.g. "packages/core". */
  readonly dir: string;
}

/**
 * Lists the workspace packages declared in pnpm-workspace.yaml. Only `<dir>/*`
 * patterns are supported; anything else throws so a layout change cannot be
 * silently missed by the test aliases or the boundary scan.
 */
export function listWorkspacePackages(root: string): WorkspacePackageLocation[] {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const patterns = [...yaml.matchAll(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((match) => match[1] ?? '');
  const packages: WorkspacePackageLocation[] = [];
  for (const pattern of patterns) {
    const parent = /^([\w-]+)\/\*$/.exec(pattern)?.[1];
    if (parent === undefined) throw new Error(`Unsupported workspace pattern: ${pattern}`);
    const parentDir = join(root, parent);
    if (!existsSync(parentDir)) continue;
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      const manifestPath = join(parentDir, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown };
      if (typeof manifest.name !== 'string') throw new Error(`${manifestPath} has no name`);
      packages.push({ name: manifest.name, dir: `${parent}/${entry.name}` });
    }
  }
  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}
