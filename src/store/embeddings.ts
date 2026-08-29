import type { Database } from 'better-sqlite3';
import type { NodeKind, Provenance, TrustState } from '../core/types.js';

export interface EmbeddableNode {
  rowid: number;
  id: string;
  title: string;
  body: string;
}

export interface VectorHit {
  id: string;
  kind: NodeKind;
  ts: string;
  title: string;
  body: string;
  signal: number;
  provenance: Provenance;
  trustState: TrustState;
  /** Euclidean distance from the query vector; lower is closer. */
  distance: number;
}

/**
 * Nodes for this project that have no embedding yet (new, or invalidated
 * by a content change).
 *
 * `afterRowid` makes paging monotonic: the pass walks rowids strictly
 * upward instead of re-reading "the first N still pending". That matters
 * because a node the provider *failed* on stays pending -- an offset-free
 * loop would fetch the same failures forever, which is exactly the shape
 * of an infinite sync.
 */
export function findNodesNeedingEmbedding(
  db: Database,
  projectId: string,
  limit = 200,
  afterRowid = 0,
): EmbeddableNode[] {
  return db
    .prepare(
      `SELECT n.rowid AS rowid, n.id AS id, n.title AS title, n.body AS body
       FROM nodes n
       LEFT JOIN nodes_vec v ON v.rowid = n.rowid
       WHERE n.project_id = ? AND v.rowid IS NULL AND n.rowid > ?
       ORDER BY n.rowid
       LIMIT ?`,
    )
    .all(projectId, afterRowid, limit) as EmbeddableNode[];
}

/** How many of this project's nodes still need a vector. For progress reporting. */
export function countNodesNeedingEmbedding(db: Database, projectId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM nodes n
       LEFT JOIN nodes_vec v ON v.rowid = n.rowid
       WHERE n.project_id = ? AND v.rowid IS NULL`,
    )
    .get(projectId) as { n: number };
  return row.n;
}

/** The stored vector for one node, or null if it has not been embedded yet. */
export function getEmbedding(db: Database, nodeId: string): Float32Array | null {
  const row = db
    .prepare('SELECT v.embedding AS embedding FROM nodes_vec v JOIN nodes n ON n.rowid = v.rowid WHERE n.id = ?')
    .get(nodeId) as { embedding: Buffer } | undefined;
  if (!row) return null;
  return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
}

export function upsertEmbedding(db: Database, rowid: number, projectId: string, embedding: Float32Array): void {
  db.prepare('INSERT OR REPLACE INTO nodes_vec (rowid, project_id, embedding) VALUES (?, ?, ?)').run(BigInt(rowid), projectId, embedding);
}

/**
 * Drop every vector in this database, across all projects.
 *
 * Whole-database on purpose: `nodes_vec` is shared and holds no
 * provenance, so once the vectors in it stopped being comparable there is
 * no subset that is still trustworthy. Nodes are untouched, so the next
 * embedding pass simply rebuilds them.
 */
export function dropAllEmbeddings(db: Database): number {
  return db.prepare('DELETE FROM nodes_vec').run().changes;
}

export interface VectorSearchOptions {
  /** Same record-time cutoff as `search`'s `asOfEpoch` -- see `SearchOptions`. */
  asOfEpoch?: number;
}

/**
 * Nearest-neighbour search over the corpus.
 *
 * `project_id` is a vec0 `PARTITION KEY` on `nodes_vec` (schema.ts's V11),
 * so `k` is computed *within* the project's own rows -- no cross-project
 * over-fetch-then-filter needed, and no risk of a sparse project's true
 * nearest neighbours falling outside an over-fetch window sized for a much
 * larger database. `created_at` isn't a partition column though (an
 * `--as-of` query is rare and per-query, not worth a second one), so that
 * path still over-fetches to compensate for rows the time filter drops
 * afterward -- the same heuristic this function used to need for both
 * dimensions, now needed for only one.
 */
export function vectorSearch(
  db: Database,
  projectId: string,
  embedding: Float32Array,
  limit = 20,
  opts: VectorSearchOptions = {},
): VectorHit[] {
  const asOfEpoch = opts.asOfEpoch ?? null;
  const k = asOfEpoch === null ? limit : Math.max(limit * 8, 50);
  return db
    .prepare(
      `SELECT n.id, n.kind, n.ts, n.title, n.body, n.signal, n.provenance, n.trust_state AS trustState, v.distance AS distance
       FROM nodes_vec v
       JOIN nodes n ON n.rowid = v.rowid
       WHERE v.embedding MATCH ? AND k = ? AND v.project_id = ?
         AND (? IS NULL OR n.created_at <= ?)
       ORDER BY v.distance
       LIMIT ?`,
    )
    .all(embedding, k, projectId, asOfEpoch, asOfEpoch, limit) as VectorHit[];
}
