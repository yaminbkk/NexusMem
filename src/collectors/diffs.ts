import { redact } from '../conversation/redact.js';
import { makeNodeId } from '../core/ids.js';
import { truncate } from '../core/text.js';
import type { MemoryNode } from '../core/types.js';
import { readCommitDiffs, type RawCommitDiff, type RawFileDiff, type ReadCommitDiffsOptions } from '../git/diff.js';
import { parseConventionalHeader, TYPE_WEIGHTS } from './git-commits.js';

/**
 * Maps commit patches onto MemoryNodes, one per changed file.
 *
 * The `git_commit` node answers "what changed and why did the author say they
 * changed it"; this one answers "what did the change actually look like".
 * Those are different questions, and the second is the one an agent asks when
 * it is about to edit the same lines -- the commit node's `Files changed:`
 * list can say `src/git/exec.ts (+41/-6)` without containing a single line of
 * the code that makes the answer.
 *
 * One node per file rather than per commit: a commit that touches six files
 * would otherwise pack six unrelated patches into one budgeted summary, and
 * retrieval could only ever return all of them or none.
 */

export const DIFF_SOURCE = 'diff';

export interface DiffCollectorOptions extends ReadCommitDiffsOptions {
  /** Keep at most this many files per commit, biggest churn first. Default 20. */
  maxFilesPerCommit?: number;
  /** Hard cap on one node's body, to bound index and embedding cost. Default 2000. */
  maxBodyChars?: number;
}

const DEFAULTS = { maxFilesPerCommit: 20, maxBodyChars: 2000 } as const;
const MAX_TITLE_CHARS = 200;

/**
 * Paths whose diff is machine-written.
 *
 * A lockfile churns on every dependency bump and would otherwise dominate the
 * corpus with thousands of lines nobody ever wrote or will ever ask about.
 * The commit node still records that the file changed.
 */
const GENERATED_PATHS: RegExp[] = [
  /(^|\/)(node_modules|dist|build|out|coverage|vendor|third_party)\//,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum)$/,
  /\.(min\.js|min\.css|map|snap)$/,
];

export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATHS.some((re) => re.test(path));
}

const TEST_PATHS = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Hand-written but almost always mechanical wiring (a script entry, a
 * dependency bump, a contribution point) rather than the change someone
 * asking about a feature actually wants -- the same "not the interesting
 * content" reasoning as `TEST_PATHS`, just for the opposite reason (nobody
 * wrote a test *for* the feature; nobody explains the feature *in* the
 * manifest, they just register it there).
 */
const MANIFEST_PATHS = /(^|\/)(package\.json|tsconfig(\..+)?\.json)$/;

/**
 * Prior importance of one file's patch.
 *
 * Anchored on the commit's own type -- a patch inside a `fix:` is worth more
 * than the same patch inside a `chore:` -- then adjusted for what the patch
 * itself looks like. The size adjustments both point the same way: a surgical
 * change is usually the interesting one, and a thousand-line rewrite is
 * usually a move, a reformat or generated output that slipped past the path
 * filter.
 */
export function scoreFileDiff(subject: string, file: RawFileDiff): number {
  const header = parseConventionalHeader(subject);
  let score = header.type ? (TYPE_WEIGHTS[header.type] ?? 0.5) : 0.5;

  if (header.breaking) score += 0.1;
  if (TEST_PATHS.test(file.path)) score -= 0.1;
  if (MANIFEST_PATHS.test(file.path)) score -= 0.1;
  if (file.status === 'added') score += 0.05;
  if (file.status === 'deleted') score -= 0.1;

  const churn = file.insertions + file.deletions;
  if (churn <= 2) score -= 0.05;
  if (churn > 400) score *= 0.75;

  return Number(Math.min(1, Math.max(0.05, score)).toFixed(3));
}

function byChurnDesc(a: RawFileDiff, b: RawFileDiff): number {
  return b.insertions + b.deletions - (a.insertions + a.deletions);
}

/** Files worth indexing: real text hunks, hand-written path. */
export function indexableFiles(files: readonly RawFileDiff[]): RawFileDiff[] {
  return files.filter((f) => !f.binary && f.hunkCount > 0 && !isGeneratedPath(f.path));
}

const STATUS_LABEL: Record<RawFileDiff['status'], string> = {
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  modified: 'modified',
};

function fileTitle(shortSha: string, subject: string, file: RawFileDiff): string {
  return truncate(`${file.path} @ ${shortSha} — ${subject}`, MAX_TITLE_CHARS);
}

export function toMemoryNodes(
  commit: RawCommitDiff,
  projectId: string,
  opts: DiffCollectorOptions = {},
): MemoryNode[] {
  const maxFiles = opts.maxFilesPerCommit ?? DEFAULTS.maxFilesPerCommit;
  const maxBody = opts.maxBodyChars ?? DEFAULTS.maxBodyChars;

  const kept = indexableFiles(commit.files).sort(byChurnDesc).slice(0, maxFiles);

  return kept.map((file) => {
    const churn = `+${file.insertions}/-${file.deletions}`;
    const renamePart = file.previousPath ? `, renamed from ${file.previousPath}` : '';
    const head = [
      `${commit.subject} (${commit.shortSha})`,
      `${STATUS_LABEL[file.status]} ${file.path} (${churn}, ${file.hunkCount} hunk${file.hunkCount === 1 ? '' : 's'}${renamePart})`,
      '',
    ].join('\n');

    // High-confidence rules only: this body is source code, and the key/value
    // rule would rewrite ordinary lines like `apiKey = config.apiKey` into a
    // redaction marker. See redact.ts.
    const { text: patch } = redact(file.patch, 'high-confidence');

    return {
      id: makeNodeId(projectId, 'code_diff', `${commit.sha}:${file.path}`),
      kind: 'code_diff',
      projectId,
      ts: commit.authoredAt,
      source: DIFF_SOURCE,
      title: fileTitle(commit.shortSha, commit.subject, file),
      body: truncate(head + patch, maxBody),
      files: [
        {
          path: file.path,
          ...(file.previousPath ? { previousPath: file.previousPath } : {}),
          insertions: file.insertions,
          deletions: file.deletions,
          binary: false,
        },
      ],
      signal: scoreFileDiff(commit.subject, file),
      provenance: 'observed',
      meta: {
        sha: commit.sha,
        shortSha: commit.shortSha,
        path: file.path,
        status: file.status,
        hunkCount: file.hunkCount,
        insertions: file.insertions,
        deletions: file.deletions,
        subject: commit.subject,
      },
    };
  });
}

/** Stream file-level diff nodes from `cwd`'s repository. */
export async function* collectCommitDiffs(
  cwd: string,
  projectId: string,
  opts: DiffCollectorOptions = {},
): AsyncGenerator<MemoryNode> {
  for await (const commit of readCommitDiffs(cwd, opts)) {
    for (const node of toMemoryNodes(commit, projectId, opts)) yield node;
  }
}
