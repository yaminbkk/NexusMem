import { type spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, GitCrashError, GitError, GitSpawnError, gitStream } from '../src/git/exec.js';
import { NotAGitRepositoryError, readRepoInfo } from '../src/git/repo.js';
import { gitFixture, isCrashStatus } from './helpers.js';

/**
 * These cover the distinction the error types exist for: whether git ran at
 * all, and if it did, whether "not a repository" was actually its verdict.
 * Before the split, every one of these paths produced the same
 * `NotAGitRepositoryError`.
 */
describe('git failure classification', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-giterr-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a real non-repository directory as NotAGitRepositoryError', async () => {
    // A temp dir could sit under a repo on some machines; a bare `--show-toplevel`
    // would then walk up and succeed. Fencing stops the walk at `dir`.
    const prev = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dir;
    try {
      await expect(readRepoInfo(dir)).rejects.toBeInstanceOf(NotAGitRepositoryError);
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prev;
    }
  });

  it('does not claim "not a git repository" when the directory does not exist', async () => {
    const missing = join(dir, 'no', 'such', 'path');

    const err = await readRepoInfo(missing).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitSpawnError);
    expect(err).not.toBeInstanceOf(NotAGitRepositoryError);
    expect((err as GitSpawnError).code).toBe('ENOENT');
    // Not retryable: a missing binary or missing cwd does not fix itself.
    expect((err as GitSpawnError).transient).toBe(false);
  });

  it('marks resource-pressure spawn failures transient and ENOENT not', () => {
    // Constructed directly: the Windows EPERM/EAGAIN race this classification
    // exists for cannot be provoked on demand, so assert the policy instead.
    const transient = new GitSpawnError('x', [], 'EAGAIN', true, null);
    expect(transient.transient).toBe(true);
    expect(new GitSpawnError('x', [], 'ENOENT', false, null).transient).toBe(false);
  });

  it('keeps git\'s own message for a failure that is not "not a repository"', async () => {
    gitFixture(dir, ['init', '-q']);
    // A config value git cannot parse: rev-parse fails, but the repo is real.
    gitFixture(dir, ['config', 'core.repositoryformatversion', 'bogus']);

    const err = await readRepoInfo(dir).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(NotAGitRepositoryError);
    expect(err).toBeInstanceOf(GitError);
    // git's own first stderr line is carried into the message rather than discarded.
    expect((err as GitError).message).toMatch(/repository version|repositoryformatversion/i);
  });

  it('still resolves a healthy repository', async () => {
    const run = (...args: string[]) => gitFixture(dir, args);
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('commit', '-q', '--allow-empty', '-m', 'init');

    const info = await readRepoInfo(dir);

    expect(info.branch).toBe('main');
    expect(info.head).toMatch(/^[0-9a-f]{40}$/);
    expect(info.originUrl).toBeNull(); // no remote configured
  });
});

/**
 * The Windows `uv_spawn` race these retries exist for cannot be provoked on
 * demand, so `spawn` is injected instead of waiting for the real thing. `sleep`
 * is injected too, both to keep the suite fast and to make the backoff schedule
 * itself assertable rather than merely "something waited".
 */
describe('transient spawn retry', () => {
  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`spawn git ${code}`), { code });

  function stream(text: string): Readable {
    const r = new Readable({ read() {} });
    if (text) r.push(text);
    r.push(null);
    return r;
  }

  /** Minimal stand-in for the ChildProcess surface gitStream actually touches. */
  function child(outcome: {
    stdout?: string;
    stderr?: string;
    code?: number;
    signal?: NodeJS.Signals;
    error?: NodeJS.ErrnoException;
  }) {
    const c = new EventEmitter() as EventEmitter & Record<string, unknown>;
    c.stdout = stream(outcome.stdout ?? '');
    c.stderr = stream(outcome.stderr ?? '');
    c.exitCode = null;
    c.kill = () => undefined;

    setImmediate(() => {
      if (outcome.error) {
        c.emit('error', outcome.error);
        return;
      }
      c.exitCode = outcome.code ?? 0;
      // Node passes (code, signal); a signal-killed process reports code null.
      c.emit('close', outcome.signal ? null : (outcome.code ?? 0), outcome.signal ?? null);
    });

    return c;
  }

  /** Returns a spawn stub that plays `outcomes` in order, plus the call count and observed backoff. */
  function harness(outcomes: Array<Parameters<typeof child>[0]>) {
    const sleeps: number[] = [];
    let calls = 0;
    const spawn = (() => {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)]!;
      calls += 1;
      return child(outcome);
    }) as unknown as typeof nodeSpawn;

    return {
      sleeps,
      calls: () => calls,
      opts: { spawn, sleep: async (ms: number) => void sleeps.push(ms) },
    };
  }

  it('retries a transient spawn failure and returns the eventual output', async () => {
    const h = harness([{ error: errno('EAGAIN') }, { error: errno('EPERM') }, { stdout: 'refs/heads/main\n' }]);

    await expect(git('/repo', ['rev-parse', '--abbrev-ref', 'HEAD'], h.opts)).resolves.toBe('refs/heads/main\n');

    expect(h.calls()).toBe(3);
    expect(h.sleeps).toEqual([50, 150]); // backoff schedule, in order
  });

  it('gives up after the last delay and reports the real spawn error', async () => {
    const h = harness([{ error: errno('EAGAIN') }]);

    const err = await git('/repo', ['status'], h.opts).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitSpawnError);
    expect((err as GitSpawnError).code).toBe('EAGAIN');
    expect(h.calls()).toBe(4); // one attempt plus three retries
    expect(h.sleeps).toEqual([50, 150, 400]);
  });

  it('does not retry ENOENT -- a missing binary or cwd does not fix itself', async () => {
    const h = harness([{ error: errno('ENOENT') }]);

    await expect(git('/repo', ['status'], h.opts)).rejects.toBeInstanceOf(GitSpawnError);

    expect(h.calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it('does not retry a non-zero exit -- that is git\'s own answer, not a failure to start', async () => {
    const h = harness([{ code: 128, stderr: 'fatal: not a git repository' }]);

    await expect(git('/repo', ['rev-parse'], h.opts)).rejects.toBeInstanceOf(GitError);

    expect(h.calls()).toBe(1);
  });

  /**
   * The flake that made CI untenable: git *starts*, then is torn down by the
   * OS. It reaches `close` with an NTSTATUS instead of an exit code, so the
   * spawn-failure retry above never saw it and the suite stayed red at an
   * unchanged rate after that retry landed.
   */
  const ACCESS_VIOLATION = 0xc0000005; // 3221225477, as observed
  const CONTROL_C_EXIT = 0xc000013a;

  it('retries a git that was killed mid-run and returns the eventual output', async () => {
    const h = harness([{ code: ACCESS_VIOLATION }, { code: ACCESS_VIOLATION }, { stdout: 'deadbeef\n' }]);

    await expect(git('/repo', ['rev-parse', 'HEAD'], h.opts)).resolves.toBe('deadbeef\n');

    expect(h.calls()).toBe(3);
    expect(h.sleeps).toEqual([50, 150]);
  });

  it('reports a crash as GitCrashError, not as git\'s own verdict', async () => {
    const h = harness([{ code: ACCESS_VIOLATION }]);

    const err = await git('/repo', ['rev-parse', 'HEAD'], h.opts).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitCrashError);
    expect(err).not.toBeInstanceOf(GitError);
    expect((err as GitCrashError).status).toBe('0xC0000005');
    expect((err as GitCrashError).message).toContain('not a problem with the repository');
    expect(h.calls()).toBe(4); // one attempt plus three retries
  });

  /**
   * A third real Windows failure mode, distinct from both above: git's own
   * launcher shim fails to exec the real `git.exe` under the same handle/AV
   * contention that causes spawn EPERM, but reports it through a clean
   * non-zero exit rather than a spawn error. Observed live from
   * `git rev-parse --show-toplevel` during this suite's own full run.
   */
  it('retries "error launching git" -- a clean exit that is not really git\'s verdict', async () => {
    const h = harness([
      { code: 1, stderr: 'error launching git: Access is denied.\n' },
      { stdout: 'C:/repo\n' },
    ]);

    await expect(git('/repo', ['rev-parse', '--show-toplevel'], h.opts)).resolves.toBe('C:/repo\n');

    expect(h.calls()).toBe(2);
    expect(h.sleeps).toEqual([50]);
  });

  it('gives up on a persistent "error launching git" as GitSpawnError, not GitError', async () => {
    const h = harness([{ code: 1, stderr: 'error launching git: Access is denied.\n' }]);

    const err = await git('/repo', ['status'], h.opts).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitSpawnError);
    expect(err).not.toBeInstanceOf(GitError);
    expect(h.calls()).toBe(4); // one attempt plus three retries
  });

  it('does not retry Ctrl+C -- that is the user stopping, not a fault', async () => {
    const h = harness([{ code: CONTROL_C_EXIT }]);

    const err = await git('/repo', ['log'], h.opts).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GitError);
    expect(err).not.toBeInstanceOf(GitCrashError);
    expect(h.calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it('treats a fatal POSIX signal the same way as a Windows crash', async () => {
    const h = harness([{ signal: 'SIGSEGV' }, { stdout: 'ok\n' }]);

    await expect(git('/repo', ['rev-parse', 'HEAD'], h.opts)).resolves.toBe('ok\n');
    expect(h.calls()).toBe(2);
  });

  it('does not retry a crash once output has already reached the consumer', async () => {
    // A crash, unlike a spawn failure, can strike part-way through a long
    // `git log`. The produced guard is the only thing standing between that
    // and replayed chunks landing in a parser mid-parse.
    const h = harness([{ stdout: 'commit 1\n', code: ACCESS_VIOLATION }, { stdout: 'commit 1\n' }]);
    const chunks: string[] = [];

    const err = await (async () => {
      try {
        for await (const chunk of gitStream('/repo', ['log'], h.opts)) chunks.push(chunk);
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(chunks).toEqual(['commit 1\n']);
    expect(err).toBeInstanceOf(GitCrashError);
    expect(h.calls()).toBe(1);
  });

  /**
   * The fixture helper shells out separately from `src/git/exec.ts` and so
   * needs the same classification of its own. These pin the boundary: git's
   * real exit codes must never be read as a crash, or a genuine "not a
   * repository" would be retried three times before surfacing.
   */
  it('classifies fixture exit statuses the same way the production path does', () => {
    expect(isCrashStatus(ACCESS_VIOLATION)).toBe(true);
    expect(isCrashStatus(0xc0000374)).toBe(true); // heap corruption
    expect(isCrashStatus(CONTROL_C_EXIT)).toBe(false); // the user, not a fault

    for (const gitVerdict of [1, 2, 128, 129]) {
      expect(isCrashStatus(gitVerdict), `exit ${gitVerdict} is git's own answer`).toBe(false);
    }
    expect(isCrashStatus(null)).toBe(false);
    expect(isCrashStatus(undefined)).toBe(false);
  });

  it('does not retry once output has already reached the consumer', async () => {
    // Guards the streaming boundary: re-running here would replay chunks into a
    // parser that has already consumed them.
    const h = harness([{ stdout: 'commit 1\n', error: errno('EAGAIN') }]);
    const chunks: string[] = [];

    const err = await (async () => {
      try {
        for await (const chunk of gitStream('/repo', ['log'], h.opts)) chunks.push(chunk);
        return null;
      } catch (e) {
        return e;
      }
    })();

    expect(chunks).toEqual(['commit 1\n']);
    expect(err).toBeInstanceOf(GitSpawnError);
    expect(h.calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });
});
