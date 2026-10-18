import { isAbsolute, resolve } from 'node:path';

/**
 * The folders named on the app's command line, resolved
 * against `cwd`. Switches are skipped, and so is the app path when Electron
 * runs the app from source (`electron <app> <folder>`).
 */
export function folderArguments(argv: readonly string[], fromSource: boolean, cwd: string): string[] {
  const positional = argv.slice(1).filter((arg) => !arg.startsWith('-'));
  return (fromSource ? positional.slice(1) : positional).map((arg) => (isAbsolute(arg) ? arg : resolve(cwd, arg)));
}
