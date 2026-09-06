// Standalone vitest config, deliberately NOT importing vite.config.ts: the tests
// are pure Node tests over src/worker modules, and the Cloudflare Vite plugin
// rejects the environment options vitest injects.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // tests/ holds the worker and shared tests, and is compiled by
    // tsconfig.worker.json — which has no JSX and no DOM. An app-side test
    // therefore lives beside what it tests, under tsconfig.app.json, rather than
    // dragging browser types into the worker's project. Still pure functions:
    // nothing here renders, so the node environment is enough.
    include: ['tests/**/*.test.ts', 'src/app/**/*.test.tsx'],
  },
});
