/**
 * The canonical shape of everything NexusMem remembers.
 *
 * Every collector (git, shell, diffs, notes) normalises into a MemoryNode so
 * that storage, ranking and context-packing never need to know where a fact
 * came from.
 */

export type NodeKind =
  | 'git_commit'
  | 'shell_command'
  | 'code_diff'
  | 'note'
  | 'conversation_turn'
  | 'doc_section'
  | 'session_summary';

/**
 * Trust tier, highest first: `observed` (the event itself), `authored` (a
 * human's own written claim), `recorded` (verbatim discourse about events),
 * `derived` (a model's distillation). Set per-collector at ingest time.
 */
export type Provenance = 'observed' | 'authored' | 'recorded' | 'derived';

/**
 * Whether a human has checked a claim -- the axis `provenance` deliberately
 * doesn't cover (source vs. verification are different questions). Every
 * node starts `candidate`; only `nexusmem review <id> --verify`/`--reject`
 * moves it, so this is never set by a collector and never touched by a
 * re-sync (see `upsertNodes`).
 */
export type TrustState = 'candidate' | 'verified' | 'rejected';

/** Fallback for nodes written without an explicit `provenance` (older callers, test fixtures). */
export function defaultProvenanceForKind(kind: NodeKind): Provenance {
  switch (kind) {
    case 'git_commit':
    case 'code_diff':
    case 'shell_command':
      return 'observed';
    case 'doc_section':
    case 'note':
      return 'authored';
    case 'conversation_turn':
      return 'recorded';
    case 'session_summary':
      return 'derived';
  }
}

/** A single file touched by an event. */
export interface FileTouch {
  /** Repo-relative path, forward slashes, post-rename. */
  path: string;
  /** Set only when the file was renamed/moved in this event. */
  previousPath?: string;
  /** `null` for binary files, where git reports `-`. */
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface MemoryNode {
  /** Content-addressed, stable across re-syncs. See `makeNodeId`. */
  id: string;
  kind: NodeKind;
  /** Stable identity of the repo this node belongs to. See `makeProjectId`. */
  projectId: string;
  /** ISO-8601 with offset, taken from the event itself (never sync time). */
  ts: string;
  /** Provenance, e.g. `git`, `shell:pwsh`, `shell:zsh`. */
  source: string;
  /** One-line summary. Shown to the agent, and boosted in the search index. */
  title: string;
  /** Full searchable/embeddable text. */
  body: string;
  files: FileTouch[];
  /**
   * Structural importance in 0..1, computed once at ingest time.
   *
   * Retrieval ranks by `relevance * signal`, not relevance alone -- this is
   * what keeps a chatty `chore: bump deps` from eating the context budget that
   * a `fix:` commit deserves.
   */
  signal: number;
  /** Kind-specific extras. Persisted as a JSON blob. */
  meta: Record<string, unknown>;
  /** Optional here so it can default via `defaultProvenanceForKind`; collectors set it explicitly. */
  provenance?: Provenance;
  /** Id of an older node this one replaces. Down-weighted by the ranker, never deleted. Written by `nexusmem mark-stale`. */
  supersedes?: string | null;
}
