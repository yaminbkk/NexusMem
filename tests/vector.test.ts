import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryNode } from '../src/core/types.js';
import { mergeSearchAndVectorHits, reciprocalRankFusion } from '../src/retrieval/fuse.js';
import { rankHits } from '../src/retrieval/rank.js';
import { MemoryStore } from '../src/store/store.js';
import { EMBEDDING_DIM } from '../src/store/schema.js';
import { FakeEmbeddingProvider } from '../src/vector/embed.js';
import { embedPendingNodes } from '../src/vector/sync.js';

describe('reciprocalRankFusion', () => {
  it('ranks an item appearing near the top of both lists above one appearing in only one', () => {
    const bm25 = [{ id: 'both' }, { id: 'bm25-only' }];
    const vector = [{ id: 'both' }, { id: 'vector-only' }];
    const scores = reciprocalRankFusion([bm25, vector]);

    expect(scores.get('both')!).toBeGreaterThan(scores.get('bm25-only')!);
    expect(scores.get('both')!).toBeGreaterThan(scores.get('vector-only')!);
  });

  it('rewards a better position within a single list', () => {
    const scores = reciprocalRankFusion([[{ id: 'first' }, { id: 'second' }, { id: 'third' }]]);
    expect(scores.get('first')!).toBeGreaterThan(scores.get('second')!);
    expect(scores.get('second')!).toBeGreaterThan(scores.get('third')!);
  });

  it('returns an empty map for no lists', () => {
    expect(reciprocalRankFusion([]).size).toBe(0);
  });
});

describe('mergeSearchAndVectorHits', () => {
  const bm25Hit = {
    id: 'a',
    kind: 'git_commit' as const,
    ts: 't',
    title: 'A',
    body: 'body a',
    signal: 0.5,
    provenance: 'observed' as const,
    trustState: 'candidate' as const,
    rank: -3,
  };
  const vectorHit = {
    id: 'b',
    kind: 'shell_command' as const,
    ts: 't',
    title: 'B',
    body: 'body b',
    signal: 0.3,
    provenance: 'observed' as const,
    trustState: 'candidate' as const,
    distance: 0.1,
  };

  it('keeps the bm25 version when a node appears in both sets', () => {
    const dupVector = { ...vectorHit, id: 'a', title: 'should not win' };
    const merged = mergeSearchAndVectorHits([bm25Hit], [dupVector]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toBe('A');
  });

  it('includes a vector-only hit with a placeholder rank', () => {
    const merged = mergeSearchAndVectorHits([bm25Hit], [vectorHit]);
    expect(merged.map((h) => h.id).sort()).toEqual(['a', 'b']);
    expect(merged.find((h) => h.id === 'b')!.rank).toBe(0);
  });
});

describe('rankHits with relevanceScores override', () => {
  const hit = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    kind: 'git_commit' as const,
    ts: new Date().toISOString(),
    title: id,
    body: id,
    signal: 0.5,
    provenance: 'observed' as const,
    trustState: 'candidate' as const,
    rank: -1, // deliberately identical / meaningless -- relevanceScores should be what decides order
    ...overrides,
  });

  it('orders purely by the supplied relevance map, ignoring bm25 rank', () => {
    const hits = [hit('low'), hit('high')];
    const scores = new Map([
      ['low', 0.1],
      ['high', 0.9],
    ]);
    const ranked = rankHits(hits, { relevanceScores: scores, now: new Date() });
    expect(ranked[0]!.id).toBe('high');
  });

  it('falls back to a floor for an id missing from the map', () => {
    const hits = [hit('known'), hit('unknown')];
    const scores = new Map([['known', 0.8]]);
    expect(() => rankHits(hits, { relevanceScores: scores })).not.toThrow();
  });
});

describe('MemoryStore vector search (real sqlite-vec extension)', () => {
  let dir: string;
  let store: MemoryStore;
  const PROJECT = 'proj-a';

  const node = (overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id'>): MemoryNode => ({
    kind: 'git_commit',
    projectId: PROJECT,
    ts: '2026-08-09T00:00:00Z',
    source: 'git',
    title: 'feat: something',
    body: 'feat: something',
    files: [],
    signal: 0.5,
    meta: {},
    ...overrides,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-vec-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the sqlite-vec extension and creates nodes_vec at the confirmed embedding dimension', () => {
    const info = store.raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'nodes_vec'").get() as { sql: string };
    expect(info.sql).toContain(`float[${EMBEDDING_DIM}]`);
  });

  it('reports every node as needing embedding before any embedding pass runs', () => {
    store.upsertNodes([node({ id: 'a' }), node({ id: 'b' })]);
    expect(store.findNodesNeedingEmbedding(PROJECT)).toHaveLength(2);
  });

  it('finds the closer of two vectors via KNN', () => {
    store.upsertNodes([node({ id: 'near' }), node({ id: 'far' })]);
    const [near, far] = store.findNodesNeedingEmbedding(PROJECT);

    store.upsertEmbedding(near!.rowid, PROJECT, new Float32Array(EMBEDDING_DIM).fill(0.1));
    store.upsertEmbedding(far!.rowid, PROJECT, new Float32Array(EMBEDDING_DIM).fill(0.9));

    const hits = store.vectorSearch(PROJECT, new Float32Array(EMBEDDING_DIM).fill(0.1), 5);
    expect(hits[0]!.id).toBe('near');
    expect(hits[0]!.distance).toBeLessThan(hits[1]!.distance);
  });

  it('does not leak vector hits across projects', () => {
    store.upsertNodes([node({ id: 'a' }), node({ id: 'b', projectId: 'proj-b' })]);
    for (const n of store.findNodesNeedingEmbedding('proj-b')) {
      store.upsertEmbedding(n.rowid, 'proj-b', new Float32Array(EMBEDDING_DIM).fill(0.5));
    }
    expect(store.vectorSearch(PROJECT, new Float32Array(EMBEDDING_DIM).fill(0.5))).toHaveLength(0);
  });

  it('finds a sparse project’s true nearest neighbours even when a much larger project shares the database', () => {
    // The exact failure `project_id` as a vec0 PARTITION KEY (schema.ts's V11)
    // exists to prevent: before it, `vectorSearch` over-fetched `k` globally
    // and filtered afterward, so a small project's real matches could fall
    // entirely outside that window once another project in the same database
    // got large enough. Reproduces that shape directly: 200 unrelated
    // "big-project" nodes all closer to the query vector than any of the 3
    // real "sparse-project" nodes are to each other.
    const bigNodes: MemoryNode[] = [];
    for (let i = 0; i < 200; i++) bigNodes.push(node({ id: `big-${i}`, projectId: 'big-project' }));
    const sparseNodes = [node({ id: 's0' }), node({ id: 's1' }), node({ id: 's2' })];
    store.upsertNodes([...bigNodes, ...sparseNodes]);

    for (const n of store.findNodesNeedingEmbedding('big-project')) {
      store.upsertEmbedding(n.rowid, 'big-project', new Float32Array(EMBEDDING_DIM).fill(1));
    }
    for (const [i, n] of store.findNodesNeedingEmbedding(PROJECT).entries()) {
      store.upsertEmbedding(n.rowid, PROJECT, new Float32Array(EMBEDDING_DIM).fill(0.5 + i * 0.01));
    }

    const hits = store.vectorSearch(PROJECT, new Float32Array(EMBEDDING_DIM).fill(1), 3);
    expect(hits.map((h) => h.id).sort()).toEqual(['s0', 's1', 's2']);
  });

  it('invalidates a stale embedding when the node content changes', () => {
    store.upsertNodes([node({ id: 'a', body: 'original' })]);
    const [pending] = store.findNodesNeedingEmbedding(PROJECT);
    store.upsertEmbedding(pending!.rowid, PROJECT, new Float32Array(EMBEDDING_DIM).fill(0.2));
    expect(store.findNodesNeedingEmbedding(PROJECT)).toHaveLength(0);

    store.upsertNodes([node({ id: 'a', body: 'changed', signal: 0.9 })]);
    expect(store.findNodesNeedingEmbedding(PROJECT)).toHaveLength(1);
  });

  it('removes nodes_vec rows when a project is cleared', () => {
    store.upsertNodes([node({ id: 'a' })]);
    const [pending] = store.findNodesNeedingEmbedding(PROJECT);
    store.upsertEmbedding(pending!.rowid, PROJECT, new Float32Array(EMBEDDING_DIM).fill(0.4));

    store.clearProject(PROJECT);
    const remaining = store.raw.prepare('SELECT COUNT(*) AS n FROM nodes_vec').get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('forget removes the node from vector search too, not just BM25 -- the embedding row itself is dropped', () => {
    store.upsertNodes([node({ id: 'secret', title: 'export API_KEY=sk-vector-leak-test', body: 'export API_KEY=sk-vector-leak-test' })]);
    const [pending] = store.findNodesNeedingEmbedding(PROJECT);
    const queryVector = new Float32Array(EMBEDDING_DIM).fill(0.42);
    store.upsertEmbedding(pending!.rowid, PROJECT, queryVector);

    expect(store.vectorSearch(PROJECT, queryVector, 5).map((h) => h.id)).toContain('secret');
    const vecCountBefore = (store.raw.prepare('SELECT COUNT(*) AS n FROM nodes_vec').get() as { n: number }).n;
    expect(vecCountBefore).toBe(1);

    store.forget(PROJECT, [], { matchType: 'literal', pattern: 'sk-vector-leak-test', ignoreCase: false, reason: null });

    expect(store.vectorSearch(PROJECT, queryVector, 5)).toEqual([]);
    const vecCountAfter = (store.raw.prepare('SELECT COUNT(*) AS n FROM nodes_vec').get() as { n: number }).n;
    expect(vecCountAfter).toBe(0); // the embedding row itself is gone, not just excluded by a post-filter
  });
});

describe('embedPendingNodes', () => {
  let dir: string;
  let store: MemoryStore;
  const PROJECT = 'proj-a';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-vec-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
    store.upsertNodes([
      {
        id: 'a',
        kind: 'git_commit',
        projectId: PROJECT,
        ts: '2026-08-09T00:00:00Z',
        source: 'git',
        title: 'fix: thing',
        body: 'fix: thing',
        files: [],
        signal: 0.5,
        meta: {},
      },
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('embeds every pending node with a working provider', async () => {
    const result = await embedPendingNodes(store, new FakeEmbeddingProvider(EMBEDDING_DIM), PROJECT);
    expect(result).toEqual({ embedded: 1, skipped: 0, providerUnavailable: false, invalidated: 0, remaining: 0 });
    expect(store.findNodesNeedingEmbedding(PROJECT)).toHaveLength(0);
  });

  it('reports providerUnavailable without throwing when the provider always fails', async () => {
    const deadProvider = { dimension: EMBEDDING_DIM, identity: 'dead', embed: async () => null };
    const result = await embedPendingNodes(store, deadProvider, PROJECT);
    expect(result).toEqual({ embedded: 0, skipped: 1, providerUnavailable: true, invalidated: 0, remaining: 1 });
    // Sync must still succeed with BM25-only nodes intact -- embedding is additive, never a gate.
    expect(store.stats(PROJECT).total).toBe(1);
  });
});
