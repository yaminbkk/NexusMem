import type { MemoryStore } from '../store/store.js';
import type { EmbeddingProvider } from './embed.js';

/** `meta` key holding the identity of whatever produced the vectors currently in `nodes_vec`. */
export const EMBEDDING_IDENTITY_KEY = 'embedding.identity';

export interface EmbedPendingResult {
  embedded: number;
  skipped: number;
  /** True if the provider never produced a single vector -- likely means Ollama isn't reachable at all. */
  providerUnavailable: boolean;
  /** Vectors discarded because the provider that made them is no longer the one in use. */
  invalidated: number;
  /**
   * Nodes still without a vector when the pass ended -- whether because
   * `maxNodes` capped it, the provider gave up, or individual texts failed.
   * Measured, not inferred, so the CLI never has to guess whether the
   * backlog was actually cleared.
   */
  remaining: number;
}

export interface EmbedPendingOptions {
  /** Texts per provider request. Default 32. */
  batchSize?: number;
  /** Rows read from SQLite per page. Default 500. */
  pageSize?: number;
  /**
   * Hard cap on nodes attempted in one pass. Default: none -- a single sync
   * drains the whole backlog, which is the point of batching.
   */
  maxNodes?: number;
  /** Consecutive all-failed requests tolerated before giving up. Default 3. */
  failureTolerance?: number;
  /** Called after each request with cumulative attempts and the backlog size measured at the start. */
  onProgress?: (attempted: number, total: number) => void;
  /**
   * Called before any embedding when a provider change forced the existing
   * vectors to be dropped.
   *
   * A callback rather than just the returned count because the re-embed that
   * follows is the longest part of a sync: reporting it afterwards means the
   * user watches an unexplained progress bar and only learns the reason once
   * it has finished. Observed exactly that way while dogfooding this change.
   */
  onInvalidated?: (count: number) => void;
}

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_FAILURE_TOLERANCE = 3;

/**
 * Bring the stored vectors and the current provider back into agreement.
 *
 * Any mismatch invalidates the whole corpus rather than part of it: vectors
 * from two providers occupy different spaces, `nodes_vec` records no
 * per-row provenance, and a KNN over the mixture returns confident
 * nonsense. A corpus with no recorded identity counts as a mismatch -- it
 * predates this key, so it was built by the unnormalised `/api/embeddings`
 * endpoint (see embed.ts) and is not comparable with anything produced now.
 *
 * The cost is honest and bounded: nodes are untouched, so a re-embed
 * rebuilds what was dropped. It is reported, never silent.
 */
function reconcileProviderIdentity(store: MemoryStore, provider: EmbeddingProvider): number {
  if (store.getMeta(EMBEDDING_IDENTITY_KEY) === provider.identity) return 0;

  const invalidated = store.dropAllEmbeddings();
  // Written after the drop, so a crash in between merely repeats a no-op
  // drop on the next run rather than leaving stale vectors under a new name.
  store.setMeta(EMBEDDING_IDENTITY_KEY, provider.identity);
  return invalidated;
}

/** One request's worth of embeddings, positionally aligned, whether or not the provider can batch. */
async function embedTexts(provider: EmbeddingProvider, texts: readonly string[]): Promise<(Float32Array | null)[]> {
  if (provider.embedBatch) return provider.embedBatch(texts);

  const out: (Float32Array | null)[] = [];
  for (const text of texts) out.push(await provider.embed(text));
  return out;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Embed every node for a project that doesn't have a vector yet.
 *
 * A node with no embedding just doesn't participate in vector search --
 * BM25 still finds it. This is additive, not a gate: sync always succeeds
 * whether or not an embedding provider is available.
 *
 * Drains the entire backlog by default. It used to stop after 200 nodes,
 * which meant a large repository needed several `sync` runs before vector
 * search covered it, with nothing in the output saying so. Two things make
 * one pass safe to leave uncapped:
 *
 * - **Paging is monotonic in rowid**, so a node the provider failed on is
 *   passed over rather than retried forever (see `findNodesNeedingEmbedding`).
 * - **A dead provider is detected in seconds, not in timeouts × corpus.**
 *   `failureTolerance` consecutive all-failed requests end the pass, so an
 *   Ollama that isn't running costs three requests, not ten thousand.
 */
export async function embedPendingNodes(
  store: MemoryStore,
  provider: EmbeddingProvider,
  projectId: string,
  opts: EmbedPendingOptions = {},
): Promise<EmbedPendingResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const failureTolerance = opts.failureTolerance ?? DEFAULT_FAILURE_TOLERANCE;
  const maxNodes = opts.maxNodes ?? Number.POSITIVE_INFINITY;

  const invalidated = reconcileProviderIdentity(store, provider);
  if (invalidated > 0) opts.onInvalidated?.(invalidated);

  const total = Math.min(store.countNodesNeedingEmbedding(projectId), maxNodes);

  let embedded = 0;
  let skipped = 0;
  let attempted = 0;
  let consecutiveFailedRequests = 0;
  let cursor = 0;

  outer: while (attempted < maxNodes) {
    const page = store.findNodesNeedingEmbedding(projectId, Math.min(pageSize, maxNodes - attempted), cursor);
    if (page.length === 0) break;
    // Advance before writing anything: the cursor is a position in the walk,
    // not a record of success, and must move past failures too.
    cursor = page[page.length - 1]!.rowid;

    for (const group of chunk(page, batchSize)) {
      const vectors = await embedTexts(
        provider,
        group.map((node) => `${node.title}\n${node.body}`),
      );

      let embeddedHere = 0;
      for (const [index, node] of group.entries()) {
        const vector = vectors[index];
        if (vector && vector.length === provider.dimension) {
          store.upsertEmbedding(node.rowid, projectId, vector);
          embedded += 1;
          embeddedHere += 1;
        } else {
          skipped += 1;
        }
      }

      attempted += group.length;
      consecutiveFailedRequests = embeddedHere === 0 ? consecutiveFailedRequests + 1 : 0;
      opts.onProgress?.(attempted, total);

      if (consecutiveFailedRequests >= failureTolerance) break outer;
    }
  }

  return {
    embedded,
    skipped,
    // Unchanged meaning: nothing came back at all. Reached far sooner now --
    // `failureTolerance` requests instead of the whole first page.
    providerUnavailable: attempted > 0 && embedded === 0,
    invalidated,
    remaining: store.countNodesNeedingEmbedding(projectId),
  };
}
