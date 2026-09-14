import type Database from 'better-sqlite3';
import { REDACTION_MARK } from '../conversation/redact.js';
import { significantTokens } from '../store/fts.js';
import type { MemoryStore } from '../store/store.js';

/**
 * Links a failed `shell_command` node to whatever later resolved it --
 * Phase 7's "failure -> fix chain" building block. Two independent,
 * deliberately narrow heuristics; a failure can be linked by either, both,
 * or neither. Both are unvalidated until dogfooded against a real corpus
 * (see ROADMAP.local.md's Phase 7 entry) -- this is a first pass sized for
 * that validation, not a claim that either heuristic is correct yet.
 *
 * - **Same-command retry.** A later `shell_command` in the same project and
 *   `cwd`, the *exact* normalized command text (trim + collapse whitespace +
 *   lowercase) -- or, when both rows are agent-recorded, the same `execHash`
 *   -- `exitCode === 0`, within `retryWindowMs`. High precision by
 *   construction, low recall: a fix that changes the command itself (a typo
 *   correction, an added flag) is invisible to an exact-text match. Not
 *   attempted here -- fuzzy matching is a stretch goal, not this pass's job.
 *   For agent-recorded pairs one more thing is known -- which files the agent
 *   changed -- so an identical command that passes with nothing edited in
 *   between is counted as unexplained rather than linked: the pass is real,
 *   the explanation is not. Human shell history records no files, so the same
 *   question cannot be asked of it.
 * - **Conversation bridge.** The best FTS match (AND of every significant,
 *   non-boilerplate token in the failing command) among
 *   `conversation_turn`/`session_summary` nodes in the following
 *   `discussionWindowMs`. Originally used an OR-of-tokens match and was
 *   dogfooded against this repo's real history 2026-08-15: roughly half
 *   the links were wrong, and the confirmed false positives were all driven
 *   by a single shared generic token (e.g. an "npm whoami" failure linked to
 *   an unrelated summary that just happens to mention "npm"). Tightened to
 *   AND -- still loose in the other direction, since a discussion that
 *   paraphrases the command instead of naming its words will not match, but
 *   an unvalidated false positive is worse than a missed true positive here.
 *   Does not chain further to whatever commit that conversation might cite;
 *   linking failure -> discussion is the whole claim this heuristic makes.
 *
 *   Re-dogfooded at larger scale 2026-08-16 against a second real project
 *   (`villa-bot`, previously unseen by this heuristic): the AND fix held on
 *   this repo's own 5 links (still 5/5 correct) but missed a new false-
 *   positive class the small original sample never surfaced -- a command
 *   made entirely of the tool's own boilerplate words (`nexusmem sync`)
 *   AND-matched an unrelated turn that just happened to show the same
 *   command as generic advice. bm25 score could not separate this from a
 *   true positive (measured: the false positive scored -9.685, *stronger*
 *   than two real true positives at -5.899/-6.559) -- bm25 rewards rarity
 *   *within whatever corpus it's run against*, and in villa-bot's smaller
 *   corpus those words hadn't accumulated enough occurrences to be
 *   recognized as boilerplate, even though the same words measure 33-39%
 *   document frequency in this repo's own (more self-referential) history.
 *   `filterBoilerplateTokens` below adds that corpus-relative check as a
 *   second filtering pass. Note honestly: at villa-bot's actual measured
 *   frequency for those words (9.3%/4.6%, comfortably under the threshold),
 *   this pass does *not* retroactively catch that specific instance -- it
 *   was a low-frequency AND-coincidence, not corpus saturation. What it does
 *   protect against is the class the numbers actually support: a command
 *   whose words are truly ubiquitous in a project's own history (like this
 *   repo's own name/verbs), which the villa-bot corpus wasn't saturated with
 *   yet but plausibly will be over time, and which this repo's corpus
 *   already is.
 */

export interface CorrelateOptions {
  /** How long after a failure a same-command retry may count as its resolution. Default 24h. */
  retryWindowMs?: number;
  /** How long after a failure a conversation may count as discussing it. Default 24h. */
  discussionWindowMs?: number;
}

export interface CorrelateStats {
  failuresExamined: number;
  linkedByRetry: number;
  linkedByDiscussion: number;
  /**
   * Agent-recorded runs where the same command later passed with nothing
   * edited in between. Deliberately counted rather than linked: the pass is
   * real, the explanation is not.
   */
  unexplainedRetries: number;
}

const DEFAULT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DISCUSSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * One relation string per heuristic, not a shared `resolved_by` -- dogfooding
 * against this repo's real history (2026-08-15) found the retry heuristic
 * correct on every manually-checked link, but the discussion heuristic wrong
 * on roughly half. A consumer (e.g. `pack.ts`) needs to trust one and ignore
 * the other; a single relation string could not express that distinction
 * without also tagging every row, which the relation string already does
 * for free.
 */
export const RESOLVED_BY_RETRY = 'resolved_by:retry';
export const RESOLVED_BY_DISCUSSION = 'resolved_by:discussion';

interface FailureRow {
  id: string;
  ts_epoch: number;
  command: string | null;
  /** Hash of the raw, pre-redaction command; absent on rows written before it was recorded. */
  command_hash: string | null;
  /** Agent rows only: the execution the command reduces to, across cd and exit-echo wrappers. */
  exec_hash: string | null;
  cwd: string | null;
  source: string | null;
}

interface RetryRow {
  id: string;
  source: string | null;
  /** Files recorded as changed before that run; the collector attaches them to the command that follows them. */
  file_count: number;
}

/** Agent collectors write `agent:<vendor>`; only they record which files an attempt changed. */
const isAgentSource = (source: string | null): boolean => source?.startsWith('agent:') === true;

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * A token appearing in more than this fraction of a project's own
 * `conversation_turn`/`session_summary` nodes is treated as corpus-relative
 * boilerplate for the discussion-bridge heuristic -- picked from real
 * measured numbers, not guessed: the known "id" false positive measures
 * 22-40% document frequency across two real corpora checked, and this repo's
 * own name/verbs ("nexusmem"/"sync") measure 33-39% in this repo's own
 * history, while genuinely distinguishing terms from the same real links
 * ("whoami", "wsl", "publish") all measure under 2%. 0.2 sits clearly below
 * the boilerplate cluster and clearly above the signal cluster in every
 * real measurement taken so far.
 */
const MAX_TOKEN_DOC_FREQUENCY = 0.2;

/**
 * Below this many discussable nodes, frequency is not a meaningful signal --
 * with a handful of nodes total, any word can trivially hit 20%+ just by
 * appearing once or twice, which would suppress real links on a young
 * project purely for lack of data rather than because the word is actually
 * boilerplate. 10 is a floor, not a tuned value: below it, skip the filter
 * entirely and fall back to whatever `significantTokens` already decided.
 */
const MIN_CORPUS_FOR_FREQUENCY_FILTER = 10;

const DEFAULT_BOILERPLATE_KINDS = ['conversation_turn', 'session_summary'] as const;

/**
 * Drops tokens that are boilerplate *in this specific project's own
 * history*, unlike `LOW_SIGNAL_TOKENS` in `fts.ts` which is a fixed list for
 * general search. Deliberately does NOT fall back to the unfiltered token
 * list when every token is boilerplate (the pattern `significantTokens`
 * itself uses) -- for this heuristic specifically, a command built entirely
 * of words that saturate the project's own corpus (e.g. this repo's own
 * name/verbs, "nexusmem sync") has no word left that could distinguish a
 * real discussion of *this* failure from generic chatter, and this
 * heuristic's whole design already prefers a missed link over a false one.
 *
 * `kinds` defaults to the discussion-bridge heuristic's own scope
 * (conversation/session nodes) but is a parameter so `correlate/precheck.ts`
 * can reuse the identical corpus-relative logic scoped to `shell_command`
 * nodes instead -- document frequency is only meaningful when measured
 * against the same population the match query will run over.
 */
export function filterBoilerplateTokens(
  db: Database.Database,
  projectId: string,
  tokens: string[],
  kinds: readonly string[] = DEFAULT_BOILERPLATE_KINDS,
): string[] {
  if (tokens.length === 0) return tokens;

  const kindsPlaceholder = kinds.map(() => '?').join(', ');
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM nodes WHERE project_id = ? AND kind IN (${kindsPlaceholder})`)
      .get(projectId, ...kinds) as { c: number }
  ).c;
  if (total < MIN_CORPUS_FOR_FREQUENCY_FILTER) return tokens;

  const countMatching = db.prepare(
    `SELECT COUNT(*) AS c FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid
     WHERE nodes_fts MATCH ? AND n.project_id = ? AND n.kind IN (${kindsPlaceholder})`,
  );

  return tokens.filter((t) => {
    const matching = (countMatching.get(`"${t}"*`, projectId, ...kinds) as { c: number }).c;
    return matching / total <= MAX_TOKEN_DOC_FREQUENCY;
  });
}

export function correlateFailures(store: MemoryStore, projectId: string, opts: CorrelateOptions = {}): CorrelateStats {
  const retryWindowMs = opts.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
  const discussionWindowMs = opts.discussionWindowMs ?? DEFAULT_DISCUSSION_WINDOW_MS;

  const db = store.raw;

  const failures = db
    .prepare(
      `SELECT id, ts_epoch, source, json_extract(meta, '$.command') AS command,
              json_extract(meta, '$.commandHash') AS command_hash, json_extract(meta, '$.execHash') AS exec_hash,
              json_extract(meta, '$.cwd') AS cwd
       FROM nodes
       WHERE project_id = ? AND kind = 'shell_command'
         AND source_ts IS NOT NULL
         AND json_extract(meta, '$.exitCode') IS NOT NULL
         AND json_extract(meta, '$.exitCode') != 0
         AND json_extract(meta, '$.cwd') IS NOT NULL`,
    )
    .all(projectId) as FailureRow[];

  const findRetry = db.prepare(
    `SELECT n.id, n.source,
            (SELECT COUNT(*) FROM node_files f WHERE f.node_id = n.id) AS file_count
     FROM nodes n
     WHERE n.project_id = ? AND n.kind = 'shell_command'
       AND n.source_ts IS NOT NULL
       AND json_extract(n.meta, '$.exitCode') = 0
       AND json_extract(n.meta, '$.cwd') IS NOT NULL
       AND n.ts_epoch > ? AND n.ts_epoch <= ?
       AND (json_extract(n.meta, '$.cwd') IS ? OR json_extract(n.meta, '$.cwd') = ?)
       AND CASE
         WHEN ? IS NOT NULL AND json_extract(n.meta, '$.execHash') IS NOT NULL
           THEN json_extract(n.meta, '$.execHash') = ?
         ELSE lower(trim(json_extract(n.meta, '$.command'))) = ?
           AND (? IS NULL OR json_extract(n.meta, '$.commandHash') = ?)
       END
     ORDER BY n.ts_epoch ASC LIMIT 1`,
  );

  const findDiscussion = db.prepare(
    `SELECT n.id FROM nodes_fts
     JOIN nodes n ON n.rowid = nodes_fts.rowid
     WHERE nodes_fts MATCH ? AND n.project_id = ? AND n.kind IN ('conversation_turn', 'session_summary')
       AND n.ts_epoch > ? AND n.ts_epoch <= ?
     ORDER BY bm25(nodes_fts, 10.0, 1.0)
     LIMIT 1`,
  );

  let linkedByRetry = 0;
  let linkedByDiscussion = 0;
  let unexplainedRetries = 0;

  for (const failure of failures) {
    if (!failure.command) continue;

    // Two agent rows compare by execHash, so `cd "<cwd>" && cmd; echo "exit: $?"` and a bare `cmd` are
    // one execution. Anything else compares text as before. Redaction can make different raw commands
    // (TOKEN=a cmd, TOKEN=b cmd) store identical text, so a redacted command must also match on the
    // raw-command hash; without one ('' never matches) the text comparison is ambiguous and fails.
    const redacted = failure.command.includes(REDACTION_MARK);
    const requiredHash = redacted ? (failure.command_hash ?? '') : null;
    const retry =
      redacted && !failure.command_hash && !failure.exec_hash
        ? undefined
        : (findRetry.get(
            projectId,
            failure.ts_epoch,
            failure.ts_epoch + retryWindowMs,
            failure.cwd,
            failure.cwd,
            failure.exec_hash,
            failure.exec_hash,
            normalizeCommand(failure.command),
            requiredHash,
            requiredHash,
          ) as RetryRow | undefined);
    if (retry) {
      // An attempt is files changed + execution + result. For agent-recorded
      // runs all three are known, so an identical command that suddenly passes
      // with nothing edited in between is not evidence of a fix -- it is a
      // flake or a change of environment. Ambiguous beats a confident false
      // link. Human shell history records no files at all, so this can only be
      // asked of agent-recorded pairs. Only the earliest pass is considered, deliberately: once the
      // command passed unexplained, a later edited pass cannot be credited with fixing this failure.
      const bothAgentRecorded = isAgentSource(failure.source) && isAgentSource(retry.source);
      if (bothAgentRecorded && retry.file_count === 0) {
        unexplainedRetries += 1;
      } else {
        store.linkNodes(failure.id, retry.id, RESOLVED_BY_RETRY);
        linkedByRetry += 1;
      }
    }

    const tokens = filterBoilerplateTokens(db, projectId, significantTokens(failure.command));
    const match = tokens.length > 0 ? tokens.map((t) => `"${t}"*`).join(' AND ') : null;
    if (match) {
      const discussion = findDiscussion.get(match, projectId, failure.ts_epoch, failure.ts_epoch + discussionWindowMs) as
        | { id: string }
        | undefined;
      if (discussion) {
        store.linkNodes(failure.id, discussion.id, RESOLVED_BY_DISCUSSION);
        linkedByDiscussion += 1;
      }
    }
  }

  return { failuresExamined: failures.length, linkedByRetry, linkedByDiscussion, unexplainedRetries };
}

export interface ChainStats {
  /** Every failed `shell_command` node this project has ever recorded, linked or not. */
  failuresTotal: number;
  /** Distinct failures with at least one `resolved_by:retry` link. */
  resolvedByRetry: number;
  /** Distinct failures with at least one `resolved_by:discussion` link. */
  resolvedByDiscussion: number;
  /** Distinct failures resolved by either heuristic -- the headline "chains built" number. */
  resolvedTotal: number;
}

/**
 * Read-only summary of what `correlateFailures` has built so far, for
 * `nexusmem status` -- the failure->fix chain feature is this project's one
 * genuinely hard-to-copy capability (see ROADMAP.local.md's Phase 9), and
 * before this it was invisible to anyone who didn't already know to query
 * `node_links` directly. Counts what already exists; running `sync
 * --link-failures` is what grows these numbers, not this function.
 */
export function getChainStats(store: MemoryStore, projectId: string): ChainStats {
  const db = store.raw;

  const failuresTotal = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM nodes
         WHERE project_id = ? AND kind = 'shell_command'
           AND json_extract(meta, '$.exitCode') IS NOT NULL AND json_extract(meta, '$.exitCode') != 0`,
      )
      .get(projectId) as { c: number }
  ).c;

  const countDistinctLinked = (relations: string[]): number =>
    (
      db
        .prepare(
          `SELECT COUNT(DISTINCT nl.from_node_id) AS c
           FROM node_links nl JOIN nodes n ON n.id = nl.from_node_id
           WHERE n.project_id = ? AND nl.relation IN (${relations.map(() => '?').join(', ')})`,
        )
        .get(projectId, ...relations) as { c: number }
    ).c;

  return {
    failuresTotal,
    resolvedByRetry: countDistinctLinked([RESOLVED_BY_RETRY]),
    resolvedByDiscussion: countDistinctLinked([RESOLVED_BY_DISCUSSION]),
    resolvedTotal: countDistinctLinked([RESOLVED_BY_RETRY, RESOLVED_BY_DISCUSSION]),
  };
}
