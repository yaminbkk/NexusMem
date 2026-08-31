import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireSyncLock } from '../src/cli/sync-lock.js';

describe('acquireSyncLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-synclock-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires the lock when none exists, creating the workspace dir if needed', () => {
    const nested = join(dir, 'nested');
    const lock = acquireSyncLock(nested);
    expect(lock).not.toBeNull();
    expect(readFileSync(join(nested, 'sync.lock'), 'utf8')).toContain(String(process.pid));
  });

  it('refuses a second acquire while the first is still held (same live process)', () => {
    const first = acquireSyncLock(dir);
    expect(first).not.toBeNull();

    const second = acquireSyncLock(dir);
    expect(second).toBeNull();
  });

  it('release lets a later acquire succeed again', () => {
    const first = acquireSyncLock(dir);
    first?.release();

    const second = acquireSyncLock(dir);
    expect(second).not.toBeNull();
  });

  it('reclaims a stale lock left by a dead pid', () => {
    // Far beyond any real OS pid (Windows caps well under this, POSIX pid_max
    // typically far lower too), so `process.kill(pid, 0)` reliably throws.
    writeFileSync(join(dir, 'sync.lock'), JSON.stringify({ pid: 999_999_999 }));

    const lock = acquireSyncLock(dir);
    expect(lock).not.toBeNull();
  });

  it('reclaims a corrupt/unreadable lock file', () => {
    writeFileSync(join(dir, 'sync.lock'), 'not json');

    const lock = acquireSyncLock(dir);
    expect(lock).not.toBeNull();
  });

  it('reclaims a lock recorded with pid 0, instead of treating it as permanently alive', () => {
    // `process.kill(0, 0)` signals the caller's own process group and does not
    // throw -- naively trusting that as "alive" would make a {pid:0} lock (from
    // corruption or a partial write) unreclaimable forever. This must never
    // come from a real acquire (`process.pid` is never 0), only from bad data.
    writeFileSync(join(dir, 'sync.lock'), JSON.stringify({ pid: 0 }));

    const lock = acquireSyncLock(dir);
    expect(lock).not.toBeNull();
  });

  it('does NOT reclaim a lock whose pid exists but is inaccessible (EPERM, not ESRCH)', () => {
    const pid = 123;
    writeFileSync(join(dir, 'sync.lock'), JSON.stringify({ pid }));

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target) => {
      if (target === pid) {
        const err = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
        throw err;
      }
      return true;
    });

    try {
      const lock = acquireSyncLock(dir);
      expect(lock).toBeNull();
      // Must not have deleted the lock it couldn't confirm was dead.
      expect(readFileSync(join(dir, 'sync.lock'), 'utf8')).toContain(String(pid));
    } finally {
      killSpy.mockRestore();
    }
  });

  it('does reclaim a lock whose pid is confirmed gone (ESRCH)', () => {
    const pid = 456;
    writeFileSync(join(dir, 'sync.lock'), JSON.stringify({ pid }));

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target) => {
      if (target === pid) {
        const err = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
        throw err;
      }
      return true;
    });

    try {
      const lock = acquireSyncLock(dir);
      expect(lock).not.toBeNull();
    } finally {
      killSpy.mockRestore();
    }
  });
});
