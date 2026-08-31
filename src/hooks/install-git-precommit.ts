import { join } from 'node:path';
import { ensureShebang, isForeignHook, isHookInstalled, SHEBANG, stripHookSnippet, upsertHookSnippet } from './git-pre-commit.js';
import {
  gitHookStatusGeneric,
  installGitHookGeneric,
  removeGitHookGeneric,
  type GitHookKind,
  type GitHookTarget,
  type InstallGitHookResult,
} from './git-hook-install.js';

export type { GitHookTarget };

/**
 * `.git/hooks/pre-commit` already has real, non-NexusMem content -- a real
 * tool (husky, lint-staged, lefthook) commonly owns this exact file. Refusing
 * by default and requiring `--force` mirrors how `sync --prune-source`
 * requires `--yes` for an action a typo could make irreversible-feeling: an
 * unreviewed overwrite of someone else's hook is exactly that kind of
 * surprise.
 */
export class ForeignGitHookError extends Error {
  constructor(readonly hookPath: string) {
    super(
      `${hookPath} already has a pre-commit hook NexusMem did not install. ` +
        'Pass --force to append nexusmem\'s check to the end of it, or integrate manually.',
    );
    this.name = 'ForeignGitHookError';
  }
}

const KIND: GitHookKind = {
  isHookInstalled,
  isForeignHook,
  stripHookSnippet,
  upsertHookSnippet,
  ensureShebang,
  SHEBANG,
  createForeignError: (hookPath) => new ForeignGitHookError(hookPath),
};

export function resolveGitHookTarget(repoRoot: string): GitHookTarget {
  return { hookPath: join(repoRoot, '.git', 'hooks', 'pre-commit') };
}

export type { InstallGitHookResult };

export async function installGitHook(target: GitHookTarget, opts: { force?: boolean } = {}): Promise<InstallGitHookResult> {
  return installGitHookGeneric(target, KIND, opts);
}

export async function removeGitHook(target: GitHookTarget): Promise<{ changed: boolean }> {
  return removeGitHookGeneric(target, KIND);
}

export async function gitHookStatus(target: GitHookTarget): Promise<{ installed: boolean; foreign: boolean }> {
  return gitHookStatusGeneric(target, KIND);
}
