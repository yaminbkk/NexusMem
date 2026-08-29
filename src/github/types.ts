/** One comment on an issue or pull request thread. */
export interface RawGithubComment {
  author: string;
  body: string;
  createdAt: string;
}

/**
 * An issue or PR, with its full comment thread already attached.
 *
 * GitHub models a pull request as an issue with extra fields (confirmed live
 * against this repo's own API: `GET /issues/:number` carries a `pull_request`
 * sub-object, including `merged_at`, whenever the issue actually is one) --
 * `type` is derived from that at read time so the rest of the pipeline never
 * has to special-case two endpoints.
 */
export interface RawGithubThread {
  number: number;
  type: 'issue' | 'pull_request';
  title: string;
  body: string;
  author: string;
  state: 'open' | 'closed';
  /** Only ever true for a `pull_request` thread. */
  merged: boolean;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  url: string;
  comments: RawGithubComment[];
}
