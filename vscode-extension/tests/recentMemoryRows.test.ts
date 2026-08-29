import { describe, expect, it } from 'vitest';
import { formatRelativeTime, iconIdForKind, rowsForState } from '../src/recentMemoryRows.js';
import type { RecentMemoryItem } from '../src/mcpClient.js';

function item(overrides: Partial<RecentMemoryItem> = {}): RecentMemoryItem {
  return {
    id: 'a',
    kind: 'git_commit',
    ts: '2026-01-01T10:00:00.000Z',
    source: 'git',
    title: 'fix: handle the retry timeout correctly',
    signal: 0.7,
    ...overrides,
  };
}

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z');

  it('formats minutes for something under an hour old', () => {
    expect(formatRelativeTime('2026-01-01T11:45:00.000Z', now)).toBe('15 minutes ago');
  });

  it('formats hours for something under a day old', () => {
    expect(formatRelativeTime('2026-01-01T09:00:00.000Z', now)).toBe('3 hours ago');
  });

  it('formats days for anything a day or older', () => {
    expect(formatRelativeTime('2025-12-29T12:00:00.000Z', now)).toBe('3 days ago');
  });

  it('falls back to the raw timestamp for something unparseable', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('not-a-date');
  });
});

describe('iconIdForKind', () => {
  it('maps every known NodeKind to a distinct codicon id', () => {
    const kinds = ['git_commit', 'shell_command', 'code_diff', 'doc_section', 'conversation_turn', 'session_summary', 'note', 'github_thread'];
    const icons = kinds.map(iconIdForKind);
    expect(new Set(icons).size).toBe(icons.length); // discriminating: catches a copy-pasted duplicate mapping
  });

  it('falls back to a default icon for an unrecognized kind', () => {
    expect(iconIdForKind('something_new')).toBe(iconIdForKind('unknown_kind'));
  });
});

describe('rowsForState', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z');

  it('shows a single placeholder row when no workspace is open', () => {
    const rows = rowsForState({ kind: 'no-workspace' }, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isPlaceholder).toBe(true);
    expect(rows[0]?.searchQuery).toBeUndefined();
  });

  it('shows a loading placeholder', () => {
    const rows = rowsForState({ kind: 'loading' }, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label.toLowerCase()).toContain('loading');
  });

  it('shows the error message in an error placeholder', () => {
    const rows = rowsForState({ kind: 'error', message: 'boom' }, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('boom');
  });

  it('shows one clickable row per item, newest label first, in the given order', () => {
    const rows = rowsForState({ kind: 'items', items: [item({ id: 'a', title: 'first' }), item({ id: 'b', title: 'second' })] }, now);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label)).toEqual(['first', 'second']);
    expect(rows.every((r) => !r.isPlaceholder)).toBe(true);
    expect(rows[0]?.searchQuery).toBe('first'); // discriminating: proves the row can drive a click-to-search action
  });

  it('shows an empty placeholder, not a blank list, when there are zero items', () => {
    const rows = rowsForState({ kind: 'items', items: [] }, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isPlaceholder).toBe(true);
  });
});
