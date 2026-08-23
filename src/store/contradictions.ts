import type { Database } from 'better-sqlite3';

/** One memoized SLM judgment on a (candidate, newer neighbour) pair. */
export interface ContradictionCheckInput {
  candidateId: string;
  againstId: string;
  contradicts: boolean;
  /** The model's one-line justification; only meaningful when `contradicts`. */
  reason: string | null;
  /** Ollama model tag that produced the verdict. */
  model: string;
}

/** A recorded YES verdict still awaiting a human's `mark-stale` decision. */
export interface ContradictionSuggestionRow {
  candidateId: string;
  candidateTitle: string;
  againstId: string;
  againstTitle: string;
  reason: string | null;
  checkedAt: number;
}

/**
 * Record a judgment either way -- a NO is as worth remembering as a YES,
 * since it is what lets the next sync skip re-asking the model about the
 * same pair. REPLACE keeps re-judging (e.g. with a different model) sane.
 */
export function recordContradictionCheck(db: Database, input: ContradictionCheckInput): void {
  db.prepare(
    `INSERT OR REPLACE INTO contradiction_checks (candidate_id, against_id, contradicts, reason, model, checked_at)
     VALUES (@candidateId, @againstId, @contradicts, @reason, @model, @now)`,
  ).run({
    candidateId: input.candidateId,
    againstId: input.againstId,
    contradicts: input.contradicts ? 1 : 0,
    reason: input.reason,
    model: input.model,
    now: Date.now(),
  });
}

/** Whether this exact pair has already been judged (either verdict). */
export function hasContradictionCheck(db: Database, candidateId: string, againstId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM contradiction_checks WHERE candidate_id = ? AND against_id = ?')
    .get(candidateId, againstId);
  return row !== undefined;
}

/**
 * Open YES verdicts for this project, newest judgment first. "Open" means
 * the candidate has not been superseded since -- once a human ran
 * `mark-stale`, the suggestion did its job and stops being listed -- and
 * has not been explicitly dismissed via {@link dismissContradictionSuggestion}.
 */
export function listContradictionSuggestions(
  db: Database,
  projectId: string,
  opts: { limit?: number } = {},
): ContradictionSuggestionRow[] {
  return db
    .prepare(
      `SELECT c.candidate_id AS candidateId, n.title AS candidateTitle,
              c.against_id AS againstId, a.title AS againstTitle,
              c.reason AS reason, c.checked_at AS checkedAt
       FROM contradiction_checks c
       JOIN nodes n ON n.id = c.candidate_id
       JOIN nodes a ON a.id = c.against_id
       WHERE n.project_id = @projectId AND c.contradicts = 1 AND c.dismissed = 0
         AND c.candidate_id NOT IN (SELECT supersedes FROM nodes WHERE project_id = @projectId AND supersedes IS NOT NULL)
       ORDER BY c.checked_at DESC
       LIMIT @limit`,
    )
    .all({ projectId, limit: opts.limit ?? 50 }) as ContradictionSuggestionRow[];
}

/** Same criteria as {@link listContradictionSuggestions}, but just the count -- for `status`. */
export function countContradictionSuggestions(db: Database, projectId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM contradiction_checks c
       JOIN nodes n ON n.id = c.candidate_id
       WHERE n.project_id = @projectId AND c.contradicts = 1 AND c.dismissed = 0
         AND c.candidate_id NOT IN (SELECT supersedes FROM nodes WHERE project_id = @projectId AND supersedes IS NOT NULL)`,
    )
    .get({ projectId }) as { count: number };
  return row.count;
}

/**
 * Reject every currently-open YES verdict for `candidateId` -- the fix for
 * "no rejection state" (flagged externally, see
 * docs/forget-mechanism.md-style writeups for the pattern): a suggestion the
 * reviewing human judges wrong stops resurfacing without pretending
 * `mark-stale` was run. Scoped through the same `nodes.project_id` join
 * `listContradictionSuggestions` uses, so an id from another project cannot
 * be dismissed by accident. Returns how many rows were actually flipped, so
 * the CLI can report "no open suggestion for that id" on 0.
 */
export function dismissContradictionSuggestion(db: Database, projectId: string, candidateId: string): number {
  return db
    .prepare(
      `UPDATE contradiction_checks
       SET dismissed = 1
       WHERE candidate_id = @candidateId AND contradicts = 1 AND dismissed = 0
         AND candidate_id IN (SELECT id FROM nodes WHERE project_id = @projectId)`,
    )
    .run({ projectId, candidateId }).changes;
}
