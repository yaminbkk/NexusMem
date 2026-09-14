import { REDACTION_MARK } from '../conversation/redact.js';
import { RESOLVED_BY_DISCUSSION, RESOLVED_BY_RETRY } from '../correlate/failure-fix.js';
import type { MemoryStore } from '../store/store.js';

/**
 * Looks up what already happened the last time this exact command failed in
 * this repository, and renders it for an agent to read.
 *
 * Deliberately narrow. It matches on `execHash` -- the hash of the raw
 * command reduced to its one real execution, with navigation and
 * observation segments around it dropped (see `canonicalizeCommand` in
 * `agent/event.ts`), so two redacted commands that render the same text can
 * never be confused, and a live `cd "<cwd>" && ls && npm test; echo "exit:
 * $?"` still finds a historical bare `npm test` -- and returns nothing at
 * all when there is no match. Silence is the default, and no model,
 * embedding or network call is on this path.
 */

/** ~300 tokens. An injection that grows past this stops being cheap enough to be automatic. */
export const MAX_RECALL_CHARS = 1200;
const MAX_PAST_FAILURES = 3;

interface NodeRow {
  id: string;
  ts: string;
  meta: string;
  paths: string | null;
}

export interface FailureRecall {
  text: string;
  /** How many past failures backed this, for the eval and for `--json`. */
  matched: number;
  resolved: boolean;
  /** The fix exists but a later revert undid it, so it is not today's answer. */
  superseded: boolean;
}

const SELECT_BY_HASH = `
  SELECT n.id, n.ts, n.meta,
         (SELECT group_concat(f.path) FROM node_files f WHERE f.node_id = n.id) AS paths
  FROM nodes n
  WHERE n.project_id = ?
    AND n.kind = 'shell_command'
    AND json_extract(n.meta, '$.execHash') = ?
    AND json_extract(n.meta, '$.exitCode') IS NOT NULL
    AND json_extract(n.meta, '$.exitCode') != 0
  ORDER BY n.ts DESC
  LIMIT ?`;

/** Recent failures, newest first; the caller drops the ones something already resolved. */
const SELECT_RECENT_FAILURES = `
  SELECT n.id, n.ts, n.meta, NULL AS paths
  FROM nodes n
  WHERE n.project_id = ?
    AND n.kind = 'shell_command'
    AND json_extract(n.meta, '$.exitCode') IS NOT NULL
    AND json_extract(n.meta, '$.exitCode') != 0
    AND n.ts >= ?
  ORDER BY n.ts DESC
  LIMIT 40`;

const SELECT_BY_ID = `
  SELECT n.id, n.ts, n.meta,
         (SELECT group_concat(f.path) FROM node_files f WHERE f.node_id = n.id) AS paths
  FROM nodes n WHERE n.id = ?`;

/**
 * Conventional `revert: ...` / `revert(scope): ...`, and git's own
 * `Revert "..."`. Nothing looser: in the Phase-5 fixtures a plain
 * `refactor(parse): simplify config mapping` also undid a fix, but its
 * message claims no such thing, and reading intent out of a diff is not
 * evidence this function has. An unprovable staleness stays unclaimed.
 */
const REVERT_SUBJECT = /^revert(\([^)]*\))?[:!]|^revert\s+"/i;

/**
 * A later commit that says it is a revert and touches a file the fix edited.
 * Both halves are required: the message alone could be reverting anything,
 * and a later commit touching the same file is ordinary work, not a reversal.
 * A fix with no recorded files can never satisfy this, so it stays resolved --
 * absence of evidence is not evidence of staleness.
 */
const SELECT_REVERT_OF = `
  SELECT n.ts, n.title
  FROM nodes n
  WHERE n.project_id = ?
    AND n.kind = 'git_commit'
    AND n.title LIKE 'revert%'
    AND n.ts_epoch > (SELECT ts_epoch FROM nodes WHERE id = ?)
    AND EXISTS (
      SELECT 1 FROM node_files a
      JOIN node_files b ON b.path = a.path
      WHERE a.node_id = n.id AND b.node_id = ?
    )
  ORDER BY n.ts_epoch ASC
  LIMIT 3`;

function revertOfFix(store: MemoryStore, projectId: string, fixId: string): { ts: string; title: string } | null {
  const rows = store.raw.prepare(SELECT_REVERT_OF).all(projectId, fixId, fixId) as Array<{ ts: string; title: string }>;
  return rows.find((row) => REVERT_SUBJECT.test(row.title)) ?? null;
}

const day = (ts: string): string => ts.slice(0, 10);
const files = (row: NodeRow): string => (row.paths ? row.paths.split(',').join(', ') : '');

function describeAttempt(row: NodeRow): string {
  const changed = files(row);
  return changed ? `${day(row.ts)}: failed after editing ${changed}` : `${day(row.ts)}: failed`;
}

/**
 * `execHash` comes from the failing command the agent just ran. The node
 * for that run is not in the database yet -- it is ingested by the next sync --
 * so what comes back is genuinely the past, not the present failure.
 */
export function recallFailure(store: MemoryStore, projectId: string, execHash: string): FailureRecall | null {
  const db = store.raw;
  const past = db.prepare(SELECT_BY_HASH).all(projectId, execHash, MAX_PAST_FAILURES) as NodeRow[];
  if (past.length === 0) return null;

  const lines: string[] = [];
  let resolved = false;
  let superseded = false;

  // Newest first is what the agent needs: the most recent attempt is the one it is about to repeat.
  for (const row of past) {
    lines.push(`- ${describeAttempt(row)}`);
  }

  for (const row of past) {
    const [fixId] = store.getLinkedNodeIds(row.id, RESOLVED_BY_RETRY);
    if (!fixId) continue;
    const fix = db.prepare(SELECT_BY_ID).get(fixId) as NodeRow | undefined;
    if (!fix) continue;
    const changed = files(fix);
    const what = changed ? `fixed on ${day(fix.ts)} after editing ${changed}` : `fixed on ${day(fix.ts)}`;
    // What was tried is still worth saying -- it is the most actionable thing
    // here -- but it is said as history, not as today's answer, the moment
    // there is evidence it was undone.
    const revert = revertOfFix(store, projectId, fixId);
    lines.push(revert ? `- ${what}, but that fix was reverted on ${day(revert.ts)} -- it no longer holds` : `- ${what}`);
    resolved = !revert;
    superseded = Boolean(revert);
    break;
  }

  if (!resolved && !superseded) lines.push('- no fix for it was ever recorded here');

  const header = `NexusMem: this exact command has failed in this repository before (${past.length} time(s)).`;
  let footer = 'Previous attempts did not resolve it, so a different approach is likely needed.';
  if (resolved) footer = 'Check what changed in that fix before retrying the same approach.';
  if (superseded) footer = 'That fix was reverted, so repeating it is unlikely to work -- check why it was backed out.';

  return { text: [header, ...lines, footer].join('\n').slice(0, MAX_RECALL_CHARS), matched: past.length, resolved, superseded };
}

const displayCommand = (row: NodeRow): string | undefined =>
  (JSON.parse(row.meta) as { command?: string }).command?.split(/\r?\n/)[0]?.trim() || undefined;

/**
 * Which digest entry a failure belongs to: one execution, not one display
 * string. An agent row's execHash already names its execution across cd and
 * exit-echo wrappers. A row without one (human shell history, or written
 * before execHash existed) falls back to its raw-command hash, which equals
 * the execHash of the same command run plain -- so a human `npm test` still
 * joins the agent's. Only a row with neither hash uses its text, and never
 * when that text was redacted: two different secrets can read the same.
 */
function executionKey(row: NodeRow): string | null {
  const meta = JSON.parse(row.meta) as { command?: string; execHash?: unknown; commandHash?: unknown };
  const command = displayCommand(row);
  if (!command) return null;
  if (typeof meta.execHash === 'string') return `exec:${meta.execHash}`;
  if (typeof meta.commandHash === 'string') return `exec:${meta.commandHash}`;
  if (meta.command!.includes(REDACTION_MARK)) return `row:${row.id}`;
  return `text:${command}`;
}

/** ~150 tokens. A session opener has to be cheap enough that nobody would turn it off. */
export const MAX_DIGEST_CHARS = 600;
const DIGEST_WINDOW_DAYS = 14;
const MAX_DIGEST_COMMANDS = 3;

export interface SessionDigest {
  text: string;
  /** Counts by state, for the eval and for `--json`. */
  resolved: number;
  stale: number;
  superseded: number;
  uncertain: number;
  unresolved: number;
}

type CommandState = 'resolved' | 'stale' | 'superseded' | 'uncertain' | 'unresolved';

interface CommandSummary {
  command: string;
  /** This command's most recent failure in the window. */
  newestTs: string;
  state: CommandState;
  /** When state is 'resolved', 'stale' or 'superseded': when the (possibly no-longer-holding) fix landed. */
  fixTs?: string;
  /** When state is 'superseded': when the revert that undid that fix landed. */
  revertTs?: string;
}

/** Resolved chains are shown first regardless of recency -- see the doc comment below. */
const STATE_PRIORITY: Record<CommandState, number> = { resolved: 0, stale: 1, superseded: 2, uncertain: 3, unresolved: 4 };

/**
 * What is worth knowing when a session opens.
 *
 * This used to mean only "commands that failed here recently and that
 * nothing has fixed" -- which excluded the single most useful thing NexusMem
 * can say, "this failed before, and here is what fixed it", for the sole
 * reason that it *was* fixed. A resolved failure->fix chain is the most
 * actionable memory there is, so it is now listed ahead of an unrelated
 * failure with no known answer, even when the latter is more recent.
 *
 * Per command, only the MOST RECENT occurrence in the window decides the
 * state: if it has a `resolved_by:retry` link, the chain is 'resolved' -- the
 * one heuristic dogfooding found correct on every manually-checked link (see
 * correlate/failure-fix.ts) -- unless git shows that fix was later reverted,
 * which makes it 'superseded'. The Phase-5 eval measured the cost of not
 * having that check: every ambient trial of the `stale-fix` scenario was told
 * a fix was in place on a date when the repository's own history had already
 * backed it out. If the newest occurrence has no retry link but an OLDER
 * occurrence of the exact same command did, that fix has since stopped
 * holding -- said as 'stale', not silently dropped and not repeated as if it
 * still applied. If
 * the newest occurrence instead has only a `resolved_by:discussion` link --
 * the other heuristic, measured roughly half wrong when dogfooded -- it is
 * 'uncertain': named, but never worded as "fixed", because that evidence does
 * not support the word. Otherwise it is plain 'unresolved'.
 *
 * Returns null only when there is truly nothing in the window -- a
 * repository whose only history is fully resolved chains now gets a digest,
 * not silence, which is the deliberate behaviour change here.
 */
export function recallSessionStart(store: MemoryStore, projectId: string, now = new Date()): SessionDigest | null {
  const since = new Date(now.getTime() - DIGEST_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = store.raw.prepare(SELECT_RECENT_FAILURES).all(projectId, since) as NodeRow[];

  // Rows arrive newest-first (the query orders by ts DESC); grouping
  // preserves that, so each group's first entry is that execution's most
  // recent failure in the window.
  const byExecution = new Map<string, { command: string; rows: NodeRow[] }>();
  for (const row of rows) {
    const key = executionKey(row);
    if (!key) continue;
    const command = displayCommand(row)!;
    const group = byExecution.get(key);
    if (!group) byExecution.set(key, { command, rows: [row] });
    else {
      group.rows.push(row);
      // Presentation only: the shortest spelling, so a bare `npm test` names the entry rather than its cd wrapper.
      if (command.length < group.command.length) group.command = command;
    }
  }
  if (byExecution.size === 0) return null;

  const summaries: CommandSummary[] = [];
  for (const { command, rows: [newest, ...older] } of byExecution.values()) {
    const [newestFixId] = store.getLinkedNodeIds(newest!.id, RESOLVED_BY_RETRY);
    if (newestFixId) {
      const fix = store.raw.prepare(SELECT_BY_ID).get(newestFixId) as NodeRow | undefined;
      const revert = revertOfFix(store, projectId, newestFixId);
      summaries.push(
        revert
          ? { command, newestTs: newest!.ts, state: 'superseded', fixTs: fix?.ts, revertTs: revert.ts }
          : { command, newestTs: newest!.ts, state: 'resolved', fixTs: fix?.ts },
      );
      continue;
    }
    const staleFixId = older.map((row) => store.getLinkedNodeIds(row.id, RESOLVED_BY_RETRY)[0]).find((id): id is string => id !== undefined);
    if (staleFixId) {
      const fix = store.raw.prepare(SELECT_BY_ID).get(staleFixId) as NodeRow | undefined;
      summaries.push({ command, newestTs: newest!.ts, state: 'stale', fixTs: fix?.ts });
      continue;
    }
    // Weaker evidence than a retry link, and never described as a fix -- see
    // the doc comment above. Only checked once retry evidence is exhausted.
    const [discussionId] = store.getLinkedNodeIds(newest!.id, RESOLVED_BY_DISCUSSION);
    if (discussionId) {
      const discussion = store.raw.prepare(SELECT_BY_ID).get(discussionId) as NodeRow | undefined;
      summaries.push({ command, newestTs: newest!.ts, state: 'uncertain', fixTs: discussion?.ts });
    } else {
      summaries.push({ command, newestTs: newest!.ts, state: 'unresolved' });
    }
  }

  summaries.sort((a, b) => STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state] || (b.newestTs < a.newestTs ? -1 : 1));

  const listed = summaries.slice(0, MAX_DIGEST_COMMANDS);
  const lines = listed.map((s) => {
    if (s.state === 'resolved') return `- ${s.command} (failed here before, fixed ${day(s.fixTs!)})`;
    if (s.state === 'stale') {
      return `- ${s.command} (fixed ${day(s.fixTs!)}, but failed again ${day(s.newestTs)} -- that fix no longer holds)`;
    }
    if (s.state === 'superseded') {
      return `- ${s.command} (fixed ${day(s.fixTs!)}, but that fix was reverted ${day(s.revertTs!)} -- it no longer holds)`;
    }
    if (s.state === 'uncertain') {
      return `- ${s.command} failed ${day(s.newestTs)} -- possibly discussed around ${day(s.fixTs!)}, not confirmed as a fix`;
    }
    return `- ${s.command} failed ${day(s.newestTs)} with no recorded fix`;
  });
  const more = summaries.length > listed.length ? ` and ${summaries.length - listed.length} other(s)` : '';

  const counts = { resolved: 0, stale: 0, superseded: 0, uncertain: 0, unresolved: 0 };
  for (const s of summaries) counts[s.state] += 1;

  return {
    text: [
      `NexusMem: ${summaries.length} relevant command(s) from the last ${DIGEST_WINDOW_DAYS} days${more}:`,
      ...lines,
      'This history is searchable with the nexusmem MCP tools if one of them comes up.',
    ]
      .join('\n')
      .slice(0, MAX_DIGEST_CHARS),
    ...counts,
  };
}
