import { join } from 'node:path';
import { ensureShebang, isForeignHook, isHookInstalled, SHEBANG, stripHookSnippet, upsertHookSnippet } from './git-post-commit.js';
import { resolveHooksDir } from './git-hooks-dir.js';
import {
  gitHookStatusGeneric,
  installGitHookGeneric,
  removeGitHookGeneric,
  type GitHookKind,
  type InstallGitHookResult,
} from './git-hook-install.js';

export interface GitPostCommitHookTarget {
  hookPath: string;
  /** Raw `core.hooksPath` value if the repo redirects hooks elsewhere (e.g. Husky v7+), else `null`. */
  hooksPathConfig?: string | null;
}

/**
 * Same reasoning as `ForeignGitHookError` (`install-git-precommit.ts`):
 * `.git/hooks/post-commit` is a file a real tool (husky, lefthook) can
 * already own, so an unreviewed overwrite needs an explicit `--force`.
 */
export class ForeignPostCommitHookError extends Error {
  constructor(readonly hookPath: string) {
    super(
      `${hookPath} already has a post-commit hook NexusMem did not install. ` +
        'Pass --force to append nexusmem\'s sync to the end of it, or integrate manually.',
    );
    this.name = 'ForeignPostCommitHookError';
  }
}

const KIND: GitHookKind = {
  isHookInstalled,
  isForeignHook,
  stripHookSnippet,
  upsertHookSnippet,
  ensureShebang,
  SHEBANG,
  createForeignError: (hookPath) => new ForeignPostCommitHookError(hookPath),
};

export async function resolvePostCommitHookTarget(repoRoot: string): Promise<GitPostCommitHookTarget> {
  const { dir, hooksPathConfig } = await resolveHooksDir(repoRoot);
  return { hookPath: join(dir, 'post-commit'), hooksPathConfig };
}

export type InstallPostCommitHookResult = InstallGitHookResult;

export async function installPostCommitGitHook(
  target: GitPostCommitHookTarget,
  opts: { force?: boolean } = {},
): Promise<InstallPostCommitHookResult> {
  return installGitHookGeneric(target, KIND, opts);
}

export async function removePostCommitGitHook(target: GitPostCommitHookTarget): Promise<{ changed: boolean }> {
  return removeGitHookGeneric(target, KIND);
}

export async function postCommitGitHookStatus(
  target: GitPostCommitHookTarget,
): Promise<{ installed: boolean; foreign: boolean }> {
  return gitHookStatusGeneric(target, KIND);
}
