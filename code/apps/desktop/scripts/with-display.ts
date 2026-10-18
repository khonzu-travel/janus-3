import { spawnSync } from 'node:child_process';

// Runs a command with a display: under `xvfb-run` on Linux when there is none,
// directly everywhere else.

const [command, ...args] = process.argv.slice(2);
if (command === undefined) throw new Error('usage: node scripts/with-display.ts <command> [args...]');
const headless =
  process.platform === 'linux' &&
  (process.env['DISPLAY'] ?? '') === '' &&
  (process.env['WAYLAND_DISPLAY'] ?? '') === '';
const [program, programArgs] = headless ? ['xvfb-run', ['-a', command, ...args]] : [command, args];
const result = spawnSync(program, programArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
