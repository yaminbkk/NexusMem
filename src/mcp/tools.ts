import { basename } from 'node:path';
import { makeProjectId } from '../core/project.js';
import { readRepoInfo } from '../git/repo.js';
import { renderContextBlock } from '../retrieval/pack.js';
import { runCrossProjectQuery, runHybridQuery } from '../retrieval/query-pipeline.js';
import { openAllProjectSources } from '../retrieval/sources.js';
import { resolveWorkspace } from '../config/workspace.js';
import { MemoryStore, type RecentNode } from '../store/store.js';
import type { ContradictionSuggestionRow } from '../store/contradictions.js';
import { OllamaEmbeddingProvider } from '../vector/embed.js';
import { runInit } from '../cli/commands/init.js';
import { runSync, type SyncOptions } from '../cli/commands/sync.js';
import { runMarkStale } from '../cli/commands/mark-stale.js';

/**
 * Thin MCP-facing wrappers over the same CLI logic (`runSync`, the hybrid
 * query pipeline, `MemoryStore.stats`) -- no new business logic here. Every
 * tool takes an explicit `projectRoot` because, unlike a terminal command,
 * an MCP tool call carries no implicit shell cwd.
 */

export interface SearchMemoryInput {
  projectRoot: string;
  query: string;
  budget?: number;
  candidates?: number;
  /** BM25 only -- skip embedding the query and vector search. Mainly for tests; real callers want hybrid retrieval. */
  noVector?: boolean;
  /** Search every repository NexusMem has been run in on this machine, not just `projectRoot`. */
  allProjects?: boolean;
  /** ISO-8601 date/time: only nodes recorded (not just dated) at or before this instant -- "what did the store hold as of then", not "what happened then". */
  asOf?: string;
}

export interface SearchMemoryOutput {
  text: string;
  matched: number;
  bm25Matched: number;
  vectorMatched: number;
  tokensUsed: number;
  tokensBudget: number;
  /** Names of the repositories actually searched -- one entry unless `allProjects` was set. */
  projectsSearched: string[];
}

export async function searchMemory(input: SearchMemoryInput): Promise<SearchMemoryOutput> {
  const repo = await readRepoInfo(input.projectRoot);
  const ws = resolveWorkspace(repo.root);
  const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });
  const budget = input.budget ?? 2000;
  const candidates = input.candidates ?? 30;
  let asOfEpoch: number | undefined;
  if (input.asOf) {
    const parsed = Date.parse(input.asOf);
    if (Number.isNaN(parsed)) throw new Error(`asOf "${input.asOf}" is not a parseable date`);
    asOfEpoch = parsed;
  }
  const queryOpts = {
    budget,
    candidates,
    embeddingProvider: input.noVector ? null : new OllamaEmbeddingProvider(),
    asOfEpoch,
  };

  if (input.allProjects) {
    const opened = await openAllProjectSources({ projectId, root: repo.root, dbPath: ws.dbPath });
    try {
      const { bm25Count, vectorCount, hits, packed } = await runCrossProjectQuery(opened.sources, input.query, queryOpts);
      return {
        text: renderContextBlock(input.query, packed),
        matched: hits.length,
        bm25Matched: bm25Count,
        vectorMatched: vectorCount,
        tokensUsed: packed.tokensUsed,
        tokensBudget: packed.tokensBudget,
        projectsSearched: opened.sources.map((s) => s.label),
      };
    } finally {
      opened.close();
    }
  }

  const store = MemoryStore.open(ws.dbPath);
  try {
    const { bm25Count, vectorCount, hits, packed } = await runHybridQuery(store, projectId, input.query, queryOpts);

    return {
      text: renderContextBlock(input.query, packed),
      matched: hits.length,
      bm25Matched: bm25Count,
      vectorMatched: vectorCount,
      tokensUsed: packed.tokensUsed,
      tokensBudget: packed.tokensBudget,
      projectsSearched: [basename(repo.root) || repo.root],
    };
  } finally {
    store.close();
  }
}

export interface SyncProjectInput {
  projectRoot: string;
  /** Skip the embedding pass for this sync. Mainly for tests; real callers want vectors kept fresh. */
  noEmbed?: boolean;
  /** Delete every node from this exact source (e.g. `shell:pwsh`) instead of syncing. Dry-run unless `yes` is also set. */
  pruneSource?: string;
  /** Shortcut for `pruneSource` on shell:pwsh, shell:bash and shell:zsh at once -- the dead pre-hook scrape sources. */
  pruneStaleShell?: boolean;
  /** Confirms an irreversible `pruneSource`/`pruneStaleShell` delete. Without it, the matching count is returned and nothing is removed. */
  yes?: boolean;
}

export interface SyncProjectOutput {
  summary: string;
}

/**
 * Collects `runInit`/`runSync`'s summary through an explicit sink rather than
 * by reassigning `process.stdout.write`, which is what this used to do.
 *
 * That mattered more than it looked: under the stdio transport, `stdout` *is*
 * the JSON-RPC channel. `StdioServerTransport` holds the stream object and
 * resolves `.write` at send time, so a patched `write` also intercepts
 * protocol traffic -- a response emitted while a sync was running would land
 * in the capture buffer, and the patch's unconditional `return true` would
 * report it as delivered. Overlapping syncs compounded it: the second call
 * saved the first call's patch as "the original" and restored that instead.
 *
 * Passing a sink keeps the single shared implementation (the reason for the
 * original trade) without borrowing a global that something else owns.
 *
 * Always runs `init` first: an MCP client has no reason to know this tool
 * needs a separate init step, and `runInit` is already a safe no-op (just a
 * printed notice) when the project is initialized already.
 */
export async function syncProject(input: SyncProjectInput): Promise<SyncProjectOutput> {
  const chunks: string[] = [];
  const out = (chunk: string) => {
    chunks.push(chunk);
  };

  await runInit({ cwd: input.projectRoot, force: false, hook: false, enableConversation: false, out });

  const opts: SyncOptions = {
    cwd: input.projectRoot,
    full: false,
    rebuild: false,
    quiet: true,
    noEmbed: input.noEmbed,
    pruneSource: input.pruneSource,
    pruneStaleShell: input.pruneStaleShell,
    yes: input.yes,
    out,
  };
  await runSync(opts);

  return { summary: stripAnsi(chunks.join('').trim()) };
}

/**
 * Strips ANSI SGR color codes (`\x1b[...m`) from CLI-formatted text before
 * it leaves the MCP boundary.
 *
 * `runInit`/`runSync` format their `out` stream with picocolors for
 * terminal display -- correct there. But picocolors' own source
 * (`node_modules/picocolors/picocolors.js`) treats `platform === 'win32'`
 * as sufficient evidence of color support on its own; it never checks
 * `process.stdout.isTTY`. This process's stdout is the MCP JSON-RPC
 * channel, piped, never a terminal, on every platform -- so on Windows the
 * summary came out colorized regardless. Confirmed live, not just reasoned
 * about: a real MCP client (the VS Code extension's Output channel)
 * rendered the raw escape codes as literal text.
 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

export interface ListRecentMemoryInput {
  projectRoot: string;
  /** Max items to return, newest first. Default 20. */
  limit?: number;
}

export interface ListRecentMemoryOutput {
  items: RecentNode[];
}

/**
 * Chronology, not relevance -- "what has this project's memory recorded
 * lately" rather than "what answers this question" (that's `searchMemory`).
 * Built for the VS Code extension's sidebar view, which lists rather than
 * searches.
 */
export async function listRecentMemory(input: ListRecentMemoryInput): Promise<ListRecentMemoryOutput> {
  const repo = await readRepoInfo(input.projectRoot);
  const ws = resolveWorkspace(repo.root);
  const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });

  const store = MemoryStore.open(ws.dbPath);
  try {
    return { items: store.listRecentNodes(projectId, input.limit) };
  } finally {
    store.close();
  }
}

export interface GetStatusInput {
  projectRoot: string;
}

export interface GetStatusOutput {
  total: number;
  byKind: Record<string, number>;
  sources: Array<{ source: string; cursor: string | null; lastRunAt: number | null }>;
}

export async function getStatus(input: GetStatusInput): Promise<GetStatusOutput> {
  const repo = await readRepoInfo(input.projectRoot);
  const ws = resolveWorkspace(repo.root);
  const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });

  const store = MemoryStore.open(ws.dbPath);
  try {
    const stats = store.stats(projectId);
    return { total: stats.total, byKind: stats.byKind, sources: store.listSyncState(projectId) };
  } finally {
    store.close();
  }
}

export interface ListStaleSuggestionsInput {
  projectRoot: string;
  /** Max suggestions to return, most recently judged first. Default 50. */
  limit?: number;
}

export interface ListStaleSuggestionsOutput {
  suggestions: ContradictionSuggestionRow[];
}

/**
 * Open contradiction verdicts (from `nexusmem stale --check-contradictions`,
 * or sync's own automatic leg) that no human has acted on yet -- the same
 * "open" definition `nexusmem stale`'s plain listing decorates with, not a
 * fresh SLM pass. Built for the VS Code extension's review sidebar, which
 * lists standing suggestions rather than triggering new judgments.
 */
export async function listStaleSuggestions(input: ListStaleSuggestionsInput): Promise<ListStaleSuggestionsOutput> {
  const repo = await readRepoInfo(input.projectRoot);
  const ws = resolveWorkspace(repo.root);
  const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });

  const store = MemoryStore.open(ws.dbPath);
  try {
    return { suggestions: store.listContradictionSuggestions(projectId, { limit: input.limit }) };
  } finally {
    store.close();
  }
}

export interface ResolveStaleSuggestionInput {
  projectRoot: string;
  /** The stale/superseded side of the suggestion. */
  candidateId: string;
  /** 'accept' writes the supersede link (same effect as `mark-stale`); 'dismiss' silences the suggestion without touching ranking. */
  action: 'accept' | 'dismiss';
  /** The newer, superseding node. Required for 'accept', ignored for 'dismiss'. */
  againstId?: string;
}

export interface ResolveStaleSuggestionOutput {
  summary: string;
}

/**
 * 'accept' reuses `runMarkStale` itself (not just its store call), so the
 * same-project validation and the human-readable summary stay in one place.
 * 'dismiss' has no comparable CLI command function to reuse -- `nexusmem
 * stale --dismiss` is a single store call wrapped in listing logic this tool
 * doesn't need -- so it goes straight to the store, same as `listRecentMemory`
 * above does for its own single-call read.
 */
export async function resolveStaleSuggestion(input: ResolveStaleSuggestionInput): Promise<ResolveStaleSuggestionOutput> {
  if (input.action === 'dismiss') {
    const repo = await readRepoInfo(input.projectRoot);
    const ws = resolveWorkspace(repo.root);
    const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });

    const store = MemoryStore.open(ws.dbPath);
    try {
      const dismissed = store.dismissContradictionSuggestion(projectId, input.candidateId);
      return {
        summary: dismissed > 0
          ? `dismissed the contradiction suggestion for ${input.candidateId}`
          : `no open contradiction suggestion for ${input.candidateId}`,
      };
    } finally {
      store.close();
    }
  }

  if (!input.againstId) {
    throw new Error('againstId is required to accept a stale suggestion');
  }

  const chunks: string[] = [];
  await runMarkStale({
    cwd: input.projectRoot,
    nodeId: input.candidateId,
    supersedesId: input.againstId,
    out: (chunk) => chunks.push(chunk),
  });
  return { summary: stripAnsi(chunks.join('').trim()) };
}
