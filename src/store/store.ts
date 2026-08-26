import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import type { MemoryNode } from '../core/types.js';
import type { FileEdge } from '../structure/types.js';
import type { DenyListEntry, DenyListInput } from './deny-list.js';
import { migrate } from './schema.js';
import { listMutationAudit, recordMutationAudit, type MutationAuditInput, type MutationAuditRow } from './audit.js';
import {
  countProjectNodes,
  getSyncCursor,
  listOtherProjectIds,
  listSyncState,
  markSynced,
  setSyncCursor,
  upsertProject,
  type ProjectRecord,
} from './projects.js';
import {
  clearProject,
  countSourceNodes,
  getNodeMeta,
  getNodeProjectId,
  countStaleCandidates,
  getNodesByIds,
  getSupersededIds,
  listRecentNodes,
  listStaleCandidates,
  pruneSourceNodes,
  setSupersedes,
  setTrustState,
  upsertNodes,
  type IngestStats,
  type LinkedNode,
  type RecentNode,
  type StaleCandidate,
} from './nodes.js';
import { getLinkedNodeIds, linkNodes } from './links.js';
import {
  forget,
  importDenyList,
  listDenyList,
  previewForget,
  previewImportDenyList,
  type ForgetPreview,
  type ForgetResult,
  type ImportDenyListResult,
  type ImportPreviewItem,
} from './forget.js';
import { fileEdgeStats, replaceFileEdges } from './file-edges.js';
import {
  countNodesNeedingEmbedding,
  dropAllEmbeddings,
  findNodesNeedingEmbedding,
  getEmbedding,
  upsertEmbedding,
  vectorSearch,
  type EmbeddableNode,
  type VectorHit,
} from './embeddings.js';
import { search, stats, type SearchHit, type StoreStats } from './search.js';
import { getMeta, setMeta } from './meta.js';
import {
  countContradictionSuggestions,
  dismissContradictionSuggestion,
  hasContradictionCheck,
  listContradictionSuggestions,
  recordContradictionCheck,
  type ContradictionCheckInput,
  type ContradictionSuggestionRow,
} from './contradictions.js';

export type { ProjectRecord } from './projects.js';
export type { IngestStats, LinkedNode, RecentNode, StaleCandidate } from './nodes.js';
export type { ForgetPreview, ForgetResult, ImportDenyListResult, ImportPreviewItem } from './forget.js';
export type { EmbeddableNode, VectorHit } from './embeddings.js';
export type { SearchHit, StoreStats } from './search.js';
export type { ContradictionCheckInput, ContradictionSuggestionRow } from './contradictions.js';

export class MemoryStore {
  private constructor(private readonly db: Database.Database) {}

  static open(dbPath: string): MemoryStore {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);

    // WAL lets a long `sync` write while an agent reads via `query`.
    db.pragma('journal_mode = WAL');
    // NORMAL is the right durability trade for a rebuildable derived index:
    // worst case after a crash we re-run sync, which is idempotent anyway.
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    // Must load before migrate(): the nodes_vec migration's CREATE VIRTUAL
    // TABLE ... USING vec0 needs the module registered first.
    sqliteVec.load(db);

    migrate(db);
    return new MemoryStore(db);
  }

  close(): void {
    this.db.close();
  }

  upsertProject(project: ProjectRecord): void {
    upsertProject(this.db, project);
  }

  markSynced(projectId: string): void {
    markSynced(this.db, projectId);
  }

  listOtherProjectIds(currentProjectId: string): string[] {
    return listOtherProjectIds(this.db, currentProjectId);
  }

  /** Total nodes held under the given project identities. */
  countProjectNodes(projectIds: readonly string[]): number {
    return countProjectNodes(this.db, projectIds);
  }

  /**
   * Write a batch of nodes in one transaction.
   *
   * Ids are content-addressed, so re-ingesting the same event is a no-op --
   * a node is only rewritten when the derived content actually changed (which
   * happens when scoring or body composition is improved between releases).
   */
  upsertNodes(nodes: readonly MemoryNode[]): IngestStats {
    return upsertNodes(this.db, nodes);
  }

  /**
   * The stored `meta` blob for one node, or null if it has never been
   * written. Used by the session summarizer to recognise work it has
   * already done without re-reading the node's whole body.
   */
  getNodeMeta(id: string): Record<string, unknown> | null {
    return getNodeMeta(this.db, id);
  }

  getSyncCursor(projectId: string, source: string): string | null {
    return getSyncCursor(this.db, projectId, source);
  }

  setSyncCursor(projectId: string, source: string, cursor: string | null): void {
    setSyncCursor(this.db, projectId, source, cursor);
  }

  /** Every source that has ever synced for this project, most recently run first. */
  listSyncState(projectId: string): Array<{ source: string; cursor: string | null; lastRunAt: number | null }> {
    return listSyncState(this.db, projectId);
  }

  /** Drop every node for a project. Used by `sync --rebuild`. */
  clearProject(projectId: string): number {
    return clearProject(this.db, projectId);
  }

  linkNodes(fromNodeId: string, toNodeId: string, relation: string): void {
    linkNodes(this.db, fromNodeId, toNodeId, relation);
  }

  /** Ids linked from `fromNodeId` under one relation, most recently linked first. Empty if none exist. */
  getLinkedNodeIds(fromNodeId: string, relation: string): string[] {
    return getLinkedNodeIds(this.db, fromNodeId, relation);
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
  getNodesByIds(ids: readonly string[]): LinkedNode[] {
    return getNodesByIds(this.db, ids);
  }

  /**
   * The most recently-remembered nodes for a project, newest event first --
   * chronology, not relevance. No `body`: a listing (e.g. a sidebar) needs
   * the title and enough metadata to label each row, not the full text.
   * `idx_nodes_project_ts` already exists for exactly this access pattern.
   */
  listRecentNodes(projectId: string, limit = 20): RecentNode[] {
    return listRecentNodes(this.db, projectId, limit);
  }

  /** How many nodes of one source exist for a project. Used to preview a `pruneSourceNodes` wipe before running it. */
  countSourceNodes(projectId: string, source: string): number {
    return countSourceNodes(this.db, projectId, source);
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
  pruneSourceNodes(
    projectId: string,
    source: string,
    keepIds: readonly string[],
    opts: { keepPaths?: readonly string[] } = {},
  ): number {
    return pruneSourceNodes(this.db, projectId, source, keepIds, opts);
  }

  previewForget(projectId: string, otherProjectIds: readonly string[], input: DenyListInput): ForgetPreview[] {
    return previewForget(this.db, projectId, otherProjectIds, input);
  }

  forget(projectId: string, otherProjectIds: readonly string[], input: DenyListInput): ForgetResult {
    return forget(this.db, projectId, otherProjectIds, input);
  }

  /** Active deny-list entries for one project, oldest first. */
  listDenyList(projectId: string): DenyListEntry[] {
    return listDenyList(this.db, projectId);
  }

  previewImportDenyList(
    projectId: string,
    otherProjectIds: readonly string[],
    entries: readonly DenyListInput[],
  ): ImportPreviewItem[] {
    return previewImportDenyList(this.db, projectId, otherProjectIds, entries);
  }

  importDenyList(
    projectId: string,
    otherProjectIds: readonly string[],
    entries: readonly DenyListInput[],
  ): ImportDenyListResult {
    return importDenyList(this.db, projectId, otherProjectIds, entries);
  }

  replaceFileEdges(projectId: string, edges: readonly FileEdge[]): void {
    replaceFileEdges(this.db, projectId, edges);
  }

  /** Edge count + distinct source-file count, for `nexusmem status`'s `structure` line. */
  fileEdgeStats(projectId: string): { edges: number; files: number } {
    return fileEdgeStats(this.db, projectId);
  }

  findNodesNeedingEmbedding(projectId: string, limit = 200, afterRowid = 0): EmbeddableNode[] {
    return findNodesNeedingEmbedding(this.db, projectId, limit, afterRowid);
  }

  /** How many of this project's nodes still need a vector. For progress reporting. */
  countNodesNeedingEmbedding(projectId: string): number {
    return countNodesNeedingEmbedding(this.db, projectId);
  }

  upsertEmbedding(rowid: number, embedding: Float32Array): void {
    upsertEmbedding(this.db, rowid, embedding);
  }

  /** The stored vector for one node, or null if it has not been embedded yet. */
  getEmbedding(nodeId: string): Float32Array | null {
    return getEmbedding(this.db, nodeId);
  }

  dropAllEmbeddings(): number {
    return dropAllEmbeddings(this.db);
  }

  getMeta(key: string): string | null {
    return getMeta(this.db, key);
  }

  setMeta(key: string, value: string): void {
    setMeta(this.db, key, value);
  }

  vectorSearch(projectId: string, embedding: Float32Array, limit = 20): VectorHit[] {
    return vectorSearch(this.db, projectId, embedding, limit);
  }

  stats(projectId: string): StoreStats {
    return stats(this.db, projectId);
  }

  search(projectId: string, query: string, limit = 20): SearchHit[] {
    return search(this.db, projectId, query, limit);
  }

  /** The project a node belongs to, or null if no node has this id. Used by `mark-stale` to validate both ids. */
  getNodeProjectId(id: string): string | null {
    return getNodeProjectId(this.db, id);
  }

  /** Every node id some other node's `supersedes` points at, for one project -- what the ranker should down-weight. */
  getSupersededIds(projectId: string): Set<string> {
    return getSupersededIds(this.db, projectId);
  }

  /** Record that `newNodeId` supersedes `staleNodeId` -- the write behind `nexusmem mark-stale`. Caller validates both ids first. */
  setSupersedes(newNodeId: string, staleNodeId: string): void {
    setSupersedes(this.db, newNodeId, staleNodeId);
  }

  /** Record a human's verdict on one node -- the write behind `nexusmem review`. Caller validates project ownership first. */
  setTrustState(nodeId: string, state: 'verified' | 'rejected'): boolean {
    return setTrustState(this.db, nodeId, state);
  }

  /** Aging non-`observed` nodes nothing supersedes yet -- candidates for `nexusmem mark-stale`, not auto-applied. */
  listStaleCandidates(projectId: string, opts: { now?: Date; minAgeDays?: number; limit?: number } = {}): StaleCandidate[] {
    return listStaleCandidates(this.db, projectId, opts);
  }

  /** Same criteria as `listStaleCandidates`, but just the count -- for `status`'s summary line. */
  countStaleCandidates(projectId: string, opts: { now?: Date; minAgeDays?: number } = {}): number {
    return countStaleCandidates(this.db, projectId, opts);
  }

  /** Memoize one SLM contradiction judgment (either verdict). Suggest-only: never writes `supersedes`. */
  recordContradictionCheck(input: ContradictionCheckInput): void {
    recordContradictionCheck(this.db, input);
  }

  hasContradictionCheck(candidateId: string, againstId: string): boolean {
    return hasContradictionCheck(this.db, candidateId, againstId);
  }

  /** Open YES verdicts awaiting a human's `mark-stale`, newest judgment first. */
  listContradictionSuggestions(projectId: string, opts: { limit?: number } = {}): ContradictionSuggestionRow[] {
    return listContradictionSuggestions(this.db, projectId, opts);
  }

  countContradictionSuggestions(projectId: string): number {
    return countContradictionSuggestions(this.db, projectId);
  }

  /** Reject every open suggestion for this candidate; returns how many were actually dismissed. */
  dismissContradictionSuggestion(projectId: string, candidateId: string): number {
    return dismissContradictionSuggestion(this.db, projectId, candidateId);
  }

  /** Record one `mutation_audit` row for a coarse/destructive operation outside `forget` (currently: `--prune-source`/`--prune-stale-shell`). */
  recordMutationAudit(input: MutationAuditInput): number {
    return recordMutationAudit(this.db, input);
  }

  /** Newest-first `mutation_audit` rows for this project -- every `forget` and `--prune-source` run, whether or not anything matched. */
  listMutationAudit(projectId: string, opts: { limit?: number } = {}): MutationAuditRow[] {
    return listMutationAudit(this.db, projectId, opts);
  }

  /** Escape hatch for tests and future modules. */
  get raw(): Database.Database {
    return this.db;
  }
}
