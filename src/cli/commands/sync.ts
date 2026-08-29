import pc from 'picocolors';
import { correlateFailures } from '../../correlate/failure-fix.js';
import { collectConversationTurns } from '../../collectors/conversation.js';
import { collectCommitDiffs, DIFF_SOURCE } from '../../collectors/diffs.js';
import { collectDocFiles } from '../../collectors/docs.js';
import { collectGitCommits } from '../../collectors/git-commits.js';
import { collectGithubThreads } from '../../collectors/github.js';
import { collectSessionSummaries } from '../../collectors/sessions.js';
import { collectShellHistory } from '../../collectors/shell-history.js';
import { forgetProjects, recordProject } from '../../config/registry.js';
import { writeConfig, type NexusConfig } from '../../config/workspace.js';
import { collectClaudeCodeTranscripts } from '../../conversation/claude-code-reader.js';
import type { RawConversationTurn } from '../../conversation/types.js';
import { makeNodeId } from '../../core/ids.js';
import type { MemoryNode } from '../../core/types.js';
import { readDocFiles } from '../../docs/read.js';
import { isAncestor } from '../../git/repo.js';
import { GhCliProvider, GithubUnavailableError, parseGithubSlug, type GithubProvider } from '../../github/read.js';
import { checkContradictions } from '../../retrieval/contradiction.js';
import { collectAvailableShellHistory } from '../../shell/detect.js';
import { OllamaChatProvider, type SummarizationProvider } from '../../slm/provider.js';
import { reconcileProjectId } from '../../store/reconcile.js';
import { MemoryStore, type IngestStats } from '../../store/store.js';
import { collectFileEdges } from '../../structure/collect.js';
import { OllamaEmbeddingProvider, type EmbeddingProvider } from '../../vector/embed.js';
import { embedPendingNodes } from '../../vector/sync.js';
import { loadContext } from '../context.js';

export interface SyncOptions {
  cwd: string;
  /** Ignore the stored cursor and re-walk all history (still deduplicated). */
  full: boolean;
  /** Delete this project's nodes first, then re-ingest from scratch. */
  rebuild: boolean;
  /** Overrides `sources.git.since` from config for this run. */
  since?: string;
  /** Overrides `sources.shell.tailLines` from config for this run. */
  shellTailLines?: number;
  /** Forces the (opt-in) conversation source on for this run without persisting it to config. */
  conversationOverride?: boolean;
  /** Forces the (opt-in) github source on for this run without persisting it to config. */
  githubOverride?: boolean;
  /** Injectable for tests; defaults to the real `gh`-backed provider. */
  githubProvider?: GithubProvider;
  /** Skip the embedding pass entirely -- useful when Ollama isn't running and you don't want to wait out its timeout. */
  noEmbed?: boolean;
  /** Stop the embedding pass after this many nodes. Unset means drain the backlog. */
  embedLimit?: number;
  /** Wipe every node of this exact source (e.g. `shell:pwsh`) instead of syncing. Dry-run unless `yes` is also set. */
  pruneSource?: string;
  /** Shortcut for `pruneSource` on all three dead pre-hook shell-scrape sources at once. Combines with `pruneSource` if both are set. */
  pruneStaleShell?: boolean;
  /** Confirms an irreversible `pruneSource`/`pruneStaleShell` delete. Without it, the matching count is printed and nothing is removed. */
  yes?: boolean;
  /**
   * Opt-in (Phase 7): after ingest, run `correlateFailures` to link failed
   * shell commands to whatever later resolved them. Off by default -- both
   * heuristics are new and unvalidated, matching how session summarization
   * shipped opt-in first before being trusted as a default.
   */
  linkFailures?: boolean;
  quiet: boolean;
  /**
   * Where the final summary goes. Defaults to real stdout for the CLI.
   *
   * Progress lines keep going to stderr regardless (see `log` below); this is
   * only the result. The MCP server passes its own sink because there `stdout`
   * carries the JSON-RPC transport -- see `InitOptions.out`.
   */
  out?: (chunk: string) => void;
}

/**
 * Rows per transaction.
 *
 * Large enough that per-transaction overhead disappears, small enough that a
 * huge repository does not hold every node in memory before the first write.
 */
const BATCH_SIZE = 500;

/** Below this backlog the embedding pass finishes fast enough that progress lines are just noise. */
const PROGRESS_THRESHOLD = 200;
const PROGRESS_EVERY = 100;

const GIT_SOURCE = 'git';

function addStats(into: IngestStats, from: IngestStats): void {
  into.inserted += from.inserted;
  into.updated += from.updated;
  into.unchanged += from.unchanged;
  into.denied += from.denied;
}

async function syncGit(
  store: MemoryStore,
  projectId: string,
  opts: SyncOptions,
  repo: Awaited<ReturnType<typeof loadContext>>['repo'],
  config: Awaited<ReturnType<typeof loadContext>>['config'],
  log: (line: string) => void,
): Promise<{ totals: IngestStats; seen: number }> {
  const totals: IngestStats = { inserted: 0, updated: 0, unchanged: 0, denied: 0 };

  if (!repo.head) {
    log(`${pc.yellow('git')} skipped -- repository has no commits yet`);
    return { totals, seen: 0 };
  }
  if (!config.sources.git.enabled) {
    log(`${pc.dim('git')} disabled in config`);
    return { totals, seen: 0 };
  }

  let cursor = opts.full || opts.rebuild ? null : store.getSyncCursor(projectId, GIT_SOURCE);

  if (cursor && !(await isAncestor(repo.root, cursor, repo.head))) {
    log(`${pc.yellow('git cursor stale')} ${cursor.slice(0, 7)} is not an ancestor of HEAD — falling back to a full walk`);
    cursor = null;
  }

  if (cursor === repo.head) {
    log(`${pc.green('git up to date')} at ${repo.head.slice(0, 7)}`);
    store.setSyncCursor(projectId, GIT_SOURCE, repo.head);
    return { totals, seen: 0 };
  }

  log(
    `${pc.dim('git syncing')} ${repo.branch ?? 'HEAD'} ${cursor ? `${cursor.slice(0, 7)}..${repo.head.slice(0, 7)}` : '(full history)'}`,
  );

  let batch: MemoryNode[] = [];
  let seen = 0;

  const flush = () => {
    if (batch.length === 0) return;
    addStats(totals, store.upsertNodes(batch));
    batch = [];
    log(`  ${pc.dim(`${seen} commits read, ${totals.inserted} new`)}`);
  };

  const nodes = collectGitCommits(repo.root, projectId, {
    afterCommit: cursor,
    since: opts.since ?? config.sources.git.since,
    includeMerges: config.sources.git.includeMerges,
    maxFilesPerNode: config.limits.maxFilesPerNode,
    maxBodyChars: config.limits.maxBodyChars,
  });

  for await (const node of nodes) {
    batch.push(node);
    seen += 1;
    if (batch.length >= BATCH_SIZE) flush();
  }
  flush();

  // Only advance the cursor once the walk completed without throwing -- a
  // crash mid-sync leaves the old cursor, and the next run redoes the range
  // (harmlessly, because ingestion is idempotent).
  store.setSyncCursor(projectId, GIT_SOURCE, repo.head);
  return { totals, seen };
}

async function syncDiffs(
  store: MemoryStore,
  projectId: string,
  opts: SyncOptions,
  repo: Awaited<ReturnType<typeof loadContext>>['repo'],
  config: Awaited<ReturnType<typeof loadContext>>['config'],
  log: (line: string) => void,
): Promise<{ totals: IngestStats; seen: number }> {
  const totals: IngestStats = { inserted: 0, updated: 0, unchanged: 0, denied: 0 };

  if (!repo.head) return { totals, seen: 0 };
  if (!config.sources.diff.enabled) {
    log(`${pc.dim('diff')} disabled in config`);
    return { totals, seen: 0 };
  }

  // Its own cursor, not git's: the two sources walk the same history but are
  // enabled independently, so a repository that had diffs turned on later must
  // not inherit git's "already up to date" position and skip everything.
  let cursor = opts.full || opts.rebuild ? null : store.getSyncCursor(projectId, DIFF_SOURCE);

  if (cursor && !(await isAncestor(repo.root, cursor, repo.head))) {
    log(`${pc.yellow('diff cursor stale')} ${cursor.slice(0, 7)} is not an ancestor of HEAD — falling back to a bounded walk`);
    cursor = null;
  }

  if (cursor === repo.head) {
    store.setSyncCursor(projectId, DIFF_SOURCE, repo.head);
    return { totals, seen: 0 };
  }

  let batch: MemoryNode[] = [];
  let seen = 0;

  const flush = () => {
    if (batch.length === 0) return;
    addStats(totals, store.upsertNodes(batch));
    batch = [];
  };

  const nodes = collectCommitDiffs(repo.root, projectId, {
    afterCommit: cursor,
    since: opts.since ?? config.sources.git.since,
    maxCount: config.sources.diff.maxCommits,
    maxFilesPerCommit: config.sources.diff.maxFilesPerCommit,
    contextLines: config.sources.diff.contextLines,
    maxBodyChars: config.limits.maxBodyChars,
  });

  for await (const node of nodes) {
    batch.push(node);
    seen += 1;
    if (batch.length >= BATCH_SIZE) flush();
  }
  flush();

  // Same rule as git: advance only after a walk that completed, so a crash
  // mid-sync redoes the range instead of silently skipping it.
  store.setSyncCursor(projectId, DIFF_SOURCE, repo.head);
  log(`  ${pc.dim(`${DIFF_SOURCE}: ${seen} file diff(s) read`)}`);

  return { totals, seen };
}

async function syncShell(
  store: MemoryStore,
  projectId: string,
  opts: SyncOptions,
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadContext>>['config'],
  log: (line: string) => void,
): Promise<{ totals: IngestStats; seen: number }> {
  const totals: IngestStats = { inserted: 0, updated: 0, unchanged: 0, denied: 0 };

  if (!config.sources.shell.enabled) {
    log(`${pc.dim('shell')} disabled in config`);
    return { totals, seen: 0 };
  }

  const results = await collectAvailableShellHistory({
    tailLines: opts.shellTailLines ?? config.sources.shell.tailLines,
    repoRoot,
    hookCursor: store.getSyncCursor(projectId, 'shell:pwsh-hook'),
  });

  if (results.length === 0) {
    log(`${pc.dim('shell')} no history source found on this machine`);
    return { totals, seen: 0 };
  }

  let seen = 0;
  for (const result of results) {
    const sourceKey = `shell:${result.name}`;
    const nodes = collectShellHistory(result.entries, projectId, { maxBodyChars: config.limits.maxBodyChars });
    seen += nodes.length;

    if (nodes.length > 0) {
      addStats(totals, store.upsertNodes(nodes));
    }

    // Hook source is a real append-only log: advance a walk-forward cursor.
    // Scrape sources re-read their tail window every run (bounded, cheap,
    // and self-deduplicating via content-addressed ids) so their "cursor" is
    // informational only, for `status` to show a last-synced marker.
    store.setSyncCursor(projectId, sourceKey, result.cursorAfter ?? `scanned:${result.entries.length}`);
    log(`  ${pc.dim(`${sourceKey}: ${nodes.length} entr${nodes.length === 1 ? 'y' : 'ies'} read`)}`);
  }

  return { totals, seen };
}

const CONVERSATION_SOURCE = 'conversation:claude-code';

function syncConversation(
  store: MemoryStore,
  projectId: string,
  turns: readonly RawConversationTurn[],
  config: Awaited<ReturnType<typeof loadContext>>['config'],
  log: (line: string) => void,
  forceEnabled: boolean | undefined,
): { totals: IngestStats; seen: number } {
  const totals: IngestStats = { inserted: 0, updated: 0, unchanged: 0, denied: 0 };
  const enabled = forceEnabled ?? config.sources.conversation.enabled;

  if (!enabled) {
    // Opt-in and silent by default -- this source is off for almost every
    // sync, and it would be noise to announce that on every single run.
    return { totals, seen: 0 };
  }

  if (turns.length === 0) {
    log(`${pc.dim('conversation')} no transcripts found`);
    return { totals, seen: 0 };
  }

  const nodes = collectConversationTurns(turns, projectId, { maxBodyChars: config.limits.maxBodyChars });
  if (nodes.length > 0) addStats(totals, store.upsertNodes(nodes));

  // Re-read in full each sync (see claude-code-reader.ts) -- the cursor here
  // is informational only, matching the shell scrape sources.
  store.setSyncCursor(projectId, CONVERSATION_SOURCE, `scanned:${nodes.length}`);
  log(`  ${pc.dim(`${CONVERSATION_SOURCE}: ${nodes.length} of ${turns.length} exchange(s) kept`)}`);

  return { totals, seen: nodes.length };
}

const SESSION_SOURCE = 'session:claude-code';

async function syncSessions(
  store: MemoryStore,
  projectId: string,
  turns: readonly RawConversationTurn[],
  config: Awaited<ReturnType<typeof loadContext>>['config'],
  log: (line: string) => void,
): Promise<{ totals: IngestStats; seen: number }> {
  const totals: IngestStats = { inserted: 0, updated: 0, unchanged: 0, denied: 0 };
  const settings = config.sources.session;

  // Opt-in and silent when off, same as the conversation source.
  if (!settings.enabled) return { totals, seen: 0 };

  if (turns.length === 0) {
    log(`${pc.dim('session')} no transcripts found`);
    return { totals, seen: 0 };
  }

  const result = await collectSessionSummaries(turns, projectId, new OllamaChatProvider({ model: settings.model }), {
    settleMinutes: settings.settleMinutes,
    maxSessions: settings.maxSessions,
    maxPromptChars: settings.maxPromptChars,
    maxBodyChars: config.limits.maxBodyChars,
    knownHash: (sessionKey) => {
      const meta = store.getNodeMeta(makeNodeId(projectId, 'session_summary', sessionKey));
      return typeof meta?.contentHash === 'string' ? meta.contentHash : null;
    },
    onProgress: (done, total) => log(`  ${pc.dim(`session: summarizing ${done}/${total}`)}`),
  });

  if (result.nodes.length > 0) addStats(totals, store.upsertNodes(result.nodes));

  if (result.providerUnavailable) {
    log(
      `${pc.dim('session')} summarization model unavailable (is Ollama running with \`${settings.model}\` pulled?) -- skipped`,
    );
  } else {
    const parts = [`${result.nodes.length} summarized`];
    if (result.cached > 0) parts.push(`${result.cached} unchanged`);
    if (result.deferred > 0) parts.push(`${result.deferred} queued for the next sync`);
    if (result.unsettled > 0) parts.push(`${result.unsettled} still active`);
    if (result.failed > 0) parts.push(`${result.failed} failed`);
    log(`  ${pc.dim(`${SESSION_SOURCE}: ${parts.join(', ')}`)}`);
  }

  // Informational only, like the other full-rescan sources.
  store.setSyncCursor(projectId, SESSION_SOURCE, `scanned:${result.nodes.length}`);

  return { totals, seen: result.nodes.length };
}

const DOCS_SOURCE = 'docs';

async function syncDocs(
  store: MemoryStore,
  projectId: string,
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadContext>>['config'],
  log: (line: string) => void,
): Promise<{ totals: IngestStats; seen: number }> {
  const totals: IngestStats = { inserted: 0, updated: 0, unchanged: 0, denied: 0 };

  if (!config.sources.docs.enabled) {
    log(`${pc.dim('docs')} disabled in config`);
    return { totals, seen: 0 };
  }

  const { files, unreadable } = await readDocFiles(repoRoot, { include: config.sources.docs.include });

  const nodes = collectDocFiles(files, projectId, { maxBodyChars: config.limits.maxBodyChars });
  if (nodes.length > 0) addStats(totals, store.upsertNodes(nodes));

  // Prune *after* the upsert, so a renamed heading's replacement is already in
  // place and only the stranded original is left to remove.
  //
  // This scan is always a complete one -- every tracked .md file, re-read in
  // full -- which is what makes the delete safe: anything of this source not in
  // `nodes` genuinely no longer exists in the repository. An empty scan is a
  // legitimate outcome (every .md file deleted) and prunes accordingly; files
  // that could not be read are excluded rather than treated as gone.
  const pruned = store.pruneSourceNodes(
    projectId,
    DOCS_SOURCE,
    nodes.map((node) => node.id),
    { keepPaths: unreadable },
  );

  // Re-read in full each sync, the same trade the conversation source makes:
  // content-addressed ids make it idempotent, and a doc file has no cheap
  // append-only cursor to walk incrementally.
  store.setSyncCursor(projectId, DOCS_SOURCE, `scanned:${nodes.length}`);

  if (files.length === 0 && unreadable.length === 0) {
    log(`${pc.dim('docs')} no tracked .md files found`);
  } else {
    const prunedPart = pruned > 0 ? `, ${pc.yellow(`${pruned} stale removed`)}` : '';
    const skippedPart = unreadable.length > 0 ? `, ${unreadable.length} unreadable (kept)` : '';
    log(`  ${pc.dim(`${DOCS_SOURCE}: ${nodes.length} section(s) from ${files.length} file(s)`)}${prunedPart}${pc.dim(skippedPart)}`);
  }

  return { totals, seen: nodes.length };
}

const GITHUB_SOURCE = 'github';

/**
 * Issue/PR threads for this repo's github.com remote, via `gh`.
 *
 * One cursor for both issues and PRs, since one API call covers both (see
 * `RawGithubThread.type`). Unlike `syncDocs`, this never prunes: the GitHub
 * API's `since` filter only returns threads *updated* since the cursor, so a
 * thread absent from an incremental batch just means nothing changed on
 * it -- not that it was deleted, the way an absent doc file's section means.
 * The cursor is the moment the request was sent, not the newest `updatedAt`
 * seen -- a batch that happens to return zero threads must not leave the
 * cursor pointing at some much older value.
 */
async function syncGithub(
  store: MemoryStore,
  projectId: string,
  opts: SyncOptions,
  repo: Awaited<ReturnType<typeof loadContext>>['repo'],
  config: Awaited<ReturnType<typeof loadContext>>['config'],
  log: (line: string) => void,
): Promise<{ totals: IngestStats; seen: number }> {
  const totals: IngestStats = { inserted: 0, updated: 0, unchanged: 0, denied: 0 };
  const enabled = opts.githubOverride ?? config.sources.github.enabled;

  if (!enabled) return { totals, seen: 0 };

  const slug = parseGithubSlug(repo.originUrl);
  if (!slug) {
    log(`${pc.dim('github')} no github.com remote found -- skipped`);
    return { totals, seen: 0 };
  }

  const provider =
    opts.githubProvider ??
    new GhCliProvider(slug, {
      maxThreads: config.sources.github.maxThreads,
      maxCommentsPerThread: config.sources.github.maxCommentsPerThread,
    });

  const cursor = opts.full || opts.rebuild ? null : store.getSyncCursor(projectId, GITHUB_SOURCE);
  const requestedAt = new Date().toISOString();

  let threads;
  try {
    threads = await provider.listThreads(cursor);
  } catch (err) {
    if (err instanceof GithubUnavailableError) {
      log(`${pc.dim('github')} ${err.message} -- skipped`);
      return { totals, seen: 0 };
    }
    throw err;
  }

  const nodes = collectGithubThreads(threads, projectId, { maxBodyChars: config.limits.maxBodyChars });
  if (nodes.length > 0) addStats(totals, store.upsertNodes(nodes));

  store.setSyncCursor(projectId, GITHUB_SOURCE, requestedAt);
  log(`  ${pc.dim(`${GITHUB_SOURCE}: ${nodes.length} thread(s) read from ${slug}`)}`);

  return { totals, seen: nodes.length };
}

/**
 * JS/TS/Python/Go/Rust/Java/PHP import-graph edges (`file_edges`, not `nodes`) -- there is no
 * `IngestStats` to report since edges aren't MemoryNodes, just a full
 * replace of the project's `file_edges` snapshot every run, same reasoning
 * `syncDocs` above documents for why a full re-scan is safe here too (no
 * incremental cursor for "which files' imports changed").
 */
async function syncStructure(
  store: MemoryStore,
  projectId: string,
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadContext>>['config'],
  log: (line: string) => void,
): Promise<{ edges: number; filesScanned: number }> {
  if (!config.sources.structure.enabled) {
    log(`${pc.dim('structure')} disabled in config`);
    return { edges: 0, filesScanned: 0 };
  }

  const { edges, filesScanned, unreadable } = await collectFileEdges(repoRoot);
  store.replaceFileEdges(projectId, edges);

  const skippedPart = unreadable.length > 0 ? `, ${unreadable.length} unreadable (skipped)` : '';
  log(`  ${pc.dim(`structure: ${edges.length} edge(s) from ${filesScanned} file(s)`)}${pc.dim(skippedPart)}`);

  return { edges: edges.length, filesScanned };
}

/**
 * The three sources `collectAvailableShellHistory` produced before the
 * PowerShell hook existed. Nothing has written to them since the hook took
 * over (it always returns `pwsh-hook` results once installed -- see the
 * `hookCursor`-driven branch in `syncShell` below), so on a machine with the
 * hook installed these are pure dead weight with no live collector to diff
 * against, unlike `docs`.
 */
const STALE_SHELL_SOURCES = ['shell:pwsh', 'shell:bash', 'shell:zsh'] as const;

/** Resolves `--prune-source`/`--prune-stale-shell` into a deduplicated list of exact source strings. */
function collectPruneSources(opts: SyncOptions): string[] {
  const sources = new Set<string>();
  if (opts.pruneStaleShell) {
    for (const source of STALE_SHELL_SOURCES) sources.add(source);
  }
  if (opts.pruneSource?.trim()) sources.add(opts.pruneSource.trim());
  return [...sources];
}

/**
 * Handles `--prune-source`/`--prune-stale-shell` as a standalone maintenance
 * action -- it never falls through into the rest of `runSync`'s ingest
 * pipeline, so a single invocation either inspects/deletes the named
 * source(s) or does a normal sync, never both in one run.
 *
 * Dry-run by default: without `--yes` this only counts and prints, matching
 * the user's explicit call that a scoped, easy-to-typo delete needs a shown
 * number before anything irreversible happens -- unlike `--rebuild`, which
 * has no such gate because its own name already states the full-project
 * scope.
 *
 * Sweeps `otherProjectIds` (this same sync's own `listOtherProjectIds`
 * result) in addition to the live `projectId`, not just the live id alone.
 * Found live, 2026-08-15: this repo's own dead `shell:pwsh` rows were
 * invisible to a live-id-only prune because they were left stranded under
 * the pre-rename project id by [[nexusmem-project-id-fragmentation]]'s
 * reconcile step (deliberately -- see `reconcile.ts`'s doc comment, which
 * already called this "no different in effect from pruning it" without
 * anything actually able to reach it). `reconcile.ts` already treats every
 * id `listOtherProjectIds` returns as a prior identity of this same repo,
 * never another repository's data (`db` is one file per repo) -- this reuses
 * that exact invariant rather than inventing a new one.
 */
function runPruneSources(
  store: MemoryStore,
  projectId: string,
  otherProjectIds: readonly string[],
  sources: readonly string[],
  yes: boolean,
  out: (chunk: string) => void,
): number {
  const scopeIds = [projectId, ...otherProjectIds];
  const counts = sources.flatMap((source) => scopeIds.map((id) => ({ source, id, count: store.countSourceNodes(id, source) })));
  const total = counts.reduce((sum, c) => sum + c.count, 0);

  if (total === 0) {
    out(`${pc.dim('prune-source')} no node(s) match ${sources.join(', ')} -- nothing to do\n`);
    return 0;
  }

  const describe = (c: { source: string; id: string; count: number }) =>
    `  ${pc.dim(c.source)}${c.id !== projectId ? pc.dim(` (prior identity ${c.id.slice(0, 8)})`) : ''}: ${c.count} node(s)`;

  if (!yes) {
    const lines = counts.filter((c) => c.count > 0).map(describe);
    out(
      [`${pc.yellow('would remove')} ${total} node(s):`, ...lines, pc.dim('re-run with --yes to actually delete these -- this cannot be undone'), ''].join(
        '\n',
      ),
    );
    return 0;
  }

  // Passing an empty keep-list is a full wipe of the source, not the
  // incremental prune `syncDocs` above uses it for -- there is no fresh scan
  // to diff against for a source nothing collects anymore.
  const startedAt = Date.now();
  let removed = 0;
  for (const { source, id } of counts) removed += store.pruneSourceNodes(id, source, []);
  // Coarse deletes previously left no trace at all -- `forget` writes
  // `mutation_audit`, this didn't, an asymmetry an external review flagged
  // (docs/forget-mechanism.md). No tombstones here: unlike `forget`, this
  // path deletes by source/id, not by value, so there is no single matched
  // value to hash.
  store.recordMutationAudit({
    action: 'prune_source',
    projectId,
    detail: { sources, scopeProjectIds: scopeIds },
    affectedCount: removed,
    succeeded: true,
    startedAt,
    finishedAt: Date.now(),
  });
  const identityPart = otherProjectIds.length > 0 ? `, ${scopeIds.length} project identit${scopeIds.length === 1 ? 'y' : 'ies'}` : '';
  out(`${pc.green('pruned')} ${removed} node(s) across ${sources.length} source(s)${identityPart}\n`);
  return 0;
}

/**
 * The automatic leg of contradiction detection: judge up to
 * `contradictions.maxPerSync` new (candidate, newer neighbour) pairs and
 * return the one-line summary for the sync report ('' when there is nothing
 * to say). Exported with injectable providers for tests; `runSync` passes
 * the real Ollama ones. Suggest-only, same as `stale --check-contradictions`
 * -- the judgments land in `contradiction_checks` for `stale`/`status` to
 * surface, never in `supersedes`.
 */
export async function runAutoContradictionCheck(
  store: MemoryStore,
  config: NexusConfig,
  projectId: string,
  providers: { embedder: EmbeddingProvider; slm: SummarizationProvider },
): Promise<string> {
  if (!config.contradictions.autoCheck) return '';

  const candidates = store.listStaleCandidates(projectId);
  if (candidates.length === 0) return '';

  const fresh = await checkContradictions(store, providers.embedder, providers.slm, projectId, candidates, {
    limit: candidates.length,
    maxJudgments: config.contradictions.maxPerSync,
    model: config.contradictions.model,
  });

  const open = store.countContradictionSuggestions(projectId);
  if (fresh.length === 0 && open === 0) return '';

  const freshPart = fresh.length > 0 ? pc.yellow(`${fresh.length} new`) : `${fresh.length} new`;
  return `  ${pc.dim('contradictions:')} ${freshPart}${pc.dim(`, ${open} open suggestion(s) -- run`)} ${pc.bold('nexusmem stale')} ${pc.dim('for detail')}\n`;
}

export async function runSync(opts: SyncOptions): Promise<number> {
  const { repo, ws, projectId, config } = await loadContext(opts.cwd);
  const log = (line: string) => {
    if (!opts.quiet) process.stderr.write(`${line}\n`);
  };
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));

  const store = MemoryStore.open(ws.dbPath);
  const started = Date.now();

  try {
    store.upsertProject({ id: projectId, root: repo.root, originUrl: repo.originUrl });

    // Cleared *before* reconciliation runs below, deliberately: reconciliation
    // writes under `projectId` too, and clearing after it ran would silently
    // destroy the very data it just migrated forward -- data that, unlike
    // git/diff/docs, a fresh re-ingest cannot reproduce.
    if (opts.rebuild) {
      const removed = store.clearProject(projectId);
      log(`${pc.dim('rebuild')} dropped ${removed} existing node(s)`);
    }

    // A repo's own database never holds another repo's data (see
    // registry.ts), so any other project id already in it is this same
    // repo's prior identity -- almost always its git remote URL changed
    // since the last sync (see reconcile.ts for the full story).
    const staleProjectIds = store.listOtherProjectIds(projectId);
    for (const staleId of staleProjectIds) {
      const result = reconcileProjectId(store.raw, staleId, projectId);
      const parts = [
        result.migrated > 0 ? `${result.migrated} migrated` : null,
        result.reassigned > 0 ? `${result.reassigned} reassigned` : null,
        result.deduped > 0 ? `${result.deduped} already up to date` : null,
        result.skipped > 0 ? `${result.skipped} left behind (not reconstructable)` : null,
        result.denied > 0 ? `${result.denied} denied (deny-list)` : null,
      ].filter((part): part is string => part !== null);
      if (parts.length > 0) {
        log(
          `${pc.yellow('reconciled')} previous project identity ${pc.dim(staleId)} (remote URL likely changed): ${parts.join(', ')}`,
        );
      }
    }
    if (staleProjectIds.length > 0) {
      if (opts.rebuild) {
        // Reconciliation just salvaged everything recoverable; --rebuild's
        // fresh-start intent extends naturally to purging what's deliberately
        // left behind (git/diff/doc/pre-hook-shell rows -- see reconcile.ts
        // for why those specifically are never migrated).
        for (const staleId of staleProjectIds) store.clearProject(staleId);
      }
      await forgetProjects(staleProjectIds);
      // config.json's projectId is otherwise write-once (set at init) and
      // would keep reporting the stale id in `nexusmem init`'s "already
      // initialized" message forever.
      if (config.projectId !== projectId) await writeConfig(ws, { ...config, projectId });
    }

    // Refreshed on every sync, not only at init: a repo initialized before
    // the registry existed, or moved since, is re-pointed by being used.
    await recordProject({ projectId, root: repo.root, dbPath: ws.dbPath, originUrl: repo.originUrl });

    const pruneSources = collectPruneSources(opts);
    if (pruneSources.length > 0) {
      return runPruneSources(store, projectId, staleProjectIds, pruneSources, opts.yes ?? false, out);
    }

    const git = await syncGit(store, projectId, opts, repo, config, log);
    const diffs = await syncDiffs(store, projectId, opts, repo, config, log);
    const shell = await syncShell(store, projectId, opts, repo.root, config, log);

    // Read once, used by two sources. Parsing every transcript twice was
    // measurable on a repo with a long history of sessions, and both sources
    // want the exact same turns.
    const conversationEnabled = opts.conversationOverride ?? config.sources.conversation.enabled;
    const turns =
      conversationEnabled || config.sources.session.enabled ? await collectClaudeCodeTranscripts(repo.root) : [];

    const conversation = syncConversation(store, projectId, turns, config, log, opts.conversationOverride);
    const sessions = await syncSessions(store, projectId, turns, config, log);
    const docs = await syncDocs(store, projectId, repo.root, config, log);
    const github = await syncGithub(store, projectId, opts, repo, config, log);
    const structure = await syncStructure(store, projectId, repo.root, config, log);

    let embedLine = '';
    let embeddingAvailable = false;
    if (!opts.noEmbed) {
      // Progress matters now that one pass drains the whole backlog: on a
      // first sync of a large repository this is the longest step by far, and
      // without a heartbeat it is indistinguishable from a hang.
      let lastLogged = 0;
      const result = await embedPendingNodes(store, new OllamaEmbeddingProvider(), projectId, {
        maxNodes: opts.embedLimit,
        onInvalidated: (count) =>
          log(`${pc.yellow('vector')} embedding model changed -- dropped ${count} vector(s), re-embedding from scratch`),
        onProgress: (attempted, total) => {
          if (total < PROGRESS_THRESHOLD || attempted - lastLogged < PROGRESS_EVERY) return;
          lastLogged = attempted;
          log(`  ${pc.dim(`vector: ${attempted}/${total} embedded`)}`);
        },
      });

      embeddingAvailable = !result.providerUnavailable;

      if (result.embedded > 0) {
        const skippedPart = result.skipped > 0 ? pc.dim(`, ${result.skipped} skipped`) : '';
        const remainingPart = result.remaining > 0 ? pc.yellow(`, ${result.remaining} still pending`) : '';
        embedLine = `  ${pc.dim(`vector: ${result.embedded} node(s) embedded`)}${skippedPart}${remainingPart}\n`;
      } else if (result.providerUnavailable) {
        log(`${pc.dim('vector')} embedding provider unavailable (is Ollama running with nomic-embed-text pulled?) -- BM25-only for now`);
      }
    }

    // Piggybacks on the embedding gate: --no-embed means "stay off the
    // network this run", and an unavailable embedding provider means the chat
    // model behind the same Ollama endpoint is not worth trying either.
    const contradictionLine =
      !opts.noEmbed && embeddingAvailable
        ? await runAutoContradictionCheck(store, config, projectId, {
            embedder: new OllamaEmbeddingProvider(),
            slm: new OllamaChatProvider({ model: config.contradictions.model }),
          })
        : '';

    let linkLine = '';
    if (opts.linkFailures) {
      // After ingest/embedding, not folded into any one source's sync
      // function above: correlation reads across shell_command and
      // conversation_turn/session_summary nodes together, so it only makes
      // sense once whatever this run ingested is already in the store.
      const linkStats = correlateFailures(store, projectId);
      linkLine = `  ${pc.dim(`chains: ${linkStats.failuresExamined} failure(s) examined, ${linkStats.linkedByRetry} linked by retry, ${linkStats.linkedByDiscussion} by discussion`)}\n`;
    }

    store.markSynced(projectId);

    const totals: IngestStats = { inserted: 0, updated: 0, unchanged: 0, denied: 0 };
    addStats(totals, git.totals);
    addStats(totals, diffs.totals);
    addStats(totals, shell.totals);
    addStats(totals, conversation.totals);
    addStats(totals, sessions.totals);
    addStats(totals, docs.totals);
    addStats(totals, github.totals);

    const stats = store.stats(projectId);
    const elapsed = ((Date.now() - started) / 1000).toFixed(2);

    const conversationPart = conversationEnabled ? `, ${conversation.seen} conversation exchange(s)` : '';
    const sessionPart = config.sources.session.enabled ? `, ${sessions.seen} session summar${sessions.seen === 1 ? 'y' : 'ies'}` : '';
    const docsPart = config.sources.docs.enabled ? `, ${docs.seen} doc section(s)` : '';
    const diffPart = config.sources.diff.enabled ? `, ${diffs.seen} file diff(s)` : '';
    const structurePart = config.sources.structure.enabled ? `, ${structure.edges} import edge(s)` : '';
    const deniedPart = totals.denied > 0 ? `  ${pc.red(`-${totals.denied} denied`)}` : '';

    out(
      [
        `${pc.green('synced')} ${git.seen} commit(s)${diffPart}, ${shell.seen} shell entr${shell.seen === 1 ? 'y' : 'ies'}${conversationPart}${sessionPart}${docsPart}${structurePart} in ${elapsed}s`,
        `  ${pc.green(`+${totals.inserted} new`)}  ${pc.yellow(`~${totals.updated} updated`)}  ${pc.dim(`=${totals.unchanged} unchanged`)}${deniedPart}`,
        `  ${pc.dim(`${stats.total} node(s) total across ${stats.distinctFiles} file path(s)`)}`,
        '',
      ].join('\n') + embedLine + linkLine + contradictionLine,
    );

    return 0;
  } finally {
    store.close();
  }
}
