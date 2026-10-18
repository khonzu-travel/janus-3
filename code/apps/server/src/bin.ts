#!/usr/bin/env node
import { main, type Signal } from './main.js';

const signals: readonly Signal[] = ['SIGINT', 'SIGTERM'];

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  onSignal: (handler) => {
    for (const signal of signals) process.on(signal, handler);
    return () => {
      for (const signal of signals) process.off(signal, handler);
    };
  },
});
