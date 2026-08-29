import { describe, expect, it } from 'vitest';
import { scoreGithubThread } from '../src/collectors/github.js';
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
