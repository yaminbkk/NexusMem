import { posix, win32 } from 'node:path';

/**
 * Turns the path spelling an agent happened to use into one the harness can
 * compare against the repository it built.
 *
 * Harness-only. Nothing here is product behaviour: NexusMem's own collectors
 * receive paths from their hook, not from a model's prose.
 *
 * The Phase-5 eval scored one correct ambient fix as a failure because of
 * this. Claude Code edited `/c/Users/.../app/src/parse.js` -- Git Bash's
 * spelling of a Windows path, which the model used in that run and only that
 * run -- while the harness held `C:\Users\...\app`. `path.relative` on
 * win32 cannot relate the two: it treats the POSIX-looking argument as
 * relative to the current drive and returns `D:/c/Users/...`, so the edit was
 * filed under a path that matched nothing and `editedFixFile` came out false
 * for a run whose check demonstrably passed.
 *
 * Both conversions are win32-only on purpose. On a POSIX host `/c/tools` and
 * `/mnt/c/data` are ordinary directories, and rewriting them into drive
 * letters would invent a bug where there is none.
 */

const WSL_DRIVE = /^\/mnt\/([a-zA-Z])\/(.*)$/;
const GIT_BASH_DRIVE = /^\/([a-zA-Z])\/(.*)$/;

const toDrive = (letter: string, rest: string): string => `${letter.toUpperCase()}:\\${rest.split('/').join('\\')}`;

export function toNativePath(filePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return filePath;
  const wsl = WSL_DRIVE.exec(filePath);
  if (wsl) return toDrive(wsl[1]!, wsl[2]!);
  const bash = GIT_BASH_DRIVE.exec(filePath);
  if (bash) return toDrive(bash[1]!, bash[2]!);
  return filePath;
}

/**
 * Repo-relative, forward slashes -- the form every scenario states its files
 * in. `platform` is a parameter rather than read from the environment so the
 * win32 path rules can be exercised from any host.
 */
export function repoRelative(repoDir: string, filePath: string, platform: NodeJS.Platform = process.platform): string {
  const impl = platform === 'win32' ? win32 : posix;
  return impl.relative(repoDir, toNativePath(filePath, platform)).split('\\').join('/');
}
