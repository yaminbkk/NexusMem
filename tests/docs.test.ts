import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectDocFiles, scoreDocSection, toMemoryNodes } from '../src/collectors/docs.js';
import type { MemoryNode } from '../src/core/types.js';
import type { RawDocFile } from '../src/docs/types.js';
import { MemoryStore } from '../src/store/store.js';

const file = (content: string, path = 'README.md'): RawDocFile => ({
  path,
  content,
  ts: '2026-08-09T10:00:00.000Z',
});

describe('scoreDocSection', () => {
  it('scores a section with explanation markers above one without', () => {
    const explained = scoreDocSection('README.md', 'Why BM25 first', 'We chose BM25 first because developer queries are keyword-heavy.');
    const plain = scoreDocSection('README.md', 'Install', 'Run npm install.');
    expect(explained).toBeGreaterThan(plain);
  });

  it('boosts README.md over other doc files, all else equal', () => {
    const readme = scoreDocSection('README.md', 'Overview', 'Some section content of reasonable length here.');
    const other = scoreDocSection('docs/phase-2-spec.md', 'Overview', 'Some section content of reasonable length here.');
    expect(readme).toBeGreaterThan(other);
  });

  it('stays inside 0.05..1', () => {
    expect(scoreDocSection('README.md', 'Why', 'because ' + 'x'.repeat(2000))).toBeLessThanOrEqual(1);
    expect(scoreDocSection('README.md', null, 'x')).toBeGreaterThanOrEqual(0.05);
  });
});

describe('toMemoryNodes (docs)', () => {
  it('keeps a whole short file as one node when it has no headings', () => {
    const nodes = toMemoryNodes(file('Just a short line of prose.'), 'proj1');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.title).toBe('README.md');
    expect(nodes[0]!.kind).toBe('doc_section');
  });

  it('splits at markdown headings, one node per section', () => {
    const content = ['# Overview', '', 'Intro text.', '', '## Why BM25 first', '', 'Because developer queries are keyword-heavy.'].join('\n');
    const nodes = toMemoryNodes(file(content), 'proj1');
    expect(nodes.map((n) => n.meta.heading)).toEqual(['Overview', 'Why BM25 first']);
    expect(nodes[1]!.title).toBe('README.md — Why BM25 first');
    expect(nodes[1]!.body).toContain('keyword-heavy');
    expect(nodes[1]!.body).not.toContain('Intro text');
  });

  it('is content-addressed via file path + heading, stable across re-runs', () => {
    const content = '## Section A\n\nContent.';
    const a = toMemoryNodes(file(content), 'proj1');
    const b = toMemoryNodes(file(content), 'proj1');
    expect(a[0]!.id).toBe(b[0]!.id);
  });

  it('gives distinct ids to duplicate headings in the same file', () => {
    const content = '## Why\n\nFirst reason.\n\n## Why\n\nSecond reason.';
    const nodes = toMemoryNodes(file(content), 'proj1');
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.id).not.toBe(nodes[1]!.id);
  });

  it('tags every node with the docs source and the file as a touched path', () => {
    const nodes = toMemoryNodes(file('## A\n\ntext'), 'proj1');
    expect(nodes[0]!.source).toBe('docs');
    expect(nodes[0]!.files.map((f) => f.path)).toEqual(['README.md']);
  });

  it('splits an oversized headingless file further and labels titles with a part suffix', () => {
    const content = Array.from({ length: 10 }, (_, i) => `Paragraph number ${i} with some filler text repeated here.`).join('\n\n');
    const nodes = toMemoryNodes(file(content), 'proj1', { maxChunkChars: 120 });
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes[0]!.title).toContain('(part 1/');
    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns nothing for an empty file', () => {
    expect(toMemoryNodes(file(''), 'proj1')).toEqual([]);
  });
});

describe('CRLF working trees', () => {
  const LF = ['# Overview', '', 'Intro text.', '', '## Why BM25 first', '', 'Because queries are keyword-heavy.', '', '## Install', '', 'Run npm install.'].join('\n');

  it('chunks a CRLF file identically to the same file with LF endings', () => {
    // git checks files out as CRLF on Windows by default, so this is the normal
    // case there. Unnormalized, `\r\n\r\n` contains no two consecutive `\n`,
    // the paragraph split never fires, and the whole file collapses into one
    // heading-less chunk.
    const lf = toMemoryNodes(file(LF), 'proj1');
    const crlf = toMemoryNodes(file(LF.replace(/\n/g, '\r\n')), 'proj1');

    expect(crlf.map((n) => n.meta.heading)).toEqual(['Overview', 'Why BM25 first', 'Install']);
    expect(crlf.map((n) => n.title)).toEqual(lf.map((n) => n.title));
    // Ids must match too, or every checkout would re-mint the whole corpus.
    expect(crlf.map((n) => n.id)).toEqual(lf.map((n) => n.id));
  });

  it('leaves no carriage returns in the stored body or heading', () => {
    const nodes = toMemoryNodes(file(LF.replace(/\n/g, '\r\n')), 'proj1');
    for (const node of nodes) {
      expect(node.body).not.toMatch(/\r/);
      expect(String(node.meta.heading ?? '')).not.toMatch(/\r/);
    }
  });
});

describe('collectDocFiles', () => {
  it('flattens nodes across multiple files', () => {
    const nodes = collectDocFiles(
      [file('## A\n\ntext', 'README.md'), file('## B\n\ntext', 'docs/phase-2-spec.md')],
      'proj1',
    );
    expect(nodes.map((n) => n.meta.path)).toEqual(['README.md', 'docs/phase-2-spec.md']);
  });
});

/**
 * A `doc_section` id derives from `path + heading slug`, so editing a heading
 * mints a new node instead of updating the old one. Without a prune the corpus
 * keeps both, and a query gets the current *and* the outdated text for the same
 * section -- observed on this repo's own README on 2026-08-09.
 */
describe('docs sync pruning (stale/orphaned sections)', () => {
  const PROJECT = 'proj-docs';
  const OTHER_PROJECT = 'proj-other';
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-docs-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Exactly what syncDocs does: upsert a complete scan, then prune what it didn't produce. */
  function syncDocs(files: RawDocFile[], unreadable: string[] = [], projectId = PROJECT) {
    const nodes = collectDocFiles(files, projectId);
    if (nodes.length > 0) store.upsertNodes(nodes);
    const pruned = store.pruneSourceNodes(
      projectId,
      'docs',
      nodes.map((n) => n.id),
      { keepPaths: unreadable },
    );
    return { nodes, pruned };
  }

  const docCount = (projectId = PROJECT) => store.stats(projectId).byKind.doc_section ?? 0;

  const nodeOf = (overrides: Partial<MemoryNode> & Pick<MemoryNode, 'id' | 'kind' | 'source'>): MemoryNode => ({
    projectId: PROJECT,
    ts: '2026-08-09T10:00:00.000Z',
    title: 'untitled',
    body: 'body text',
    files: [],
    signal: 0.5,
    meta: {},
    ...overrides,
  });

  it('removes the stranded old section when a heading is renamed', () => {
    syncDocs([file('## Old Heading\n\nThe explanation lives here.')]);
    expect(docCount()).toBe(1);

    const { pruned } = syncDocs([file('## New Heading\n\nThe explanation lives here.')]);

    expect(pruned).toBe(1);
    expect(docCount()).toBe(1);
    expect(store.search(PROJECT, 'heading').map((h) => h.title)).toEqual(['README.md — New Heading']);
  });

  it('removes a section that was deleted outright', () => {
    syncDocs([file('## Keep\n\nkept text here\n\n## Drop\n\ndiscarded text here')]);
    expect(docCount()).toBe(2);

    const { pruned } = syncDocs([file('## Keep\n\nkept text here')]);

    expect(pruned).toBe(1);
    expect(docCount()).toBe(1);
    expect(store.search(PROJECT, 'discarded')).toEqual([]);
  });

  it('removes every section of a doc file that no longer exists', () => {
    syncDocs([file('## A\n\nalpha text', 'README.md'), file('## B\n\nbravo text', 'docs/spec.md')]);
    expect(docCount()).toBe(2); // one section per file

    const { pruned } = syncDocs([file('## A\n\nalpha text', 'README.md')]);

    expect(pruned).toBe(1);
    expect(store.search(PROJECT, 'bravo')).toEqual([]);
    expect(store.search(PROJECT, 'alpha')).toHaveLength(1);
  });

  it('prunes everything when every tracked .md file is gone', () => {
    syncDocs([file('## A\n\nalpha text')]);
    const { pruned } = syncDocs([]);
    expect(pruned).toBe(1);
    expect(docCount()).toBe(0);
  });

  it('keeps sections of a file it could not read, rather than treating them as deleted', () => {
    syncDocs([file('## A\n\nalpha text', 'README.md')]);

    // README.md tracked but unreadable this run: scan produced nothing for it.
    const { pruned } = syncDocs([], ['README.md']);

    expect(pruned).toBe(0);
    expect(docCount()).toBe(1);
  });

  it('never touches other sources, even when they have no nodes left in the scan', () => {
    store.upsertNodes([
      nodeOf({ id: 'c1', kind: 'conversation_turn', source: 'conversation:claude-code', body: 'conversation body' }),
      nodeOf({ id: 's1', kind: 'shell_command', source: 'shell:pwsh', body: 'shell body' }),
      nodeOf({ id: 'g1', kind: 'git_commit', source: 'git', body: 'commit body' }),
    ]);
    syncDocs([file('## A\n\nalpha text')]);

    syncDocs([]); // prunes the whole docs source

    const stats = store.stats(PROJECT);
    expect(stats.byKind.doc_section).toBeUndefined();
    expect(stats.byKind.conversation_turn).toBe(1);
    expect(stats.byKind.shell_command).toBe(1);
    expect(stats.byKind.git_commit).toBe(1);
  });

  it('never touches another project\'s docs', () => {
    syncDocs([file('## A\n\nalpha text')], [], OTHER_PROJECT);
    syncDocs([file('## A\n\nalpha text')]);

    syncDocs([]); // empty scan for PROJECT only

    expect(docCount(PROJECT)).toBe(0);
    expect(docCount(OTHER_PROJECT)).toBe(1);
  });

  it('drops the embedding alongside the pruned node, since nodes_vec has no cascade', () => {
    syncDocs([file('## Old Heading\n\nThe explanation lives here.')]);
    const [pending] = store.findNodesNeedingEmbedding(PROJECT);
    const vector = new Float32Array(768).fill(0.1);
    store.upsertEmbedding(pending!.rowid, PROJECT, vector);
    expect(store.vectorSearch(PROJECT, vector)).toHaveLength(1);

    syncDocs([file('## New Heading\n\nThe explanation lives here.')]);

    // The stale node's embedding is gone; the replacement has none yet.
    expect(store.vectorSearch(PROJECT, vector)).toEqual([]);
    expect(store.findNodesNeedingEmbedding(PROJECT)).toHaveLength(1);
  });

  it('is a no-op when nothing changed', () => {
    const content = file('## A\n\nalpha text\n\n## B\n\nbravo text');
    syncDocs([content]);
    const { pruned } = syncDocs([content]);
    expect(pruned).toBe(0);
    expect(docCount()).toBe(2);
  });
});
