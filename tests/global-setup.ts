import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Builds the root CLI exactly once, in Vitest's main process, before any
 * test file (root or vscode-extension) starts running.
 *
 * `tests/mcp.test.ts` and `vscode-extension/tests/mcpClient.test.ts` both
 * spawn the built `dist/cli/index.js` as a real subprocess and used to each
 * run their own file-scoped `npm run build` in a `beforeAll` to guarantee
 * it existed first. Vitest runs test files in parallel by default, so two
 * builds could race against the same `dist/` -- and since tsup clears its
 * output directory before writing, the loser's spawn saw either a missing
 * module or a mid-write one. Confirmed as the cause of three real nightly
 * flake-rate failures (2026-08-25, 08-26, 08-29): "Cannot find module
 * .../dist/cli/index.js" and "ServerNotFoundError: ... MCP error -32000:
 * Connection closed" are exactly what a torn `dist/` produces. A Vitest
 * `globalSetup` runs once, in the orchestrating process, strictly before
 * any worker starts, which removes the race instead of narrowing it.
 */
export default function setup(): void {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}
