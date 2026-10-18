import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The app's own pages: start, status and log, served from
// janus-app://app/ with relative asset URLs and nothing fetched from a network.
const root = resolve(import.meta.dirname, 'src/pages');

export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/pages'),
    emptyOutDir: true,
    // Fonts stay files, never data: URLs, so the CSP needs no font-src exception.
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        start: resolve(root, 'start.html'),
        status: resolve(root, 'status.html'),
        log: resolve(root, 'log.html'),
      },
    },
  },
});
