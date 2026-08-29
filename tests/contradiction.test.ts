import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkContradictions } from '../src/retrieval/contradiction.js';
import type { MemoryNode } from '../src/core/types.js';
import type { StaleCandidate } from '../src/store/nodes.js';
import { MemoryStore } from '../src/store/store.js';
import { EMBEDDING_DIM } from '../src/store/schema.js';
import { FakeEmbeddingProvider } from '../src/vector/embed.js';
import { FakeSummarizationProvider } from '../src/slm/provider.js';

const PROJECT = 'proj-a';

const node = (overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id'>): MemoryNode => ({
  kind: 'conversation_turn',
  projectId: PROJECT,
  provenance: 'recorded',
  ts: '2026-08-01T00:00:00Z',
  source: 'conversation:claude-code',
  title: 'Decided to use SQLite',
  body: 'We chose SQLite for local-first storage.',
  files: [],
  signal: 0.5,
  meta: {},
  ...overrides,
});

function staleCandidate(n: MemoryNode): StaleCandidate {
  return { id: n.id, kind: n.kind, ts: n.ts, source: n.source, title: n.title, ageDays: 90 };
}

describe('checkContradictions', () => {
  let dir: string;
  let store: MemoryStore;
  const embedder = new FakeEmbeddingProvider(EMBEDDING_DIM);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-contradiction-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Embeds every pending node with the same deterministic fake provider used to embed the live query, so KNN distance reflects real text similarity. */
  async function embedAllPending(): Promise<void> {
    for (const pending of store.findNodesNeedingEmbedding(PROJECT)) {
      const vector = await embedder.embed(`${pending.title}\n${pending.body}`);
      store.upsertEmbedding(pending.rowid, PROJECT, vector!);
    }
  }

  it('flags a candidate when its nearest newer node is a real embedding match and the SLM confirms the contradiction', async () => {
    const oldNode = node({ id: 'old', ts: '2026-08-01T00:00:00Z', body: 'We chose SQLite for local-first storage.' });
    const newNode = node({
      id: 'new',
      ts: '2026-08-20T00:00:00Z',
      title: 'Reversed the SQLite decision',
      body: 'We chose SQLite for local-first storage.', // identical body -> distance 0, guaranteed nearest neighbour
    });
    store.upsertNodes([oldNode, newNode]);
    await embedAllPending();

    const slm = new FakeSummarizationProvider(() => 'VERDICT: YES\nREASON: the earlier storage decision was reversed');
    const suggestions = await checkContradictions(store, embedder, slm, PROJECT, [staleCandidate(oldNode)]);

    expect(suggestions).toEqual([
      { candidateId: 'old', againstId: 'new', againstTitle: 'Reversed the SQLite decision', reason: 'the earlier storage decision was reversed' },
    ]);
  });

  it('returns nothing when the SLM judges the newer node unrelated', async () => {
    const oldNode = node({ id: 'old', ts: '2026-08-01T00:00:00Z' });
    const newNode = node({ id: 'new', ts: '2026-08-20T00:00:00Z', body: oldNode.body });
    store.upsertNodes([oldNode, newNode]);
    await embedAllPending();

    const slm = new FakeSummarizationProvider(() => 'VERDICT: NO\nREASON: different topics');
    const suggestions = await checkContradictions(store, embedder, slm, PROJECT, [staleCandidate(oldNode)]);

    expect(suggestions).toEqual([]);
  });

  it('never calls the SLM when no newer node exists at all', async () => {
    const oldNode = node({ id: 'old', ts: '2026-08-01T00:00:00Z' });
    store.upsertNodes([oldNode]);
    await embedAllPending();

    const slm = new FakeSummarizationProvider();
    const suggestions = await checkContradictions(store, embedder, slm, PROJECT, [staleCandidate(oldNode)]);

    expect(suggestions).toEqual([]);
    expect(slm.prompts).toHaveLength(0);
  });

  it('ignores an older node even when it is the closest embedding match', async () => {
    const oldNode = node({ id: 'old', ts: '2026-08-10T00:00:00Z' });
    const olderNode = node({ id: 'older', ts: '2026-08-01T00:00:00Z', body: oldNode.body }); // identical text, but OLDER
    store.upsertNodes([oldNode, olderNode]);
    await embedAllPending();

    const slm = new FakeSummarizationProvider(() => 'VERDICT: YES\nREASON: should never fire');
    const suggestions = await checkContradictions(store, embedder, slm, PROJECT, [staleCandidate(oldNode)]);

    expect(suggestions).toEqual([]);
    expect(slm.prompts).toHaveLength(0);
  });

  it('degrades quietly when the embedding provider is unavailable', async () => {
    const oldNode = node({ id: 'old' });
    store.upsertNodes([oldNode]);

    const deadEmbedder = { dimension: 8, identity: 'dead', embed: async () => null };
    const slm = new FakeSummarizationProvider();
    const suggestions = await checkContradictions(store, deadEmbedder, slm, PROJECT, [staleCandidate(oldNode)]);

    expect(suggestions).toEqual([]);
    expect(slm.prompts).toHaveLength(0);
  });

  it('degrades quietly when the SLM is unavailable', async () => {
    const oldNode = node({ id: 'old', ts: '2026-08-01T00:00:00Z' });
    const newNode = node({ id: 'new', ts: '2026-08-20T00:00:00Z', body: oldNode.body });
    store.upsertNodes([oldNode, newNode]);
    await embedAllPending();

    const deadSlm = { identity: 'dead', complete: async () => null };
    const suggestions = await checkContradictions(store, embedder, deadSlm, PROJECT, [staleCandidate(oldNode)]);

    expect(suggestions).toEqual([]);
  });

  it('respects the limit option and only spends SLM calls on the first N candidates', async () => {
    const a = node({ id: 'a', ts: '2026-08-01T00:00:00Z', title: 'A' });
    const b = node({ id: 'b', ts: '2026-08-02T00:00:00Z', title: 'B' });
    const newer = node({ id: 'newer', ts: '2026-08-20T00:00:00Z', title: 'Newer', body: a.body });
    store.upsertNodes([a, b, newer]);
    await embedAllPending();

    const slm = new FakeSummarizationProvider(() => 'VERDICT: NO\nREASON: n/a');
    await checkContradictions(store, embedder, slm, PROJECT, [staleCandidate(a), staleCandidate(b)], { limit: 1 });

    expect(slm.prompts).toHaveLength(1);
  });

  it('reaches past a same-timestamp cluster of near-identical siblings to a genuinely newer node -- real shape found dogfooding this repo', async () => {
    const candidate = node({ id: 'old', ts: '2026-08-01T00:00:00Z' });
    // A long conversation chunked into many nodes shares one timestamp and near-identical
    // phrasing -- these dominate the candidate's own nearest neighbours, exactly what a too-small
    // neighborLimit fails to see past (this is what DEFAULT_NEIGHBOR_LIMIT's own comment documents).
    // Identical title AND body -> the embedded `title\nbody` text is identical -> distance 0,
    // guaranteed closer than anything below (only `id`/`ts` differ, same as real chunked nodes).
    const siblings = Array.from({ length: 20 }, (_, i) =>
      node({ id: `sibling-${i}`, ts: '2026-08-01T00:00:00Z', title: candidate.title, body: candidate.body }),
    );
    // Slightly different body -> nonzero distance, guaranteed to sort after all 20 siblings.
    const genuinelyNewer = node({ id: 'newer', ts: '2026-08-20T00:00:00Z', title: 'Newer', body: `${candidate.body} (updated)` });
    store.upsertNodes([candidate, ...siblings, genuinelyNewer]);
    await embedAllPending();

    const slm = new FakeSummarizationProvider(() => 'VERDICT: YES\nREASON: superseded');
    const suggestions = await checkContradictions(store, embedder, slm, PROJECT, [staleCandidate(candidate)]);

    expect(suggestions).toEqual([{ candidateId: 'old', againstId: 'newer', againstTitle: 'Newer', reason: 'superseded' }]);
  });

  it('records every new judgment (either verdict) so the pair is never re-asked', async () => {
    const oldNode = node({ id: 'old', ts: '2026-08-01T00:00:00Z' });
    const newNode = node({ id: 'new', ts: '2026-08-20T00:00:00Z', body: oldNode.body });
    store.upsertNodes([oldNode, newNode]);
    await embedAllPending();

    const slm = new FakeSummarizationProvider(() => 'VERDICT: NO\nREASON: different topics');
    await checkContradictions(store, embedder, slm, PROJECT, [staleCandidate(oldNode)], { model: 'test-model' });
    expect(store.hasContradictionCheck('old', 'new')).toBe(true);
    expect(slm.prompts).toHaveLength(1);

    // Second run: memoized, zero model calls, still no suggestion.
    const again = await checkContradictions(store, embedder, slm, PROJECT, [staleCandidate(oldNode)], { model: 'test-model' });
    expect(again).toEqual([]);
    expect(slm.prompts).toHaveLength(1);
  });

  it('uses the stored embedding when one exists instead of re-embedding the candidate', async () => {
    const oldNode = node({ id: 'old', ts: '2026-08-01T00:00:00Z' });
    const newNode = node({ id: 'new', ts: '2026-08-20T00:00:00Z', body: oldNode.body });
    store.upsertNodes([oldNode, newNode]);
    await embedAllPending();

    // A provider that fails loudly if asked proves the stored vector was used.
    const deadEmbedder = {
      dimension: EMBEDDING_DIM,
      identity: 'dead',
      embed: async (): Promise<Float32Array | null> => {
        throw new Error('embed() must not be called when a stored vector exists');
      },
    };
    const slm = new FakeSummarizationProvider(() => 'VERDICT: YES\nREASON: superseded');
    const suggestions = await checkContradictions(store, deadEmbedder, slm, PROJECT, [staleCandidate(oldNode)]);

    expect(suggestions.map((s) => s.candidateId)).toEqual(['old']);
  });

  it('caps new SLM judgments at maxJudgments while limit still admits more candidates', async () => {
    const a = node({ id: 'a', ts: '2026-08-01T00:00:00Z', title: 'A' });
    const b = node({ id: 'b', ts: '2026-08-02T00:00:00Z', title: 'B' });
    const newer = node({ id: 'newer', ts: '2026-08-20T00:00:00Z', title: 'Newer', body: a.body });
    store.upsertNodes([a, b, newer]);
    await embedAllPending();

    const slm = new FakeSummarizationProvider(() => 'VERDICT: NO\nREASON: n/a');
    await checkContradictions(store, embedder, slm, PROJECT, [staleCandidate(a), staleCandidate(b)], {
      limit: 10,
      maxJudgments: 1,
    });

    expect(slm.prompts).toHaveLength(1);
  });

  it('stops after two consecutive null replies instead of burning a timeout per remaining candidate', async () => {
    const a = node({ id: 'a', ts: '2026-08-01T00:00:00Z', title: 'A' });
    const b = node({ id: 'b', ts: '2026-08-02T00:00:00Z', title: 'B' });
    const c = node({ id: 'c', ts: '2026-08-03T00:00:00Z', title: 'C' });
    const newer = node({ id: 'newer', ts: '2026-08-20T00:00:00Z', title: 'Newer' });
    store.upsertNodes([a, b, c, newer]);
    await embedAllPending();

    const downSlm = new FakeSummarizationProvider(() => null);
    await checkContradictions(store, embedder, downSlm, PROJECT, [staleCandidate(a), staleCandidate(b), staleCandidate(c)]);

    expect(downSlm.prompts).toHaveLength(2);
  });

  it('does not memoize when the SLM is unavailable, so the pair is retried next run', async () => {
    const oldNode = node({ id: 'old', ts: '2026-08-01T00:00:00Z' });
    const newNode = node({ id: 'new', ts: '2026-08-20T00:00:00Z', body: oldNode.body });
    store.upsertNodes([oldNode, newNode]);
    await embedAllPending();

    const deadSlm = { identity: 'dead', complete: async () => null };
    await checkContradictions(store, embedder, deadSlm, PROJECT, [staleCandidate(oldNode)]);

    expect(store.hasContradictionCheck('old', 'new')).toBe(false);
  });
});
