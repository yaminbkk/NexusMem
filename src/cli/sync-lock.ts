import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Advisory file lock for `nexusmem sync --auto` (the post-commit hook's own
 * invocation), so a burst of commits (e.g. a rebase) coalesces into one sync
 * instead of piling up N overlapping full syncs fighting over the same
 * SQLite file. Only `--auto` acquires this -- a manually-typed `nexusmem
 * sync` must never silently no-op just because a background one is running.
 *
 * Not used to serialize *all* writers: WAL mode plus better-sqlite3's own
 * busy-timeout already covers a manual sync briefly overlapping an auto one.
 * This exists only to stop the hook itself from stacking up redundant work.
 */

interface LockOwner {
  pid: number;
  startedAt: string;
}

export interface SyncLock {
  release(): void;
}

function lockPath(wsDir: string): string {
  return join(wsDir, 'sync.lock');
}

function readOwner(path: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const pid = parsed?.pid;
    // Must be a genuine positive pid, not just typeof number: 0 is never a
    // real process's own `process.pid`, but `kill(0, 0)` doesn't throw (it
    // signals the caller's own process group) -- treating a `{pid:0}` lock
    // (corruption, a partial write) as belonging to a live process would make
    // it permanently unreclaimable.
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? (parsed as LockOwner) : null;
  } catch {
    return null;
  }
}

/**
 * `kill -0`: throws if the pid is gone, succeeds (without actually
 * signalling) if it's alive. Works on Windows too.
 *
 * Only `ESRCH` (no such process) counts as dead. Anything else -- `EPERM`
 * (the pid exists but this user can't signal it), or an unexpected error --
 * is treated as alive: reclaiming a lock that's still genuinely held lets two
 * syncs run concurrently against the same database, while wrongly treating a
 * dead one as alive just costs one skipped sync that the next commit's hook
 * picks up anyway. The two mistakes are not equally bad, so ties go to "alive".
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Acquires the lock, or returns `null` if another live process already holds
 * it. A lock file left behind by a process that no longer exists (crashed
 * mid-sync) is treated as stale and reclaimed automatically.
 */
export function acquireSyncLock(wsDir: string): SyncLock | null {
  mkdirSync(wsDir, { recursive: true });
  const path = lockPath(wsDir);

  for (;;) {
    try {
      // Exclusive create: atomically fails with EEXIST if the file is
      // already there, instead of a read-then-write that could race another
      // process between the two steps.
      writeFileSync(path, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, {
        flag: 'wx',
      });
      return { release: () => tryUnlink(path) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const owner = readOwner(path);
    if (owner && isPidAlive(owner.pid)) return null;

    // Stale lock (owner pid is gone, or the file was unreadable) -- reclaim it and retry.
    tryUnlink(path);
  }
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone -- fine
  }
}
