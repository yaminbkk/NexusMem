import pc from 'picocolors';
import { collectGithubThreads } from '../../collectors/github.js';
import { makeProjectId } from '../../core/project.js';
import type { MemoryNode } from '../../core/types.js';
import { readRepoInfo } from '../../git/repo.js';
import { GhCliProvider, GithubUnavailableError, parseGithubSlug, type GithubProvider } from '../../github/read.js';
import { approxTotalTokens, formatSignal, GITHUB_SIGNAL_BANDS } from '../format.js';

export interface ScanGithubOptions {
  cwd: string;
  minSignal: number;
  json: boolean;
  /** Injectable for tests; defaults to the real `gh`-backed provider. */
  provider?: GithubProvider;
}

export async function runScanGithub(opts: ScanGithubOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });

  const slug = parseGithubSlug(repo.originUrl);
  if (!slug) {
    process.stderr.write(`${pc.yellow('no github.com remote found for this repository')}\n`);
    return 0;
  }

  const provider = opts.provider ?? new GhCliProvider(slug);

  let threads;
  try {
    threads = await provider.listThreads(null);
  } catch (err) {
    if (err instanceof GithubUnavailableError) {
      process.stderr.write(`${pc.yellow(err.message)}\n`);
      return 0;
    }
    throw err;
  }

  const nodes = collectGithubThreads(threads, projectId).filter((n) => n.signal >= opts.minSignal);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(nodes, null, 2)}\n`);
    return 0;
  }

  for (const node of nodes) process.stdout.write(`${formatNode(node)}\n`);

  const approxTotal = approxTotalTokens(nodes);
  process.stderr.write(
    `\n${pc.bold(String(nodes.length))} thread(s) from ${pc.dim(slug)} above threshold  ${pc.dim(`~${approxTotal.toLocaleString()} tokens if sent raw`)}\n`,
  );

  return 0;
}

function formatNode(node: MemoryNode): string {
  return [formatSignal(node.signal, GITHUB_SIGNAL_BANDS), node.title].join(' ');
}
