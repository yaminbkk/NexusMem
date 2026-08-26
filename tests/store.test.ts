import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryNode } from '../src/core/types.js';
import { MemoryStore } from '../src/store/store.js';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION } from '../src/store/schema.js';
import { significantTokens, toMatchQuery, toStrictMatchQuery } from '../src/store/fts.js';
import { insertDenyListEntry } from '../src/store/deny-list.js';

const PROJECT = 'proj-a';

function node(overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id'>): MemoryNode {
  return {
    kind: 'git_commit',
    projectId: PROJECT,
    ts: '2026-03-01T10:00:00+07:00',
    source: 'git',
    title: 'feat: something',
    body: 'feat: something',
    files: [],
    signal: 0.5,
    meta: {},
    ...overrides,
  };
}

describe('MemoryStore', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migrates a fresh database to the latest schema', () => {
    expect(currentSchemaVersion(store.raw)).toBe(LATEST_SCHEMA_VERSION);
  });

  it('is idempotent: re-ingesting identical nodes changes nothing', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' })];

    expect(store.upsertNodes(nodes)).toEqual({ inserted: 2, updated: 0, unchanged: 0, denied: 0 });
    expect(store.upsertNodes(nodes)).toEqual({ inserted: 0, updated: 0, unchanged: 2, denied: 0 });
    expect(store.stats(PROJECT).total).toBe(2);
  });

  it('rewrites a node only when its derived content changed', () => {
    store.upsertNodes([node({ id: 'a', signal: 0.5 })]);
    expect(store.upsertNodes([node({ id: 'a', signal: 0.9 })])).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
      denied: 0,
    });
  });

  it('persists file touches, including renames and binaries', () => {
    store.upsertNodes([
      node({
        id: 'a',
        files: [
          { path: 'src/core/app.ts', previousPath: 'src/app.ts', insertions: 3, deletions: 1, binary: false },
          { path: 'assets/logo.png', insertions: null, deletions: null, binary: true },
        ],
      }),
    ]);

    const rows = store.raw
      .prepare('SELECT path, previous_path, insertions, is_binary FROM node_files ORDER BY path')
      .all() as Array<{ path: string; previous_path: string | null; insertions: number | null; is_binary: number }>;

    expect(rows).toEqual([
      { path: 'assets/logo.png', previous_path: null, insertions: null, is_binary: 1 },
      { path: 'src/core/app.ts', previous_path: 'src/app.ts', insertions: 3, is_binary: 0 },
    ]);
    expect(store.stats(PROJECT).distinctFiles).toBe(2);
  });

  it('replaces the file list when a node is updated', () => {
    store.upsertNodes([node({ id: 'a', files: [{ path: 'old.ts', insertions: 1, deletions: 0, binary: false }] })]);
    store.upsertNodes([
      node({ id: 'a', signal: 0.9, files: [{ path: 'new.ts', insertions: 1, deletions: 0, binary: false }] }),
    ]);

    const paths = (store.raw.prepare('SELECT path FROM node_files').all() as Array<{ path: string }>).map(
      (r) => r.path,
    );
    expect(paths).toEqual(['new.ts']);
  });

  it('cascades file rows when a project is cleared', () => {
    store.upsertNodes([node({ id: 'a', files: [{ path: 'a.ts', insertions: 1, deletions: 0, binary: false }] })]);
    expect(store.clearProject(PROJECT)).toBe(1);

    const remaining = store.raw.prepare('SELECT COUNT(*) AS n FROM node_files').get() as { n: number };
    expect(remaining.n).toBe(0);
    expect(store.getSyncCursor(PROJECT, 'git')).toBeNull();
  });

  it('keeps sync cursors per project and source', () => {
    expect(store.getSyncCursor(PROJECT, 'git')).toBeNull();
    store.setSyncCursor(PROJECT, 'git', 'abc123');
    store.setSyncCursor(PROJECT, 'shell:pwsh', 'line-42');
    store.setSyncCursor('proj-b', 'git', 'def456');

    expect(store.getSyncCursor(PROJECT, 'git')).toBe('abc123');
    expect(store.getSyncCursor(PROJECT, 'shell:pwsh')).toBe('line-42');
    expect(store.getSyncCursor('proj-b', 'git')).toBe('def456');
  });

  it('isolates stats between projects', () => {
    store.upsertNodes([node({ id: 'a' }), node({ id: 'b', projectId: 'proj-b' })]);
    expect(store.stats(PROJECT).total).toBe(1);
    expect(store.stats('proj-b').total).toBe(1);
  });
});

describe('MemoryStore provenance', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults an observed kind (git_commit) to "observed" when the node omits provenance', () => {
    store.upsertNodes([node({ id: 'a', kind: 'git_commit' })]);
    const row = store.raw.prepare('SELECT provenance FROM nodes WHERE id = ?').get('a') as { provenance: string };
    expect(row.provenance).toBe('observed');
  });

  it('defaults conversation_turn to "recorded" and session_summary to "derived" when the node omits provenance', () => {
    store.upsertNodes([node({ id: 'a', kind: 'conversation_turn' }), node({ id: 'b', kind: 'session_summary' })]);
    const rows = store.raw.prepare('SELECT id, provenance FROM nodes ORDER BY id').all() as Array<{ id: string; provenance: string }>;
    expect(rows).toEqual([
      { id: 'a', provenance: 'recorded' },
      { id: 'b', provenance: 'derived' },
    ]);
  });

  it('respects an explicit provenance over the kind-based default', () => {
    store.upsertNodes([node({ id: 'a', kind: 'doc_section', provenance: 'observed' })]);
    const row = store.raw.prepare('SELECT provenance FROM nodes WHERE id = ?').get('a') as { provenance: string };
    expect(row.provenance).toBe('observed'); // doc_section defaults to 'authored'
  });

  it('surfaces provenance on search/vectorSearch/listRecentNodes/getNodesByIds results', () => {
    store.upsertNodes([node({ id: 'a', kind: 'shell_command', title: 'npm test', body: 'npm test' })]);

    expect(store.search(PROJECT, 'npm')[0]!.provenance).toBe('observed');
    expect(store.listRecentNodes(PROJECT)[0]!.provenance).toBe('observed');
    expect(store.getNodesByIds(['a'])[0]!.provenance).toBe('observed');
  });
});

describe('MemoryStore supersedes (mark-stale)', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('getNodeProjectId finds an existing node and returns null for a missing one', () => {
    store.upsertNodes([node({ id: 'a' })]);
    expect(store.getNodeProjectId('a')).toBe(PROJECT);
    expect(store.getNodeProjectId('does-not-exist')).toBeNull();
  });

  it('setSupersedes links the new node to the stale one, and getSupersededIds reports the stale id', () => {
    store.upsertNodes([node({ id: 'old' }), node({ id: 'new' })]);
    expect(store.getSupersededIds(PROJECT).size).toBe(0);

    store.setSupersedes('new', 'old');

    expect(store.getSupersededIds(PROJECT)).toEqual(new Set(['old']));
  });

  it('is scoped to one project -- a link recorded in PROJECT does not leak into a query for another project', () => {
    store.upsertNodes([node({ id: 'old' }), node({ id: 'new' })]);
    store.setSupersedes('new', 'old');

    expect(store.getSupersededIds(PROJECT)).toEqual(new Set(['old']));
    expect(store.getSupersededIds('proj-b')).toEqual(new Set());
  });

  it('a re-sync of unchanged content never touches a manually-set supersedes link', () => {
    const doomed = node({ id: 'old', body: 'unchanged content' });
    store.upsertNodes([doomed, node({ id: 'new' })]);
    store.setSupersedes('new', 'old');

    store.upsertNodes([doomed]); // identical content -- hits the "unchanged" skip in upsertNodes

    expect(store.getSupersededIds(PROJECT)).toEqual(new Set(['old']));
  });
});

describe('MemoryStore trust_state (review)', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults every new node to candidate', () => {
    store.upsertNodes([node({ id: 'a' })]);
    expect(store.search(PROJECT, 'something')[0]?.trustState).toBe('candidate');
  });

  it('setTrustState records the verdict and reports whether a row actually matched', () => {
    store.upsertNodes([node({ id: 'a' })]);
    expect(store.setTrustState('a', 'rejected')).toBe(true);
    expect(store.search(PROJECT, 'something')[0]?.trustState).toBe('rejected');
    expect(store.setTrustState('does-not-exist', 'verified')).toBe(false);
  });

  it('a re-sync of unchanged content never touches a manually-set trust_state, same rule as supersedes', () => {
    const doomed = node({ id: 'a', body: 'unchanged content' });
    store.upsertNodes([doomed]);
    store.setTrustState('a', 'rejected');

    store.upsertNodes([doomed]); // identical content -- hits the "unchanged" skip in upsertNodes

    expect(store.search(PROJECT, 'unchanged')[0]?.trustState).toBe('rejected');
  });
});

describe('MemoryStore.listStaleCandidates', () => {
  let dir: string;
  let store: MemoryStore;
  const NOW = new Date('2026-08-20T00:00:00Z');
  const old = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
  const recent = new Date(NOW.getTime() - 5 * 86_400_000).toISOString();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces an old inferred node but not an old observed one or a recent inferred one', () => {
    store.upsertNodes([
      node({ id: 'old-inferred', kind: 'session_summary', ts: old }),
      node({ id: 'old-observed', kind: 'git_commit', ts: old }),
      node({ id: 'recent-inferred', kind: 'session_summary', ts: recent }),
    ]);

    const candidates = store.listStaleCandidates(PROJECT, { now: NOW, minAgeDays: 45 });

    expect(candidates.map((c) => c.id)).toEqual(['old-inferred']);
    expect(candidates[0]!.ageDays).toBe(90);
  });

  it('excludes a node that is already superseded -- it is already known-stale', () => {
    store.upsertNodes([
      node({ id: 'old-inferred', kind: 'session_summary', ts: old }),
      node({ id: 'replacement', kind: 'session_summary', ts: recent }),
    ]);
    store.setSupersedes('replacement', 'old-inferred');

    expect(store.listStaleCandidates(PROJECT, { now: NOW, minAgeDays: 45 })).toEqual([]);
  });

  it('orders oldest first and respects limit', () => {
    store.upsertNodes([
      node({ id: 'a', kind: 'session_summary', ts: old }),
      node({ id: 'b', kind: 'session_summary', ts: new Date(NOW.getTime() - 200 * 86_400_000).toISOString() }),
    ]);

    const all = store.listStaleCandidates(PROJECT, { now: NOW, minAgeDays: 45 });
    expect(all.map((c) => c.id)).toEqual(['b', 'a']);

    const limited = store.listStaleCandidates(PROJECT, { now: NOW, minAgeDays: 45, limit: 1 });
    expect(limited.map((c) => c.id)).toEqual(['b']);
  });

  it('is scoped to one project', () => {
    store.upsertNodes([
      node({ id: 'a', kind: 'session_summary', ts: old }),
      node({ id: 'b', kind: 'session_summary', ts: old, projectId: 'proj-b' }),
    ]);

    expect(store.listStaleCandidates(PROJECT, { now: NOW, minAgeDays: 45 }).map((c) => c.id)).toEqual(['a']);
    expect(store.listStaleCandidates('proj-b', { now: NOW, minAgeDays: 45 }).map((c) => c.id)).toEqual(['b']);
  });
});

describe('MemoryStore contradiction checks', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
    store.upsertNodes([
      node({ id: 'old', kind: 'session_summary', title: 'old claim' }),
      node({ id: 'newer', kind: 'session_summary', title: 'newer claim' }),
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const yes = { candidateId: 'old', againstId: 'newer', contradicts: true, reason: 'directly reverses it', model: 'test-model' };

  it('remembers a judged pair either way, so the next run can skip re-asking the model', () => {
    expect(store.hasContradictionCheck('old', 'newer')).toBe(false);

    store.recordContradictionCheck({ ...yes, contradicts: false, reason: null });
    expect(store.hasContradictionCheck('old', 'newer')).toBe(true);
    expect(store.hasContradictionCheck('newer', 'old')).toBe(false); // direction matters
  });

  it('lists only YES verdicts, with both titles and the reason', () => {
    store.recordContradictionCheck(yes);
    store.recordContradictionCheck({ candidateId: 'newer', againstId: 'old', contradicts: false, reason: null, model: 'test-model' });

    const rows = store.listContradictionSuggestions(PROJECT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      candidateId: 'old',
      candidateTitle: 'old claim',
      againstId: 'newer',
      againstTitle: 'newer claim',
      reason: 'directly reverses it',
    });
    expect(store.countContradictionSuggestions(PROJECT)).toBe(1);
  });

  it('drops a suggestion once the candidate is superseded -- it did its job', () => {
    store.recordContradictionCheck(yes);
    store.setSupersedes('newer', 'old');

    expect(store.listContradictionSuggestions(PROJECT)).toEqual([]);
    expect(store.countContradictionSuggestions(PROJECT)).toBe(0);
  });

  it('is scoped to one project', () => {
    store.upsertNodes([node({ id: 'foreign', kind: 'session_summary', projectId: 'proj-b' })]);
    store.recordContradictionCheck({ ...yes, candidateId: 'foreign', againstId: 'old' });

    expect(store.countContradictionSuggestions(PROJECT)).toBe(0);
    expect(store.countContradictionSuggestions('proj-b')).toBe(1);
  });

  it('cascades away with either node, so a check never outlives what it judged', () => {
    store.recordContradictionCheck(yes);
    store.raw.prepare('DELETE FROM nodes WHERE id = ?').run('newer');

    expect(store.hasContradictionCheck('old', 'newer')).toBe(false);
  });
});

describe('MemoryStore.search', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
    store.upsertNodes([
      node({
        id: 'wal',
        title: 'fix(store): close the WAL handle on Windows',
        body: 'fix(store): close the WAL handle on Windows\n\nSQLite kept the file locked.\n\nFiles changed:\n  src/store/db.ts (+12/-3)',
      }),
      node({
        id: 'auth',
        title: 'feat(auth): add refresh tokens',
        body: 'feat(auth): add refresh tokens\n\nFiles changed:\n  src/auth/token.ts (+80/-0)',
      }),
      node({
        id: 'chore',
        title: 'chore: bump deps',
        body: 'chore: bump deps\n\nFiles changed:\n  package.json (+4/-4)',
      }),
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds nodes by a word in the body', () => {
    const hits = store.search(PROJECT, 'sqlite locked');
    expect(hits.map((h) => h.id)).toContain('wal');
  });

  it('finds nodes by file path', () => {
    const hits = store.search(PROJECT, 'token.ts');
    expect(hits[0]?.id).toBe('auth');
  });

  it('ranks a title match above a body-only match', () => {
    const hits = store.search(PROJECT, 'store');
    // 'store' appears in the title of `wal` and only in a file path elsewhere.
    expect(hits[0]?.id).toBe('wal');
  });

  it('does not leak nodes across projects', () => {
    expect(store.search('proj-b', 'WAL')).toHaveLength(0);
  });

  it('survives FTS5 syntax in user input instead of throwing', () => {
    for (const q of ['"unterminated', 'a OR', 'NEAR(', '*', 'src/store/db.ts', "it's broken -- why?"]) {
      expect(() => store.search(PROJECT, q)).not.toThrow();
    }
  });

  it('does not let the generic word "id" pull in an unrelated node over a real match', () => {
    // Reproduces a live finding: "id" alone prefix-matched "--id" in an
    // unrelated shell command, ranking it inside the results for a query
    // that was actually about a Facebook webhook's sender id.
    store.upsertNodes([
      node({ id: 'noise', kind: 'shell_command', source: 'shell:pwsh', title: 'winget install --id 9PFHDD62MXS1' }),
      node({ id: 'real', title: 'Log the identifiers the automation webhook actually receives' }),
    ]);

    const hits = store.search(PROJECT, 'Facebook Page inbox webhook PSID sender id');
    expect(hits.map((h) => h.id)).not.toContain('noise');
    expect(hits[0]?.id).toBe('real');
  });

  it('reflects updates in the index', () => {
    store.upsertNodes([node({ id: 'wal', title: 'fix(store): totally rewritten', body: 'kangaroo' })]);
    expect(store.search(PROJECT, 'kangaroo').map((h) => h.id)).toEqual(['wal']);
    expect(store.search(PROJECT, 'locked')).toHaveLength(0);
  });

  it('drops a deleted node from the index', () => {
    store.clearProject(PROJECT);
    expect(store.search(PROJECT, 'WAL')).toHaveLength(0);
  });

  it('asOfEpoch excludes a node recorded after the cutoff, even though it happened before -- the bi-temporal read', () => {
    // Backdate 'wal's created_at ahead of 'auth's and 'chore's: the event
    // timestamp (`ts`) says nothing about when the store actually learned
    // about it, and asOfEpoch filters on the latter, not the former.
    store.raw.prepare('UPDATE nodes SET created_at = 2000 WHERE id = ?').run('wal');
    store.raw.prepare('UPDATE nodes SET created_at = 1000 WHERE id IN (?, ?)').run('auth', 'chore');

    const asOfBeforeWal = store.search(PROJECT, 'store', 20, { asOfEpoch: 1500 });
    expect(asOfBeforeWal.map((h) => h.id)).not.toContain('wal');

    const asOfAfterWal = store.search(PROJECT, 'store', 20, { asOfEpoch: 2500 });
    expect(asOfAfterWal.map((h) => h.id)).toContain('wal');

    expect(store.search(PROJECT, 'store').map((h) => h.id)).toContain('wal'); // omitted entirely -- no filter, same as before this option existed
  });
});

describe('MemoryStore node_links', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
    store.upsertNodes([
      node({ id: 'failure', kind: 'shell_command', title: 'npm test failed' }),
      node({ id: 'fix', kind: 'code_diff', title: 'fix(store): the actual fix' }),
      node({ id: 'unrelated', title: 'unrelated node' }),
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('links a failure to its resolution, and reads it back by relation', () => {
    store.linkNodes('failure', 'fix', 'resolved_by');

    expect(store.getLinkedNodeIds('failure', 'resolved_by')).toEqual(['fix']);
    expect(store.getLinkedNodeIds('failure', 'some_other_relation')).toEqual([]); // discriminating: relation is part of the key, not just a label
    expect(store.getLinkedNodeIds('unrelated', 'resolved_by')).toEqual([]);
  });

  it('is idempotent: linking the same pair and relation twice does not error or duplicate', () => {
    store.linkNodes('failure', 'fix', 'resolved_by');
    store.linkNodes('failure', 'fix', 'resolved_by');

    expect(store.getLinkedNodeIds('failure', 'resolved_by')).toEqual(['fix']);
    const count = store.raw.prepare('SELECT COUNT(*) AS n FROM node_links').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('hydrates full node content for a set of linked ids', () => {
    store.linkNodes('failure', 'fix', 'resolved_by');
    const linkedIds = store.getLinkedNodeIds('failure', 'resolved_by');

    const hydrated = store.getNodesByIds(linkedIds);

    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({ id: 'fix', kind: 'code_diff', title: 'fix(store): the actual fix' });
  });

  it('getNodesByIds returns nothing for an empty id list, and silently omits ids with no matching row', () => {
    expect(store.getNodesByIds([])).toEqual([]);
    expect(store.getNodesByIds(['does-not-exist'])).toEqual([]);
  });

  it('a link is deleted along with either node it references (ON DELETE CASCADE)', () => {
    store.linkNodes('failure', 'fix', 'resolved_by');
    store.clearProject(PROJECT); // deletes every node for this project, including both ends of the link

    const count = store.raw.prepare('SELECT COUNT(*) AS n FROM node_links').get() as { n: number };
    expect(count.n).toBe(0); // discriminating: without the FK's ON DELETE CASCADE this would still be 1
  });
});

describe('MemoryStore.listRecentNodes', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns nodes newest first, by event time not insertion order', () => {
    // Inserted oldest-first so a naive "last inserted" implementation would
    // pass by accident; ts_epoch ordering is what actually matters.
    store.upsertNodes([
      node({ id: 'oldest', ts: '2026-01-01T10:00:00+07:00', title: 'oldest' }),
      node({ id: 'newest', ts: '2026-03-01T10:00:00+07:00', title: 'newest' }),
      node({ id: 'middle', ts: '2026-02-01T10:00:00+07:00', title: 'middle' }),
    ]);

    expect(store.listRecentNodes(PROJECT).map((n) => n.id)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('respects the limit', () => {
    store.upsertNodes([
      node({ id: 'a', ts: '2026-01-01T10:00:00+07:00' }),
      node({ id: 'b', ts: '2026-01-02T10:00:00+07:00' }),
      node({ id: 'c', ts: '2026-01-03T10:00:00+07:00' }),
    ]);

    expect(store.listRecentNodes(PROJECT, 2).map((n) => n.id)).toEqual(['c', 'b']);
  });

  it('is scoped to one project', () => {
    store.upsertNodes([node({ id: 'a' }), node({ id: 'b', projectId: 'proj-b' })]);

    expect(store.listRecentNodes(PROJECT).map((n) => n.id)).toEqual(['a']);
    expect(store.listRecentNodes('proj-b').map((n) => n.id)).toEqual(['b']);
  });

  it('returns the fields a sidebar-style listing needs, without the full body', () => {
    store.upsertNodes([node({ id: 'a', kind: 'shell_command', source: 'shell:pwsh', title: 'npm whoami', signal: 0.42 })]);

    expect(store.listRecentNodes(PROJECT)).toEqual([
      {
        id: 'a',
        kind: 'shell_command',
        ts: '2026-03-01T10:00:00+07:00',
        source: 'shell:pwsh',
        title: 'npm whoami',
        signal: 0.42,
        provenance: 'observed', // defaultProvenanceForKind: no explicit provenance was set on this fixture node
      },
    ]);
  });

  it('returns an empty list for a project with no nodes', () => {
    expect(store.listRecentNodes('no-such-project')).toEqual([]);
  });
});

describe('MemoryStore.upsertNodes deny-list', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips inserting a node whose body matches an active literal deny-list entry', () => {
    insertDenyListEntry(store.raw, {
      projectId: PROJECT,
      matchType: 'literal',
      pattern: 'sk-secret-123',
      ignoreCase: false,
      reason: null,
    });

    const stats = store.upsertNodes([
      node({ id: 'a', body: 'export API_KEY=sk-secret-123' }),
      node({ id: 'b', body: 'unrelated content' }),
    ]);

    expect(stats).toEqual({ inserted: 1, updated: 0, unchanged: 0, denied: 1 });
    expect(store.listRecentNodes(PROJECT).map((n) => n.id)).toEqual(['b']);
  });

  it('matches a regex entry, case-insensitively when requested', () => {
    insertDenyListEntry(store.raw, {
      projectId: PROJECT,
      matchType: 'regex',
      pattern: 'sk-[a-z0-9]+',
      ignoreCase: true,
      reason: null,
    });

    const stats = store.upsertNodes([node({ id: 'a', body: 'token SK-ABC123 leaked' })]);

    expect(stats).toEqual({ inserted: 0, updated: 0, unchanged: 0, denied: 1 });
  });

  it('a deny-list entry scoped to another project does not affect this one', () => {
    insertDenyListEntry(store.raw, {
      projectId: 'proj-other',
      matchType: 'literal',
      pattern: 'sk-secret-123',
      ignoreCase: false,
      reason: null,
    });

    const stats = store.upsertNodes([node({ id: 'a', body: 'export API_KEY=sk-secret-123' })]);

    expect(stats).toEqual({ inserted: 1, updated: 0, unchanged: 0, denied: 0 });
  });
});

describe('MemoryStore.forget / previewForget', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('previewForget counts matches by source without deleting anything', () => {
    store.upsertNodes([
      node({ id: 'a', source: 'shell:pwsh-hook', body: 'export API_KEY=sk-secret-123' }),
      node({ id: 'b', source: 'git', body: 'unrelated' }),
    ]);

    const preview = store.previewForget(PROJECT, [], { matchType: 'literal', pattern: 'sk-secret-123', ignoreCase: false, reason: null });

    expect(preview).toEqual([{ projectId: PROJECT, source: 'shell:pwsh-hook', count: 1 }]);
    expect(store.listRecentNodes(PROJECT).map((n) => n.id).sort()).toEqual(['a', 'b']);
  });

  it('deletes every matching node, leaves a control node untouched, and writes one deny_list + one tombstones row', () => {
    store.upsertNodes([
      node({ id: 'a', body: 'export API_KEY=sk-secret-123' }),
      node({ id: 'control', body: 'unrelated content' }),
    ]);

    const result = store.forget(PROJECT, [], { matchType: 'literal', pattern: 'sk-secret-123', ignoreCase: false, reason: 'test leak' });

    expect(result.removed).toBe(1);
    expect(store.listRecentNodes(PROJECT).map((n) => n.id)).toEqual(['control']);

    const denyRows = store.raw.prepare('SELECT COUNT(*) AS c FROM deny_list WHERE id = ?').get(result.entryId) as { c: number };
    expect(denyRows.c).toBe(1);
    const tombstoneRows = store.raw.prepare('SELECT COUNT(*) AS c FROM tombstones WHERE deny_list_id = ?').get(result.entryId) as {
      c: number;
    };
    expect(tombstoneRows.c).toBe(1);
  });

  it('the tombstone never contains the forgotten value -- hash-only, by design', () => {
    const secret = 'sk-secret-hash-only-999';
    store.upsertNodes([node({ id: 'a', body: `leaked: ${secret}` })]);

    const result = store.forget(PROJECT, [], { matchType: 'literal', pattern: secret, ignoreCase: false, reason: null });

    const row = store.raw.prepare('SELECT * FROM tombstones WHERE mutation_audit_id = ?').get(result.auditId);
    expect(JSON.stringify(row).includes(secret)).toBe(false);
  });

  it('writes a mutation_audit row with the correct affected_count, even for a zero-match forget', () => {
    const result = store.forget(PROJECT, [], { matchType: 'literal', pattern: 'never-appeared', ignoreCase: false, reason: null });

    expect(result.removed).toBe(0);
    const audit = store.raw.prepare('SELECT action, project_id, affected_count, succeeded FROM mutation_audit WHERE id = ?').get(
      result.auditId,
    ) as { action: string; project_id: string; affected_count: number; succeeded: number };
    expect(audit).toEqual({ action: 'forget', project_id: PROJECT, affected_count: 0, succeeded: 1 });

    const denyRows = store.raw.prepare('SELECT COUNT(*) AS c FROM deny_list WHERE project_id = ?').get(PROJECT) as { c: number };
    expect(denyRows.c).toBe(1);
  });

  it('a future upsertNodes of identical content is denied, not re-inserted', () => {
    const secret = 'sk-secret-resurrect-1';
    const doomed = node({ id: 'a', body: `leaked: ${secret}` });
    store.upsertNodes([doomed]);

    store.forget(PROJECT, [], { matchType: 'literal', pattern: secret, ignoreCase: false, reason: null });

    const stats = store.upsertNodes([doomed]);
    expect(stats).toEqual({ inserted: 0, updated: 0, unchanged: 0, denied: 1 });
    expect(store.stats(PROJECT).total).toBe(0);
  });

  it('deny-list survives clearProject, so a forgotten value stays denied through a sync --rebuild-style drop and re-ingest', () => {
    const secret = 'sk-secret-rebuild-1';
    const doomed = node({ id: 'a', body: `leaked: ${secret}` });
    const control = node({ id: 'control', body: 'unrelated commit' });
    store.upsertNodes([doomed, control]);

    store.forget(PROJECT, [], { matchType: 'literal', pattern: secret, ignoreCase: false, reason: null });
    expect(store.stats(PROJECT).total).toBe(1);

    const removed = store.clearProject(PROJECT); // what `sync --rebuild` does before re-ingesting
    expect(removed).toBe(1);

    const denyRows = store.raw.prepare('SELECT COUNT(*) AS c FROM deny_list WHERE project_id = ?').get(PROJECT) as { c: number };
    expect(denyRows.c).toBe(1);

    const stats = store.upsertNodes([doomed, control]); // simulates --rebuild's re-ingest from the same source
    expect(stats).toEqual({ inserted: 1, updated: 0, unchanged: 0, denied: 1 });
    expect(store.listRecentNodes(PROJECT).map((n) => n.id)).toEqual(['control']);
  });

  it('sweeps otherProjectIds, mirroring pruneSourceNodes -- forgets a value under a stale prior project identity too', () => {
    const STALE = 'stale-prior-id';
    store.upsertNodes([node({ id: 'a', projectId: STALE, body: 'export API_KEY=sk-secret-stale' })]);

    const result = store.forget(PROJECT, [STALE], { matchType: 'literal', pattern: 'sk-secret-stale', ignoreCase: false, reason: null });

    expect(result.removed).toBe(1);
    expect(store.stats(STALE).total).toBe(0);
  });

  it('rejects an empty pattern instead of silently denying every node', () => {
    expect(() => store.previewForget(PROJECT, [], { matchType: 'literal', pattern: '  ', ignoreCase: false, reason: null })).toThrow();
    expect(() => store.forget(PROJECT, [], { matchType: 'literal', pattern: '  ', ignoreCase: false, reason: null })).toThrow();
  });

  it('lists active deny-list entries for a project', () => {
    store.forget(PROJECT, [], { matchType: 'literal', pattern: 'value-one', ignoreCase: false, reason: 'r1' });
    store.forget(PROJECT, [], { matchType: 'regex', pattern: 'value-t[wo]+', ignoreCase: false, reason: null });

    const entries = store.listDenyList(PROJECT);
    expect(entries.map((e) => e.pattern)).toEqual(['value-one', 'value-t[wo]+']);
  });
});

describe('toMatchQuery', () => {
  it('quotes tokens and adds prefix matching', () => {
    expect(toMatchQuery('refresh token')).toBe('"refresh"* OR "token"*');
  });

  it('strips FTS5 operators out of user text', () => {
    expect(toMatchQuery('NEAR("a" b)')).toBe('"NEAR"* OR "a"* OR "b"*');
  });

  it('returns null when nothing searchable is left', () => {
    expect(toMatchQuery('   ')).toBeNull();
    expect(toMatchQuery('*(){}')).toBeNull();
  });

  it('drops the generic token "id" when other signal survives', () => {
    expect(toMatchQuery('sender id')).toBe('"sender"*');
    expect(toMatchQuery('sender ID')).toBe('"sender"*');
  });

  it('keeps "id" when it is the only token, rather than matching nothing', () => {
    expect(toMatchQuery('id')).toBe('"id"*');
  });
});

describe('toStrictMatchQuery', () => {
  it('same tokenization as toMatchQuery, but AND-ed instead of OR-ed', () => {
    expect(toStrictMatchQuery('refresh token')).toBe('"refresh"* AND "token"*');
  });

  it('strips FTS5 operators out of user text, same as toMatchQuery', () => {
    expect(toStrictMatchQuery('NEAR("a" b)')).toBe('"NEAR"* AND "a"* AND "b"*');
  });

  it('returns null when nothing searchable is left', () => {
    expect(toStrictMatchQuery('   ')).toBeNull();
    expect(toStrictMatchQuery('*(){}')).toBeNull();
  });

  it('drops the generic token "id" when other signal survives', () => {
    expect(toStrictMatchQuery('sender id')).toBe('"sender"*');
  });

  it('keeps "id" when it is the only token, rather than matching nothing', () => {
    expect(toStrictMatchQuery('id')).toBe('"id"*');
  });
});

describe('significantTokens', () => {
  it('splits on whitespace after stripping FTS5 syntax characters', () => {
    expect(significantTokens('NEAR("a" b)')).toEqual(['NEAR', 'a', 'b']);
  });

  it('is the shared tokenization behind both toMatchQuery and toStrictMatchQuery', () => {
    const tokens = significantTokens('sender id');
    expect(tokens).toEqual(['sender']); // "id" already dropped here, not just at the join step
  });

  it('returns an empty array for input with no searchable text', () => {
    expect(significantTokens('   ')).toEqual([]);
    expect(significantTokens('*(){}')).toEqual([]);
  });
});
