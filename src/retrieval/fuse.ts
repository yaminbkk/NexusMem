import type { SearchHit, VectorHit } from '../store/store.js';

/**
 * Reciprocal Rank Fusion: combine several best-first ranked lists into one
 * relevance score per item, using only each item's *position* in each list,
 * never the raw scores.
 *
 * This is what makes fusing BM25 (a cost, lower is better) with vector
 * distance (also lower is better, but on a completely different, unbounded
 * scale) safe without any manual normalization between them -- position is
 * the only thing the two scales agree on.
 */

/** Standard RRF constant. Large enough that rank 1 doesn't overwhelmingly dominate rank 2. */
const RRF_K = 60;

export interface RankedItem {
  id: string;
}

/**
 * `lists` are each assumed already sorted best-first. An id absent from a
 * list simply contributes nothing from it -- appearing in multiple lists
 * compounds, which is the intended behavior: a node both BM25 *and* vector
 * search agree on should outrank one only one of them found.
 */
export function reciprocalRankFusion(lists: readonly (readonly RankedItem[])[]): Map<string, number> {
  const scores = new Map<string, number>();

  for (const list of lists) {
    list.forEach((item, index) => {
      const contribution = 1 / (RRF_K + index + 1);
      scores.set(item.id, (scores.get(item.id) ?? 0) + contribution);
    });
  }

  return scores;
}

/**
 * Union two hit sets by id for a combined ranking pass.
 *
 * A vector-only match (found by semantic similarity, sharing no keywords
 * with the query at all) has no real BM25 rank -- it gets a placeholder
 * `rank` of 0, which is never read: once `relevanceScores` (from
 * `reciprocalRankFusion`) is passed to `rankHits`, the BM25-derived
 * relevance path is bypassed entirely for every hit in the set, fused or not.
 */
export function mergeSearchAndVectorHits(bm25Hits: readonly SearchHit[], vectorHits: readonly VectorHit[]): SearchHit[] {
  const byId = new Map<string, SearchHit>();

  for (const hit of bm25Hits) byId.set(hit.id, hit);

  for (const hit of vectorHits) {
    if (byId.has(hit.id)) continue;
    byId.set(hit.id, {
      id: hit.id,
      kind: hit.kind,
      ts: hit.ts,
      title: hit.title,
      body: hit.body,
      signal: hit.signal,
      provenance: hit.provenance,
      trustState: hit.trustState,
      rank: 0,
    });
  }

  return [...byId.values()];
}
