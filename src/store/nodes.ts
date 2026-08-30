import type { Database } from 'better-sqlite3';
import { defaultProvenanceForKind, type MemoryNode, type NodeKind, type Provenance, type TrustState } from '../core/types.js';
import { firstMatchingEntry, listDenyListEntries, type DenyListEntry } from './deny-list.js';

export interface IngestStats {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Skipped because it matched an active deny-list entry -- see `forget`. */
  denied: number;
}

/** Enough of a node's content to pack it, without the `node_files`/`meta` join a full `MemoryNode` carries. */
export interface LinkedNode {
  id: string;
  kind: NodeKind;
  projectId: string;
  ts: string;
  title: string;
  body: string;
  signal: number;
  provenance: Provenance;
  trustState: TrustState;
}

/** Enough of a node to list it, without the `node_files`/`meta`/body a full `MemoryNode` carries. */
export interface RecentNode {
  id: string;
  kind: NodeKind;
  ts: string;
  source: string;
  title: string;
  signal: number;
  provenance: Provenance;
}

function epochOf(ts: string): number {
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * Write a batch of nodes in one transaction.
 *
 * Ids are content-addressed, so re-ingesting the same event is a no-op --
 * a node is only rewritten when the derived content actually changed (which
 * happens when scoring or body composition is improved between releases).
 */
export function upsertNodes(db: Database, nodes: readonly MemoryNode[]): IngestStats {
  const exists = db.prepare('SELECT body, signal, title FROM nodes WHERE id = ?');
  // vec0 has no triggers to keep itself in sync (see schema.ts) -- when a
  // node's indexed text actually changes, its old embedding is stale and
  // must be dropped so the embedding pass in vector/embed.ts re-embeds it.
  const dropStaleEmbedding = db.prepare('DELETE FROM nodes_vec WHERE rowid = (SELECT rowid FROM nodes WHERE id = ?)');
  // `supersedes` is deliberately absent from the ON CONFLICT SET clause: it's
  // set out-of-band by `nexusmem mark-stale` and a re-sync must not wipe it.
  const insertNode = db.prepare(
    `INSERT INTO nodes (id, kind, project_id, ts, ts_epoch, source, title, body, signal, meta, provenance, supersedes, created_at)
     VALUES (@id, @kind, @projectId, @ts, @tsEpoch, @source, @title, @body, @signal, @meta, @provenance, @supersedes, @now)
     ON CONFLICT(id) DO UPDATE SET
       ts = excluded.ts, ts_epoch = excluded.ts_epoch, source = excluded.source,
       title = excluded.title, body = excluded.body, signal = excluded.signal, meta = excluded.meta,
       provenance = excluded.provenance`,
  );
  const clearFiles = db.prepare('DELETE FROM node_files WHERE node_id = ?');
  const insertFile = db.prepare(
    `INSERT INTO node_files (node_id, path, previous_path, insertions, deletions, is_binary)
     VALUES (@nodeId, @path, @previousPath, @insertions, @deletions, @isBinary)
     ON CONFLICT(node_id, path) DO UPDATE SET
       previous_path = excluded.previous_path, insertions = excluded.insertions,
       deletions = excluded.deletions, is_binary = excluded.is_binary`,
  );

  const stats: IngestStats = { inserted: 0, updated: 0, unchanged: 0, denied: 0 };
  // Loaded lazily, once per distinct project id seen in the batch -- a
  // batch is almost always a single project's sync, so this is one query
  // in practice, not N.
  const denyEntriesByProject = new Map<string, DenyListEntry[]>();

  const run = db.transaction((batch: readonly MemoryNode[]) => {
    const now = Date.now();

    for (const node of batch) {
      let denyEntries = denyEntriesByProject.get(node.projectId);
      if (!denyEntries) {
        denyEntries = listDenyListEntries(db, node.projectId);
        denyEntriesByProject.set(node.projectId, denyEntries);
      }
      if (firstMatchingEntry(denyEntries, node)) {
        stats.denied += 1;
        continue;
      }

      const prior = exists.get(node.id) as { body: string; signal: number; title: string } | undefined;

      if (prior) {
        if (prior.body === node.body && prior.signal === node.signal && prior.title === node.title) {
          stats.unchanged += 1;
          continue;
        }
        stats.updated += 1;
        dropStaleEmbedding.run(node.id);
      } else {
        stats.inserted += 1;
      }

      insertNode.run({
        id: node.id,
        kind: node.kind,
        projectId: node.projectId,
        ts: node.ts,
        tsEpoch: epochOf(node.ts),
        source: node.source,
        title: node.title,
        body: node.body,
        signal: node.signal,
        meta: JSON.stringify(node.meta),
        provenance: node.provenance ?? defaultProvenanceForKind(node.kind),
        supersedes: node.supersedes ?? null,
        now,
      });

      clearFiles.run(node.id);
      for (const file of node.files) {
        insertFile.run({
          nodeId: node.id,
          path: file.path,
          previousPath: file.previousPath ?? null,
          insertions: file.insertions,
          deletions: file.deletions,
          isBinary: file.binary ? 1 : 0,
        });
      }
    }
  });

  run(nodes);
  return stats;
}

/**
 * The stored `meta` blob for one node, or null if it has never been
 * written. Used by the session summarizer to recognise work it has
 * already done without re-reading the node's whole body.
 */
export function getNodeMeta(db: Database, id: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT meta FROM nodes WHERE id = ?').get(id) as { meta: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.meta) as Record<string, unknown>;
  } catch {
    return null; // a meta blob we cannot read is treated as absent, never as a reason to fail a sync
  }
}

/** Drop every node for a project. Used by `sync --rebuild`. */
export function clearProject(db: Database, projectId: string): number {
  // nodes_vec has no FK/trigger relationship to nodes (see schema.ts) --
  // clean it up explicitly, before the rows it points at disappear.
  db.prepare('DELETE FROM nodes_vec WHERE rowid IN (SELECT rowid FROM nodes WHERE project_id = ?)').run(projectId);
  const info = db.prepare('DELETE FROM nodes WHERE project_id = ?').run(projectId);
  db.prepare('DELETE FROM sync_state WHERE project_id = ?').run(projectId);
  return info.changes;
}

/**
 * Hydrate full content for a set of node ids, e.g. to pack a linked
 * resolution alongside the failure node that points at it. Order is not
 * guaranteed to match `ids`; ids with no matching row are silently omitted
 * rather than erroring. `node_links` has `ON DELETE CASCADE` on both
 * columns, so an individual node delete (e.g. `reconcile.ts` migrating a
 * node to a freshly-computed id) removes any link pointing at the old id
 * along with it -- correct as a safety default, though note that reconcile
 * does not currently re-create the link under the migrated node's new id;
 * that gap is not addressed here.
 */
export function getNodesByIds(db: Database, ids: readonly string[]): LinkedNode[] {
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT id, kind, project_id AS projectId, ts, title, body, signal, provenance, trust_state AS trustState
       FROM nodes WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids)) as LinkedNode[];
}

/**
 * The most recently-remembered nodes for a project, newest event first --
 * chronology, not relevance. No `body`: a listing (e.g. a sidebar) needs
 * the title and enough metadata to label each row, not the full text.
 * `idx_nodes_project_ts` already exists for exactly this access pattern.
 */
export function listRecentNodes(db: Database, projectId: string, limit = 20): RecentNode[] {
  return db
    .prepare(
      `SELECT id, kind, ts, source, title, signal, provenance
       FROM nodes
       WHERE project_id = ?
       ORDER BY ts_epoch DESC
       LIMIT ?`,
    )
    .all(projectId, limit) as RecentNode[];
}

/** How many nodes of one source exist for a project. Used to preview a `pruneSourceNodes` wipe before running it. */
export function countSourceNodes(db: Database, projectId: string, source: string): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE project_id = ? AND source = ?').get(
    projectId,
    source,
  ) as { count: number };
  return row.count;
}

/**
 * Delete the nodes of one source that its latest full scan did not produce.
 *
 * Needed by any source whose node ids are derived from content that can be
 * *edited in place* rather than only appended to. A `doc_section` id comes
 * from `path + heading slug`, so renaming a markdown heading mints a new node
 * and strands the old one: `sync` reports `+1 new`, and the corpus then holds
 * two contradictory versions of the same section, both of which come back for
 * the same query. Git and shell nodes describe events that already happened
 * and are never restated, so they have nothing to prune.
 *
 * Scoping is the whole safety story here, and it is deliberately narrow:
 *
 * - `project_id` -- never reaches another repository's memory.
 * - `source` -- an exact match on the collector's own key, so pruning `docs`
 *   cannot touch `conversation:claude-code`, `shell:pwsh` or `git` nodes even
 *   though they share the table.
 * - `keepIds` -- everything this scan produced.
 * - `keepPaths` -- files the scan could not read. Their nodes are kept
 *   because an unreadable file is not evidence that its sections are gone.
 *
 * Callers must pass the ids from a *complete* scan of the source. A partial
 * or filtered scan would read as "these nodes no longer exist" and delete
 * real history.
 */
export function pruneSourceNodes(
  db: Database,
  projectId: string,
  source: string,
  keepIds: readonly string[],
  opts: { keepPaths?: readonly string[] } = {},
): number {
  // json_each keeps this one statement regardless of how many sections a
  // repo has, instead of an id list that grows into SQLite's parameter cap.
  const scope = `project_id = @projectId AND source = @source
      AND id NOT IN (SELECT value FROM json_each(@keepIds))
      AND id NOT IN (SELECT node_id FROM node_files WHERE path IN (SELECT value FROM json_each(@keepPaths)))`;

  const params = {
    projectId,
    source,
    keepIds: JSON.stringify(keepIds),
    keepPaths: JSON.stringify(opts.keepPaths ?? []),
  };

  return db.transaction(() => {
    // Same ordering constraint as clearProject: nodes_vec is not reachable by
    // FK or trigger, so its rows must go while their rowids still resolve.
    // nodes_fts *is* trigger-backed (schema.ts) and cleans itself up on
    // DELETE, and node_files cascades.
    db.prepare(`DELETE FROM nodes_vec WHERE rowid IN (SELECT rowid FROM nodes WHERE ${scope})`).run(params);
    return db.prepare(`DELETE FROM nodes WHERE ${scope}`).run(params).changes;
  })();
}

/** The project a node belongs to, or null if no node has this id. Used by `mark-stale` to validate both ids. */
export function getNodeProjectId(db: Database, id: string): string | null {
  const row = db.prepare('SELECT project_id FROM nodes WHERE id = ?').get(id) as { project_id: string } | undefined;
  return row?.project_id ?? null;
}

/** Every node id some other node's `supersedes` points at, for one project -- what the ranker should down-weight. */
export function getSupersededIds(db: Database, projectId: string): Set<string> {
  const rows = db
    .prepare('SELECT DISTINCT supersedes AS id FROM nodes WHERE project_id = ? AND supersedes IS NOT NULL')
    .all(projectId) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** Record that `newNodeId` supersedes `staleNodeId` -- the write behind `nexusmem mark-stale`. Caller validates both ids first. */
export function setSupersedes(db: Database, newNodeId: string, staleNodeId: string): void {
  db.prepare('UPDATE nodes SET supersedes = ? WHERE id = ?').run(staleNodeId, newNodeId);
}

/** Record a human's verdict on one node -- the write behind `nexusmem review`. Caller validates project ownership first. Returns whether a row actually matched. */
export function setTrustState(db: Database, nodeId: string, state: 'verified' | 'rejected'): boolean {
  return db.prepare('UPDATE nodes SET trust_state = ? WHERE id = ?').run(state, nodeId).changes > 0;
}

/** A non-`observed` node old enough to be a candidate for `nexusmem mark-stale`, oldest first. */
export interface StaleCandidate {
  id: string;
  kind: NodeKind;
  ts: string;
  source: string;
  title: string;
  ageDays: number;
}

/**
 * Heuristic surfacing only, not contradiction detection: every non-`observed`
 * node past `minAgeDays` that nothing already supersedes. A human still
 * decides whether it's actually stale and runs `mark-stale` themselves.
 */
export function listStaleCandidates(
  db: Database,
  projectId: string,
  opts: { now?: Date; minAgeDays?: number; limit?: number } = {},
): StaleCandidate[] {
  const now = opts.now ?? new Date();
  const minAgeDays = opts.minAgeDays ?? 45;
  const cutoff = now.getTime() - minAgeDays * 86_400_000;

  const rows = db
    .prepare(
      `SELECT id, kind, ts, ts_epoch AS tsEpoch, source, title
       FROM nodes
       WHERE project_id = @projectId AND provenance != 'observed' AND ts_epoch < @cutoff
         AND id NOT IN (SELECT supersedes FROM nodes WHERE project_id = @projectId AND supersedes IS NOT NULL)
       ORDER BY ts_epoch ASC
       LIMIT @limit`,
    )
    .all({ projectId, cutoff, limit: opts.limit ?? 50 }) as Array<{
    id: string;
    kind: NodeKind;
    ts: string;
    tsEpoch: number;
    source: string;
    title: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    ts: r.ts,
    source: r.source,
    title: r.title,
    ageDays: Math.round((now.getTime() - r.tsEpoch) / 86_400_000),
  }));
}

/**
 * Bump retrieval bookkeeping for nodes that were actually packed into a
 * query's returned context (see `packContext`) -- called once per completed
 * `runHybridQuery`/`runCrossProjectQuery`, the one pipeline both `nexusmem
 * query` and the MCP `search_memory` tool share, so both stay covered from
 * one call site. `retrieved_count`/`last_retrieved_at` (schema V12) are
 * intentionally not read by `rank.ts`'s score formula; see that migration's
 * comment for why folding this into ranking is a separate, deferred step.
 */
export function recordRetrievals(db: Database, ids: readonly string[]): void {
  if (ids.length === 0) return;
  db.prepare(
    `UPDATE nodes SET retrieved_count = retrieved_count + 1, last_retrieved_at = @now
     WHERE id IN (SELECT value FROM json_each(@ids))`,
  ).run({ now: Date.now(), ids: JSON.stringify(ids) });
}

/** Retrieval bookkeeping for one node, or null if it doesn't exist. Read-side for `recordRetrievals`, mainly for tests. */
export function getRetrievalStats(db: Database, id: string): { retrievedCount: number; lastRetrievedAt: number | null } | null {
  const row = db.prepare('SELECT retrieved_count AS retrievedCount, last_retrieved_at AS lastRetrievedAt FROM nodes WHERE id = ?').get(
    id,
  ) as { retrievedCount: number; lastRetrievedAt: number | null } | undefined;
  return row ?? null;
}

/** Same criteria as {@link listStaleCandidates}, but just the count -- for `status`'s summary line. */
export function countStaleCandidates(db: Database, projectId: string, opts: { now?: Date; minAgeDays?: number } = {}): number {
  const now = opts.now ?? new Date();
  const minAgeDays = opts.minAgeDays ?? 45;
  const cutoff = now.getTime() - minAgeDays * 86_400_000;

  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM nodes
       WHERE project_id = @projectId AND provenance != 'observed' AND ts_epoch < @cutoff
         AND id NOT IN (SELECT supersedes FROM nodes WHERE project_id = @projectId AND supersedes IS NOT NULL)`,
    )
    .get({ projectId, cutoff }) as { count: number };
  return row.count;
}
