import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/commands/init.js';
import { runStatus, type StatusOptions } from '../src/cli/commands/status.js';
import { resolveWorkspace } from '../src/config/workspace.js';
import { makeNodeId } from '../src/core/ids.js';
import { makeProjectId } from '../src/core/project.js';
import type { MemoryNode } from '../src/core/types.js';
import { installPostCommitGitHook, resolvePostCommitHookTarget } from '../src/hooks/install-git-postcommit.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

/** Avoids resolveHookTarget() spawning a real powershell.exe / touching this machine's real shell profile. */
const NO_SHELL_HOOK_TARGET = { shell: 'bash' as const, profilePath: '/dev/null/no-such-profile', logPath: '/dev/null/no-such-log' };

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const REMOTE = 'https://example.com/acme/status.git';

function initGitRepo(dir: string): void {
  const git = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  git('add', '.');
  git('commit', '-q', '-m', 'chore: initial commit');
  git('remote', 'add', 'origin', REMOTE);
}

function node(projectId: string, key: string): MemoryNode {
  return {
    id: makeNodeId(projectId, 'shell_command', key),
    kind: 'shell_command',
    projectId,
    ts: '2026-01-01T00:00:00Z',
    source: 'shell:pwsh',
    title: `$ echo ${key}`,
    body: `$ echo ${key}`,
    files: [],
    signal: 0.2,
    meta: {},
  };
}

describe('status stale project identities', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-status-'));
    initGitRepo(dir);
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function statusOutput(overrides: Partial<StatusOptions> = {}): Promise<string> {
    const chunks: string[] = [];
    await runStatus({ cwd: dir, out: (chunk) => chunks.push(chunk), shellHookTarget: NO_SHELL_HOOK_TARGET, ...overrides });
    return chunks.join('');
  }

  it('prints nothing extra when the database has no other project identity', async () => {
    expect(await statusOutput()).not.toContain('prior project');
  });

  it('reports the identity and node counts with a cleanup hint', async () => {
    const ws = resolveWorkspace(dir);
    const staleProjectId = makeProjectId({
      root: dir,
      originUrl: 'https://example.com/acme/status-renamed-from.git',
    });
    const store = MemoryStore.open(ws.dbPath);
    try {
      store.upsertProject({
        id: staleProjectId,
        root: dir,
        originUrl: 'https://example.com/acme/status-renamed-from.git',
      });
      store.upsertNodes([node(staleProjectId, 'one'), node(staleProjectId, 'two')]);
    } finally {
      store.close();
    }

    const output = await statusOutput();
    expect(output).toContain('1 prior project identity holds 2 node(s)');
    expect(output).toContain('nexusmem sync --prune-source <name>');
  });

  it('reports the shell hook using the injected target, without touching the real machine', async () => {
    const output = await statusOutput();
    expect(output).toContain('shell (bash)');
    expect(output).toContain('not installed');
  });

  it('reports git pre-commit/post-commit as not installed, and last auto-sync as n/a, before either hook is installed', async () => {
    const output = await statusOutput();
    expect(output).toContain('git pre-commit');
    expect(output).toContain('git post-commit');
    expect(output).toContain('n/a -- hook not installed');
  });

  it('reports git post-commit as installed once installed, and core.hooksPath when the repo redirects hooks', async () => {
    gitFixture(dir, ['config', 'core.hooksPath', '.husky'], { env: GIT_ENV });
    const target = await resolvePostCommitHookTarget(dir);
    await installPostCommitGitHook(target);

    const output = await statusOutput();
    expect(output).toContain('git post-commit');
    expect(output).toContain('installed');
    expect(output).toContain('core.hooksPath=.husky');
  });

  it('reports "never" for last auto-sync once the hook is installed but has not run yet', async () => {
    const target = await resolvePostCommitHookTarget(dir);
    await installPostCommitGitHook(target);

    const output = await statusOutput();
    expect(output).toContain('never');
  });

  it('reports a successful last auto-sync with a deterministic relative time', async () => {
    const target = await resolvePostCommitHookTarget(dir);
    await installPostCommitGitHook(target);
    await mkdir(join(dir, '.nexusmem'), { recursive: true });
    await writeFile(
      join(dir, '.nexusmem', 'post-commit-sync-state.json'),
      JSON.stringify({ ts: '2026-09-02T14:00:00Z', ok: true, exitCode: 0 }),
      'utf8',
    );

    const fixedNow = Date.parse('2026-09-02T14:05:00Z');
    const output = await statusOutput({ now: () => fixedNow });
    expect(output).toContain('ok');
    expect(output).toContain('5 minutes ago');
  });

  it('reports a failed last auto-sync with its exit code', async () => {
    const target = await resolvePostCommitHookTarget(dir);
    await installPostCommitGitHook(target);
    await mkdir(join(dir, '.nexusmem'), { recursive: true });
    await writeFile(
      join(dir, '.nexusmem', 'post-commit-sync-state.json'),
      JSON.stringify({ ts: '2026-09-02T14:00:00Z', ok: false, exitCode: 7 }),
      'utf8',
    );

    const output = await statusOutput({ now: () => Date.parse('2026-09-02T14:01:00Z') });
    expect(output).toContain('FAILED (exit 7)');
  });
});
