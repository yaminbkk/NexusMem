/**
 * `gh` isn't installed, isn't authenticated, or the call otherwise failed --
 * distinct from a real defect in this project's own code, and always
 * recoverable by skipping the source, the same fail-soft treatment
 * `sources.session`/vector embedding already give an unreachable Ollama.
 */
export class GithubUnavailableError extends Error {
  constructor(
    message: string,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = 'GithubUnavailableError';
  }
}

function toGithubError(err: unknown): GithubUnavailableError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new GithubUnavailableError(
      'gh CLI not found on PATH -- install it from https://cli.github.com and run `gh auth login`',
      err,
    );
  }
  const stderr = String((err as { stderr?: unknown } | undefined)?.stderr ?? '');
  if (/auth login|not logged into|401/i.test(stderr)) {
    return new GithubUnavailableError('gh CLI is not authenticated -- run `gh auth login`', err);
  }
  const detail = stderr.trim().split('\n')[0] || (err instanceof Error ? err.message : String(err));
  return new GithubUnavailableError(`gh api call failed: ${detail}`, err);
}

/**
 * `owner/repo` from a git remote URL, or `null` if it isn't a github.com
 * remote at all (a GitLab/Bitbucket/local-only repo, or no remote yet).
 *
 * Handles both protocols `readRepoInfo` can hand back: `https://github.com/o/r.git`
 * and `git@github.com:o/r.git`.
 */
export function parseGithubSlug(originUrl: string | null): string | null {
  if (!originUrl) return null;
  const match = originUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}
