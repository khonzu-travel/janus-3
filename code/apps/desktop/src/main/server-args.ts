import type { StartArgs } from '../shared/messages.js';

/**
 * The arguments the main process sends with `start`: no flags,
 * except port 0 for a run started with Start on a Free Port. The server host
 * adds the watch default, since only it reads the configuration.
 */
export function startArgs(freePort: boolean): StartArgs {
  return freePort ? { noConfig: false, port: 0 } : { noConfig: false };
}
