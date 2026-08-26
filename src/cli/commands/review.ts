import pc from 'picocolors';
import { MemoryStore } from '../../store/store.js';
import { loadContext } from '../context.js';

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
  }
}

export interface ReviewOptions {
  cwd: string;
  nodeId: string;
  verdict: 'verified' | 'rejected';
  out?: (chunk: string) => void;
}

/**
 * `nexusmem review <nodeId> --verify` / `--reject`. Records a human's own
 * verdict on one node's `trust_state` -- a separate axis from `provenance`
 * (which says where a claim came from, not whether anyone checked it). A
 * `rejected` node is down-weighted by the ranker (`rank.ts`), never deleted;
 * `verified` is a label only, no ranking boost. The node must belong to the
 * current project.
 */
export async function runReview(opts: ReviewOptions): Promise<number> {
  const { projectId, ws } = await loadContext(opts.cwd);
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));

  const store = MemoryStore.open(ws.dbPath);
  try {
    const owner = store.getNodeProjectId(opts.nodeId);
    if (owner === null) {
      throw new ReviewError(`no node found with id ${opts.nodeId}`);
    }
    if (owner !== projectId) {
      throw new ReviewError('node must belong to the current project');
    }

    store.setTrustState(opts.nodeId, opts.verdict);
    const verb = opts.verdict === 'verified' ? 'verified' : 'rejected';
    out(
      `${pc.green(verb)} ${opts.nodeId}\n` +
        (opts.verdict === 'rejected'
          ? `${pc.dim('down-weighted in ranking')} -- the node stays queryable, just ranked lower\n`
          : `${pc.dim('labeled only')} -- verifying does not change ranking\n`),
    );
    return 0;
  } finally {
    store.close();
  }
}
