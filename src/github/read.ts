import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RawGithubComment, RawGithubThread } from './types.js';

const execFileAsync = promisify(execFile);

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

export interface GithubProvider {
  /**
   * Issues and PRs updated at or after `since` (inclusive), newest-updated
   * first, each with its full comment thread attached. `since === null` means
   * every thread, bounded by `maxThreads`.
   */
  listThreads(since: string | null): Promise<RawGithubThread[]>;
}

interface GhIssueItem {
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  state: 'open' | 'closed';
  labels: Array<{ name: string } | string>;
  created_at: string;
  updated_at: string;
  html_url: string;
  comments: number;
  pull_request?: { merged_at: string | null };
}

interface GhCommentItem {
  user: { login: string } | null;
  body: string | null;
  created_at: string;
}

export interface GhCliProviderOptions {
  /** Threads fetched per call, newest-updated first. Default 100. */
  maxThreads?: number;
  /** Comments read per thread. Default 100. */
  maxCommentsPerThread?: number;
}

/**
 * Real `gh` CLI-backed provider. Reuses this machine's own `gh auth login`
 * session -- no token handling in this codebase, same trust boundary as
 * every other `gh api`/`gh release` call this project already makes from a
 * session, just now from inside the product instead of only from a dev
 * session's own hands.
 */
export class GhCliProvider implements GithubProvider {
  constructor(
    private readonly repoSlug: string,
    private readonly opts: GhCliProviderOptions = {},
  ) {}

  async listThreads(since: string | null): Promise<RawGithubThread[]> {
    const maxThreads = this.opts.maxThreads ?? 100;
    const perPage = Math.min(maxThreads, 100);
    const params = new URLSearchParams({
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: String(perPage),
    });
    if (since) params.set('since', since);

    let items: GhIssueItem[];
    try {
      const { stdout } = await execFileAsync('gh', ['api', `repos/${this.repoSlug}/issues?${params}`], {
        maxBuffer: 16 * 1024 * 1024,
      });
      items = JSON.parse(stdout) as GhIssueItem[];
    } catch (err) {
      throw toGithubError(err);
    }

    const bounded = items.slice(0, maxThreads);
    const threads: RawGithubThread[] = [];
    for (const item of bounded) {
      const comments = item.comments > 0 ? await this.fetchComments(item.number) : [];
      threads.push({
        number: item.number,
        type: item.pull_request ? 'pull_request' : 'issue',
        title: item.title,
        body: item.body ?? '',
        author: item.user?.login ?? 'unknown',
        state: item.state,
        merged: item.pull_request?.merged_at != null,
        labels: item.labels.map((l) => (typeof l === 'string' ? l : l.name)),
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        url: item.html_url,
        comments,
      });
    }
    return threads;
  }

  /**
   * Fails soft per thread, unlike `listThreads` itself: one comment fetch
   * failing (a deleted comment, a transient network blip) shouldn't drop the
   * whole sync the way an unreachable `gh`/no auth does. The thread still
   * gets ingested, just without that page of discussion this run.
   */
  private async fetchComments(number: number): Promise<RawGithubComment[]> {
    const maxComments = this.opts.maxCommentsPerThread ?? 100;
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['api', `repos/${this.repoSlug}/issues/${number}/comments?per_page=${Math.min(maxComments, 100)}`],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      const items = JSON.parse(stdout) as GhCommentItem[];
      return items.slice(0, maxComments).map((c) => ({
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        createdAt: c.created_at,
      }));
    } catch {
      return [];
    }
  }
}
