import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ensureShebang,
  isForeignHook,
  isHookInstalled,
  SHEBANG,
  stripHookSnippet,
  upsertHookSnippet,
} from './git-post-commit.js';

export interface GitPostCommitHookTarget {
  hookPath: string;
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

export function resolvePostCommitHookTarget(repoRoot: string): GitPostCommitHookTarget {
  return { hookPath: join(repoRoot, '.git', 'hooks', 'post-commit') };
}

async function readHook(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export interface InstallPostCommitHookResult {
  changed: boolean;
  alreadyInstalled: boolean;
  /** True when this install appended onto a pre-existing foreign hook under `--force`. */
  appendedToForeign: boolean;
}

export async function installPostCommitGitHook(
  target: GitPostCommitHookTarget,
  opts: { force?: boolean } = {},
): Promise<InstallPostCommitHookResult> {
  const current = await readHook(target.hookPath);
  const alreadyInstalled = isHookInstalled(current);
  const foreign = isForeignHook(current);

  if (foreign && !alreadyInstalled && !opts.force) {
    throw new ForeignPostCommitHookError(target.hookPath);
  }

  // Same ordering caveat as the pre-commit installer: shebang applied before
  // upsert, since upsert measures "prior content" to decide the blank-line
  // separator, and that measurement must stay stable across calls.
  const next = upsertHookSnippet(ensureShebang(current));
  if (next === current) return { changed: false, alreadyInstalled, appendedToForeign: false };

  await mkdir(dirname(target.hookPath), { recursive: true });
  await writeFile(target.hookPath, next, 'utf8');
  // Best-effort: NTFS (Windows) ignores unix mode bits entirely, and git for
  // Windows runs hooks via its bundled sh.exe regardless.
  await chmod(target.hookPath, 0o755).catch(() => {});

  return { changed: true, alreadyInstalled, appendedToForeign: foreign && !alreadyInstalled };
}

export async function removePostCommitGitHook(target: GitPostCommitHookTarget): Promise<{ changed: boolean }> {
  const current = await readHook(target.hookPath);
  if (!isHookInstalled(current)) return { changed: false };

  const stripped = stripHookSnippet(current).trim();
  if (stripped === '' || stripped === SHEBANG) {
    await unlink(target.hookPath).catch(() => {});
  } else {
    await writeFile(target.hookPath, `${stripped}\n`, 'utf8');
  }

  return { changed: true };
}

export async function postCommitGitHookStatus(
  target: GitPostCommitHookTarget,
): Promise<{ installed: boolean; foreign: boolean }> {
  const current = await readHook(target.hookPath);
  return { installed: isHookInstalled(current), foreign: isForeignHook(current) };
}
