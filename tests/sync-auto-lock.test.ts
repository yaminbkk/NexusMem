import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/commands/init.js';
import { runSync } from '../src/cli/commands/sync.js';
import { acquireSyncLock } from '../src/cli/sync-lock.js';
import { resolveWorkspace } from '../src/config/workspace.js';
import { gitFixture } from './helpers.js';

/**
 * CLI-level coverage for `sync --auto`, the flag the post-commit hook uses
 * (see `src/hooks/git-post-commit.ts`). Only `--auto` should acquire and
 * check `sync-lock.ts`'s lock -- a manually-typed `nexusmem sync` must always
 * run, lock or no lock, since a user who explicitly asked for a sync should
 * never see it silently skipped.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-sync-auto-'));
  const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'chore: initial commit');

  await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sync --auto', () => {
  it('runs normally when no other sync holds the lock', async () => {
    const chunks: string[] = [];
    const code = await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, auto: true, out: (c) => chunks.push(c) });

    expect(code).toBe(0);
    expect(stripAnsi(chunks.join(''))).toMatch(/synced 1 commit/);
  });

  it('skips instead of running when another --auto sync already holds the lock, reporting it through `out` (not `log`)', async () => {
    // Through `out`, not `log`: the post-commit hook always runs with `--quiet`,
    // and `log` is gated on `!quiet` -- if the skip message went through `log`,
    // a `quiet: true` run (the hook's actual invocation) would report nothing
    // at all, anywhere, making a skip indistinguishable from the hook never
    // firing. This is why the assertion below runs with `quiet: true`.
    const ws = resolveWorkspace(dir);
    const lock = acquireSyncLock(ws.dir);
    expect(lock).not.toBeNull();

    try {
      const chunks: string[] = [];
      const code = await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, auto: true, out: (c) => chunks.push(c) });
      expect(code).toBe(0);
      expect(stripAnsi(chunks.join(''))).toMatch(/auto-sync.*already running.*skipping/);
    } finally {
      lock?.release();
    }
  });

  it('a plain (non-auto) sync ignores an existing lock and runs anyway', async () => {
    const ws = resolveWorkspace(dir);
    const lock = acquireSyncLock(ws.dir);
    expect(lock).not.toBeNull();

    try {
      const chunks: string[] = [];
      const code = await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, out: (c) => chunks.push(c) });

      expect(code).toBe(0);
      expect(stripAnsi(chunks.join(''))).toMatch(/synced 1 commit/);
    } finally {
      lock?.release();
    }
  });

  it('releases the lock after finishing, so a later --auto sync can acquire it again', async () => {
    const first = await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, auto: true, out: () => {} });
    expect(first).toBe(0);

    const chunks: string[] = [];
    const second = await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true, auto: true, out: (c) => chunks.push(c) });

    expect(second).toBe(0);
    expect(stripAnsi(chunks.join(''))).toMatch(/git up to date|synced 0 commit/);
  });
});
