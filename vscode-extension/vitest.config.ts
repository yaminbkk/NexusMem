import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Shared with the root project's own vitest.config.ts: builds the root
    // CLI exactly once, before any test file runs, so this workspace's own
    // stdio integration test (which spawns the built CLI as a real
    // subprocess) never races another test file's independent build against
    // the same `dist/`. See ../tests/global-setup.ts.
    globalSetup: ['../tests/global-setup.ts'],
    // The stdio integration test spawns real git -- same rationale as the
    // root project's own vitest.config.ts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
