import { makeNodeId } from '../core/ids.js';
import { truncate } from '../core/text.js';
import type { MemoryNode } from '../core/types.js';
import type { RawGithubThread } from '../github/types.js';

/**
 * Maps a fetched issue/PR thread onto one MemoryNode -- deliberately one node
 * per thread, not one per comment. A `conversation_turn`-style per-message
 * split would need its own chunker for a shape (nested quoting, reactions,
 * review-comment vs. issue-comment) this pass doesn't try to model; folding
 * the whole thread into one node, truncated like a diff's patch or a doc
 * file's oversized section, is the narrower-but-correct choice that matches
 * every other collector's own "missed edge over wrong edge" discipline.
 */

const NOTABLE_LABELS = /\b(bug|help wanted|good first issue)\b/i;

/**
 * Prior importance of one thread.
 *
 * A merged PR is a real, accepted decision -- the strongest signal available
 * here, the same reasoning `scoreDocSection` gives README.md over an
 * arbitrary doc file. Real discussion (several comments) matters more than a
 * label alone; a closed thread with zero comments and no label is the
 * closest thing to noise this source produces (a duplicate closed on sight,
 * a stale bot-filed issue) and is scored below the 0.5 midline every other
 * collector centers on.
 */
export function scoreGithubThread(thread: RawGithubThread): number {
  let score = 0.4;

  if (thread.merged) score += 0.2;
  else if (thread.state === 'closed' && thread.comments.length === 0) score -= 0.15;

  if (thread.comments.length >= 3) score += 0.15;
  else if (thread.comments.length >= 1) score += 0.05;

  if (thread.labels.some((l) => NOTABLE_LABELS.test(l))) score += 0.1;

  return Number(Math.min(1, Math.max(0.05, score)).toFixed(3));
}

const MAX_TITLE_CHARS = 200;

function threadTitle(thread: RawGithubThread): string {
  const prefix = thread.type === 'pull_request' ? 'PR' : 'Issue';
  return truncate(`${prefix} #${thread.number}: ${thread.title}`, MAX_TITLE_CHARS);
}

function renderBody(thread: RawGithubThread): string {
  const status = thread.merged ? 'merged' : thread.state;
  const header = `${thread.title}\nopened by @${thread.author}, ${status}`;
  const opening = thread.body.trim();
  const commentsText = thread.comments
    .map((c) => `--- @${c.author} (${c.createdAt.slice(0, 10)}) ---\n${c.body.trim()}`)
    .join('\n\n');

  return [header, opening, commentsText].filter(Boolean).join('\n\n');
}

export interface GithubCollectorOptions {
  /** Default 4000, same default as `limits.maxBodyChars` elsewhere. */
  maxBodyChars?: number;
}

const DEFAULT_MAX_BODY_CHARS = 4000;

export function toMemoryNode(thread: RawGithubThread, projectId: string, opts: GithubCollectorOptions = {}): MemoryNode {
  const maxBody = opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  const naturalKey = `${thread.type}:${thread.number}`;
  const source = thread.type === 'pull_request' ? 'github:pr' : 'github:issue';

  return {
    id: makeNodeId(projectId, 'github_thread', naturalKey),
    kind: 'github_thread',
    projectId,
    ts: thread.updatedAt,
    source,
    title: threadTitle(thread),
    body: truncate(renderBody(thread), maxBody),
    files: [],
    signal: scoreGithubThread(thread),
    provenance: 'recorded', // verbatim discourse, same tier as conversation_turn
    meta: {
      number: thread.number,
      type: thread.type,
      state: thread.state,
      merged: thread.merged,
      labels: thread.labels,
      url: thread.url,
      commentCount: thread.comments.length,
    },
  };
}

export function collectGithubThreads(
  threads: readonly RawGithubThread[],
  projectId: string,
  opts: GithubCollectorOptions = {},
): MemoryNode[] {
  return threads.map((thread) => toMemoryNode(thread, projectId, opts));
}
