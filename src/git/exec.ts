import { spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * `git` could not be started at all -- distinct from git starting and then
 * exiting non-zero (`GitError`).
 *
 * Worth its own type because the two have nothing in common diagnostically:
 * a `GitError` is git's own verdict about the repository, while this means we
 * never got git's opinion. Collapsing them is what previously let a failed
 * process spawn be reported as "not a git repository", pointing the user at
 * their repo when the repo was fine.
 */
export class GitSpawnError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    /** libuv errno string (`ENOENT`, `EPERM`, ...), or `undefined` if the platform gave none. */
    readonly code: string | undefined,
    /** Whether retrying the identical command could plausibly succeed. */
    readonly transient: boolean,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = 'GitSpawnError';
  }
}

/**
 * `git` started, then died without reaching an exit of its own -- a segfault
 * or an access violation, not a verdict.
 *
 * Distinct from `GitError` for the same reason `GitSpawnError` is: a
 * `GitError` carries git's opinion about the repository and must be shown to
 * the user as such, while this means git never formed one. Reported as a
 * `GitError` it reads as "git rev-parse exited with code 3221225477", which
 * sends the reader looking for a git problem that does not exist.
 */
export class GitCrashError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    /** `0xC0000005` on Windows, or the POSIX signal name. */
    readonly status: string,
    readonly exitCode: number,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(message);
    this.name = 'GitCrashError';
  }
}

/**
 * A Windows process torn down by an unhandled exception exits with its
 * NTSTATUS value, and every failure NTSTATUS sits at or above this bound.
 * git's own exit codes are small (1, 2, 128, 129), so the boundary separates
 * "the OS killed git" from "git ran and disagreed" without guesswork.
 *
 * Observed here as 0xC0000005 (STATUS_ACCESS_VIOLATION) from `git init` and
 * `git commit` in test fixtures, at roughly two runs in five on this machine.
 */
const NTSTATUS_FAILURE_BASE = 0xc0000000;

/**
 * Ctrl+C arrives as an NTSTATUS too, and is the one that must not be retried:
 * it is the user's instruction to stop, not a fault.
 */
const STATUS_CONTROL_C_EXIT = 0xc000013a;

/** POSIX counterpart -- the process died on a signal instead of returning a code. */
const FATAL_SIGNALS = new Set<string>(['SIGSEGV', 'SIGBUS', 'SIGABRT', 'SIGILL', 'SIGFPE']);

/** A short label for how git died, or `null` if it exited normally (however unhappily). */
function crashStatus(code: number, signal: NodeJS.Signals | null): string | null {
  if (signal) return FATAL_SIGNALS.has(signal) ? signal : null;
  if (code >= NTSTATUS_FAILURE_BASE && code !== STATUS_CONTROL_C_EXIT) {
    return `0x${code.toString(16).toUpperCase()}`;
  }
  return null;
}

/**
 * Spawn failures that are worth retrying rather than reporting as a broken
 * setup.
 *
 * Windows is the reason this list exists: under process-creation pressure
 * (antivirus scanning a new image, handle exhaustion) `uv_spawn` intermittently
 * returns `EPERM` or `EAGAIN` for a binary that is present and runnable, and
 * succeeds on an immediate retry. `ENOENT` is deliberately absent -- git being
 * missing, or the cwd not existing, does not fix itself.
 */
const TRANSIENT_SPAWN_CODES = new Set(['EAGAIN', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'ENOMEM', 'EBUSY', 'ETXTBSY']);

/**
 * Git for Windows' own launcher can fail to exec the real `git.exe` under the
 * same handle/AV contention that causes a raw spawn EPERM elsewhere -- but it
 * reports that failure through a clean non-zero exit instead of a spawn
 * error, e.g. `error launching git: Access is denied.` from `git rev-parse`.
 * Observed live under this suite's own parallel load. Without this check that
 * surfaces as `GitError` (git's own verdict) even though a retry very likely
 * succeeds, same as the spawn-EPERM and mid-run-crash cases below.
 */
const GIT_LAUNCH_FAILURE = /error launching git/i;

function toSpawnError(err: unknown, cwd: string, args: string[]): GitSpawnError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;

  if (code === 'ENOENT') {
    // Ambiguous by design in libuv: the missing thing is either the binary or
    // the cwd, and the error carries nothing that tells them apart.
    return new GitSpawnError(
      `Could not run git: either git is not on PATH, or the directory does not exist: ${cwd}`,
      args,
      code,
      false,
      err,
    );
  }

  const transient = code !== undefined && TRANSIENT_SPAWN_CODES.has(code);
  const suffix = transient ? ' This is usually transient on Windows -- retrying the same command often succeeds.' : '';

  return new GitSpawnError(
    `Could not start git (${code ?? 'unknown spawn failure'}) in ${cwd}.${suffix}`,
    args,
    code,
    transient,
    err,
  );
}

/**
 * Flags applied to every invocation.
 *
 * - `core.quotePath=false` keeps non-ASCII paths readable instead of `\303\251`.
 * - `--no-pager` / `core.pager=` stops git from ever trying to spawn `less`.
 */
const BASE_ARGS = ['-c', 'core.quotePath=false', '-c', 'core.pager=', '--no-pager'];

/**
 * Backoff between spawn retries, in milliseconds. Length sets the retry count.
 *
 * The failures this covers are short-lived contention (an antivirus scanner
 * holding a new image, momentary handle exhaustion), so the useful waits are
 * tens to low hundreds of milliseconds. A worst-case run adds ~600ms before
 * giving up, and only on a path that was going to fail outright before.
 */
const RETRY_DELAYS_MS = [50, 150, 400];

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface GitExecOptions {
  /** Injectable for deterministic tests; defaults to `child_process.spawn`. */
  spawn?: typeof spawn;
  /** Injectable for deterministic tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Stream `git <args>` stdout as UTF-8 chunks, retrying the two failures that
 * are the environment's fault rather than git's: a transient failure to start
 * (`GitSpawnError`), and git being killed mid-run (`GitCrashError`).
 *
 * A non-zero exit is never retried. That is git's own answer, and running the
 * same command again will get the same one.
 *
 * The two retryable cases differ in where they can strike. A spawn failure is
 * necessarily before any output exists; a crash can happen part-way through a
 * long `git log`. The `produced` guard is what makes retrying safe in both:
 * once a single chunk has reached the consumer, re-running would replay output
 * into a parser that has already consumed it, so from that point the error
 * propagates instead.
 *
 * Retrying is also safe at the command level here because every git invocation
 * in this codebase reads (`log`, `rev-parse`, `merge-base`, `ls-files`,
 * `remote get-url`). Nothing writes, so a half-finished attempt leaves no lock
 * file or partial state for the next one to trip over. A future write command
 * would need that reasoning revisited.
 */
export async function* gitStream(cwd: string, args: string[], opts: GitExecOptions = {}): AsyncGenerator<string> {
  const sleep = opts.sleep ?? realSleep;

  for (let attempt = 0; ; attempt += 1) {
    let produced = false;
    try {
      for await (const chunk of runGitOnce(cwd, args, opts)) {
        produced = true;
        yield chunk;
      }
      return;
    } catch (err) {
      const retryable = (err instanceof GitSpawnError && err.transient) || err instanceof GitCrashError;
      if (produced || !retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
}

async function* runGitOnce(cwd: string, args: string[], opts: GitExecOptions): AsyncGenerator<string> {
  const fullArgs = [...BASE_ARGS, ...args];
  const child = (opts.spawn ?? spawn)('git', fullArgs, { cwd, windowsHide: true });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stderr = '';
  child.stderr.on('data', (chunk: string) => {
    // Bounded, so a pathological repo cannot blow up memory via stderr.
    if (stderr.length < 64 * 1024) stderr += chunk;
  });

  const exited = new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', (err) => reject(toSpawnError(err, cwd, fullArgs)));
    child.once('close', (code, signal) => resolve({ code: code ?? 0, signal: signal ?? null }));
  });
  // A spawn failure rejects `exited` before the stdout loop below has a
  // consumer for it; without this the rejection is unhandled for a tick even
  // though we do await it further down.
  exited.catch(() => {});

  try {
    for await (const chunk of child.stdout) {
      yield chunk as string;
    }
  } finally {
    // Consumer broke out early (e.g. hit --limit): don't leave git running.
    if (child.exitCode === null) child.kill();
  }

  const { code, signal } = await exited;

  const crash = crashStatus(code, signal);
  if (crash) {
    throw new GitCrashError(
      `git ${args.join(' ')} was killed before it could answer (${crash}) in ${cwd}.` +
        ' This is an environment fault, not a problem with the repository.',
      fullArgs,
      crash,
      code,
      signal,
    );
  }

  if (code !== 0) {
    const trimmed = stderr.trim();

    if (GIT_LAUNCH_FAILURE.test(trimmed)) {
      throw new GitSpawnError(
        `Could not start git (${trimmed.split('\n')[0]}) in ${cwd}. This is usually transient on Windows -- retrying the same command often succeeds.`,
        fullArgs,
        undefined,
        true,
        null,
      );
    }

    // Lead with git's own first line: now that callers no longer rewrite every
    // failure into "not a git repository", this message is what the user sees
    // for the cases that aren't specifically handled.
    const detail = trimmed.split('\n')[0];
    throw new GitError(
      `git ${args.join(' ')} exited with code ${code}${detail ? `: ${detail}` : ''}`,
      fullArgs,
      code,
      trimmed,
    );
  }
}

/** Buffered variant, for commands with small, bounded output. */
export async function git(cwd: string, args: string[], opts: GitExecOptions = {}): Promise<string> {
  let out = '';
  for await (const chunk of gitStream(cwd, args, opts)) out += chunk;
  return out;
}

/** Buffered variant that returns `null` instead of throwing (e.g. no origin remote). */
export async function gitOrNull(cwd: string, args: string[], opts: GitExecOptions = {}): Promise<string | null> {
  try {
    return await git(cwd, args, opts);
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}
