import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHookGitPostInstall, runHookGitPostRemove, runHookGitPostStatus } from '../src/cli/commands/hook-git.js';
import { resolvePostCommitHookTarget } from '../src/hooks/install-git-postcommit.js';
import { gitFixture } from './helpers.js';

/**
 * CLI-level coverage for `nexusmem hook git-post install/remove/status`,
 * same shape as `tests/hook-git-cli.test.ts` for the pre-commit hook.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

let dir: string;
let hookPath: string;
let stdout: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-hookgitpost-cli-'));
  gitFixture(dir, ['init', '-q', '-b', 'main'], { env: GIT_ENV });
  hookPath = resolvePostCommitHookTarget(dir).hookPath;

  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(chunk.toString());
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('nexusmem hook git-post', () => {
  it('install creates the hook and reports it as newly installed', async () => {
    const code = await runHookGitPostInstall({ cwd: dir });

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('installed');
    expect(stdout.join('')).toContain('git post-commit hook');
    expect(readFileSync(hookPath, 'utf8')).toContain('nexusmem sync');
  });

  it('install is idempotent: a second run reports already up to date', async () => {
    await runHookGitPostInstall({ cwd: dir });
    const before = readFileSync(hookPath, 'utf8');
    stdout.length = 0;

    const code = await runHookGitPostInstall({ cwd: dir });

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('already up to date');
    expect(readFileSync(hookPath, 'utf8')).toBe(before);
  });

  it('status reports not installed before install, installed after', async () => {
    await runHookGitPostStatus({ cwd: dir });
    expect(stdout.join('')).toContain('not installed');

    stdout.length = 0;
    await runHookGitPostInstall({ cwd: dir });
    stdout.length = 0;

    await runHookGitPostStatus({ cwd: dir });
    expect(stdout.join('')).toContain('installed');
    expect(stdout.join('')).not.toContain('not installed');
  });

  it('remove reports nothing to remove when no hook is installed', async () => {
    const code = await runHookGitPostRemove({ cwd: dir });

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('nothing to remove');
  });

  it('remove strips the hook after install, leaving status not installed again', async () => {
    await runHookGitPostInstall({ cwd: dir });
    stdout.length = 0;

    const code = await runHookGitPostRemove({ cwd: dir });
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('removed');

    stdout.length = 0;
    await runHookGitPostStatus({ cwd: dir });
    expect(stdout.join('')).toContain('not installed');
  });

  it('refuses to overwrite a foreign hook without --force', async () => {
    writeFileSync(hookPath, '#!/bin/sh\nnpx lint-staged\n');

    await expect(runHookGitPostInstall({ cwd: dir })).rejects.toThrow(/already has a post-commit hook/);
    expect(readFileSync(hookPath, 'utf8')).toBe('#!/bin/sh\nnpx lint-staged\n');
  });

  it('appends after a foreign hook with --force, and status flags it while unforced', async () => {
    writeFileSync(hookPath, '#!/bin/sh\nnpx lint-staged\n');

    await runHookGitPostStatus({ cwd: dir });
    expect(stdout.join('')).toContain('a foreign hook exists');
    stdout.length = 0;

    const code = await runHookGitPostInstall({ cwd: dir, force: true });
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('appended after an existing post-commit hook');

    const content = readFileSync(hookPath, 'utf8');
    expect(content.indexOf('npx lint-staged')).toBeLessThan(content.indexOf('nexusmem sync'));
  });
});
