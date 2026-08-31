import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    writeFileSync(join(dir, 'sync.lock'), JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() }));

    const lock = acquireSyncLock(dir);
    expect(lock).not.toBeNull();
  });

  it('reclaims a corrupt/unreadable lock file', () => {
    writeFileSync(join(dir, 'sync.lock'), 'not json');

    const lock = acquireSyncLock(dir);
    expect(lock).not.toBeNull();
  });
});
