import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureShebang, isForeignHook, isHookInstalled, renderHookSnippet, stripHookSnippet, upsertHookSnippet } from '../src/hooks/git-post-commit.js';
import {
  ForeignPostCommitHookError,
  installPostCommitGitHook,
  postCommitGitHookStatus,
  removePostCommitGitHook,
  resolvePostCommitHookTarget,
} from '../src/hooks/install-git-postcommit.js';

describe('git post-commit hook snippet (pure)', () => {
  it('is not installed in empty content, and empty content is not "foreign"', () => {
    expect(isHookInstalled('')).toBe(false);
    expect(isForeignHook('')).toBe(false);
  });

  it('real content with no marker is foreign', () => {
    expect(isForeignHook('#!/bin/sh\nnpx lint-staged\n')).toBe(true);
  });

  it('installing then checking reports installed, and is no longer "foreign"', () => {
    const withHook = upsertHookSnippet('');
    expect(isHookInstalled(withHook)).toBe(true);
    expect(isForeignHook(withHook)).toBe(false);
  });

  it('preserves unrelated hook content around the block', () => {
    const original = '#!/bin/sh\nnpx lint-staged\n';
    const withHook = upsertHookSnippet(original);
    expect(withHook).toContain('npx lint-staged');
    expect(withHook).toContain('nexusmem sync');
  });

  it('appends after existing content, not before -- the existing hook still runs first', () => {
    const original = '#!/bin/sh\nnpx lint-staged\n';
    const withHook = upsertHookSnippet(original);
    expect(withHook.indexOf('npx lint-staged')).toBeLessThan(withHook.indexOf('nexusmem sync'));
  });

  it('is idempotent: upserting twice does not duplicate the block', () => {
    const once = upsertHookSnippet('#!/bin/sh\n');
    const twice = upsertHookSnippet(once);
    expect(twice.match(/# >>> nexusmem postcommit hook >>>/g)).toHaveLength(1);
  });

  it('strips cleanly back to the original content', () => {
    const original = '#!/bin/sh\n# before\necho hi\n';
    const withHook = upsertHookSnippet(original);
    expect(stripHookSnippet(withHook).replace(/\n+$/, '')).toBe(original.replace(/\n+$/, ''));
  });

  it('the rendered snippet runs sync detached, quiet, and in auto (lock-and-skip) mode', () => {
    expect(renderHookSnippet()).toContain('nexusmem sync --quiet --auto >>.nexusmem/post-commit-sync.log 2>&1');
  });

  it('the rendered snippet truncates the log in place once it passes 2000 lines, so it cannot grow forever', () => {
    const snippet = renderHookSnippet();
    expect(snippet).toContain('wc -l <.nexusmem/post-commit-sync.log');
    expect(snippet).toContain('-gt 2000 ] && : >.nexusmem/post-commit-sync.log;');
  });

  it('ensureShebang adds one only when missing', () => {
    expect(ensureShebang('echo hi\n')).toBe('#!/bin/sh\necho hi\n');
    expect(ensureShebang('#!/usr/bin/env sh\necho hi\n')).toBe('#!/usr/bin/env sh\necho hi\n');
  });
});

describe('git post-commit hook install/remove/status (filesystem, scratch repo)', () => {
  let dir: string;
  let hookPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-githook-post-'));
    hookPath = resolvePostCommitHookTarget(dir).hookPath;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the hooks directory and file if neither exists', async () => {
    const result = await installPostCommitGitHook({ hookPath });
    expect(result.changed).toBe(true);
    expect(result.appendedToForeign).toBe(false);
    expect((await postCommitGitHookStatus({ hookPath })).installed).toBe(true);
    expect(readFileSync(hookPath, 'utf8').startsWith('#!/bin/sh')).toBe(true);
  });

  it('is a no-op the second time', async () => {
    await installPostCommitGitHook({ hookPath });
    const second = await installPostCommitGitHook({ hookPath });
    expect(second.changed).toBe(false);
    expect(second.alreadyInstalled).toBe(true);
  });

  it('removes cleanly, deleting the file entirely when nothing else was in it', async () => {
    await installPostCommitGitHook({ hookPath });
    const removed = await removePostCommitGitHook({ hookPath });
    expect(removed.changed).toBe(true);
    expect((await postCommitGitHookStatus({ hookPath })).installed).toBe(false);
    expect(() => readFileSync(hookPath, 'utf8')).toThrow();
  });

  it('removing when nothing is installed is a safe no-op', async () => {
    const result = await removePostCommitGitHook({ hookPath });
    expect(result.changed).toBe(false);
  });

  it('refuses to touch a foreign hook without --force', async () => {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(hookPath, '#!/bin/sh\nnpx lint-staged\n', 'utf8');

    await expect(installPostCommitGitHook({ hookPath })).rejects.toThrow(ForeignPostCommitHookError);
    expect(readFileSync(hookPath, 'utf8')).toBe('#!/bin/sh\nnpx lint-staged\n');
    expect((await postCommitGitHookStatus({ hookPath })).foreign).toBe(true);
  });

  it('appends after a foreign hook with --force, preserving it', async () => {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(hookPath, '#!/bin/sh\nnpx lint-staged\n', 'utf8');

    const result = await installPostCommitGitHook({ hookPath }, { force: true });
    expect(result.appendedToForeign).toBe(true);

    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('npx lint-staged');
    expect(content).toContain('nexusmem sync');
    expect(content.indexOf('npx lint-staged')).toBeLessThan(content.indexOf('nexusmem sync'));
  });

  it('removing after a --force append restores the original foreign hook, not an empty file', async () => {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(hookPath, '#!/bin/sh\nnpx lint-staged\n', 'utf8');
    await installPostCommitGitHook({ hookPath }, { force: true });

    const removed = await removePostCommitGitHook({ hookPath });
    expect(removed.changed).toBe(true);
    expect(readFileSync(hookPath, 'utf8')).toBe('#!/bin/sh\nnpx lint-staged\n');
  });

  it('sets the file executable on platforms that track the bit', async () => {
    await installPostCommitGitHook({ hookPath });
    if (process.platform !== 'win32') {
      expect(statSync(hookPath).mode & 0o111).not.toBe(0);
    }
  });
});
