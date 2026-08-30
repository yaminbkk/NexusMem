import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  forgetProjects,
  readLiveRegistry,
  readRegistry,
  recordProject,
  registryPath,
} from '../src/config/registry.js';
import { makeNodeId } from '../src/core/ids.js';
import type { MemoryNode } from '../src/core/types.js';
import { renderContextBlock } from '../src/retrieval/pack.js';
import { runCrossProjectQuery, type QuerySource } from '../src/retrieval/query-pipeline.js';
import { labelProjects, openAllProjectSources } from '../src/retrieval/sources.js';
import { MemoryStore } from '../src/store/store.js';

/**
 * Cross-project recall reads databases outside the current repository, so its
 * two halves are tested separately: the registry that says which databases
 * exist (a plain file that can be stale, corrupt or missing), and the query
 * that merges their results (where BM25's per-corpus scale is the trap).
 */

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'nexusmem-home-'));
  // A registry per test, so ordering cannot leak between them. Restored
  // rather than deleted afterwards: `tests/setup.ts` points the whole suite
  // at a temp home, and unsetting it here would hand the next file the
  // developer's real one.
  previousHome = process.env.NEXUSMEM_HOME;
  process.env.NEXUSMEM_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.NEXUSMEM_HOME;
  else process.env.NEXUSMEM_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

/**
 * If `tests/setup.ts` stops running, every test that syncs a repository goes
 * back to writing into the real `~/.nexusmem`. Nothing else in the suite would
 * notice, so this is the one place that checks the guard is in place.
 */
describe('test isolation', () => {
  it('keeps the user-scoped directory inside a temp path', () => {
    expect(previousHome, 'tests/setup.ts did not set NEXUSMEM_HOME').toBeDefined();
    expect(previousHome!.startsWith(tmpdir())).toBe(true);
  });
});

const entryFor = (name: string, dir: string) => ({
  projectId: `proj-${name}`,
  root: join(dir, name),
  dbPath: join(dir, name, '.nexusmem', 'memory.db'),
  originUrl: null,
});

describe('project registry', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-registry-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a project and reads it back', async () => {
    await recordProject(entryFor('alpha', dir));
    const entries = await readRegistry();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ projectId: 'proj-alpha', originUrl: null });
    expect(entries[0]!.lastSeenAt).toBeGreaterThan(0);
  });

  it('moves an existing project rather than adding a second entry', async () => {
    await recordProject(entryFor('alpha', dir));
    const moved = { ...entryFor('alpha', dir), root: join(dir, 'moved'), dbPath: join(dir, 'moved', 'db') };
    await recordProject(moved);

    const entries = await readRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.root).toBe(join(dir, 'moved'));
  });

  it('reads a corrupt registry as empty instead of failing the query', async () => {
    await recordProject(entryFor('alpha', dir));
    writeFileSync(registryPath(), '{ this is not json');

    await expect(readRegistry()).resolves.toEqual([]);
  });

  it('reads a missing registry as empty', async () => {
    await expect(readRegistry()).resolves.toEqual([]);
  });

  it('separates entries whose database is gone from ones that are still there', async () => {
    const live = entryFor('alpha', dir);
    mkdtempSync(join(tmpdir(), 'unused-')); // keep tmpdir noise out of the assertion
    writeFileSync(join(dir, 'alpha.db'), '');
    await recordProject({ ...live, dbPath: join(dir, 'alpha.db') });
    await recordProject(entryFor('ghost', dir));

    const { entries, missing } = await readLiveRegistry();

    expect(entries.map((e) => e.projectId)).toEqual(['proj-alpha']);
    expect(missing.map((e) => e.projectId)).toEqual(['proj-ghost']);
  });

  it('keeps a stale entry until it is explicitly pruned', async () => {
    await recordProject(entryFor('ghost', dir));

    // A read must not quietly rewrite the file: an unplugged drive is not a
    // deleted project.
    await readLiveRegistry();
    expect(await readRegistry()).toHaveLength(1);

    expect(await forgetProjects(['proj-ghost'])).toBe(1);
    expect(await readRegistry()).toEqual([]);
    expect(await forgetProjects(['proj-ghost'])).toBe(0);
  });
});

describe('labelProjects', () => {
  it('uses the directory name', () => {
    expect(labelProjects([{ projectId: 'a1b2c3d4e5', root: join('D:', 'work', 'nexusmem'), dbPath: 'x' }])).toEqual([
      'nexusmem',
    ]);
  });

  it('disambiguates two repositories with the same directory name', () => {
    const labels = labelProjects([
      { projectId: 'aaaaaaaaaa', root: join('D:', 'work', 'api'), dbPath: 'x' },
      { projectId: 'bbbbbbbbbb', root: join('D:', 'other', 'api'), dbPath: 'y' },
    ]);
    expect(labels).toEqual(['api#aaaaaa', 'api#bbbbbb']);
  });
});

describe('runCrossProjectQuery', () => {
  let dir: string;
  let stores: MemoryStore[] = [];

  const node = (id: string, projectId: string, title: string, body: string, overrides: Partial<MemoryNode> = {}): MemoryNode => ({
    id,
    kind: 'git_commit',
    projectId,
    ts: '2026-08-01T00:00:00Z',
    source: 'git',
    title,
    body,
    files: [],
    signal: 0.5,
    meta: {},
    ...overrides,
  });

  function sourceWith(name: string, nodes: MemoryNode[]): QuerySource {
    const store = MemoryStore.open(join(dir, `${name}.db`));
    store.upsertNodes(nodes);
    stores.push(store);
    return { store, projectId: `proj-${name}`, label: name };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-xproj-'));
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const queryOpts = { budget: 2000, candidates: 30, embeddingProvider: null };

  it('returns hits from every project, each tagged with where it came from', async () => {
    const alpha = sourceWith('alpha', [
      node('a1', 'proj-alpha', 'fix: retry the flaky spawn', 'The spawn failed intermittently on Windows.'),
    ]);
    const beta = sourceWith('beta', [
      node('b1', 'proj-beta', 'fix: spawn the worker pool lazily', 'Spawn cost dominated startup.'),
    ]);

    const result = await runCrossProjectQuery([alpha, beta], 'spawn', queryOpts);

    expect(result.packed.nodes.map((n) => n.project).sort()).toEqual(['alpha', 'beta']);
    expect(result.perProject).toEqual([
      { label: 'alpha', bm25: 1, vector: 0 },
      { label: 'beta', bm25: 1, vector: 0 },
    ]);
    expect(renderContextBlock('spawn', result.packed)).toContain('[alpha] fix: retry the flaky spawn');
  });

  it('leaves out a project that has nothing to say', async () => {
    const alpha = sourceWith('alpha', [node('a1', 'proj-alpha', 'fix: retry the flaky spawn', 'Windows spawn failure.')]);
    const beta = sourceWith('beta', [node('b1', 'proj-beta', 'feat: kubernetes ingress', 'Routing rules for the cluster.')]);

    const result = await runCrossProjectQuery([alpha, beta], 'spawn failure', queryOpts);

    expect(result.packed.nodes).toHaveLength(1);
    expect(result.packed.nodes[0]!.project).toBe('alpha');
    expect(result.perProject.find((p) => p.label === 'beta')!.bm25).toBe(0);
  });

  it('scores each project\'s best hit by rank, not by a bm25 cost from a different corpus', async () => {
    // bm25() is computed against its own corpus statistics, so the same score
    // means different things in a 1-node and a 40-node database. Min-max
    // normalizing the two together invents a comparison; RRF compares each
    // list only against itself, so two rank-1 hits are equally relevant.
    const alpha = sourceWith('alpha', [node('a1', 'proj-alpha', 'fix: spawn retry', 'spawn spawn spawn spawn spawn')]);
    const beta = sourceWith('beta', [
      node('b1', 'proj-beta', 'fix: spawn once', 'spawn'),
      ...Array.from({ length: 40 }, (_, i) =>
        node(`b-filler-${i}`, 'proj-beta', `chore: unrelated ${i}`, 'nothing to do with the question'),
      ),
    ]);

    const result = await runCrossProjectQuery([alpha, beta], 'spawn', queryOpts);
    const [first, second] = result.packed.nodes;

    expect(result.packed.nodes).toHaveLength(2);
    // Same signal, same timestamp, both rank 1 in their own list.
    expect(second!.score).toBeCloseTo(first!.score, 10);
  });

  /**
   * The union of several projects' hits is keyed by node id -- in RRF's score
   * map, and in nothing that re-checks which database a hit came from. That is
   * only safe because `makeNodeId` mixes the project id in, so the same commit
   * in two clones of the same repo is one node and two different repos can
   * never mint the same id. This pins that property at its source.
   */
  it('cannot mint the same node id for the same event in two projects', () => {
    expect(makeNodeId('proj-alpha', 'git_commit', 'abc123')).not.toBe(makeNodeId('proj-beta', 'git_commit', 'abc123'));
    expect(makeNodeId('proj-alpha', 'git_commit', 'abc123')).toBe(makeNodeId('proj-alpha', 'git_commit', 'abc123'));
  });

  it('bumps retrieval bookkeeping in each hit\'s own source database, not just the querying one', async () => {
    const alpha = sourceWith('alpha', [
      node('a1', 'proj-alpha', 'fix: retry the flaky spawn', 'The spawn failed intermittently on Windows.'),
    ]);
    const beta = sourceWith('beta', [
      node('b1', 'proj-beta', 'fix: spawn the worker pool lazily', 'Spawn cost dominated startup.'),
    ]);

    await runCrossProjectQuery([alpha, beta], 'spawn', queryOpts);

    // discriminating: each store only knows about its own node -- a bug that
    // recorded every id against the first store (or only the querying repo's
    // own db, if this were routed through one) would misattribute one of these.
    expect(alpha.store.getRetrievalStats('a1')!.retrievedCount).toBe(1);
    expect(beta.store.getRetrievalStats('b1')!.retrievedCount).toBe(1);
  });
});

describe('openAllProjectSources', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-open-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('includes the current project even when the registry has never seen it', async () => {
    const current = { projectId: 'proj-current', root: join(dir, 'current'), dbPath: join(dir, 'current.db') };

    const opened = await openAllProjectSources(current);
    try {
      expect(opened.sources.map((s) => s.projectId)).toEqual(['proj-current']);
      expect(opened.sources[0]!.label).toBe('current');
    } finally {
      opened.close();
    }
  });

  it('opens registered projects alongside the current one, and skips absent databases', async () => {
    const otherDb = join(dir, 'other.db');
    MemoryStore.open(otherDb).close();
    await recordProject({ projectId: 'proj-other', root: join(dir, 'other'), dbPath: otherDb, originUrl: null });
    await recordProject({ projectId: 'proj-ghost', root: join(dir, 'ghost'), dbPath: join(dir, 'ghost.db'), originUrl: null });

    const opened = await openAllProjectSources({
      projectId: 'proj-current',
      root: join(dir, 'current'),
      dbPath: join(dir, 'current.db'),
    });

    try {
      expect(opened.sources.map((s) => s.projectId).sort()).toEqual(['proj-current', 'proj-other']);
      expect(opened.missing.map((e) => e.projectId)).toEqual(['proj-ghost']);
    } finally {
      opened.close();
    }
  });

  it('does not list the current project twice when it is also registered', async () => {
    const dbPath = join(dir, 'current.db');
    MemoryStore.open(dbPath).close();
    await recordProject({ projectId: 'proj-current', root: join(dir, 'current'), dbPath, originUrl: null });

    const opened = await openAllProjectSources({ projectId: 'proj-current', root: join(dir, 'current'), dbPath });
    try {
      expect(opened.sources).toHaveLength(1);
    } finally {
      opened.close();
    }
  });

  it('reports a registered database that exists on disk but fails to open as unreadable, not missing', async () => {
    // Its own directory, cleaned up separately from `dir`/`afterEach`: a
    // failed better-sqlite3 open against a non-SQLite file leaves the file
    // transiently (and, empirically, not briefly) locked on Windows, which
    // would otherwise fail this test's own cleanup with EPERM. Isolating it
    // means that lock can never affect any other test's fixtures.
    const corruptHome = mkdtempSync(join(tmpdir(), 'nexusmem-open-corrupt-'));
    const corruptDb = join(corruptHome, 'corrupt.db');
    writeFileSync(corruptDb, 'this is not a sqlite file');
    await recordProject({ projectId: 'proj-corrupt', root: join(corruptHome, 'corrupt'), dbPath: corruptDb, originUrl: null });

    const opened = await openAllProjectSources({
      projectId: 'proj-current',
      root: join(dir, 'current'),
      dbPath: join(dir, 'current.db'),
    });

    try {
      // Discriminating: existsSync(corruptDb) is true, so a broken unreadable
      // check would silently drop it into `missing` (or nowhere) instead.
      expect(opened.missing).toEqual([]);
      expect(opened.unreadable).toHaveLength(1);
      expect(opened.unreadable[0]!.entry.projectId).toBe('proj-corrupt');
      expect(opened.unreadable[0]!.reason.length).toBeGreaterThan(0);
      expect(opened.sources.map((s) => s.projectId)).toEqual(['proj-current']);
    } finally {
      opened.close();
      try {
        rmSync(corruptHome, { recursive: true, force: true });
      } catch {
        // See comment above -- a leaked handle on the corrupt file itself is
        // the known, accepted cost of testing this branch on Windows.
      }
    }
  });
});
