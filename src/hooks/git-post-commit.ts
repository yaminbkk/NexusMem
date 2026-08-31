/**
 * Generates and detects the block NexusMem inserts into `.git/hooks/post-commit`
 * to run a full `nexusmem sync` (including embedding) after each commit.
 *
 * Unlike the pre-commit hook (`git-pre-commit.ts`), this one fires *after* the
 * commit already succeeded, so there is nothing left to block -- the only
 * concern is not making `git commit` itself wait. The spawned sync is
 * detached (`nohup ... &`) so the hook process exits immediately once it has
 * launched it; the sync's own output goes to `.nexusmem/post-commit-sync.log`
 * instead of the terminal, since nothing is left listening on stdout/stderr
 * once the hook has returned.
 *
 * `--auto` tells `nexusmem sync` to use its lock-and-skip behaviour (see
 * `sync-lock.ts`) instead of running unconditionally -- a burst of commits
 * (e.g. a rebase) should coalesce into one sync, not pile up N overlapping
 * full syncs each fighting over the same database.
 */

const MARK_START = '# >>> nexusmem postcommit hook >>>';
const MARK_END = '# <<< nexusmem postcommit hook <<<';
const SHEBANG = '#!/bin/sh';

export function renderHookSnippet(): string {
  return [
    MARK_START,
    '# Runs a full `nexusmem sync` (including embedding) in the background after',
    '# each commit -- detached, so this never makes `git commit` itself wait.',
    '# Output goes to .nexusmem/post-commit-sync.log, not the terminal.',
    '# Installed by: nexusmem hook git-post install',
    '# Remove with:  nexusmem hook git-post remove',
    'if command -v nexusmem >/dev/null 2>&1; then',
    '  mkdir -p .nexusmem',
    '  nohup nexusmem sync --quiet --auto >>.nexusmem/post-commit-sync.log 2>&1 &',
    'fi',
    MARK_END,
    '',
  ].join('\n');
}

export function isHookInstalled(content: string): boolean {
  return content.includes(MARK_START);
}

/** Real, non-empty content with no NexusMem marker -- i.e. a hook this installer did not write. */
export function isForeignHook(content: string): boolean {
  return content.trim().length > 0 && !isHookInstalled(content);
}

export function stripHookSnippet(content: string): string {
  const startIdx = content.indexOf(MARK_START);
  const endIdx = content.indexOf(MARK_END);
  if (startIdx === -1 || endIdx === -1) return content;

  const afterBlock = content.slice(endIdx + MARK_END.length).replace(/^\r?\n/, '');
  return content.slice(0, startIdx) + afterBlock;
}

/**
 * Idempotent, same shape as `git-pre-commit.ts`'s `upsertHookSnippet`: strips
 * any existing block first, then appends the current snippet at the end of
 * whatever content remains -- so a foreign hook installed with `--force`
 * still runs its own commands first.
 */
export function upsertHookSnippet(content: string): string {
  const stripped = stripHookSnippet(content).replace(/\s+$/, '');
  const prefix = stripped.length > 0 ? `${stripped}\n\n` : '';
  return `${prefix}${renderHookSnippet()}`;
}

/** A git hook file's shebang must be its first line; ensure one exists without disturbing existing content. */
export function ensureShebang(content: string): string {
  if (content.startsWith('#!')) return content;
  return content.length > 0 ? `${SHEBANG}\n${content}` : `${SHEBANG}\n`;
}

export { SHEBANG };
