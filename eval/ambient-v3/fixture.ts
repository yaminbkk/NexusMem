import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Repository plumbing for the ambient-v3 fixtures.
 *
 * Deliberately a copy of the equivalent helpers in `eval/ambient-v2/fixture.ts`
 * rather than an import of them: that set is a frozen, already-run experiment
 * and its bytes are part of a recorded result, so this set does not reach
 * into it for anything it would have to export -- the same reason v2's own
 * fixture.ts does not import from the older `eval/ambient/`.
 */

/** A concrete change, as an anchored substitution, so an approach can be applied and re-checked. */
export interface Edit {
  file: string;
  from: string;
  to: string;
}

export interface Commit {
  message: string;
  files?: Record<string, string>;
  /** What the check does at this commit. Every commit carries one so the verifier can re-run the history. */
  expect: 'pass' | 'fail';
}

/** Throws rather than silently producing a fixture that does not contain the change it claims. */
export function applyEdit(source: string, edit: Edit): string {
  if (!source.includes(edit.from)) throw new Error(`${edit.file}: anchor not present`);
  return source.replace(edit.from, edit.to);
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Eval',
  GIT_AUTHOR_EMAIL: 'eval@example.com',
  GIT_COMMITTER_NAME: 'Eval',
  GIT_COMMITTER_EMAIL: 'eval@example.com',
};

function git(dir: string, env: NodeJS.ProcessEnv, ...args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { env, stdio: 'ignore' });
}

export function write(dir: string, relativePath: string, content: string): void {
  const target = join(dir, relativePath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

/**
 * Commits are dated one minute apart, ending at build time -- same reasoning
 * as v2's `buildRepo`. Unlike v2, a v3 scenario's own history never carries
 * more than one or two commits: the whole point is that no commit message
 * here is allowed to describe a prior attempt (see scenario.ts), so there is
 * nothing for `git log` to leak.
 */
export function buildRepo(dir: string, files: Record<string, string>, history: readonly Commit[]): void {
  mkdirSync(dir, { recursive: true });
  const base = Date.now();
  const env = (i: number): NodeJS.ProcessEnv => {
    const at = new Date(base - (history.length - i) * 60_000).toISOString();
    return { ...GIT_ENV, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  };

  git(dir, GIT_ENV, 'init', '-q', '-b', 'main');
  // The fixture has to be byte-identical wherever the eval runs: with the
  // machine's autocrlf a checkout of an earlier commit rewrites every file.
  git(dir, GIT_ENV, 'config', 'core.autocrlf', 'false');
  git(dir, GIT_ENV, 'config', 'core.eol', 'lf');
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  history.forEach((commit, i) => {
    for (const [path, content] of Object.entries(commit.files ?? {})) write(dir, path, content);
    git(dir, GIT_ENV, 'add', '.');
    git(dir, env(i), 'commit', '-q', '--allow-empty', '--no-verify', '-m', commit.message);
  });
}
