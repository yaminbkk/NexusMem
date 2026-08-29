import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/commands/init.js';
import { runSync } from '../src/cli/commands/sync.js';
import { readConfig, resolveWorkspace, writeConfig } from '../src/config/workspace.js';
import { makeProjectId } from '../src/core/project.js';
import { GithubUnavailableError, type GithubProvider } from '../src/github/read.js';
import type { RawGithubThread } from '../src/github/types.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

/**
 * End-to-end coverage for the `github` source wired into `runSync`
 * (`syncGithub` in `src/cli/commands/sync.ts`) -- opt-in, since it's the
 * first source needing a real external dependency (`gh`) and live network
 * access, unlike every other source here. All threads come from an injected
 * `GithubProvider` fake; nothing in this file touches the real `gh` CLI.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const REMOTE = 'https://github.com/yaminbkk/NexusMem.git';

function initGitRepo(dir: string, remote = REMOTE): void {
  const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'chore: initial commit');
  if (remote) g('remote', 'add', 'origin', remote);
}

async function disableShell(dir: string): Promise<void> {
  // Same reasoning as prune-source.test.ts: a real shell sync on this
  // fixture would fall back to scraping this machine's actual PSReadLine
  // history. Irrelevant to what this file tests, and not hermetic.
  const ws = resolveWorkspace(dir);
  const config = await readConfig(ws);
  await writeConfig(ws, { ...config, sources: { ...config.sources, shell: { ...config.sources.shell, enabled: false } } });
}

const fakeThread: RawGithubThread = {
  number: 8,
  type: 'issue',
  title: 'add a regression corpus',
  body: 'body text',
  author: 'yaminbkk',
  state: 'open',
  merged: false,
  labels: [],
  createdAt: '2026-08-14T11:44:30.000Z',
  updatedAt: '2026-08-29T11:58:35.000Z',
  url: 'https://github.com/yaminbkk/NexusMem/issues/8',
  comments: [],
};

class RecordingProvider implements GithubProvider {
  calls: Array<string | null> = [];
  constructor(private readonly threads: RawGithubThread[]) {}
  async listThreads(since: string | null): Promise<RawGithubThread[]> {
    this.calls.push(since);
    return this.threads;
  }
}

describe('sync: github source', () => {
  let dir: string;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-sync-github-'));
    initGitRepo(dir);
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
    await disableShell(dir);
    projectId = makeProjectId({ root: dir, originUrl: REMOTE });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function threadCount(): number {
    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    try {
      return store.stats(projectId).byKind.github_thread ?? 0;
    } finally {
      store.close();
    }
  }

  it('is a no-op when disabled (the default) even with a provider injected', async () => {
    const provider = new RecordingProvider([fakeThread]);

    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, githubProvider: provider });

    expect(provider.calls).toHaveLength(0);
    expect(threadCount()).toBe(0);
  });

  it('ingests threads when forced on via githubOverride', async () => {
    const provider = new RecordingProvider([fakeThread]);

    await runSync({
      cwd: dir,
      full: false,
      rebuild: false,
      quiet: true,
      noEmbed: true,
      githubOverride: true,
      githubProvider: provider,
    });

    expect(threadCount()).toBe(1);
  });

  it('ingests threads when enabled via persisted config, without an override', async () => {
    const ws = resolveWorkspace(dir);
    const config = await readConfig(ws);
    await writeConfig(ws, { ...config, sources: { ...config.sources, github: { ...config.sources.github, enabled: true } } });
    const provider = new RecordingProvider([fakeThread]);

    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, githubProvider: provider });

    expect(threadCount()).toBe(1);
  });

  it('skips silently when the repo has no github.com remote', async () => {
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-sync-github-noremote-'));
    initGitRepo(dir, '');
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
    await disableShell(dir);
    projectId = makeProjectId({ root: dir, originUrl: null });
    const provider = new RecordingProvider([fakeThread]);

    await runSync({
      cwd: dir,
      full: false,
      rebuild: false,
      quiet: true,
      noEmbed: true,
      githubOverride: true,
      githubProvider: provider,
    });

    expect(provider.calls).toHaveLength(0);
    expect(threadCount()).toBe(0);
  });

  it('passes a null since-cursor on the first sync, then the prior request time on the next', async () => {
    const provider = new RecordingProvider([fakeThread]);
    const opts = { cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, githubOverride: true, githubProvider: provider };

    await runSync(opts);
    expect(provider.calls[0]).toBeNull();

    await runSync(opts);
    expect(provider.calls[1]).not.toBeNull();
    expect(Number.isNaN(Date.parse(provider.calls[1]!))).toBe(false);
  });

  it('re-ingesting the same thread is idempotent (upsert, not duplicate)', async () => {
    const provider = new RecordingProvider([fakeThread]);
    const opts = { cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, githubOverride: true, githubProvider: provider };

    await runSync(opts);
    await runSync(opts);

    expect(threadCount()).toBe(1);
  });

  it('fails soft when gh is unavailable, without breaking the rest of the sync', async () => {
    const failing: GithubProvider = {
      listThreads: async () => {
        throw new GithubUnavailableError('gh CLI is not authenticated -- run `gh auth login`', null);
      },
    };

    const code = await runSync({
      cwd: dir,
      full: false,
      rebuild: false,
      quiet: true,
      noEmbed: true,
      githubOverride: true,
      githubProvider: failing,
    });

    expect(code).toBe(0);
    expect(threadCount()).toBe(0);
  });
});
