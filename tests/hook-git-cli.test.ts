import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHookGitInstall, runHookGitRemove, runHookGitStatus } from '../src/cli/commands/hook-git.js';
import { resolveGitHookTarget } from '../src/hooks/install-git-precommit.js';
import { gitFixture } from './helpers.js';

/**
 * CLI-level coverage for `nexusmem hook git install/remove/status`.
 * `resolveGitHookTarget` takes no override -- it derives `.git/hooks/pre-commit`
 * from the resolved repo root -- so unlike `hook.ts`'s test this needs a real
 * (temp, throwaway) git repository rather than an injected path. Same
 * gitFixture helper tests/status.test.ts and tests/precheck-cli.test.ts
 * already use for exactly this reason.
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-hookgit-cli-'));
  gitFixture(dir, ['init', '-q', '-b', 'main'], { env: GIT_ENV });
  hookPath = (await resolveGitHookTarget(dir)).hookPath;

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

describe('nexusmem hook git', () => {
  it('install creates the hook and reports it as newly installed', async () => {
    const code = await runHookGitInstall({ cwd: dir });

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('installed');
    expect(stdout.join('')).toContain('git pre-commit hook');
    expect(readFileSync(hookPath, 'utf8')).toContain('nexusmem precheck');
  });

  it('install is idempotent: a second run reports already up to date', async () => {
    await runHookGitInstall({ cwd: dir });
    const before = readFileSync(hookPath, 'utf8');
    stdout.length = 0;

    const code = await runHookGitInstall({ cwd: dir });

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('already up to date');
    expect(readFileSync(hookPath, 'utf8')).toBe(before);
  });

  it('status reports not installed before install, installed after', async () => {
    await runHookGitStatus({ cwd: dir });
    expect(stdout.join('')).toContain('not installed');

    stdout.length = 0;
    await runHookGitInstall({ cwd: dir });
    stdout.length = 0;

    await runHookGitStatus({ cwd: dir });
    expect(stdout.join('')).toContain('installed');
    expect(stdout.join('')).not.toContain('not installed');
  });

  it('remove reports nothing to remove when no hook is installed', async () => {
    const code = await runHookGitRemove({ cwd: dir });

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('nothing to remove');
  });

  it('remove strips the hook after install, leaving status not installed again', async () => {
    await runHookGitInstall({ cwd: dir });
    stdout.length = 0;

    const code = await runHookGitRemove({ cwd: dir });
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('removed');

    stdout.length = 0;
    await runHookGitStatus({ cwd: dir });
    expect(stdout.join('')).toContain('not installed');
  });

  it('refuses to overwrite a foreign hook without --force', async () => {
    writeFileSync(hookPath, '#!/bin/sh\nnpx lint-staged\n');

    await expect(runHookGitInstall({ cwd: dir })).rejects.toThrow(/already has a pre-commit hook/);
    expect(readFileSync(hookPath, 'utf8')).toBe('#!/bin/sh\nnpx lint-staged\n');
  });

  it('appends after a foreign hook with --force, and status flags it while unforced', async () => {
    writeFileSync(hookPath, '#!/bin/sh\nnpx lint-staged\n');

    await runHookGitStatus({ cwd: dir });
    // Names the exact subcommand to run, not a generic "install --force" --
    // two similar hook families (git vs git-post) now coexist, and a vague
    // hint risks the user force-installing the wrong one.
    expect(stdout.join('')).toContain('nexusmem hook git install --force');
    stdout.length = 0;

    const code = await runHookGitInstall({ cwd: dir, force: true });
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('appended after an existing pre-commit hook');

    const content = readFileSync(hookPath, 'utf8');
    expect(content.indexOf('npx lint-staged')).toBeLessThan(content.indexOf('nexusmem precheck'));
  });

  it('installs into a Husky-style core.hooksPath instead of .git/hooks, and status flags the redirect', async () => {
    gitFixture(dir, ['config', 'core.hooksPath', '.husky']);
    const huskyHookPath = join(dir, '.husky', 'pre-commit');

    const code = await runHookGitInstall({ cwd: dir });
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('core.hooksPath=.husky');
    expect(readFileSync(huskyHookPath, 'utf8')).toContain('nexusmem precheck');
    expect(() => readFileSync(hookPath, 'utf8')).toThrow(); // must NOT write to the dead .git/hooks path

    stdout.length = 0;
    await runHookGitStatus({ cwd: dir });
    expect(stdout.join('')).toContain('installed');
    expect(stdout.join('')).toContain('core.hooksPath=.husky');
  });
});
