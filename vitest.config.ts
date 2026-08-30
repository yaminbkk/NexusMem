import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs once, in the main process, before any test file starts. Builds
    // the root CLI a single time so the files that spawn it as a real
    // subprocess never race each other's independent build. See
    // tests/global-setup.ts.
    globalSetup: ['tests/global-setup.ts'],
    // Runs before every test file: redirects the user-scoped NexusMem
    // directory into a temporary one. See tests/setup.ts for why.
    setupFiles: ['tests/setup.ts'],
    /**
     * Vitest's 5s default is sized for unit tests. A large share of this
     * suite is not: it spawns real `git` processes against real temporary
     * repositories and opens real SQLite databases, so its wall time is set
     * by the machine, not by the code under test.
     *
     * The number that forced this: on one CI job `tests/store.test.ts` --
     * pure in-process SQLite -- took **8358ms**, while the very same commit
     * on the very same runner OS one Node version over took **135ms**. A
     * 62x spread on identical work, in one run. The MCP test that then
     * timed out does ~6 git spawns and two full syncs; it normally finishes
     * in ~1s, so any such slowdown fails it for reasons that have nothing
     * to do with correctness.
     *
     * 30s is chosen to be far above that noise while staying far below the
     * job timeout, so a genuine hang still fails the build rather than
     * stalling it. This weakens no assertion -- a slow test still has to
     * pass, it is just no longer allowed to be graded on runner luck.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
