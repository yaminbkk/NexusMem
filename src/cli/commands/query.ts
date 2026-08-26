import pc from 'picocolors';
import { approxTokens } from '../../core/text.js';
import { renderContextBlock } from '../../retrieval/pack.js';
import { runCrossProjectQuery, runHybridQuery } from '../../retrieval/query-pipeline.js';
import { openAllProjectSources } from '../../retrieval/sources.js';
import { MemoryStore } from '../../store/store.js';
import { OllamaEmbeddingProvider } from '../../vector/embed.js';
import { loadContext } from '../context.js';

export interface QueryOptions {
  cwd: string;
  query: string;
  /** Token budget for the packed context that gets printed to stdout. */
  budget: number;
  /** How many FTS/vector candidates to rank/pack from, before the budget is applied. */
  candidates: number;
  halfLifeDays?: number;
  /** Skip embedding the query and vector search entirely -- BM25-only, same as before hybrid retrieval existed. */
  noVector?: boolean;
  /** Search every registered repository, not just this one. */
  allProjects?: boolean;
  /** ISO-8601 date/time: only nodes recorded (not just dated) at or before this instant -- "what did the store hold as of then". */
  asOf?: string;
  json: boolean;
}

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}

export async function runQuery(opts: QueryOptions): Promise<number> {
  const { repo, ws, projectId } = await loadContext(opts.cwd);

  let asOfEpoch: number | undefined;
  if (opts.asOf) {
    const parsed = Date.parse(opts.asOf);
    if (Number.isNaN(parsed)) throw new QueryError(`--as-of "${opts.asOf}" is not a parseable date`);
    asOfEpoch = parsed;
  }

  // Exactly one of these owns the database handles: cross-project mode opens
  // this repo's database as one source among several, so opening it twice
  // would leave a second connection for the same file with nothing to do.
  const opened = opts.allProjects
    ? await openAllProjectSources({ projectId, root: repo.root, dbPath: ws.dbPath })
    : null;
  let store: MemoryStore | null = null;

  try {
    const queryOpts = {
      budget: opts.budget,
      candidates: opts.candidates,
      halfLifeDays: opts.halfLifeDays,
      embeddingProvider: opts.noVector ? null : new OllamaEmbeddingProvider(),
      asOfEpoch,
    };

    let result;
    if (opened) {
      result = await runCrossProjectQuery(opened.sources, opts.query, queryOpts);
    } else {
      store = MemoryStore.open(ws.dbPath);
      result = await runHybridQuery(store, projectId, opts.query, queryOpts);
    }
    const { bm25Count, vectorCount, hits, packed } = result;

    if (asOfEpoch !== undefined && !opts.json) {
      process.stderr.write(`${pc.dim('as of  ')} ${new Date(asOfEpoch).toISOString()} -- excludes anything recorded after\n`);
    }

    if (opened && !opts.json) {
      const searched = opened.sources.map((s) => s.label).join(', ');
      process.stderr.write(`${pc.dim('scope  ')} ${opened.sources.length} project(s): ${searched}\n`);
      for (const { entry } of opened.unreadable) {
        process.stderr.write(`${pc.yellow('unreadable')} ${entry.root} -- skipped\n`);
      }
      if (opened.missing.length > 0) {
        process.stderr.write(
          `${pc.dim('skipped')} ${opened.missing.length} registered project(s) whose database is not on disk` +
            ` ${pc.dim('(nexusmem projects --prune to forget them)')}\n`,
        );
      }
    }

    const matched = hits.length;

    // Packer efficiency: the packed context against the summed raw bodies of
    // *the same candidate set*. It measures ranking + budgeted packing
    // against its own input, which is what makes it useful for tuning.
    //
    // Deliberately NOT called "token saved": the baseline is hypothetical --
    // without NexusMem you'd never have sent these candidate bodies at all,
    // so this says nothing about a session's actual token bill. End-to-end
    // saving is measured against what the agent would otherwise have read,
    // and is a separate number entirely (README § Benchmarks).
    //
    // Can go negative: for a handful of small matches, fixed per-node
    // formatting overhead can outweigh what little there was to trim. The
    // efficiency comes from dropping low-score matches entirely once
    // candidates exceed the budget, and from truncating large bodies --
    // neither has much to work with on a tiny, already-terse result set.
    const rawTokens = hits.reduce((n, h) => n + approxTokens(h.body), 0);
    const packerEfficiency = rawTokens > 0 ? 1 - packed.tokensUsed / rawTokens : 0;

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            query: opts.query,
            matched,
            bm25Matched: bm25Count,
            vectorMatched: vectorCount,
            packed: packed.nodes,
            tokensUsed: packed.tokensUsed,
            tokensBudget: packed.tokensBudget,
            droppedForBudget: packed.droppedForBudget,
            droppedForDiversity: packed.droppedForDiversity,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    if (matched === 0) {
      process.stderr.write(`${pc.yellow('no matches')} for "${opts.query}"\n`);
      return 0;
    }

    process.stderr.write(
      [
        `${pc.dim('matched')} ${bm25Count} bm25${vectorCount > 0 ? ` + ${vectorCount} vector` : ''}, packed ${pc.bold(String(packed.nodes.length))} into budget`,
        `${pc.dim('tokens ')} ${packed.tokensUsed}/${packed.tokensBudget}` +
          (packed.droppedForBudget ? pc.dim(`  (${packed.droppedForBudget} dropped for budget)`) : '') +
          (packed.droppedForDiversity ? pc.dim(`  (${packed.droppedForDiversity} dropped for diversity)`) : ''),
        rawTokens > 0
          ? `${pc.dim('vs raw ')} ${rawTokens} tokens if these same matches were sent unpacked  ${packerEfficiency >= 0 ? pc.green(`(${(packerEfficiency * 100).toFixed(0)}% packer efficiency)`) : pc.yellow(`(${(-packerEfficiency * 100).toFixed(0)}% larger -- overhead dominates on small result sets)`)}`
          : '',
        '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    process.stdout.write(`${renderContextBlock(opts.query, packed)}\n`);
    return 0;
  } finally {
    opened?.close();
    store?.close();
  }
}
