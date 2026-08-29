import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryNode } from '../src/core/types.js';
import { EMBEDDING_DIM } from '../src/store/schema.js';
import { MemoryStore } from '../src/store/store.js';
import { OllamaEmbeddingProvider, type EmbeddingProvider } from '../src/vector/embed.js';
import { EMBEDDING_IDENTITY_KEY, embedPendingNodes } from '../src/vector/sync.js';

const PROJECT = 'proj-a';

function vector(fill: number): Float32Array {
  return new Float32Array(EMBEDDING_DIM).fill(fill);
}

/**
 * Records how the pass called it, so a test can assert the *shape* of the
 * traffic (how many round trips, how many texts each) and not merely the
 * outcome. Batching is invisible in the result object -- 250 embedded looks
 * identical whether it took 8 requests or 250.
 */
class RecordingProvider implements EmbeddingProvider {
  readonly dimension = EMBEDDING_DIM;
  readonly requests: number[] = [];

  constructor(
    readonly identity = 'recording:v1',
    private readonly fails: (text: string) => boolean = () => false,
  ) {}

  async embed(text: string): Promise<Float32Array | null> {
    const [only] = await this.embedBatch([text]);
    return only ?? null;
  }

  async embedBatch(texts: readonly string[]): Promise<(Float32Array | null)[]> {
    this.requests.push(texts.length);
    return texts.map((text) => (this.fails(text) ? null : vector(0.1)));
  }
}

describe('embedPendingNodes drains the backlog in one pass', () => {
  let dir: string;
  let store: MemoryStore;

  const node = (id: string, overrides: Partial<MemoryNode> = {}): MemoryNode => ({
    id,
    kind: 'git_commit',
    projectId: PROJECT,
    ts: '2026-08-12T00:00:00Z',
    source: 'git',
    title: `commit ${id}`,
    body: `body of ${id}`,
    files: [],
    signal: 0.5,
    meta: {},
    ...overrides,
  });

  const seed = (count: number, overrides: (i: number) => Partial<MemoryNode> = () => ({})) => {
    store.upsertNodes(Array.from({ length: count }, (_, i) => node(`n${i}`, overrides(i))));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-embed-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('embeds a backlog larger than the old 200-node cap without a second sync', async () => {
    seed(250);
    const provider = new RecordingProvider();

    const result = await embedPendingNodes(store, provider, PROJECT);

    expect(result.embedded).toBe(250);
    expect(result.remaining).toBe(0);
    expect(store.countNodesNeedingEmbedding(PROJECT)).toBe(0);
  });

  it('spends one request per batch, not one per node', async () => {
    seed(100);
    const provider = new RecordingProvider();

    await embedPendingNodes(store, provider, PROJECT, { batchSize: 25 });

    expect(provider.requests).toEqual([25, 25, 25, 25]);
  });

  it('honours maxNodes and reports the leftover backlog', async () => {
    seed(50);
    const provider = new RecordingProvider();

    const result = await embedPendingNodes(store, provider, PROJECT, { maxNodes: 20, batchSize: 10 });

    expect(result.embedded).toBe(20);
    expect(result.remaining).toBe(30);
    // Never overshoots the cap by rounding a batch up.
    expect(provider.requests.reduce((a, b) => a + b, 0)).toBe(20);
  });

  it('crosses a page boundary rather than stopping at the first page', async () => {
    seed(30);
    const provider = new RecordingProvider();

    const result = await embedPendingNodes(store, provider, PROJECT, { pageSize: 10, batchSize: 10 });

    expect(result.embedded).toBe(30);
    expect(provider.requests).toEqual([10, 10, 10]);
  });
});

describe('embedPendingNodes failure handling', () => {
  let dir: string;
  let store: MemoryStore;

  const seed = (count: number) => {
    store.upsertNodes(
      Array.from({ length: count }, (_, i) => ({
        id: `n${i}`,
        kind: 'git_commit' as const,
        projectId: PROJECT,
        ts: '2026-08-12T00:00:00Z',
        source: 'git',
        title: `commit n${i}`,
        body: `body of n${i}`,
        files: [],
        signal: 0.5,
        meta: {},
      })),
    );
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-embed-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives up after failureTolerance requests instead of timing out once per node', async () => {
    seed(500);
    const dead = new RecordingProvider('dead:v1', () => true);

    const result = await embedPendingNodes(store, dead, PROJECT, { batchSize: 10, failureTolerance: 3 });

    // The whole point: an unreachable Ollama costs 3 requests, not 50.
    expect(dead.requests).toHaveLength(3);
    expect(result.providerUnavailable).toBe(true);
    expect(result.embedded).toBe(0);
    expect(result.remaining).toBe(500);
  });

  it('terminates when individual nodes keep failing, since a failure stays pending', async () => {
    seed(40);
    // Every other node fails, so no request is ever a total failure and the
    // circuit breaker never trips -- termination has to come from the walk
    // advancing past failures rather than re-reading them.
    const flaky = new RecordingProvider('flaky:v1', (text) => /n\d*[13579]\b/.test(text));

    const result = await embedPendingNodes(store, flaky, PROJECT, { batchSize: 8, pageSize: 16 });

    expect(result.embedded + result.skipped).toBe(40);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.remaining).toBe(result.skipped);
    expect(result.providerUnavailable).toBe(false);
  });

  it('resets the failure counter after a request succeeds', async () => {
    seed(60);
    // Alternating fail/succeed, tolerance 2. `failureTolerance` counts
    // *consecutive* dead requests, so this must run all six batches. Were the
    // counter merely cumulative, the third batch would end the pass and 30
    // embeddable nodes would be abandoned because of scattered failures.
    let seen = 0;
    const provider: EmbeddingProvider = {
      dimension: EMBEDDING_DIM,
      identity: 'alternating:v1',
      embed: async () => null,
      embedBatch: async (texts) => {
        seen += 1;
        return texts.map(() => (seen % 2 === 1 ? null : vector(0.2)));
      },
    };

    const result = await embedPendingNodes(store, provider, PROJECT, { batchSize: 10, failureTolerance: 2 });

    expect(seen).toBe(6);
    expect(result.embedded).toBe(30);
    expect(result.skipped).toBe(30);
  });

  it('falls back to one call at a time for a provider that cannot batch', async () => {
    seed(5);
    const calls: string[] = [];
    const provider: EmbeddingProvider = {
      dimension: EMBEDDING_DIM,
      identity: 'no-batch:v1',
      embed: async (text) => {
        calls.push(text);
        return vector(0.3);
      },
    };

    const result = await embedPendingNodes(store, provider, PROJECT, { batchSize: 32 });

    expect(result.embedded).toBe(5);
    expect(calls).toHaveLength(5);
  });
});

describe('embedding provider identity', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-embed-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
    store.upsertNodes([
      {
        id: 'a',
        kind: 'git_commit',
        projectId: PROJECT,
        ts: '2026-08-12T00:00:00Z',
        source: 'git',
        title: 'fix: thing',
        body: 'fix: thing',
        files: [],
        signal: 0.5,
        meta: {},
      },
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the provider identity on the first pass', async () => {
    await embedPendingNodes(store, new RecordingProvider('model-a:v1'), PROJECT);
    expect(store.getMeta(EMBEDDING_IDENTITY_KEY)).toBe('model-a:v1');
  });

  it('does not re-embed when the same provider runs again', async () => {
    await embedPendingNodes(store, new RecordingProvider('model-a:v1'), PROJECT);
    const second = await embedPendingNodes(store, new RecordingProvider('model-a:v1'), PROJECT);

    expect(second.invalidated).toBe(0);
    expect(second.embedded).toBe(0);
  });

  it('drops every vector and re-embeds when the provider changes', async () => {
    await embedPendingNodes(store, new RecordingProvider('model-a:v1'), PROJECT);
    const second = await embedPendingNodes(store, new RecordingProvider('model-b:v1'), PROJECT);

    expect(second.invalidated).toBe(1);
    expect(second.embedded).toBe(1);
    expect(store.getMeta(EMBEDDING_IDENTITY_KEY)).toBe('model-b:v1');
  });

  it('treats a corpus with no recorded identity as unusable', async () => {
    // What an upgrade from a pre-identity release looks like on disk: vectors
    // present, provenance unknown. They came from the unnormalised endpoint,
    // so they cannot be compared with anything produced now.
    const [pending] = store.findNodesNeedingEmbedding(PROJECT);
    store.upsertEmbedding(pending!.rowid, PROJECT, vector(0.9));
    expect(store.getMeta(EMBEDDING_IDENTITY_KEY)).toBeNull();

    const result = await embedPendingNodes(store, new RecordingProvider('model-a:v1'), PROJECT);

    expect(result.invalidated).toBe(1);
    expect(result.embedded).toBe(1);
  });

  it('announces the invalidation before the re-embed it causes, not after', async () => {
    await embedPendingNodes(store, new RecordingProvider('model-a:v1'), PROJECT);

    const events: string[] = [];
    await embedPendingNodes(store, new RecordingProvider('model-b:v1'), PROJECT, {
      onInvalidated: () => events.push('invalidated'),
      onProgress: () => events.push('progress'),
    });

    // Reported after the fact, the reason for a long re-embed arrives once the
    // wait is already over -- which is how it first shipped.
    expect(events).toEqual(['invalidated', 'progress']);
  });

  it('invalidates even when the new provider is unreachable, rather than leaving a mixed corpus', async () => {
    await embedPendingNodes(store, new RecordingProvider('model-a:v1'), PROJECT);
    const dead = new RecordingProvider('model-b:v1', () => true);

    const result = await embedPendingNodes(store, dead, PROJECT);

    expect(result.invalidated).toBe(1);
    expect(result.providerUnavailable).toBe(true);
    // BM25-only until the provider is back -- but never mixed-space KNN.
    expect(store.raw.prepare('SELECT COUNT(*) AS n FROM nodes_vec').get()).toEqual({ n: 0 });
  });
});

describe('OllamaEmbeddingProvider', () => {
  const okResponse = (embeddings: number[][]) =>
    ({ ok: true, json: async () => ({ embeddings }) }) as unknown as Response;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends one request carrying every text, to the batch endpoint', async () => {
    const fetchMock = vi.fn(async () => okResponse([Array(768).fill(0.1), Array(768).fill(0.2)]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaEmbeddingProvider();
    const out = await provider.embedBatch(['first', 'second']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/api/embed');
    expect(JSON.parse(init.body as string).input).toEqual(['first', 'second']);
    expect(out.map((v) => v?.length)).toEqual([768, 768]);
  });

  it('refuses a response whose row count does not match the input', async () => {
    // A short array would otherwise slide every vector onto the wrong node --
    // silent mislabelling, far worse than embedding nothing.
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([Array(768).fill(0.1)])));

    const out = await new OllamaEmbeddingProvider().embedBatch(['first', 'second']);
    expect(out).toEqual([null, null]);
  });

  it('nulls one row of a batch without discarding the rest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([Array(768).fill(0.1), Array(5).fill(0.2)])));

    const out = await new OllamaEmbeddingProvider().embedBatch(['first', 'second']);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[1]).toBeNull();
  });

  it('degrades to nulls, not an exception, when the server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(new OllamaEmbeddingProvider().embedBatch(['a', 'b'])).resolves.toEqual([null, null]);
  });

  it('never calls the network for an empty batch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await new OllamaEmbeddingProvider().embedBatch([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('changes identity with the model but not with the host', () => {
    const a = new OllamaEmbeddingProvider({ model: 'nomic-embed-text' });
    const b = new OllamaEmbeddingProvider({ model: 'mxbai-embed-large' });
    const remote = new OllamaEmbeddingProvider({ model: 'nomic-embed-text', baseUrl: 'http://gpu-box:11434' });

    expect(a.identity).not.toBe(b.identity);
    // Same model on another machine is the same embedding space; re-embedding
    // the corpus for a URL change would be pure waste.
    expect(remote.identity).toBe(a.identity);
  });
});
