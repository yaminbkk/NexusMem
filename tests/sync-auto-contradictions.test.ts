import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAutoContradictionCheck } from '../src/cli/commands/sync.js';
import { defaultConfig, type NexusConfig } from '../src/config/workspace.js';
import type { MemoryNode } from '../src/core/types.js';
import { FakeSummarizationProvider } from '../src/slm/provider.js';
import { EMBEDDING_DIM } from '../src/store/schema.js';
import { MemoryStore } from '../src/store/store.js';
import { FakeEmbeddingProvider } from '../src/vector/embed.js';

const PROJECT = 'proj-a';
/** Old enough to clear listStaleCandidates' 45-day default against the real clock for years. */
const OLD_TS = '2026-01-01T00:00:00Z';

const node = (overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id'>): MemoryNode => ({
  kind: 'session_summary',
  projectId: PROJECT,
  ts: OLD_TS,
  source: 'session:claude-code',
  title: 'Decided to use SQLite',
  body: 'We chose SQLite for local-first storage.',
  files: [],
  signal: 0.5,
  meta: {},
  ...overrides,
});

describe('runAutoContradictionCheck (the sync-time leg)', () => {
  let dir: string;
  let store: MemoryStore;
  let config: NexusConfig;
  const embedder = new FakeEmbeddingProvider(EMBEDDING_DIM);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-autocheck-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
    config = defaultConfig(PROJECT);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function embedAllPending(): Promise<void> {
    for (const pending of store.findNodesNeedingEmbedding(PROJECT)) {
      const vector = await embedder.embed(`${pending.title}\n${pending.body}`);
      store.upsertEmbedding(pending.rowid, PROJECT, vector!);
    }
  }

  /** An old derived claim plus a newer observed event with identical text -- guaranteed nearest neighbour. */
  async function seedContradictablePair(): Promise<void> {
    store.upsertNodes([
      node({ id: 'old-claim' }),
      node({ id: 'newer-event', kind: 'git_commit', source: 'git', ts: '2026-02-01T00:00:00Z' }),
    ]);
    await embedAllPending();
  }

  it('does nothing when disabled in config', async () => {
    await seedContradictablePair();
    const slm = new FakeSummarizationProvider(() => 'VERDICT: YES\nREASON: should never fire');

    const disabled = { ...config, contradictions: { ...config.contradictions, autoCheck: false } };
    const line = await runAutoContradictionCheck(store, disabled, PROJECT, { embedder, slm });

    expect(line).toBe('');
    expect(slm.prompts).toHaveLength(0);
  });

  it('does nothing when the corpus has no stale candidates yet', async () => {
    store.upsertNodes([node({ id: 'fresh', ts: new Date().toISOString() })]);
    await embedAllPending();
    const slm = new FakeSummarizationProvider(() => 'VERDICT: YES\nREASON: should never fire');

    const line = await runAutoContradictionCheck(store, config, PROJECT, { embedder, slm });

    expect(line).toBe('');
    expect(slm.prompts).toHaveLength(0);
  });

  it('records a YES judgment and reports it in the summary line', async () => {
    await seedContradictablePair();
    const slm = new FakeSummarizationProvider(() => 'VERDICT: YES\nREASON: the decision was reversed');

    const line = await runAutoContradictionCheck(store, config, PROJECT, { embedder, slm });

    expect(line).toContain('1 new');
    expect(line).toContain('1 open suggestion(s)');
    expect(line).toContain('nexusmem stale');
    expect(store.hasContradictionCheck('old-claim', 'newer-event')).toBe(true);
    expect(store.countContradictionSuggestions(PROJECT)).toBe(1);
  });

  it('spends at most maxPerSync new judgments per run', async () => {
    store.upsertNodes([
      node({ id: 'claim-a', title: 'Claim A', body: 'topic alpha' }),
      node({ id: 'claim-b', title: 'Claim B', body: 'topic beta' }),
      node({ id: 'event-a', kind: 'git_commit', source: 'git', ts: '2026-02-01T00:00:00Z', title: 'Event A', body: 'topic alpha' }),
      node({ id: 'event-b', kind: 'git_commit', source: 'git', ts: '2026-02-01T00:00:00Z', title: 'Event B', body: 'topic beta' }),
    ]);
    await embedAllPending();
    const slm = new FakeSummarizationProvider(() => 'VERDICT: NO\nREASON: n/a');

    const capped = { ...config, contradictions: { ...config.contradictions, maxPerSync: 1 } };
    await runAutoContradictionCheck(store, capped, PROJECT, { embedder, slm });

    expect(slm.prompts).toHaveLength(1);
  });

  it('costs zero model calls on the next run once every pair is judged, but still reports open suggestions', async () => {
    await seedContradictablePair();
    const slm = new FakeSummarizationProvider(() => 'VERDICT: YES\nREASON: reversed');
    await runAutoContradictionCheck(store, config, PROJECT, { embedder, slm });
    expect(slm.prompts).toHaveLength(1);

    const line = await runAutoContradictionCheck(store, config, PROJECT, { embedder, slm });

    expect(slm.prompts).toHaveLength(1); // memoized, no second call
    expect(line).toContain('0 new');
    expect(line).toContain('1 open suggestion(s)');
  });
});
