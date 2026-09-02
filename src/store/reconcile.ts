import type { Database as DB } from 'better-sqlite3';
import { makeNodeId, sha256Hex } from '../core/ids.js';
import type { NodeKind } from '../core/types.js';
import { firstMatchingEntry, listDenyListEntries, type DenyListEntry } from './deny-list.js';

interface StoredNodeRow {
  id: string;
  kind: string;
  project_id: string;
  ts: string;
  ts_epoch: number;
  source: string;
  title: string;
  body: string;
  signal: number;
  meta: string;
  created_at: number;
}

interface StoredFileRow {
  path: string;
  previous_path: string | null;
  insertions: number | null;
  deletions: number | null;
  is_binary: number;
}

export interface ProjectIdReconcileResult {
  oldProjectId: string;
  /** Rows re-inserted under a freshly recomputed id -- genuinely new content. */
  migrated: number;
  /** Rows reassigned to the new project id in place, keeping their existing id. */
  reassigned: number;
  /** Rows dropped because an equivalent row already exists under the new id. */
  deduped: number;
  /** Rows left untouched under the old id -- their natural key can't be reconstructed. */
  skipped: number;
  /** Rows dropped instead of carried forward because they match an active deny-list entry. */
  denied: number;
}

function recomputeByNaturalKey(
  db: DB,
  oldProjectId: string,
  newProjectId: string,
  kind: NodeKind,
  source: string | null,
  computeNaturalKey: (row: StoredNodeRow, meta: Record<string, unknown>) => string | null,
  denyEntries: readonly DenyListEntry[],
): { migrated: number; deduped: number; skipped: number; denied: number } {
  const rows = (
    source
      ? db.prepare('SELECT * FROM nodes WHERE project_id = ? AND kind = ? AND source = ?').all(oldProjectId, kind, source)
      : db.prepare('SELECT * FROM nodes WHERE project_id = ? AND kind = ?').all(oldProjectId, kind)
  ) as StoredNodeRow[];

  const nodeExists = db.prepare('SELECT 1 FROM nodes WHERE id = ?');
  const insertNode = db.prepare(
    `INSERT INTO nodes (id, kind, project_id, ts, ts_epoch, source, title, body, signal, meta, created_at)
     VALUES (@id, @kind, @projectId, @ts, @tsEpoch, @source, @title, @body, @signal, @meta, @createdAt)`,
  );
  const readFiles = db.prepare('SELECT path, previous_path, insertions, deletions, is_binary FROM node_files WHERE node_id = ?');
  const insertFile = db.prepare(
    `INSERT INTO node_files (node_id, path, previous_path, insertions, deletions, is_binary)
     VALUES (@nodeId, @path, @previousPath, @insertions, @deletions, @isBinary)`,
  );
  const dropEmbedding = db.prepare('DELETE FROM nodes_vec WHERE rowid = (SELECT rowid FROM nodes WHERE id = ?)');
  const deleteNode = db.prepare('DELETE FROM nodes WHERE id = ?');

  let migrated = 0;
  let deduped = 0;
  let skipped = 0;
  let denied = 0;

  for (const row of rows) {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.meta) as Record<string, unknown>;
    } catch {
      skipped += 1;
      continue;
    }

    const naturalKey = computeNaturalKey(row, meta);
    if (naturalKey === null) {
      skipped += 1;
      continue;
    }

    if (firstMatchingEntry(denyEntries, { title: row.title, body: row.body, meta })) {
      dropEmbedding.run(row.id);
      deleteNode.run(row.id);
      denied += 1;
      continue;
    }

    const newId = makeNodeId(newProjectId, kind, naturalKey);

    if (nodeExists.get(newId)) {
      deduped += 1;
    } else {
      insertNode.run({
        id: newId,
        kind: row.kind,
        projectId: newProjectId,
        ts: row.ts,
        tsEpoch: row.ts_epoch,
        source: row.source,
        title: row.title,
        body: row.body,
        signal: row.signal,
        meta: row.meta,
        createdAt: row.created_at,
      });
      for (const file of readFiles.all(row.id) as StoredFileRow[]) {
        insertFile.run({
          nodeId: newId,
          path: file.path,
          previousPath: file.previous_path,
          insertions: file.insertions,
          deletions: file.deletions,
          isBinary: file.is_binary,
        });
      }
      migrated += 1;
    }

    dropEmbedding.run(row.id);
    deleteNode.run(row.id); // cascades node_files; nodes_fts cleans itself via its own AFTER DELETE trigger
  }

  return { migrated, deduped, skipped, denied };
}

/**
 * Bring nodes stranded under a previous project id forward to the current one.
 *
 * `makeProjectId` (core/project.ts) is derived from the repo's git remote URL
 * on purpose, so the same repo re-cloned to a new path or machine keeps
 * sharing memory. The case that design doesn't cover is the mirror one: the
 * path stays put but the remote URL changes (a GitHub rename, an org
 * transfer) -- which silently mints a *different* id and strands every node
 * synced under the old one, invisible to every future `status`/`query`/MCP
 * call even though it is still sitting in the same `memory.db` file. Found
 * live 2026-08-15 after this repo's own GitHub account was renamed: 903
 * nodes went dark this way.
 *
 * Only kinds whose original natural key survives in what's already stored
 * are recomputed and re-inserted (`session_summary` via `meta.sessionKey`;
 * hook-sourced `shell_command` via `ts` + `meta.command`, matching
 * `shell/detect.ts`'s `<shell>-hook:${ts}:${sha256(command)}` scheme -- one
 * recompute pass per live hook source, since pwsh/bash/zsh each write their
 * own `shell:<kind>-hook` source string).
 * `conversation_turn`'s natural key embeds a transcript UUID that is never
 * persisted on the node, so it can't be recomputed -- those rows are instead
 * reassigned to the new project id in place, keeping their existing id.
 *
 * Deliberately NOT migrated:
 * - `git_commit` / `code_diff`: git history is immutable, so a normal `sync`
 *   already re-derives every commit and diff under the new id. A stale copy
 *   under the old id carries no information a fresh sync doesn't already
 *   have, so replaying the id scheme (just the commit sha) buys nothing.
 * - `doc_section`: current file content is always fully rescanned, so a
 *   fresh sync already reproduces every section still present in the repo.
 *   Migrating would mean replaying `docs.ts`'s slug+occurrence scheme for
 *   sections that (empirically, checked live) always turned out to already
 *   be present under the new id anyway.
 * - Pre-hook shell scrape sources (`shell:pwsh`, `shell:bash`, `shell:zsh`):
 *   their natural key includes a scrape-time list position that was never
 *   stored, so it cannot be reconstructed. This is also already-known dead
 *   noise the project intends to prune separately -- see nexusmem-constraints
 *   in the maintainer's notes -- so leaving it under the now-inert old id is
 *   no different in effect from pruning it.
 */
export function reconcileProjectId(db: DB, oldProjectId: string, newProjectId: string): ProjectIdReconcileResult {
  return db.transaction((): ProjectIdReconcileResult => {
    // Scoped to newProjectId (the destination): a row denied here must never
    // land under the id reconcile is migrating things *into*.
    const denyEntries = listDenyListEntries(db, newProjectId);

    const sessions = recomputeByNaturalKey(
      db,
      oldProjectId,
      newProjectId,
      'session_summary',
      null,
      (_row, meta) => (typeof meta.sessionKey === 'string' ? meta.sessionKey : null),
      denyEntries,
    );

    // One entry per live shell hook -- each writes its own `shell:<kind>-hook`
    // source and naturalKey prefix (see src/shell/detect.ts's hookEntryToRaw),
    // so each needs its own recompute pass rather than one hardcoded to
    // PowerShell's alone.
    const HOOK_SHELL_SOURCES = [
      { source: 'shell:pwsh-hook', prefix: 'pwsh-hook' },
      { source: 'shell:bash-hook', prefix: 'bash-hook' },
      { source: 'shell:zsh-hook', prefix: 'zsh-hook' },
    ] as const;

    const hookShell = { migrated: 0, deduped: 0, skipped: 0, denied: 0 };
    for (const { source, prefix } of HOOK_SHELL_SOURCES) {
      const r = recomputeByNaturalKey(
        db,
        oldProjectId,
        newProjectId,
        'shell_command',
        source,
        (row, meta) => (typeof meta.command === 'string' ? `${prefix}:${row.ts}:${sha256Hex(meta.command).slice(0, 12)}` : null),
        denyEntries,
      );
      hookShell.migrated += r.migrated;
      hookShell.deduped += r.deduped;
      hookShell.skipped += r.skipped;
      hookShell.denied += r.denied;
    }

    // conversation_turn rows are reassigned in place by the UPDATE below,
    // not re-inserted through recomputeByNaturalKey -- a denied row would
    // otherwise sail through that UPDATE untouched. Delete matches first,
    // so the UPDATE simply finds nothing left to reassign for them.
    let deniedConversationTurns = 0;
    if (denyEntries.length > 0) {
      const conversationTurns = db
        .prepare(`SELECT id, title, body, meta FROM nodes WHERE project_id = ? AND kind = 'conversation_turn'`)
        .all(oldProjectId) as Array<{ id: string; title: string; body: string; meta: string }>;

      if (conversationTurns.length > 0) {
        const dropEmbedding = db.prepare('DELETE FROM nodes_vec WHERE rowid = (SELECT rowid FROM nodes WHERE id = ?)');
        const deleteNode = db.prepare('DELETE FROM nodes WHERE id = ?');

        for (const row of conversationTurns) {
          let meta: unknown;
          try {
            meta = JSON.parse(row.meta);
          } catch {
            meta = {};
          }
          if (firstMatchingEntry(denyEntries, { title: row.title, body: row.body, meta })) {
            dropEmbedding.run(row.id);
            deleteNode.run(row.id);
            deniedConversationTurns += 1;
          }
        }
      }
    }

    const reassigned = db
      .prepare(`UPDATE nodes SET project_id = ? WHERE project_id = ? AND kind = 'conversation_turn'`)
      .run(newProjectId, oldProjectId).changes;

    return {
      oldProjectId,
      migrated: sessions.migrated + hookShell.migrated,
      reassigned,
      deduped: sessions.deduped + hookShell.deduped,
      skipped: sessions.skipped + hookShell.skipped,
      denied: sessions.denied + hookShell.denied + deniedConversationTurns,
    };
  })();
}
