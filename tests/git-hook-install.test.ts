import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureShebang, isForeignHook, isHookInstalled, renderHookSnippet, stripHookSnippet, upsertHookSnippet } from '../src/hooks/git-pre-commit.js';
import { ForeignGitHookError, gitHookStatus, installGitHook, removeGitHook, resolveGitHookTarget } from '../src/hooks/install-git-precommit.js';
import { gitFixture } from './helpers.js';

describe('git pre-commit hook snippet (pure)', () => {
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
    expect(withHook).toContain('nexusmem precheck');
  });

  it('appends after existing content, not before -- the existing hook still runs first', () => {
    const original = '#!/bin/sh\nnpx lint-staged\n';
    const withHook = upsertHookSnippet(original);
    expect(withHook.indexOf('npx lint-staged')).toBeLessThan(withHook.indexOf('nexusmem precheck'));
  });

  it('is idempotent: upserting twice does not duplicate the block', () => {
    const once = upsertHookSnippet('#!/bin/sh\n');
    const twice = upsertHookSnippet(once);
    expect(twice.match(/# >>> nexusmem precommit hook >>>/g)).toHaveLength(1);
  });

  it('strips cleanly back to the original content', () => {
    const original = '#!/bin/sh\n# before\necho hi\n';
    const withHook = upsertHookSnippet(original);
    expect(stripHookSnippet(withHook).replace(/\n+$/, '')).toBe(original.replace(/\n+$/, ''));
  });

  it('the rendered snippet invokes precheck with no flags, so it can never block a commit on its own', () => {
    // Checks the actual invocation line, not just snippet-wide text -- the
    // explanatory comment above it legitimately mentions "--strict" by name.
    expect(renderHookSnippet()).toContain('\n  nexusmem precheck\n');
  });

  it('ensureShebang adds one only when missing', () => {
    expect(ensureShebang('echo hi\n')).toBe('#!/bin/sh\necho hi\n');
    expect(ensureShebang('#!/usr/bin/env sh\necho hi\n')).toBe('#!/usr/bin/env sh\necho hi\n');
  });
});

describe('git hook install/remove/status (filesystem, scratch repo)', () => {
  let dir: string;
  let hookPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-githook-'));
    hookPath = (await resolveGitHookTarget(dir)).hookPath;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the hooks directory and file if neither exists', async () => {
    const result = await installGitHook({ hookPath });
    expect(result.changed).toBe(true);
    expect(result.appendedToForeign).toBe(false);
    expect((await gitHookStatus({ hookPath })).installed).toBe(true);
    expect(readFileSync(hookPath, 'utf8').startsWith('#!/bin/sh')).toBe(true);
  });

  it('is a no-op the second time', async () => {
    await installGitHook({ hookPath });
    const second = await installGitHook({ hookPath });
    expect(second.changed).toBe(false);
    expect(second.alreadyInstalled).toBe(true);
  });

  it('removes cleanly, deleting the file entirely when nothing else was in it', async () => {
    await installGitHook({ hookPath });
    const removed = await removeGitHook({ hookPath });
    expect(removed.changed).toBe(true);
    expect((await gitHookStatus({ hookPath })).installed).toBe(false);
    expect(() => readFileSync(hookPath, 'utf8')).toThrow();
  });

  it('removing when nothing is installed is a safe no-op', async () => {
    const result = await removeGitHook({ hookPath });
    expect(result.changed).toBe(false);
  });

  it('refuses to touch a foreign hook without --force', async () => {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(hookPath, '#!/bin/sh\nnpx lint-staged\n', 'utf8');

    await expect(installGitHook({ hookPath })).rejects.toThrow(ForeignGitHookError);
    // The foreign file itself must be untouched, not partially modified before the throw.
    expect(readFileSync(hookPath, 'utf8')).toBe('#!/bin/sh\nnpx lint-staged\n');
    expect((await gitHookStatus({ hookPath })).foreign).toBe(true);
  });

  it('appends after a foreign hook with --force, preserving it', async () => {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(hookPath, '#!/bin/sh\nnpx lint-staged\n', 'utf8');

    const result = await installGitHook({ hookPath }, { force: true });
    expect(result.appendedToForeign).toBe(true);

    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('npx lint-staged');
    expect(content).toContain('nexusmem precheck');
    expect(content.indexOf('npx lint-staged')).toBeLessThan(content.indexOf('nexusmem precheck'));
  });

  it('removing after a --force append restores the original foreign hook, not an empty file', async () => {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(hookPath, '#!/bin/sh\nnpx lint-staged\n', 'utf8');
    await installGitHook({ hookPath }, { force: true });

    const removed = await removeGitHook({ hookPath });
    expect(removed.changed).toBe(true);
    expect(readFileSync(hookPath, 'utf8')).toBe('#!/bin/sh\nnpx lint-staged\n');
  });

  it('sets the file executable on platforms that track the bit', async () => {
    await installGitHook({ hookPath });
    // On POSIX this reads back the real mode; on Windows/NTFS chmod is a
    // best-effort no-op (see installGitHook's comment), so this only asserts
    // where the platform actually tracks it.
    if (process.platform !== 'win32') {
      expect(statSync(hookPath).mode & 0o111).not.toBe(0);
    }
  });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

/**
 * `resolveGitHookTarget` reads `core.hooksPath`, which only takes effect
 * inside a real git repository -- the earlier describe block's plain
 * mkdtempSync dir never sets it, so it never exercises this path.
 */
describe('resolveGitHookTarget honors core.hooksPath', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-hookspath-'));
    gitFixture(dir, ['init', '-q', '-b', 'main'], { env: GIT_ENV });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to .git/hooks when core.hooksPath is unset', async () => {
    const target = await resolveGitHookTarget(dir);
    expect(target.hookPath).toBe(join(dir, '.git', 'hooks', 'pre-commit'));
    expect(target.hooksPathConfig).toBeNull();
  });

  it('resolves into a Husky-style relative core.hooksPath instead of .git/hooks', async () => {
    gitFixture(dir, ['config', 'core.hooksPath', '.husky']);
    const target = await resolveGitHookTarget(dir);
    expect(target.hookPath).toBe(join(dir, '.husky', 'pre-commit'));
    expect(target.hooksPathConfig).toBe('.husky');
  });

  it('resolves an absolute core.hooksPath verbatim', async () => {
    const absHooks = join(dir, 'custom-hooks');
    gitFixture(dir, ['config', 'core.hooksPath', absHooks]);
    const target = await resolveGitHookTarget(dir);
    expect(target.hookPath).toBe(join(absHooks, 'pre-commit'));
  });

  it('installing under a Husky-style core.hooksPath writes there, not .git/hooks', async () => {
    gitFixture(dir, ['config', 'core.hooksPath', '.husky']);
    const target = await resolveGitHookTarget(dir);

    await installGitHook(target);

    expect(readFileSync(target.hookPath, 'utf8')).toContain('nexusmem precheck');
    expect(() => readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf8')).toThrow();
  });
});
