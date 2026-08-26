import type { Database } from 'better-sqlite3';
import type { NodeKind, Provenance, TrustState } from '../core/types.js';
import { toMatchQuery } from './fts.js';

export interface SearchHit {
  id: string;
  kind: NodeKind;
  ts: string;
  title: string;
  body: string;
  signal: number;
  provenance: Provenance;
  trustState: TrustState;
  /** bm25 score; lower is a better lexical match. */
  rank: number;
  /**
   * Human-readable name of the project this hit came from.
   *
   * Never set by the store, which is always querying one project and has
   * nothing to disambiguate. The cross-project pipeline attaches it so a
   * packed context block can say which repository each line is from.
   */
  project?: string;
}

interface NodeRow {
  id: string;
  kind: NodeKind;
  ts: string;
  title: string;
  body: string;
  signal: number;
  provenance: Provenance;
  trustState: TrustState;
  rank: number;
}

export interface StoreStats {
  total: number;
  byKind: Record<string, number>;
  oldest: string | null;
  newest: string | null;
  distinctFiles: number;
}

/**
 * Lexical search over the corpus.
 *
 * Title is weighted 10x body: a commit subject that names the thing you asked
 * about is far stronger evidence than the same word buried in a file list.
 * Ranking by `relevance x signal` happens a layer up, in retrieval.
 */
export function search(db: Database, projectId: string, query: string, limit = 20): SearchHit[] {
  const match = toMatchQuery(query);
  if (!match) return [];

  const rows = db
    .prepare(
      `SELECT n.id, n.kind, n.ts, n.title, n.body, n.signal, n.provenance, n.trust_state AS trustState,
              bm25(nodes_fts, 10.0, 1.0) AS rank
       FROM nodes_fts
       JOIN nodes n ON n.rowid = nodes_fts.rowid
       WHERE nodes_fts MATCH ? AND n.project_id = ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(match, projectId, limit) as NodeRow[];

  return rows;
}

export function stats(db: Database, projectId: string): StoreStats {
  const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM nodes WHERE project_id = ? GROUP BY kind').all(projectId) as Array<{
    kind: string;
    n: number;
  }>;

  const range = db.prepare('SELECT MIN(ts) AS oldest, MAX(ts) AS newest FROM nodes WHERE project_id = ?').get(projectId) as {
    oldest: string | null;
    newest: string | null;
  };

  const files = db
    .prepare(
      `SELECT COUNT(DISTINCT f.path) AS n
       FROM node_files f JOIN nodes n ON n.id = f.node_id
       WHERE n.project_id = ?`,
    )
    .get(projectId) as { n: number };

  return {
    total: kinds.reduce((sum, k) => sum + k.n, 0),
    byKind: Object.fromEntries(kinds.map((k) => [k.kind, k.n])),
    oldest: range.oldest,
    newest: range.newest,
    distinctFiles: files.n,
  };
}
