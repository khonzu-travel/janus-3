import { resolve } from 'node:path';

import { defineConfig } from 'vite';

// The preload runs in a sandboxed renderer, which loads only a
// single CommonJS script: bundle it, with `electron` left to the sandbox.
export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, 'dist/preload'),
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/preload/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    rolldownOptions: { external: ['electron'] },
  },
});
