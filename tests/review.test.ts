import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/commands/init.js';
import { runReview } from '../src/cli/commands/review.js';
import { runSync } from '../src/cli/commands/sync.js';
import { readConfig, resolveWorkspace, writeConfig } from '../src/config/workspace.js';
import { makeProjectId } from '../src/core/project.js';
import type { MemoryNode } from '../src/core/types.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

const REMOTE = 'https://example.com/acme/review.git';

function initGitRepo(dir: string): void {
  const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'chore: initial commit');
  g('remote', 'add', 'origin', REMOTE);
}

function node(projectId: string, overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id'>): MemoryNode {
  return {
    kind: 'doc_section',
    projectId,
    ts: '2026-01-01T00:00:00Z',
    source: 'docs',
    title: 'untitled',
    body: 'untitled',
    files: [],
    signal: 0.5,
    meta: {},
    ...overrides,
  };
}

describe('nexusmem review', () => {
  let dir: string;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-review-'));
    initGitRepo(dir);
    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });

    const ws = resolveWorkspace(dir);
    const cfg = await readConfig(ws);
    await writeConfig(ws, { ...cfg, sources: { ...cfg.sources, shell: { ...cfg.sources.shell, enabled: false } } });
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

  it('--verify records a verified verdict', async () => {
    seed([node(projectId, { id: 'a' })]);

    const chunks: string[] = [];
    const code = await runReview({ cwd: dir, nodeId: 'a', verdict: 'verified', out: (c) => chunks.push(c) });

    expect(code).toBe(0);
    expect(chunks.join('')).toMatch(/verified/);

    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    try {
      const row = store.raw.prepare('SELECT trust_state AS trustState FROM nodes WHERE id = ?').get('a') as { trustState: string };
      expect(row.trustState).toBe('verified');
    } finally {
      store.close();
    }
  });

  it('--reject records a rejected verdict, and leaves the node itself otherwise untouched', async () => {
    seed([node(projectId, { id: 'a', title: 'still here', body: 'still here' })]);

    const chunks: string[] = [];
    const code = await runReview({ cwd: dir, nodeId: 'a', verdict: 'rejected', out: (c) => chunks.push(c) });

    expect(code).toBe(0);
    expect(chunks.join('')).toMatch(/rejected/);
    expect(chunks.join('')).toMatch(/down-weighted/);

    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    try {
      const row = store.raw.prepare('SELECT trust_state AS trustState, title, body FROM nodes WHERE id = ?').get('a') as {
        trustState: string;
        title: string;
        body: string;
      };
      expect(row.trustState).toBe('rejected');
      expect(row.title).toBe('still here'); // reviewed, not rewritten
      expect(row.body).toBe('still here');
    } finally {
      store.close();
    }
  });

  it('rejects a node id that does not exist', async () => {
    await expect(runReview({ cwd: dir, nodeId: 'does-not-exist', verdict: 'verified', out: () => {} })).rejects.toThrow(
      /no node found/,
    );
  });

  it('rejects reviewing a node that belongs to a different project', async () => {
    seed([node('some-other-project', { id: 'theirs' })]);
    await expect(runReview({ cwd: dir, nodeId: 'theirs', verdict: 'verified', out: () => {} })).rejects.toThrow(
      /current project/,
    );
  });
});
