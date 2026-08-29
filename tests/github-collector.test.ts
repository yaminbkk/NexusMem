import { describe, expect, it } from 'vitest';
import { scoreGithubThread, toMemoryNode } from '../src/collectors/github.js';
import type { RawGithubThread } from '../src/github/types.js';

const thread = (overrides: Partial<RawGithubThread> = {}): RawGithubThread => ({
  number: 8,
  type: 'issue',
  title: 'testing: add a small labelled retrieval regression corpus',
  body: 'The ranker has strong unit regressions but no compact labelled corpus.',
  author: 'yaminbkk',
  state: 'closed',
  merged: false,
  labels: ['enhancement', 'help wanted'],
  createdAt: '2026-08-14T11:44:30.000Z',
  updatedAt: '2026-08-29T11:58:35.000Z',
  url: 'https://github.com/yaminbkk/NexusMem/issues/8',
  comments: [],
  ...overrides,
});

describe('scoreGithubThread', () => {
  it('scores a merged PR above a plain closed issue', () => {
    const merged = scoreGithubThread(thread({ type: 'pull_request', merged: true, labels: [] }));
    const closed = scoreGithubThread(thread({ labels: [], comments: [] }));
    expect(merged).toBeGreaterThan(closed);
  });

  it('scores a thread with real discussion above one with none', () => {
    const discussed = scoreGithubThread(
      thread({
        comments: [
          { author: 'a', body: 'x', createdAt: '2026-08-15T00:00:00.000Z' },
          { author: 'b', body: 'y', createdAt: '2026-08-16T00:00:00.000Z' },
          { author: 'c', body: 'z', createdAt: '2026-08-17T00:00:00.000Z' },
        ],
      }),
    );
    const quiet = scoreGithubThread(thread({ comments: [] }));
    expect(discussed).toBeGreaterThan(quiet);
  });

  it('penalizes a closed thread with zero comments and no notable label below the midline', () => {
    const dead = scoreGithubThread(thread({ labels: [], comments: [], state: 'closed' }));
    expect(dead).toBeLessThan(0.4);
  });

  it('stays inside 0.05..1', () => {
    expect(
      scoreGithubThread(
        thread({
          type: 'pull_request',
          merged: true,
          labels: ['bug'],
          comments: [
            { author: 'a', body: 'x', createdAt: '2026-08-15T00:00:00.000Z' },
            { author: 'b', body: 'y', createdAt: '2026-08-16T00:00:00.000Z' },
            { author: 'c', body: 'z', createdAt: '2026-08-17T00:00:00.000Z' },
          ],
        }),
      ),
    ).toBeLessThanOrEqual(1);
    expect(scoreGithubThread(thread({ labels: [], comments: [] }))).toBeGreaterThanOrEqual(0.05);
  });
});

describe('toMemoryNode', () => {
  it('tags kind, source and provenance correctly for an issue', () => {
    const node = toMemoryNode(thread(), 'proj1');
    expect(node.kind).toBe('github_thread');
    expect(node.source).toBe('github:issue');
    expect(node.provenance).toBe('recorded');
  });

  it('tags a pull request with the github:pr source', () => {
    const node = toMemoryNode(thread({ type: 'pull_request', number: 14 }), 'proj1');
    expect(node.source).toBe('github:pr');
    expect(node.title).toContain('PR #14');
  });

  it('is content-addressed via type + number, stable across re-runs', () => {
    const a = toMemoryNode(thread(), 'proj1');
    const b = toMemoryNode(thread(), 'proj1');
    expect(a.id).toBe(b.id);
  });

  it('gives an issue and a PR sharing the same number distinct ids', () => {
    const issue = toMemoryNode(thread({ type: 'issue', number: 14 }), 'proj1');
    const pr = toMemoryNode(thread({ type: 'pull_request', number: 14 }), 'proj1');
    expect(issue.id).not.toBe(pr.id);
  });

  it('folds title, opening body and every comment into the node body', () => {
    const node = toMemoryNode(
      thread({
        body: 'the opening post text',
        comments: [{ author: 'reviewer', body: 'a real reply', createdAt: '2026-08-15T00:00:00.000Z' }],
      }),
      'proj1',
    );
    expect(node.body).toContain('the opening post text');
    expect(node.body).toContain('@reviewer');
    expect(node.body).toContain('a real reply');
  });

  it('truncates an oversized body rather than dropping the thread', () => {
    const node = toMemoryNode(thread({ body: 'x'.repeat(10_000) }), 'proj1', { maxBodyChars: 500 });
    expect(node.body.length).toBeLessThanOrEqual(500);
  });

  it('carries thread metadata (number, type, state, merged, labels, url)', () => {
    const node = toMemoryNode(thread({ type: 'pull_request', merged: true }), 'proj1');
    expect(node.meta).toMatchObject({
      number: 8,
      type: 'pull_request',
      state: 'closed',
      merged: true,
      labels: ['enhancement', 'help wanted'],
      url: 'https://github.com/yaminbkk/NexusMem/issues/8',
    });
  });

  it('uses updatedAt as ts, not createdAt -- ranking recency reflects the latest activity', () => {
    const node = toMemoryNode(thread(), 'proj1');
    expect(node.ts).toBe('2026-08-29T11:58:35.000Z');
  });
});
