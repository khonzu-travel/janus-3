import type { ServeArgs } from '@janus/server';

import type { StartArgs } from '../shared/messages.js';

/**
 * The app runs a project as `janus serve` with no flags, plus
 * `--watch` unless the configuration file sets `fixtures.watch` itself, and the
 * free-port override the main process sent. Both are the CLI's own overrides,
 * so health and `GET /_janus/config` report them with source `cli`.
 */
export function withWatchDefault(args: StartArgs, fileSetsWatch: boolean): ServeArgs {
  return {
    noConfig: false,
    ...(args.port === undefined ? {} : { port: args.port }),
    ...(fileSetsWatch ? {} : { watch: true as const }),
  };
}
