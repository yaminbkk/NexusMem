import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESOLVED_BY_DISCUSSION, RESOLVED_BY_RETRY } from '../src/correlate/failure-fix.js';
import type { MemoryNode } from '../src/core/types.js';
import { runCrossProjectQuery, runHybridQuery } from '../src/retrieval/query-pipeline.js';
import { MemoryStore } from '../src/store/store.js';

/**
 * Phase 7/8's chain feature, packing side: a shell_command failure's linked
 * resolution should ride along in the packed result even when the
 * resolution's own text has nothing to do with the query -- that is the
 * entire point (see the doc comment above `pullLinkedResolutions` in
 * `src/retrieval/query-pipeline.ts`). Both RESOLVED_BY_RETRY and
 * RESOLVED_BY_DISCUSSION are pulled in as of Phase 8's discussion-heuristic
 * tightening (`toStrictMatchQuery`) -- see that function's doc comment for
 * the dogfooding evidence.
 */

const PROJECT = 'proj-a';

function node(overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id'>): MemoryNode {
  return {
    kind: 'note',
    projectId: PROJECT,
    ts: '2026-08-01T00:00:00Z',
    source: 'test',
    title: 'untitled',
    body: 'untitled',
    files: [],
    signal: 0.5,
    meta: {},
    ...overrides,
  };
}

describe('runHybridQuery -- retrieval bookkeeping', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-query-pipeline-retrieval-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('bumps retrieved_count/last_retrieved_at only for nodes actually packed into the result', async () => {
    store.upsertNodes([
      node({ id: 'matched', title: 'npm publish OTP error', body: 'npm publish OTP error' }),
      node({ id: 'unrelated', title: 'kubernetes ingress rules', body: 'kubernetes ingress rules' }),
    ]);

    const before = Date.now();
    await runHybridQuery(store, PROJECT, 'npm publish OTP', { budget: 2000, candidates: 30 });

    const matched = store.getRetrievalStats('matched');
    const unrelated = store.getRetrievalStats('unrelated');

    expect(matched).not.toBeNull();
    expect(matched!.retrievedCount).toBe(1);
    expect(matched!.lastRetrievedAt).toBeGreaterThanOrEqual(before);

    // discriminating: a node the query never surfaced must not move at all
    expect(unrelated).toEqual({ retrievedCount: 0, lastRetrievedAt: null });
  });

  it('accumulates across repeated queries instead of resetting', async () => {
    store.upsertNodes([node({ id: 'matched', title: 'npm publish OTP error', body: 'npm publish OTP error' })]);

    await runHybridQuery(store, PROJECT, 'npm publish OTP', { budget: 2000, candidates: 30 });
    await runHybridQuery(store, PROJECT, 'npm publish OTP', { budget: 2000, candidates: 30 });

    expect(store.getRetrievalStats('matched')!.retrievedCount).toBe(2);
  });

  it('does not reset retrieval history on re-sync -- same exclusion rule as supersedes/trust_state', async () => {
    store.upsertNodes([node({ id: 'matched', title: 'npm publish OTP error', body: 'npm publish OTP error' })]);
    await runHybridQuery(store, PROJECT, 'npm publish OTP', { budget: 2000, candidates: 30 });
    expect(store.getRetrievalStats('matched')!.retrievedCount).toBe(1);

    // A re-sync with a genuinely changed body still goes through upsertNodes' UPDATE path.
    store.upsertNodes([node({ id: 'matched', title: 'npm publish OTP error', body: 'npm publish OTP error, now with more detail' })]);

    expect(store.getRetrievalStats('matched')!.retrievedCount).toBe(1);
  });
});

describe('runHybridQuery -- pulling in a failure\'s linked resolution', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-query-pipeline-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('includes a RESOLVED_BY_RETRY resolution in the packed result even though its own text does not match the query', async () => {
    store.upsertNodes([
      node({ id: 'fail', kind: 'shell_command', title: 'npm publish failed', body: 'npm publish failed with an OTP error' }),
      node({ id: 'fix', kind: 'shell_command', title: 'unrelated text', body: 'this body shares no words with the query at all' }),
    ]);
    store.linkNodes('fail', 'fix', RESOLVED_BY_RETRY);

    const result = await runHybridQuery(store, PROJECT, 'npm publish OTP', { budget: 2000, candidates: 30 });

    const ids = result.packed.nodes.map((n) => n.id);
    expect(ids).toContain('fail');
    expect(ids).toContain('fix'); // discriminating: "fix" cannot win on relevance alone
  });

  it('does not duplicate a resolution that already matched the query on its own merits', async () => {
    store.upsertNodes([
      node({ id: 'fail', kind: 'shell_command', title: 'npm publish failed', body: 'npm publish failed with an OTP error' }),
      node({ id: 'fix', kind: 'shell_command', title: 'npm publish OTP retry', body: 'npm publish OTP retry succeeded' }),
    ]);
    store.linkNodes('fail', 'fix', RESOLVED_BY_RETRY);

    const result = await runHybridQuery(store, PROJECT, 'npm publish OTP', { budget: 2000, candidates: 30 });

    expect(result.packed.nodes.filter((n) => n.id === 'fix')).toHaveLength(1);
  });

  it('pulls in a RESOLVED_BY_DISCUSSION link too, same as retry, since Phase 8 tightened the heuristic', async () => {
    store.upsertNodes([
      node({ id: 'fail', kind: 'shell_command', title: 'npm publish failed', body: 'npm publish failed with an OTP error' }),
      node({ id: 'discussion', kind: 'conversation_turn', title: 'unrelated text', body: 'this body shares no words with the query at all' }),
    ]);
    store.linkNodes('fail', 'discussion', RESOLVED_BY_DISCUSSION);

    const result = await runHybridQuery(store, PROJECT, 'npm publish OTP', { budget: 2000, candidates: 30 });

    expect(result.packed.nodes.map((n) => n.id)).toContain('discussion'); // discriminating: cannot win on relevance alone
  });

  it('a failure with no link pulls in nothing extra', async () => {
    store.upsertNodes([node({ id: 'fail', kind: 'shell_command', title: 'npm publish failed', body: 'npm publish failed with an OTP error' })]);

    const result = await runHybridQuery(store, PROJECT, 'npm publish OTP', { budget: 2000, candidates: 30 });

    expect(result.packed.nodes.map((n) => n.id)).toEqual(['fail']);
  });

  it('a pulled-in resolution inherits its failure\'s score rather than computing its own', async () => {
    store.upsertNodes([
      node({ id: 'fail', kind: 'shell_command', title: 'npm publish failed', body: 'npm publish failed with an OTP error' }),
      node({ id: 'fix', kind: 'shell_command', title: 'unrelated text', body: 'this body shares no words with the query at all' }),
    ]);
    store.linkNodes('fail', 'fix', RESOLVED_BY_RETRY);

    const result = await runHybridQuery(store, PROJECT, 'npm publish OTP', { budget: 2000, candidates: 30 });

    const fail = result.packed.nodes.find((n) => n.id === 'fail')!;
    const fix = result.packed.nodes.find((n) => n.id === 'fix')!;
    expect(fix.score).toBe(fail.score);
  });
});

describe('runCrossProjectQuery -- chain-following across the project boundary (Phase 8)', () => {
  let dirA: string;
  let dirB: string;
  let storeA: MemoryStore;
  let storeB: MemoryStore;

  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), 'nexusmem-cross-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'nexusmem-cross-b-'));
    storeA = MemoryStore.open(join(dirA, 'memory.db'));
    storeB = MemoryStore.open(join(dirB, 'memory.db'));
  });

  afterEach(() => {
    storeA.close();
    storeB.close();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('pulls in a linked resolution recorded in a source project\'s own database, not the querying one', async () => {
    storeA.upsertNodes([
      node({ id: 'fail', projectId: 'proj-a', kind: 'shell_command', title: 'npm publish failed', body: 'npm publish failed with an OTP error' }),
      node({ id: 'fix', projectId: 'proj-a', kind: 'shell_command', title: 'unrelated text', body: 'this body shares no words with the query at all' }),
    ]);
    storeA.linkNodes('fail', 'fix', RESOLVED_BY_RETRY);
    storeB.upsertNodes([node({ id: 'other', projectId: 'proj-b', kind: 'note', title: 'unrelated', body: 'nothing to do with this query' })]);

    const result = await runCrossProjectQuery(
      [
        { store: storeA, projectId: 'proj-a', label: 'A' },
        { store: storeB, projectId: 'proj-b', label: 'B' },
      ],
      'npm publish OTP',
      { budget: 2000, candidates: 30 },
    );

    const ids = result.packed.nodes.map((n) => n.id);
    expect(ids).toContain('fail');
    expect(ids).toContain('fix'); // discriminating: only reachable via storeA's own link table, not storeB's
  });
});
