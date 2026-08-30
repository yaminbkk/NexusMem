import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listRecentMemory, searchMemory, ServerNotFoundError, syncProject } from '../src/mcpClient.js';
// Reuses the root project's own hardened git fixture helper (handles the
// intermittent Windows `git` crash this project has already been bitten by)
// instead of a thinner reimplementation that would reintroduce the same flake.
import { gitFixture } from '../../tests/helpers.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BUILT_CLI = join(ROOT, 'dist', 'cli', 'index.js');

function initGitRepo(dir: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const g = (...args: string[]) => gitFixture(dir, args, { env });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'fix: handle the retry timeout correctly\n\nThe old code retried forever instead of giving up after N attempts.');
}

function syncRepo(dir: string, env: Record<string, string>): void {
  execFileSync(process.execPath, [BUILT_CLI, 'init'], { cwd: dir, env, stdio: 'pipe' });
  execFileSync(process.execPath, [BUILT_CLI, 'sync', '--no-embed'], { cwd: dir, env, stdio: 'pipe' });
}

// CLI is built once, before any test file runs (root or vscode-extension)
// -- see ../../tests/global-setup.ts. Used to be a file-scoped `beforeAll`
// here, but that raced tests/mcp.test.ts's own independent build against
// the same `dist/` (tsup clears its output directory before writing);
// confirmed as the cause of three real nightly flake-rate failures.

describe('mcpClient.searchMemory (real stdio child process)', () => {
  let repoDir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'nexusmem-vscode-mcpclient-'));
    initGitRepo(repoDir);
    env = { ...(process.env as Record<string, string>), NEXUSMEM_HOME: join(repoDir, '.test-home') };
    syncRepo(repoDir, env);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns the packed context block for a synced repo', async () => {
    const result = await searchMemory({
      command: process.execPath,
      commandArgs: [BUILT_CLI],
      projectRoot: repoDir,
      query: 'retry timeout',
      env,
    });

    expect(result.text).toContain('retry timeout');
    expect(result.bm25Matched).toBeGreaterThan(0);
    expect(result.projectsSearched.length).toBeGreaterThan(0);
  });

  it('throws ServerNotFoundError when the configured command does not exist', async () => {
    await expect(
      searchMemory({
        command: 'nexusmem-command-that-does-not-exist',
        projectRoot: repoDir,
        query: 'anything',
        env,
      }),
    ).rejects.toBeInstanceOf(ServerNotFoundError);
  });
});

describe('mcpClient.listRecentMemory (real stdio child process)', () => {
  let repoDir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'nexusmem-vscode-mcpclient-recent-'));
    initGitRepo(repoDir);
    env = { ...(process.env as Record<string, string>), NEXUSMEM_HOME: join(repoDir, '.test-home') };
    syncRepo(repoDir, env);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns the synced repo commit, newest first', async () => {
    const items = await listRecentMemory({
      command: process.execPath,
      commandArgs: [BUILT_CLI],
      projectRoot: repoDir,
      env,
    });

    expect(items.length).toBeGreaterThan(0);
    expect(items.some((item) => item.title.includes('retry timeout'))).toBe(true);
  });

  it('respects limit', async () => {
    const items = await listRecentMemory({
      command: process.execPath,
      commandArgs: [BUILT_CLI],
      projectRoot: repoDir,
      env,
      limit: 1,
    });

    expect(items).toHaveLength(1);
  });
});

describe('mcpClient.syncProject (real stdio child process)', () => {
  let repoDir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'nexusmem-vscode-mcpclient-sync-'));
    initGitRepo(repoDir);
    env = { ...(process.env as Record<string, string>), NEXUSMEM_HOME: join(repoDir, '.test-home') };
    // Deliberately NOT pre-synced (unlike the other describe blocks above) --
    // sync_project handles init + sync itself, so this proves that end to end
    // rather than against a repo the test setup already prepared.
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('ingests the repo and reports it in the summary', async () => {
    const result = await syncProject({
      command: process.execPath,
      commandArgs: [BUILT_CLI],
      projectRoot: repoDir,
      env,
    });

    expect(result.summary).toContain('synced');
    expect(result.summary).toContain('1 commit');
  });
});
