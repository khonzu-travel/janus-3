/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Local development only: `vite` and `vite preview` forward `/_janus/` to a
// running Janus, so the UI and Atlas share one origin and need no CORS.
// Override the target with JANUS_URL. To talk to Janus directly instead, list
// this dev server's origin in the server's `cors.origins`.
const janus = process.env['JANUS_URL'] ?? 'http://127.0.0.1:4010';
const proxy = { '/_janus/': { target: janus } };

export default defineConfig({
  root: import.meta.dirname,
  // Relative asset URLs, so the built UI works from any static host path.
  base: './',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy },
  preview: { proxy },
  test: {
    name: 'ui',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
  },
});
