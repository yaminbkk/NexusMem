import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryNode } from '../src/core/types.js';
import { packContext, renderContextBlock } from '../src/retrieval/pack.js';
import { rankHits, type RankedHit } from '../src/retrieval/rank.js';
import type { SearchHit } from '../src/store/store.js';
import { MemoryStore } from '../src/store/store.js';

const NOW = new Date('2026-08-08T00:00:00Z');

function hit(overrides: Partial<SearchHit> & Pick<SearchHit, 'id'>): SearchHit {
  return {
    kind: 'git_commit',
    ts: '2026-08-01T00:00:00Z',
    title: 'feat: something',
    body: 'feat: something\n\nmore detail',
    signal: 0.5,
    provenance: 'observed',
    trustState: 'candidate',
    rank: -2,
    ...overrides,
  };
}

describe('rankHits', () => {
  it('returns [] for no hits without dividing by zero', () => {
    expect(rankHits([])).toEqual([]);
  });

  it('ranks a stronger bm25 match above a weaker one, all else equal', () => {
    const ranked = rankHits([hit({ id: 'weak', rank: -1 }), hit({ id: 'strong', rank: -5 })], { now: NOW });
    expect(ranked.map((r) => r.id)).toEqual(['strong', 'weak']);
    expect(ranked[0]!.relevance).toBeGreaterThan(ranked[1]!.relevance);
  });

  it('uses signal to break relevance ties', () => {
    const ranked = rankHits(
      [
        hit({ id: 'chore', rank: -2, signal: 0.2, ts: NOW.toISOString() }),
        hit({ id: 'fix', rank: -2, signal: 0.9, ts: NOW.toISOString() }),
      ],
      { now: NOW },
    );
    expect(ranked.map((r) => r.id)).toEqual(['fix', 'chore']);
  });

  it('decays older nodes below newer ones at equal relevance and signal', () => {
    const old = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    const ranked = rankHits(
      [hit({ id: 'old', rank: -2, ts: old }), hit({ id: 'new', rank: -2, ts: NOW.toISOString() })],
      { now: NOW, halfLifeDays: 30 },
    );
    expect(ranked.map((r) => r.id)).toEqual(['new', 'old']);
    expect(ranked[1]!.recencyFactor).toBeGreaterThanOrEqual(0.3); // floor, never zero
  });

  it('decays each lower trust tier faster than the one above it at equal age, relevance and signal', () => {
    const age45d = new Date(NOW.getTime() - 45 * 86_400_000).toISOString();
    const ranked = rankHits(
      [
        hit({ id: 'derived', rank: -2, ts: age45d, provenance: 'derived' }),
        hit({ id: 'observed', rank: -2, ts: age45d, provenance: 'observed' }),
        hit({ id: 'recorded', rank: -2, ts: age45d, provenance: 'recorded' }),
        hit({ id: 'authored', rank: -2, ts: age45d, provenance: 'authored' }),
      ],
      { now: NOW, halfLifeDays: 30 },
    );
    expect(ranked.map((r) => r.id)).toEqual(['observed', 'authored', 'recorded', 'derived']);
  });

  it('respects an explicit halfLifeRatios override instead of the built-in per-tier defaults', () => {
    const age10d = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    const ranked = rankHits([hit({ id: 'a', rank: -2, ts: age10d, provenance: 'recorded' })], {
      now: NOW,
      halfLifeDays: 30,
      halfLifeRatios: { recorded: 1 }, // same as observed -- no extra decay
    });
    // 2**(-10/30) blended into [0.3, 1]
    expect(ranked[0]!.recencyFactor).toBeCloseTo(0.3 + 0.7 * 2 ** (-10 / 30), 5);
  });

  it('never lets one factor crush the others to exactly zero', () => {
    const veryOld = new Date(NOW.getTime() - 5000 * 86_400_000).toISOString();
    const ranked = rankHits([hit({ id: 'ancient', rank: -2, signal: 0.05, ts: veryOld })], { now: NOW });
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });

  it('gives every hit relevance 1 when all bm25 costs are identical', () => {
    const ranked = rankHits([hit({ id: 'a', rank: -3 }), hit({ id: 'b', rank: -3 })], { now: NOW });
    expect(ranked.every((r) => r.relevance === 1)).toBe(true);
  });
});

describe('rankHits — supersededIds down-weight (mark-stale)', () => {
  it('ranks a superseded node below the node that supersedes it, all else equal', () => {
    const ranked = rankHits([hit({ id: 'old-conclusion', rank: -3 }), hit({ id: 'new-conclusion', rank: -3 })], {
      now: NOW,
      supersededIds: new Set(['old-conclusion']),
    });
    expect(ranked[0]!.id).toBe('new-conclusion');
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('never removes a superseded node from the results -- it stays queryable, just deprioritized', () => {
    const ranked = rankHits([hit({ id: 'stale', rank: -3 })], { now: NOW, supersededIds: new Set(['stale']) });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });

  it('leaves scores untouched when supersededIds is omitted or empty', () => {
    const withoutOpt = rankHits([hit({ id: 'a', rank: -3 })], { now: NOW });
    const withEmptySet = rankHits([hit({ id: 'a', rank: -3 })], { now: NOW, supersededIds: new Set() });
    expect(withEmptySet[0]!.score).toBe(withoutOpt[0]!.score);
  });
});

describe('rankHits — trust_state rejected down-weight (review)', () => {
  it('ranks a rejected node below a candidate node, all else equal', () => {
    const ranked = rankHits(
      [hit({ id: 'rejected', rank: -3, trustState: 'rejected' }), hit({ id: 'candidate', rank: -3, trustState: 'candidate' })],
      { now: NOW },
    );
    expect(ranked[0]!.id).toBe('candidate');
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('never removes a rejected node from the results -- review demotes, it does not delete', () => {
    const ranked = rankHits([hit({ id: 'rejected', rank: -3, trustState: 'rejected' })], { now: NOW });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });

  it('gives verified no ranking boost over candidate -- a label, not a prior', () => {
    const verified = rankHits([hit({ id: 'a', rank: -3, trustState: 'verified' })], { now: NOW });
    const candidate = rankHits([hit({ id: 'a', rank: -3, trustState: 'candidate' })], { now: NOW });
    expect(verified[0]!.score).toBe(candidate[0]!.score);
  });

  it('stacks with the supersededIds penalty rather than replacing it', () => {
    const both = rankHits([hit({ id: 'x', rank: -3, trustState: 'rejected' })], { now: NOW, supersededIds: new Set(['x']) });
    const rejectedOnly = rankHits([hit({ id: 'x', rank: -3, trustState: 'rejected' })], { now: NOW });
    expect(both[0]!.score).toBeLessThan(rejectedOnly[0]!.score);
  });
});

/**
 * The priors (signal, recency) are bounded relative to relevance: *together*,
 * across their whole range, they may overturn at most a 2x relevance gap, and
 * each one alone at most sqrt(2). These pin both boundaries from both sides, so
 * a future weight change cannot quietly move them.
 *
 * `relevanceScores` is used rather than bm25 `rank` because it is the only way
 * to place a hit at a *chosen* relevance: both paths min-max rescale into
 * [0.15, 1], so with two hits the gap is always maximal. The extra anchor hit
 * pins the bottom of that rescale.
 */
describe('rankHits — prior vs relevance balance', () => {
  const AT_NOW = NOW.toISOString();
  /** Old enough that 2**(-age/halfLife) is ~0 and recencyFactor sits on its floor. */
  const AT_FLOOR = new Date(NOW.getTime() - 3000 * 86_400_000).toISOString();

  /** Build hits whose post-normalization relevance lands on `targets`. */
  function withRelevance(targets: Array<{ id: string; relevance: number; signal: number; ts?: string }>) {
    const scores = new Map<string, number>();
    for (const t of targets) scores.set(t.id, (t.relevance - 0.15) / 0.85);
    scores.set('_anchor', 0); // pins min so the rescale is the identity above

    const hits = [
      ...targets.map((t) => hit({ id: t.id, signal: t.signal, ts: t.ts ?? AT_NOW })),
      hit({ id: '_anchor', signal: 0.5, ts: AT_NOW }),
    ];
    return rankHits(hits, { now: NOW, halfLifeDays: 30, relevanceScores: scores });
  }

  it('lets max signal overturn a relevance gap below sqrt(2)', () => {
    const ranked = withRelevance([
      { id: 'relevant', relevance: 1.0, signal: 0 }, // signalWeight 0.2 (worst)
      { id: 'important', relevance: 0.75, signal: 1 }, // signalWeight 1.0 (best), gap 1.33x
    ]);
    expect(ranked[0]!.id).toBe('important');
  });

  it('does not let max signal alone overturn a relevance gap above sqrt(2)', () => {
    const ranked = withRelevance([
      { id: 'relevant', relevance: 1.0, signal: 0 },
      { id: 'important', relevance: 0.6, signal: 1 }, // gap 1.67x
    ]);
    expect(ranked[0]!.id).toBe('relevant');
  });

  it('lets both priors at once overturn a relevance gap below 2x', () => {
    // Worst prior pair (no signal, on the recency floor) against the best
    // (max signal, brand new): the widest swing the two can produce together.
    const ranked = withRelevance([
      { id: 'relevant', relevance: 1.0, signal: 0, ts: AT_FLOOR },
      { id: 'fresh-and-important', relevance: 0.56, signal: 1, ts: AT_NOW }, // gap 1.79x
    ]);
    expect(ranked[0]!.id).toBe('fresh-and-important');
  });

  it('does not let both priors together overturn a relevance gap above 2x', () => {
    // The cap that matters, and the one that was missing: bounding signal at 2x
    // and recency at 2x separately left the pair free to overturn 4x, so a node
    // that was both fresh and high-signal outranked the answer to the question.
    const ranked = withRelevance([
      { id: 'relevant', relevance: 1.0, signal: 0, ts: AT_FLOOR },
      { id: 'fresh-and-important', relevance: 0.4, signal: 1, ts: AT_NOW }, // gap 2.5x
    ]);
    expect(ranked[0]!.id).toBe('relevant');
  });

  it('keeps the answer above a burst of same-day fix commits (the dogfooded regression)', () => {
    // The observed production case: a query about the PowerShell hook returned
    // two same-day `fix:` commits at ranks 3 and 4 while the doc section that
    // answered it sat at rank 6. The doc matched better but was three weeks old
    // and lower-signal, and the two priors compounded.
    // The 1.30x relevance gap is chosen, not rounded: this pair of priors is
    // worth 1.40x jointly under per-prior caps and 1.18x under the joint cap, so
    // only a gap between those two numbers tells the versions apart. At 1.30x
    // both commits outranked the doc before the fix.
    const threeWeeksOld = new Date(NOW.getTime() - 21 * 86_400_000).toISOString();
    const ranked = withRelevance([
      { id: 'doc', relevance: 1.0, signal: 0.55, ts: threeWeeksOld },
      { id: 'fix-a', relevance: 0.77, signal: 0.9, ts: AT_NOW },
      { id: 'fix-b', relevance: 0.75, signal: 0.9, ts: AT_NOW },
    ]);
    expect(ranked[0]!.id).toBe('doc');
  });

  it('keeps the top-matching doc above a higher-signal commit (the dogfooded regression)', () => {
    // Reproduces the observed production pair: a `fix:` commit (signal .9) beat
    // the top-fused README section (signal .55) on signal alone, despite a 15%
    // relevance deficit and identical recency.
    const ranked = withRelevance([
      { id: 'doc', relevance: 1.0, signal: 0.55 },
      { id: 'commit', relevance: 0.847, signal: 0.9 },
    ]);
    expect(ranked[0]!.id).toBe('doc');
  });

  it('still reports the raw, un-exponentiated factors for display', () => {
    const ranked = withRelevance([{ id: 'a', relevance: 1.0, signal: 0.5 }]);
    const a = ranked.find((r) => r.id === 'a')!;
    expect(a.signalWeight).toBeCloseTo(0.6, 5); // 0.2 + 0.8 * 0.5
    expect(a.score).toBeLessThan(a.relevance); // but scoring discounted it
  });
});

function ranked(overrides: Partial<RankedHit> & Pick<RankedHit, 'id'>): RankedHit {
  const base = hit(overrides);
  return { ...base, relevance: 1, signalWeight: 1, recencyFactor: 1, ageDays: 0, score: 1, ...overrides };
}

describe('packContext', () => {
  it('never exceeds the token budget', () => {
    const hits = Array.from({ length: 20 }, (_, i) =>
      ranked({ id: `n${i}`, score: 1 - i * 0.01, body: 'x'.repeat(400) }),
    );
    const result = packContext(hits, 200);
    expect(result.tokensUsed).toBeLessThanOrEqual(200);
  });

  it('includes the highest-score hits first', () => {
    // packContext trusts its input is already sorted (rankHits's job) --
    // pass it pre-sorted, as real callers do.
    const hits = [
      ranked({ id: 'high', score: 0.9, body: 'small body' }),
      ranked({ id: 'low', score: 0.1, body: 'small body' }),
    ];
    const result = packContext(hits, 1000);
    expect(result.nodes[0]!.id).toBe('high');
  });

  it('skips a big node that does not fit and still packs a smaller lower-score one', () => {
    const hits = [
      ranked({ id: 'big', score: 0.9, title: 'big', body: 'y'.repeat(4000) }),
      ranked({ id: 'small', score: 0.5, title: 'small', body: 'tiny' }),
    ];
    const result = packContext(hits, 50);
    expect(result.nodes.map((n) => n.id)).toEqual(['small']);
    expect(result.droppedForBudget).toBe(1);
  });

  it('reports how many candidates were considered', () => {
    const hits = [ranked({ id: 'a' }), ranked({ id: 'b' })];
    expect(packContext(hits, 5).consideredNodes).toBe(2);
  });

  it('drops the title from the summary when the body repeats it', () => {
    const h = ranked({ id: 'a', title: 'fix: thing', body: 'fix: thing\n\nreal explanation here' });
    const result = packContext([h], 1000);
    expect(result.nodes[0]!.summary).toBe('real explanation here');
  });

  it('summarizes a conversation node from its answer, not its (possibly long) repeated question', () => {
    const longQuestion = 'why floors on ranking factor score '.repeat(20); // long enough to eat a 320-char summary alone
    const h = ranked({
      id: 'convo',
      title: 'why floors on ranking factor score — some heading',
      body: `Q: ${longQuestion}\n\nA: Because zeroing any factor would let it veto the others.`,
    });
    const result = packContext([h], 2000);
    expect(result.nodes[0]!.summary).toBe('Because zeroing any factor would let it veto the others.');
    expect(result.nodes[0]!.summary).not.toContain('floors on ranking factor score');
  });

  // conversation_turn and doc_section both chunk one long reply/file into
  // several nodes that share the *same* ts (collectors/conversation.ts,
  // collectors/docs.ts) -- verified live: a query for "token" returned 9 of
  // its top 12 hits as different chunks of one heavily-sectioned reply,
  // crowding out every other node.
  it('caps how many chunks of the same original document appear together', () => {
    const family = Array.from({ length: 5 }, (_, i) =>
      ranked({
        id: `chunk${i}`,
        kind: 'conversation_turn',
        ts: '2026-08-08T06:24:32.086Z',
        score: 0.9 - i * 0.01,
        title: `part ${i}`,
        body: `text ${i}`,
      }),
    );
    const other = ranked({
      id: 'other',
      kind: 'git_commit',
      ts: '2026-08-01T00:00:00Z',
      score: 0.5,
      title: 'fix: something else',
      body: 'unrelated',
    });

    const result = packContext([...family, other], 5000);

    // Top 2 by score, not all 5 -- the point of the cap.
    expect(result.nodes.filter((n) => n.id.startsWith('chunk')).map((n) => n.id)).toEqual(['chunk0', 'chunk1']);
    expect(result.nodes.map((n) => n.id)).toContain('other');
    expect(result.droppedForDiversity).toBe(3);
  });

  it('does not cap kinds that are never chunked, even if their timestamps happen to collide', () => {
    const hits = Array.from({ length: 4 }, (_, i) =>
      ranked({ id: `commit${i}`, kind: 'git_commit', ts: '2026-08-08T00:00:00Z', score: 0.9 - i * 0.01 }),
    );
    const result = packContext(hits, 5000);
    expect(result.nodes).toHaveLength(4);
    expect(result.droppedForDiversity).toBe(0);
  });

  it('lets a budget-skipped chunk free its family slot for a later sibling', () => {
    // 'big' is highest score but does not fit; the cap must not have already
    // spent a family slot on it, or 'small2' would be wrongly excluded too.
    const hits = [
      ranked({ id: 'big', kind: 'conversation_turn', ts: 'T', score: 0.9, body: 'y'.repeat(4000) }),
      ranked({ id: 'small1', kind: 'conversation_turn', ts: 'T', score: 0.8, body: 'tiny' }),
      ranked({ id: 'small2', kind: 'conversation_turn', ts: 'T', score: 0.7, body: 'tiny' }),
    ];
    const result = packContext(hits, 50);
    expect(result.nodes.map((n) => n.id)).toEqual(['small1', 'small2']);
  });
});

describe('renderContextBlock', () => {
  it('says nothing matched when the pack is empty', () => {
    const result = packContext([], 1000);
    expect(renderContextBlock('foo bar', result)).toContain('No remembered context matched "foo bar"');
  });

  it('renders each node as a dated bullet with its summary', () => {
    const h = ranked({ id: 'a', ts: '2026-08-01T00:00:00Z', title: 'fix: thing', body: 'fix: thing\n\ndetail line' });
    const block = renderContextBlock('thing', packContext([h], 1000));
    expect(block).toContain('2026-08-01');
    expect(block).toContain('fix: thing');
    expect(block).toContain('detail line');
  });

  it('tags each node with its trust tier, so fact and derivation are distinguishable at a glance', () => {
    const observed = ranked({ id: 'a', title: 'observed one', provenance: 'observed' });
    const derived = ranked({ id: 'b', title: 'derived one', provenance: 'derived' });
    const block = renderContextBlock('q', packContext([observed, derived], 2000));
    expect(block).toContain('[observed]');
    expect(block).toContain('[derived]');
  });

  it('tags a reviewed node with its trust_state verdict, but stays silent for the untouched default', () => {
    const candidate = ranked({ id: 'a', title: 'never reviewed', trustState: 'candidate' });
    const rejected = ranked({ id: 'b', title: 'human said no', trustState: 'rejected' });
    const verified = ranked({ id: 'c', title: 'human said yes', trustState: 'verified' });
    const block = renderContextBlock('q', packContext([candidate, rejected, verified], 2000));
    expect(block).not.toContain('[candidate]');
    expect(block).toContain('[rejected]');
    expect(block).toContain('[verified]');
  });
});

describe('retrieval integration (store -> rank -> pack)', () => {
  let dir: string;
  let store: MemoryStore;
  const PROJECT = 'proj-a';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-'));
    store = MemoryStore.open(join(dir, 'memory.db'));

    const node = (overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id'>): MemoryNode => ({
      kind: 'git_commit',
      projectId: PROJECT,
      ts: '2026-08-01T00:00:00Z',
      source: 'git',
      title: 'feat: something',
      body: 'feat: something',
      files: [],
      signal: 0.5,
      meta: {},
      ...overrides,
    });

    store.upsertNodes([
      node({
        id: 'wal',
        signal: 0.9,
        title: 'fix(store): close the WAL handle on Windows',
        body: 'fix(store): close the WAL handle on Windows\n\nSQLite kept the file locked after every write, which blocked cleanup on process exit.',
      }),
      node({
        id: 'chore',
        signal: 0.2,
        title: 'chore: bump sqlite dependency',
        body: 'chore: bump sqlite dependency\n\nRoutine version bump, no behavior change. WAL mode unaffected.',
      }),
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ranks the fix above the chore for a shared keyword despite similar relevance', () => {
    const hits = store.search(PROJECT, 'WAL');
    const r = rankHits(hits, { now: NOW });
    expect(r[0]!.id).toBe('wal');
  });

  it('packs less raw text than the full matched bodies', () => {
    const hits = store.search(PROJECT, 'WAL sqlite');
    const r = rankHits(hits, { now: NOW });
    const packed = packContext(r, 2000);

    const rawChars = hits.reduce((n, h) => n + h.body.length, 0);
    const packedChars = packed.nodes.reduce((n, x) => n + x.summary.length + x.title.length, 0);
    expect(packedChars).toBeLessThanOrEqual(rawChars);
  });

  it('does not let one heavily-chunked node dominate the packed context for a generic query', () => {
    const chunkedNode = (overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id'>): MemoryNode => ({
      kind: 'git_commit',
      projectId: PROJECT,
      ts: '2026-08-01T00:00:00Z',
      source: 'git',
      title: 'feat: something',
      body: 'feat: something',
      files: [],
      signal: 0.5,
      meta: {},
      ...overrides,
    });

    const sharedTs = '2026-08-08T06:24:32.086Z';
    const chunkNodes = Array.from({ length: 5 }, (_, i) =>
      chunkedNode({
        id: `chunk-${i}`,
        kind: 'conversation_turn',
        source: 'claude-code',
        ts: sharedTs,
        title: `Token savings conclusion (part ${i + 1}/5)`,
        body: `Q: what did we conclude about token\n\nA: token savings analysis, part ${i}`,
        signal: 0.6,
      }),
    );
    const realNode = chunkedNode({
      id: 'real',
      title: 'token-facebook-villa.txt holds the page access token',
      body: 'token-facebook-villa.txt holds the page access token\n\nRotate it if the webhook starts failing.',
      signal: 0.6,
    });

    store.upsertNodes([...chunkNodes, realNode]);

    const hits = store.search(PROJECT, 'token');
    const r = rankHits(hits, { now: NOW });
    const packed = packContext(r, 2000);

    const chunkCount = packed.nodes.filter((n) => n.id.startsWith('chunk-')).length;
    expect(chunkCount).toBeLessThanOrEqual(2);
    expect(packed.nodes.map((n) => n.id)).toContain('real');
  });
});
