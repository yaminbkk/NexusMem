import { isAbsolute, join, resolve } from 'node:path';
import { gitOrNull } from '../git/exec.js';

export interface ResolvedHooksDir {
  /** Absolute path to the directory git will actually invoke hooks from. */
  dir: string;
  /** Raw `core.hooksPath` value if set (e.g. by Husky v7+, lefthook), else `null`. */
  hooksPathConfig: string | null;
}

/**
 * `core.hooksPath` redirects git away from `.git/hooks/` entirely -- Husky v7+
 * (the default install method since 2021) sets it to `.husky/` and never
 * writes into `.git/hooks/` at all. Installing there anyway silently produces
 * a hook that is never invoked.
 *
 * `--path` makes git itself do `~`-expansion/normalization; reading the
 * unscoped key (no `--local`/`--global`) returns the same effective value git
 * consults when actually running a hook.
 */
export async function resolveHooksDir(repoRoot: string): Promise<ResolvedHooksDir> {
  const raw = await gitOrNull(repoRoot, ['config', '--path', 'core.hooksPath']);
  const hooksPathConfig = raw?.trim() || null;
  if (!hooksPathConfig) return { dir: join(repoRoot, '.git', 'hooks'), hooksPathConfig: null };

  // Relative values are resolved against the repo root, same as git does.
  const dir = isAbsolute(hooksPathConfig) ? hooksPathConfig : resolve(repoRoot, hooksPathConfig);
  return { dir, hooksPathConfig };
}
