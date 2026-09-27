import { mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { globalWorkspaceDir } from '../config/paths.js';

/**
 * What has already been said to one agent session, so ambient memory cannot
 * become ambient noise: the same failure is explained once, and a session has
 * a hard ceiling on how many injections it can receive.
 *
 * A small JSON file rather than a database: the recall path runs per tool
 * call, and this has to stay cheap and never block on a lock.
 */

export const MAX_INJECTIONS_PER_SESSION = 5;
const MAX_SESSIONS_KEPT = 20;

interface SessionState {
  count: number;
  keys: string[];
  at: number;
}

type StateFile = Record<string, SessionState>;

export function recallStatePath(): string {
  return join(globalWorkspaceDir(), 'agent-recall-state.json');
}

function read(path: string): StateFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as StateFile) : {};
  } catch {
    return {};
  }
}

/**
 * True when this session may be told about `key` now, at this instant, with
 * no lock held. Cheap on purpose: a caller uses this to skip the DB work and
 * recall computation early when the quota is obviously already spent, before
 * `claimInjection` -- the one call that actually decides and records -- ever
 * runs. Two calls racing on the read this returns can both come back true;
 * `claimInjection` is what makes only one of them count.
 */
export function shouldInject(sessionId: string, key: string, path = recallStatePath()): boolean {
  const session = read(path)[sessionId];
  if (!session) return true;
  return session.count < MAX_INJECTIONS_PER_SESSION && !session.keys.includes(key);
}

/** How long a held lock can be before it is treated as abandoned by a crashed process, not busy. */
const LOCK_STALE_MS = 2000;

/**
 * `mkdir` is atomic on every platform this runs on -- exactly one caller's
 * call can succeed when the directory does not yet exist -- unlike a plain
 * read then write, which two processes can both pass through unlocked. Never
 * waits: contention returns `false` immediately, the same answer a expired
 * quota would give, so a caller already treats it as "someone already
 * decided this, do not print again" rather than as an error to retry.
 */
function acquireLock(path: string): boolean {
  const lockPath = `${path}.lock`;
  try {
    mkdirSync(lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    // A lock this old was left by a process that died mid-write (the section
    // it guards is a JSON parse and one small write, never seconds of work).
    // Breaking it is what keeps one crashed process from silencing recall
    // for every session afterward.
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        rmdirSync(lockPath);
        mkdirSync(lockPath);
        return true;
      }
    } catch {
      // Lost the race to clear it, or another caller already did -- either
      // way this call does not hold the lock.
    }
    return false;
  }
}

function releaseLock(path: string): void {
  try {
    rmdirSync(`${path}.lock`);
  } catch {
    // Already gone, or never ours to begin with.
  }
}

/**
 * The one call that both decides and records, as a single lock-protected
 * step -- replaces a separate `shouldInject` + write, which two processes
 * racing on the same key could both pass before either recorded anything.
 * Returns whether THIS call may print `key` for `sessionId`; a caller must
 * only print when this returns `true`, never on `shouldInject` alone.
 *
 * Lock contention (another call mid-write, which lasts microseconds) and a
 * failed write both return `false`: a false negative here just costs one
 * skipped note, which is the safe direction to fail in, never a duplicate.
 */
export function claimInjection(sessionId: string, key: string, path = recallStatePath(), now = Date.now()): boolean {
  if (!acquireLock(path)) return false;
  try {
    const state = read(path);
    const session = state[sessionId];
    if (session && (session.count >= MAX_INJECTIONS_PER_SESSION || session.keys.includes(key))) return false;

    const next: SessionState = session ?? { count: 0, keys: [], at: now };
    next.count += 1;
    next.at = now;
    if (!next.keys.includes(key)) next.keys.push(key);
    state[sessionId] = next;

    // Sessions end without telling anyone, so keep only the most recent few.
    const pruned = Object.entries(state)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, MAX_SESSIONS_KEPT);

    try {
      writeFileSync(path, JSON.stringify(Object.fromEntries(pruned)), { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch {
      // A quota we cannot persist must not break the agent's tool call --
      // but this call itself still printed nothing yet, so it must not claim
      // a slot it could not record; the caller stays silent this time.
      return false;
    }
  } finally {
    releaseLock(path);
  }
}
