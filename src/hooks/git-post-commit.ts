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
 *
 * The log is truncated (emptied, not rotated) once it grows past
 * `LOG_TRUNCATE_THRESHOLD` lines, checked *before* each run appends -- so a
 * repository with the hook installed for months doesn't grow that file
 * forever. Truncation is a plain `>` on the same file (`: >file`), not a
 * write-elsewhere-then-rename: a rename swaps in a new inode, and another
 * invocation's append that's still mid-flight (e.g. a lock-skip message from
 * a commit that landed moments earlier) would keep writing to the old,
 * now-unreferenced inode and vanish once it closes. Truncating in place has
 * no such window -- a concurrent appender's fd keeps pointing at the same
 * file and simply continues writing from the new (shorter) end.
 *
 * Known limitation: the lock in `sync-lock.ts` serializes the actual sync
 * work (the database is never at risk), but not who gets to write to this
 * log file. A real burst of commits fast enough to launch genuinely
 * overlapping processes can still interleave two runs' text mid-line here --
 * confirmed live with five real-speed commits. Accepted for now since it's
 * cosmetic (the log is a diagnostic aid, not a source of truth) and the
 * fix (serializing log writes too, or giving each run its own file) adds
 * real complexity for a rare, non-destructive case.
 *
 * The marker/snippet mechanics (install-detection, strip, upsert, shebang)
 * are generic across every git hook type NexusMem installs -- see
 * `git-hook-snippet.ts`, which this just binds to this hook's own markers.
 */

import {
  ensureShebang as ensureShebangGeneric,
  isForeignHook as isForeignHookGeneric,
  isHookInstalled as isHookInstalledGeneric,
  SHEBANG,
  stripHookSnippet as stripHookSnippetGeneric,
  upsertHookSnippet as upsertHookSnippetGeneric,
  type HookMarkers,
} from './git-hook-snippet.js';

const MARK_START = '# >>> nexusmem postcommit hook >>>';
const MARK_END = '# <<< nexusmem postcommit hook <<<';
const MARKERS: HookMarkers = { markStart: MARK_START, markEnd: MARK_END };
const LOG_PATH = '.nexusmem/post-commit-sync.log';
const LOG_TRUNCATE_THRESHOLD = 2000;

/** Written fresh after every run so `nexusmem status` can report the last outcome without parsing the free-text log. */
export const STATE_PATH = '.nexusmem/post-commit-sync-state.json';

export function renderHookSnippet(): string {
  return [
    MARK_START,
    '# Runs a full `nexusmem sync` (including embedding) in the background after',
    '# each commit -- detached, so this never makes `git commit` itself wait.',
    `# Output goes to ${LOG_PATH} (reset once it passes ${LOG_TRUNCATE_THRESHOLD} lines), not the terminal.`,
    `# Last-run outcome is also written to ${STATE_PATH} (\`nexusmem status\` reads it).`,
    '# Installed by: nexusmem hook git-post install',
    '# Remove with:  nexusmem hook git-post remove',
    'if command -v nexusmem >/dev/null 2>&1; then',
    '  mkdir -p .nexusmem',
    '  nohup sh -c \'',
    `    [ "$(wc -l <${LOG_PATH} 2>/dev/null || echo 0)" -gt ${LOG_TRUNCATE_THRESHOLD} ] && : >${LOG_PATH}`,
    `    nexusmem sync --quiet --auto >>${LOG_PATH} 2>&1`,
    '    ec=$?',
    '    ok=$([ "$ec" -eq 0 ] && echo true || echo false)',
    // Atomic rename, not truncate-in-place like the log above: this file is
    // wholesale-replaced each run (no concurrent-appender fd to protect), so
    // a rename avoids a reader ever seeing a half-written, unparseable JSON file.
    // Double-quoted, not single: this whole block is already inside the
    // outer nohup sh -c '...' single-quoted argument below, and single
    // quotes cannot nest -- one here would close that argument early.
    `    printf "{\\"ts\\":\\"%s\\",\\"ok\\":%s,\\"exitCode\\":%s}\\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ok" "$ec" >${STATE_PATH}.tmp && mv ${STATE_PATH}.tmp ${STATE_PATH}`,
    "  ' >/dev/null 2>&1 &",
    'fi',
    MARK_END,
    '',
  ].join('\n');
}

export interface PostCommitSyncState {
  ts: string;
  ok: boolean;
  exitCode: number;
}

/** A malformed or half-written file (e.g. from a version predating this field) is treated as absent, not fatal. */
export function parsePostCommitSyncState(raw: string): PostCommitSyncState | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;

  const o = obj as Record<string, unknown>;
  if (typeof o.ts !== 'string' || typeof o.ok !== 'boolean' || typeof o.exitCode !== 'number') return null;
  return { ts: o.ts, ok: o.ok, exitCode: o.exitCode };
}

export function isHookInstalled(content: string): boolean {
  return isHookInstalledGeneric(content, MARKERS);
}

export function isForeignHook(content: string): boolean {
  return isForeignHookGeneric(content, MARKERS);
}

export function stripHookSnippet(content: string): string {
  return stripHookSnippetGeneric(content, MARKERS);
}

export function upsertHookSnippet(content: string): string {
  return upsertHookSnippetGeneric(content, MARKERS, renderHookSnippet);
}

export const ensureShebang = ensureShebangGeneric;
export { SHEBANG };
