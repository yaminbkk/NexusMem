import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeId, sha256Hex } from '../src/core/ids.js';
import type { MemoryNode } from '../src/core/types.js';
import { EMBEDDING_DIM } from '../src/store/schema.js';
import { insertDenyListEntry } from '../src/store/deny-list.js';
import { reconcileProjectId } from '../src/store/reconcile.js';
import { MemoryStore } from '../src/store/store.js';

const OLD = 'old-project';
const NEW = 'new-project';

function node(overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id' | 'kind' | 'projectId'>): MemoryNode {
  return {
    ts: '2026-03-01T10:00:00+07:00',
    source: 'git',
    title: 'title',
    body: 'body',
    files: [],
    signal: 0.5,
    meta: {},
    ...overrides,
  };
}

describe('reconcileProjectId', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-reconcile-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates a session_summary not yet present under the new project id, recomputing its id from meta.sessionKey', () => {
    const sessionKey = 'claude-code:abc-123';
    const oldId = makeNodeId(OLD, 'session_summary', sessionKey);
    store.upsertNodes([
      node({
        id: oldId,
        kind: 'session_summary',
        projectId: OLD,
        source: 'session:claude-code',
        title: 'old title',
        body: 'old body',
        meta: { sessionKey },
      }),
    ]);

    const result = reconcileProjectId(store.raw, OLD, NEW);

    expect(result).toEqual({ oldProjectId: OLD, migrated: 1, reassigned: 0, deduped: 0, skipped: 0, denied: 0 });
    expect(store.stats(NEW).total).toBe(1);
    expect(store.stats(OLD).total).toBe(0);

    const expectedNewId = makeNodeId(NEW, 'session_summary', sessionKey);
    const row = store.raw.prepare('SELECT id FROM nodes WHERE project_id = ?').get(NEW) as { id: string };
    expect(row.id).toBe(expectedNewId);
  });

  it('dedupes a session_summary that already exists under the new project id -- no duplicate, old row dropped', () => {
    const sessionKey = 'claude-code:dup-1';
    const oldId = makeNodeId(OLD, 'session_summary', sessionKey);
    const newId = makeNodeId(NEW, 'session_summary', sessionKey);

    store.upsertNodes([
      node({ id: oldId, kind: 'session_summary', projectId: OLD, source: 'session:claude-code', meta: { sessionKey } }),
      node({ id: newId, kind: 'session_summary', projectId: NEW, source: 'session:claude-code', meta: { sessionKey } }),
    ]);

    const result = reconcileProjectId(store.raw, OLD, NEW);

    expect(result).toEqual({ oldProjectId: OLD, migrated: 0, reassigned: 0, deduped: 1, skipped: 0, denied: 0 });
    expect(store.stats(NEW).total).toBe(1);
    expect(store.stats(OLD).total).toBe(0);
  });

  it('migrates a hook-sourced shell_command by recomputing pwsh-hook:<ts>:<hash(command)>', () => {
    const ts = '2026-08-14T10:00:00.000Z';
    const command = 'git status';
    const naturalKey = `pwsh-hook:${ts}:${sha256Hex(command).slice(0, 12)}`;
    const oldId = makeNodeId(OLD, 'shell_command', naturalKey);

    store.upsertNodes([
      node({ id: oldId, kind: 'shell_command', projectId: OLD, ts, source: 'shell:pwsh-hook', meta: { command } }),
    ]);

    const result = reconcileProjectId(store.raw, OLD, NEW);

    expect(result.migrated).toBe(1);
    const expectedNewId = makeNodeId(NEW, 'shell_command', naturalKey);
    const row = store.raw.prepare('SELECT id FROM nodes WHERE project_id = ?').get(NEW) as { id: string };
    expect(row.id).toBe(expectedNewId);
  });

  it.each([
    ['bash-hook', 'shell:bash-hook'],
    ['zsh-hook', 'shell:zsh-hook'],
  ] as const)('migrates a %s-sourced shell_command the same way, not just pwsh-hook', (prefix, source) => {
    const ts = '2026-08-14T10:00:00.000Z';
    const command = 'ls -la';
    const naturalKey = `${prefix}:${ts}:${sha256Hex(command).slice(0, 12)}`;
    const oldId = makeNodeId(OLD, 'shell_command', naturalKey);

    store.upsertNodes([node({ id: oldId, kind: 'shell_command', projectId: OLD, ts, source, meta: { command } })]);

    const result = reconcileProjectId(store.raw, OLD, NEW);

    expect(result.migrated).toBe(1);
    const expectedNewId = makeNodeId(NEW, 'shell_command', naturalKey);
    const row = store.raw.prepare('SELECT id FROM nodes WHERE project_id = ?').get(NEW) as { id: string };
    expect(row.id).toBe(expectedNewId);
  });

  it('migrates pwsh-hook, bash-hook and zsh-hook rows together in one reconcile pass', () => {
    const ts = '2026-08-14T10:00:00.000Z';
    const specs = [
      { prefix: 'pwsh-hook', source: 'shell:pwsh-hook', command: 'git status' },
      { prefix: 'bash-hook', source: 'shell:bash-hook', command: 'ls -la' },
      { prefix: 'zsh-hook', source: 'shell:zsh-hook', command: 'npm test' },
    ] as const;

    store.upsertNodes(
      specs.map(({ prefix, source, command }) => {
        const naturalKey = `${prefix}:${ts}:${sha256Hex(command).slice(0, 12)}`;
        return node({ id: makeNodeId(OLD, 'shell_command', naturalKey), kind: 'shell_command', projectId: OLD, ts, source, meta: { command } });
      }),
    );

    const result = reconcileProjectId(store.raw, OLD, NEW);

    expect(result.migrated).toBe(3);
    expect(store.stats(NEW).total).toBe(3);
    expect(store.stats(OLD).total).toBe(0);
  });

  it('leaves pre-hook shell scrape rows (shell:pwsh) untouched -- their natural key is not reconstructable', () => {
    const oldId = makeNodeId(OLD, 'shell_command', 'pwsh:12:deadbeefcafe');
    store.upsertNodes([
      node({ id: oldId, kind: 'shell_command', projectId: OLD, source: 'shell:pwsh', meta: { command: 'ls' } }),
    ]);

    const result = reconcileProjectId(store.raw, OLD, NEW);

    expect(result).toEqual({ oldProjectId: OLD, migrated: 0, reassigned: 0, deduped: 0, skipped: 0, denied: 0 });
    expect(store.stats(OLD).total).toBe(1);
    expect(store.stats(NEW).total).toBe(0);
  });

  it('reassigns conversation_turn nodes to the new project id in place, keeping their existing id', () => {
    const oldId = makeNodeId(OLD, 'conversation_turn', 'claude-code:some-uuid:0');
    store.upsertNodes([node({ id: oldId, kind: 'conversation_turn', projectId: OLD, source: 'conversation:claude-code' })]);

    const result = reconcileProjectId(store.raw, OLD, NEW);

    expect(result).toEqual({ oldProjectId: OLD, migrated: 0, reassigned: 1, deduped: 0, skipped: 0, denied: 0 });
    expect(store.stats(OLD).total).toBe(0);
    expect(store.stats(NEW).total).toBe(1);
    const row = store.raw.prepare('SELECT id FROM nodes WHERE project_id = ?').get(NEW) as { id: string };
    expect(row.id).toBe(oldId);
  });

  it('drops a denied session_summary instead of migrating it, on the recomputeByNaturalKey path', () => {
    const sessionKey = 'claude-code:leaked-1';
    const oldId = makeNodeId(OLD, 'session_summary', sessionKey);
    store.upsertNodes([
      node({
        id: oldId,
        kind: 'session_summary',
        projectId: OLD,
        source: 'session:claude-code',
        body: 'contains sk-secret-999',
        meta: { sessionKey },
      }),
    ]);
    insertDenyListEntry(store.raw, {
      projectId: NEW,
      matchType: 'literal',
      pattern: 'sk-secret-999',
      ignoreCase: false,
      reason: null,
    });

    const result = reconcileProjectId(store.raw, OLD, NEW);

    expect(result).toEqual({ oldProjectId: OLD, migrated: 0, reassigned: 0, deduped: 0, skipped: 0, denied: 1 });
    expect(store.stats(OLD).total).toBe(0);
    expect(store.stats(NEW).total).toBe(0);
  });

  it('drops a denied conversation_turn instead of letting the blanket UPDATE reassign it', () => {
    const oldId = makeNodeId(OLD, 'conversation_turn', 'claude-code:leaked-uuid:0');
    const keptId = makeNodeId(OLD, 'conversation_turn', 'claude-code:kept-uuid:0');
    store.upsertNodes([
      node({
        id: oldId,
        kind: 'conversation_turn',
        projectId: OLD,
        source: 'conversation:claude-code',
        body: 'pasted sk-secret-777 by accident',
      }),
      node({ id: keptId, kind: 'conversation_turn', projectId: OLD, source: 'conversation:claude-code', body: 'unrelated turn' }),
    ]);
    insertDenyListEntry(store.raw, {
      projectId: NEW,
      matchType: 'literal',
      pattern: 'sk-secret-777',
      ignoreCase: false,
      reason: null,
    });

    const result = reconcileProjectId(store.raw, OLD, NEW);

    expect(result).toEqual({ oldProjectId: OLD, migrated: 0, reassigned: 1, deduped: 0, skipped: 0, denied: 1 });
    expect(store.stats(NEW).total).toBe(1);
    const row = store.raw.prepare('SELECT id FROM nodes WHERE project_id = ?').get(NEW) as { id: string };
    expect(row.id).toBe(keptId);
  });

  it('does not touch git_commit, code_diff, or doc_section nodes -- fully re-derivable by a normal sync', () => {
    store.upsertNodes([
      node({ id: makeNodeId(OLD, 'git_commit', 'sha1'), kind: 'git_commit', projectId: OLD, source: 'git' }),
      node({ id: makeNodeId(OLD, 'code_diff', 'sha1:file.ts'), kind: 'code_diff', projectId: OLD, source: 'diff' }),
      node({ id: makeNodeId(OLD, 'doc_section', 'README.md#intro'), kind: 'doc_section', projectId: OLD, source: 'docs' }),
    ]);

    const result = reconcileProjectId(store.raw, OLD, NEW);

    expect(result).toEqual({ oldProjectId: OLD, migrated: 0, reassigned: 0, deduped: 0, skipped: 0, denied: 0 });
    expect(store.stats(OLD).total).toBe(3);
    expect(store.stats(NEW).total).toBe(0);
  });

  it('copies node_files for a migrated session_summary', () => {
    const sessionKey = 'claude-code:files-1';
    const oldId = makeNodeId(OLD, 'session_summary', sessionKey);
    store.upsertNodes([
      node({
        id: oldId,
        kind: 'session_summary',
        projectId: OLD,
        source: 'session:claude-code',
        meta: { sessionKey },
        files: [{ path: 'src/store/store.ts', insertions: null, deletions: null, binary: false }],
      }),
    ]);

    reconcileProjectId(store.raw, OLD, NEW);

    const newId = makeNodeId(NEW, 'session_summary', sessionKey);
    const files = store.raw.prepare('SELECT path FROM node_files WHERE node_id = ?').all(newId) as Array<{ path: string }>;
    expect(files.map((f) => f.path)).toEqual(['src/store/store.ts']);
  });

  it('skips a session_summary whose meta has no sessionKey, leaving it under the old project id', () => {
    const oldId = makeNodeId(OLD, 'session_summary', 'irrelevant');
    store.upsertNodes([
      node({ id: oldId, kind: 'session_summary', projectId: OLD, source: 'session:claude-code', meta: { notSessionKey: true } }),
    ]);

    const result = reconcileProjectId(store.raw, OLD, NEW);

    expect(result).toEqual({ oldProjectId: OLD, migrated: 0, reassigned: 0, deduped: 0, skipped: 1, denied: 0 });
    expect(store.stats(OLD).total).toBe(1);
  });

  it("drops the old row's stale embedding when migrating, so nodes_vec never points at a deleted rowid", () => {
    const sessionKey = 'claude-code:embed-1';
    const oldId = makeNodeId(OLD, 'session_summary', sessionKey);
    store.upsertNodes([
      node({ id: oldId, kind: 'session_summary', projectId: OLD, source: 'session:claude-code', meta: { sessionKey } }),
    ]);

    const rowid = (store.raw.prepare('SELECT rowid FROM nodes WHERE id = ?').get(oldId) as { rowid: number }).rowid;
    store.upsertEmbedding(rowid, OLD, new Float32Array(EMBEDDING_DIM).fill(0.1));
    expect(store.raw.prepare('SELECT COUNT(*) c FROM nodes_vec').get()).toEqual({ c: 1 });

    reconcileProjectId(store.raw, OLD, NEW);

    const dangling = store.raw.prepare('SELECT COUNT(*) c FROM nodes_vec WHERE rowid NOT IN (SELECT rowid FROM nodes)').get();
    expect(dangling).toEqual({ c: 0 });
  });

  it('handles multiple stale nodes of the same kind in one pass', () => {
    const keys = ['claude-code:multi-1', 'claude-code:multi-2', 'claude-code:multi-3'];
    store.upsertNodes(
      keys.map((sessionKey) =>
        node({
          id: makeNodeId(OLD, 'session_summary', sessionKey),
          kind: 'session_summary',
          projectId: OLD,
          source: 'session:claude-code',
          meta: { sessionKey },
        }),
      ),
    );

    const result = reconcileProjectId(store.raw, OLD, NEW);

    expect(result.migrated).toBe(3);
    expect(store.stats(NEW).total).toBe(3);
    expect(store.stats(OLD).total).toBe(0);
  });
});
