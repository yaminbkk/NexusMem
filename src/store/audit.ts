import type { Database } from 'better-sqlite3';

/**
 * A completed mutation, ready to record -- unlike `forget.ts`'s two-phase
 * insert (which needs a row id upfront for tombstones to reference via FK),
 * every caller here already knows its own outcome by the time it writes.
 */
export interface MutationAuditInput {
  action: string;
  projectId: string;
  /** JSON-serializable context (e.g. the sources/scope a prune touched). */
  detail: unknown;
  affectedCount: number;
  succeeded: boolean;
  error?: string | null;
  startedAt: number;
  finishedAt: number;
}

/**
 * Record one row in `mutation_audit`. `forget` already writes its own (it
 * needs the two-phase insert-then-update shape for the tombstone FK); this
 * is the same table for every other destructive/coarse operation --
 * currently `--prune-source`/`--prune-stale-shell`, which previously left no
 * record at all that a source-level delete had happened, flagged by an
 * external review (docs/forget-mechanism.md has the fuller history).
 */
export function recordMutationAudit(db: Database, input: MutationAuditInput): number {
  return Number(
    db
      .prepare(
        `INSERT INTO mutation_audit (action, project_id, detail, affected_count, succeeded, error, started_at, finished_at)
         VALUES (@action, @projectId, @detail, @affectedCount, @succeeded, @error, @startedAt, @finishedAt)`,
      )
      .run({
        action: input.action,
        projectId: input.projectId,
        detail: JSON.stringify(input.detail),
        affectedCount: input.affectedCount,
        succeeded: input.succeeded ? 1 : 0,
        error: input.error ?? null,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
      }).lastInsertRowid,
  );
}

/** One recorded mutation, newest first -- for a future `nexusmem audit` / `provenance` read path. */
export interface MutationAuditRow {
  id: number;
  action: string;
  projectId: string;
  detail: string;
  affectedCount: number;
  succeeded: boolean;
  error: string | null;
  startedAt: number;
  finishedAt: number;
}

export function listMutationAudit(db: Database, projectId: string, opts: { limit?: number } = {}): MutationAuditRow[] {
  const rows = db
    .prepare(
      `SELECT id, action, project_id AS projectId, detail, affected_count AS affectedCount,
              succeeded, error, started_at AS startedAt, finished_at AS finishedAt
       FROM mutation_audit
       WHERE project_id = @projectId
       ORDER BY started_at DESC
       LIMIT @limit`,
    )
    .all({ projectId, limit: opts.limit ?? 50 }) as Array<Omit<MutationAuditRow, 'succeeded'> & { succeeded: number }>;
  return rows.map((r) => ({ ...r, succeeded: r.succeeded === 1 }));
}
