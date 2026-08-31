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
    return typeof parsed?.pid === 'number' ? (parsed as LockOwner) : null;
  } catch {
    return null;
  }
}

/** `kill -0`: throws if the pid is gone, succeeds (without actually signalling) if it's alive. Works on Windows too. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
