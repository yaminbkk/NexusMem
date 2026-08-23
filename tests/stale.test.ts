import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/commands/init.js';
import { runStale } from '../src/cli/commands/stale.js';
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

const REMOTE = 'https://example.com/acme/stale.git';

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
    kind: 'session_summary',
    projectId,
    ts: '2026-01-01T00:00:00Z',
    source: 'conversation:claude-code',
    title: 'untitled',
    body: 'untitled',
    files: [],
    signal: 0.5,
    meta: {},
    ...overrides,
  };
}

describe('nexusmem stale', () => {
  let dir: string;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-stale-'));
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

  it('reports no candidates when nothing is old enough', async () => {
    seed([node(projectId, { id: 'fresh', ts: new Date().toISOString() })]);

    const chunks: string[] = [];
    const code = await runStale({ cwd: dir, out: (c) => chunks.push(c) });

    expect(code).toBe(0);
    expect(chunks.join('')).toMatch(/no stale candidates/);
  });

  it('lists an old inferred node, oldest first, with its age and a mark-stale nudge', async () => {
    const veryOld = new Date(Date.now() - 100 * 86_400_000).toISOString();
    seed([node(projectId, { id: 'old-conclusion', title: 'stale summary', ts: veryOld })]);

    const chunks: string[] = [];
    const code = await runStale({ cwd: dir, minAgeDays: 45, out: (c) => chunks.push(c) });

    expect(code).toBe(0);
    const text = chunks.join('');
    expect(text).toMatch(/old-conclusion/);
    expect(text).toMatch(/stale summary/);
    expect(text).toMatch(/mark-stale/);
  });

  it('decorates the plain listing with a standing YES verdict, no --check-contradictions needed', async () => {
    const veryOld = new Date(Date.now() - 100 * 86_400_000).toISOString();
    seed([
      node(projectId, { id: 'old-claim', title: 'stale claim' }),
      node(projectId, { id: 'newer-evidence', title: 'newer evidence', ts: veryOld }),
    ]);

    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    store.recordContradictionCheck({
      candidateId: 'old-claim',
      againstId: 'newer-evidence',
      contradicts: true,
      reason: 'the decision was reversed',
      model: 'test-model',
    });
    store.close();

    const chunks: string[] = [];
    await runStale({ cwd: dir, minAgeDays: 45, out: (c) => chunks.push(c) });

    const text = chunks.join('');
    expect(text).toMatch(/likely superseded by/);
    expect(text).toMatch(/newer evidence/);
    expect(text).toMatch(/the decision was reversed/);
  });

  it('--dismiss silences a standing YES verdict without touching supersedes, and the plain listing stops decorating it', async () => {
    const veryOld = new Date(Date.now() - 100 * 86_400_000).toISOString();
    seed([
      node(projectId, { id: 'old-claim', title: 'stale claim' }),
      node(projectId, { id: 'newer-evidence', title: 'newer evidence', ts: veryOld }),
    ]);

    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    store.recordContradictionCheck({
      candidateId: 'old-claim',
      againstId: 'newer-evidence',
      contradicts: true,
      reason: 'the decision was reversed',
      model: 'test-model',
    });
    store.close();

    const dismissChunks: string[] = [];
    const dismissCode = await runStale({ cwd: dir, dismiss: 'old-claim', out: (c) => dismissChunks.push(c) });
    expect(dismissCode).toBe(0);
    expect(dismissChunks.join('')).toMatch(/dismissed/);

    const listChunks: string[] = [];
    await runStale({ cwd: dir, minAgeDays: 45, out: (c) => listChunks.push(c) });
    const text = listChunks.join('');
    expect(text).not.toMatch(/likely superseded by/); // discriminating: proves dismissed=1 is actually filtered, not just written
    expect(text).toMatch(/old-claim/); // the plain heuristic listing itself is untouched -- only the suggestion decoration is gone

    // discriminating: dismiss must not fabricate a supersedes relationship
    const after = MemoryStore.open(ws.dbPath);
    try {
      expect(after.getSupersededIds(projectId).has('old-claim')).toBe(false);
    } finally {
      after.close();
    }
  });

  it('--dismiss on a candidate id with no open suggestion reports nothing to do, and re-dismissing is a no-op', async () => {
    const chunks: string[] = [];
    const code = await runStale({ cwd: dir, dismiss: 'never-suggested', out: (c) => chunks.push(c) });
    expect(code).toBe(0);
    expect(chunks.join('')).toMatch(/no open contradiction suggestion/);
  });

  it('omits a node that mark-stale already superseded', async () => {
    const veryOld = new Date(Date.now() - 100 * 86_400_000).toISOString();
    seed([
      node(projectId, { id: 'superseded-node', ts: veryOld }),
      node(projectId, { id: 'replacement-node', ts: veryOld }),
    ]);

    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    store.setSupersedes('replacement-node', 'superseded-node');
    store.close();

    const chunks: string[] = [];
    await runStale({ cwd: dir, minAgeDays: 45, out: (c) => chunks.push(c) });

    expect(chunks.join('')).not.toMatch(/superseded-node/);
  });
});
