import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/commands/init.js';
import { runSync } from '../src/cli/commands/sync.js';
import { readConfig, resolveWorkspace, writeConfig } from '../src/config/workspace.js';
import { makeNodeId } from '../src/core/ids.js';
import { makeProjectId } from '../src/core/project.js';
import type { MemoryNode } from '../src/core/types.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

/**
 * End-to-end coverage for `--prune-source`/`--prune-stale-shell`, wired into
 * `runSync` as a standalone maintenance action (see the comment above
 * `runPruneSources` in `src/cli/commands/sync.ts`). `tests/store.test.ts`
 * would be the place for `pruneSourceNodes` itself, but that already exists
 * and is exercised by the `docs` source -- what's new here is the CLI-level
 * dry-run gate and the exact-source scoping of a *full* wipe (`keepIds: []`)
 * rather than the diff-style prune `docs` uses it for.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const REMOTE = 'https://example.com/acme/prune-source.git';

function initGitRepo(dir: string): void {
  const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'chore: initial commit');
  g('remote', 'add', 'origin', REMOTE);
}

// picocolors wraps individual words (e.g. `pruned`) in escape codes, so a
// literal "pruned 2" match fails even though the words are adjacent on
// screen -- strip codes before asserting on message text.
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function shellNode(projectId: string, source: string, key: string): MemoryNode {
  return {
    id: makeNodeId(projectId, 'shell_command', `${source}:${key}`),
    kind: 'shell_command',
    projectId,
    ts: '2026-01-01T00:00:00Z',
    source,
    title: `$ echo ${key}`,
    body: `$ echo ${key}`,
    files: [],
    signal: 0.2,
    meta: {},
  };
}

describe('sync --prune-source / --prune-stale-shell', () => {
  let dir: string;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-prune-source-'));
    initGitRepo(dir);
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });

    // The test machine has no hook installed *for this throwaway repo*, so a
    // real shell sync would fall back to scraping this machine's actual
    // PSReadLine history (hundreds of real, unrelated commands -- exactly the
    // live-noise problem this feature exists to clean up). Disabling the
    // source keeps the fixture hermetic; the shell nodes below are seeded
    // directly instead.
    const ws = resolveWorkspace(dir);
    const config = await readConfig(ws);
    await writeConfig(ws, { ...config, sources: { ...config.sources, shell: { ...config.sources.shell, enabled: false } } });

    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true });
    projectId = makeProjectId({ root: dir, originUrl: REMOTE });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(nodes: MemoryNode[]): void {
    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    store.upsertNodes(nodes);
    store.close();
  }

  function countsBySource(): Record<string, number> {
    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    try {
      return {
        'shell:pwsh': store.countSourceNodes(projectId, 'shell:pwsh'),
        'shell:bash': store.countSourceNodes(projectId, 'shell:bash'),
        'shell:zsh': store.countSourceNodes(projectId, 'shell:zsh'),
        'shell:pwsh-hook': store.countSourceNodes(projectId, 'shell:pwsh-hook'),
        docs: store.countSourceNodes(projectId, 'docs'),
      };
    } finally {
      store.close();
    }
  }

  it('without --yes, reports the matching count and deletes nothing', async () => {
    seed([
      shellNode(projectId, 'shell:pwsh', '1'),
      shellNode(projectId, 'shell:pwsh', '2'),
      shellNode(projectId, 'docs', '1'), // control: a different source, must survive untouched
    ]);

    const chunks: string[] = [];
    const code = await runSync({
      cwd: dir,
      full: false,
      rebuild: false,
      quiet: true,
      noEmbed: true,
      pruneSource: 'shell:pwsh',
      out: (c) => chunks.push(c),
    });

    expect(code).toBe(0);
    const summary = stripAnsi(chunks.join(''));
    expect(summary).toMatch(/would remove 2 node\(s\)/);
    expect(summary).toMatch(/--yes/);

    const after = countsBySource();
    expect(after['shell:pwsh']).toBe(2); // untouched -- this is the discriminating assertion
    expect(after.docs).toBe(1);
  });

  it('with --yes, deletes exactly the named source and nothing else', async () => {
    seed([
      shellNode(projectId, 'shell:pwsh', '1'),
      shellNode(projectId, 'shell:pwsh', '2'),
      shellNode(projectId, 'shell:pwsh-hook', '1'), // control: similar name, must survive
      shellNode(projectId, 'docs', '1'), // control: unrelated source, must survive
    ]);

    const chunks: string[] = [];
    const code = await runSync({
      cwd: dir,
      full: false,
      rebuild: false,
      quiet: true,
      noEmbed: true,
      pruneSource: 'shell:pwsh',
      yes: true,
      out: (c) => chunks.push(c),
    });

    expect(code).toBe(0);
    expect(stripAnsi(chunks.join(''))).toMatch(/pruned 2 node\(s\)/);

    const after = countsBySource();
    expect(after['shell:pwsh']).toBe(0);
    expect(after['shell:pwsh-hook']).toBe(1);
    expect(after.docs).toBe(1);
  });

  it('never touches a project id this repo\'s database never registered (a genuinely foreign id)', async () => {
    // Deliberately NOT registered via store.upsertProject -- so it can never
    // appear in listOtherProjectIds, unlike the "prior identity" case below.
    // In real usage this can't happen at all (one memory.db per repo); this
    // pins the boundary of the new sweep so it can't silently grow to "every
    // project_id value present in the nodes table".
    const foreignProjectId = makeProjectId({ root: dir, originUrl: 'https://example.com/acme/other.git' });
    seed([shellNode(projectId, 'shell:pwsh', '1'), shellNode(foreignProjectId, 'shell:pwsh', '1')]);

    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, pruneSource: 'shell:pwsh', yes: true, out: () => {} });

    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    try {
      expect(store.countSourceNodes(projectId, 'shell:pwsh')).toBe(0);
      expect(store.countSourceNodes(foreignProjectId, 'shell:pwsh')).toBe(1); // discriminating: an unscoped sweep would remove this too
    } finally {
      store.close();
    }
  });

  it('also sweeps a stale prior identity of this same repo, per listOtherProjectIds -- the real bug found 2026-08-15', async () => {
    // Reproduces the real shape found live: reconcile.ts deliberately leaves
    // dead pre-hook shell nodes behind under an old project id after a remote
    // rename, registered in the projects table (as any id a real sync has
    // touched would be) but no longer the live id. A live-id-only prune
    // cannot reach them; that was this session's actual finding.
    const staleProjectId = makeProjectId({ root: dir, originUrl: 'https://example.com/acme/prune-source-renamed-from.git' });
    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    store.upsertProject({ id: staleProjectId, root: dir, originUrl: 'https://example.com/acme/prune-source-renamed-from.git' });
    store.close();

    seed([
      shellNode(projectId, 'shell:pwsh', '1'),
      shellNode(staleProjectId, 'shell:pwsh', '1'),
      shellNode(staleProjectId, 'docs', '1'), // control: unrelated source under the stale id, must survive
    ]);

    const chunks: string[] = [];
    const code = await runSync({
      cwd: dir,
      full: false,
      rebuild: false,
      quiet: true,
      noEmbed: true,
      pruneSource: 'shell:pwsh',
      yes: true,
      out: (c) => chunks.push(c),
    });

    expect(code).toBe(0);
    const summary = stripAnsi(chunks.join(''));
    expect(summary).toMatch(/pruned 2 node\(s\)/);
    expect(summary).toMatch(/2 project identities/);

    const after = MemoryStore.open(ws.dbPath);
    try {
      expect(after.countSourceNodes(projectId, 'shell:pwsh')).toBe(0);
      expect(after.countSourceNodes(staleProjectId, 'shell:pwsh')).toBe(0); // discriminating: a live-id-only sweep would leave this at 1
      expect(after.countSourceNodes(staleProjectId, 'docs')).toBe(1);
    } finally {
      after.close();
    }
  });

  it('--prune-stale-shell clears pwsh, bash and zsh in one call, leaving the live hook source alone', async () => {
    seed([
      shellNode(projectId, 'shell:pwsh', '1'),
      shellNode(projectId, 'shell:bash', '1'),
      shellNode(projectId, 'shell:zsh', '1'),
      shellNode(projectId, 'shell:pwsh-hook', '1'),
    ]);

    const chunks: string[] = [];
    await runSync({
      cwd: dir,
      full: false,
      rebuild: false,
      quiet: true,
      noEmbed: true,
      pruneStaleShell: true,
      yes: true,
      out: (c) => chunks.push(c),
    });

    expect(stripAnsi(chunks.join(''))).toMatch(/pruned 3 node\(s\)/);

    const after = countsBySource();
    expect(after['shell:pwsh']).toBe(0);
    expect(after['shell:bash']).toBe(0);
    expect(after['shell:zsh']).toBe(0);
    expect(after['shell:pwsh-hook']).toBe(1);
  });

  it('writes one mutation_audit row for a --yes prune, but none for a dry-run preview -- the gap an external review flagged', async () => {
    seed([shellNode(projectId, 'shell:pwsh', '1'), shellNode(projectId, 'shell:pwsh', '2')]);

    // Dry-run first: previewing must not itself create a record of a delete that never happened.
    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, pruneSource: 'shell:pwsh', out: () => {} });
    const ws = resolveWorkspace(dir);
    const beforeYes = MemoryStore.open(ws.dbPath);
    const auditBeforeYes = beforeYes.listMutationAudit(projectId);
    beforeYes.close();
    expect(auditBeforeYes).toEqual([]); // discriminating: dry-run wrote zero audit rows

    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, pruneSource: 'shell:pwsh', yes: true, out: () => {} });

    const after = MemoryStore.open(ws.dbPath);
    try {
      const audit = after.listMutationAudit(projectId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'prune_source', projectId, affectedCount: 2, succeeded: true });
      expect(JSON.parse(audit[0]!.detail)).toMatchObject({ sources: ['shell:pwsh'] });
    } finally {
      after.close();
    }
  });

  it('reports nothing to do, and does not fall through to a normal sync, when no node matches', async () => {
    const chunks: string[] = [];
    const code = await runSync({
      cwd: dir,
      full: false,
      rebuild: false,
      quiet: true,
      noEmbed: true,
      pruneSource: 'shell:pwsh',
      out: (c) => chunks.push(c),
    });

    expect(code).toBe(0);
    expect(stripAnsi(chunks.join(''))).toMatch(/nothing to do/);
  });
});
