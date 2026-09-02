import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Generic install/remove/status logic shared by every git hook type
 * NexusMem installs (`install-git-precommit.ts`, `install-git-postcommit.ts`).
 * The filesystem sequence (refuse-unless-forced on a foreign hook, upsert,
 * mkdir, write, chmod / strip-or-delete / read-and-report) is identical
 * regardless of hook type -- only the marker-aware functions and the
 * foreign-hook error differ, so each hook type supplies those as a `kind`
 * bundle and gets back the same three operations.
 */

export interface GitHookTarget {
  hookPath: string;
  /** Raw `core.hooksPath` value if the repo redirects hooks elsewhere (e.g. Husky v7+), else `null`. */
  hooksPathConfig?: string | null;
}

export interface GitHookKind {
  isHookInstalled(content: string): boolean;
  isForeignHook(content: string): boolean;
  stripHookSnippet(content: string): string;
  upsertHookSnippet(content: string): string;
  ensureShebang(content: string): string;
  SHEBANG: string;
  createForeignError(hookPath: string): Error;
}

export interface InstallGitHookResult {
  changed: boolean;
  alreadyInstalled: boolean;
  /** True when this install appended onto a pre-existing foreign hook under `--force`. */
  appendedToForeign: boolean;
}

async function readHook(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export async function installGitHookGeneric(
  target: GitHookTarget,
  kind: GitHookKind,
  opts: { force?: boolean } = {},
): Promise<InstallGitHookResult> {
  const current = await readHook(target.hookPath);
  const alreadyInstalled = kind.isHookInstalled(current);
  const foreign = kind.isForeignHook(current);

  if (foreign && !alreadyInstalled && !opts.force) {
    throw kind.createForeignError(target.hookPath);
  }

  // Shebang applied *before* upsert, not after: upsertHookSnippet measures
  // "prior content" to decide the blank-line separator before its block, and
  // that measurement has to be stable across calls. Applying ensureShebang
  // afterward meant the very first install (no shebang in the prior content)
  // formatted differently from every later one (shebang now part of the
  // prior content) -- a real idempotency bug caught by exactly the "second
  // install is a no-op" test this is written to satisfy.
  const next = kind.upsertHookSnippet(kind.ensureShebang(current));
  if (next === current) return { changed: false, alreadyInstalled, appendedToForeign: false };

  await mkdir(dirname(target.hookPath), { recursive: true });
  await writeFile(target.hookPath, next, 'utf8');
  // Best-effort: NTFS (Windows) ignores unix mode bits entirely, and git for
  // Windows runs hooks via its bundled sh.exe regardless -- POSIX systems do
  // need the executable bit, so this is set unconditionally rather than
  // gated on platform detection.
  await chmod(target.hookPath, 0o755).catch(() => {});

  return { changed: true, alreadyInstalled, appendedToForeign: foreign && !alreadyInstalled };
}

export async function removeGitHookGeneric(target: GitHookTarget, kind: GitHookKind): Promise<{ changed: boolean }> {
  const current = await readHook(target.hookPath);
  if (!kind.isHookInstalled(current)) return { changed: false };

  const stripped = kind.stripHookSnippet(current).trim();
  // Nothing left but the shebang this installer itself added (or nothing at
  // all) -- delete the file rather than leave a no-op executable behind.
  if (stripped === '' || stripped === kind.SHEBANG) {
    await unlink(target.hookPath).catch(() => {});
  } else {
    await writeFile(target.hookPath, `${stripped}\n`, 'utf8');
  }

  return { changed: true };
}

export async function gitHookStatusGeneric(
  target: GitHookTarget,
  kind: GitHookKind,
): Promise<{ installed: boolean; foreign: boolean }> {
  const current = await readHook(target.hookPath);
  return { installed: kind.isHookInstalled(current), foreign: kind.isForeignHook(current) };
}
