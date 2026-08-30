import { describe, expect, it } from 'vitest';
import { rowsForState } from '../src/staleReviewRows.js';
import type { StaleSuggestion } from '../src/mcpClient.js';

function suggestion(overrides: Partial<StaleSuggestion> = {}): StaleSuggestion {
  return {
    candidateId: 'a',
    candidateTitle: 'fix: old retry logic',
    againstId: 'b',
    againstTitle: 'fix: correct retry logic',
    reason: 'the newer commit fixes the same bug differently',
    checkedAt: Date.parse('2026-01-01T10:00:00.000Z'),
    ...overrides,
  };
}

describe('rowsForState', () => {
  it('shows a single placeholder row when no workspace is open', () => {
    const rows = rowsForState({ kind: 'no-workspace' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isPlaceholder).toBe(true);
    expect(rows[0]?.suggestion).toBeUndefined();
  });

  it('shows a loading placeholder', () => {
    const rows = rowsForState({ kind: 'loading' });
    expect(rows[0]?.label.toLowerCase()).toContain('loading');
  });

  it('shows the error message in an error placeholder', () => {
    const rows = rowsForState({ kind: 'error', message: 'boom' });
    expect(rows[0]?.description).toBe('boom');
  });

  it('shows an empty placeholder, not a blank list, when there are zero suggestions', () => {
    const rows = rowsForState({ kind: 'items', items: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isPlaceholder).toBe(true);
  });

  it('shows one actionable row per suggestion, carrying the ids the accept/dismiss commands need', () => {
    const rows = rowsForState({ kind: 'items', items: [suggestion()] });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.isPlaceholder).toBe(false);
    expect(row.contextValue).toBe('staleSuggestion'); // discriminating: this is what package.json's menu condition matches on
    expect(row.label).toBe('fix: old retry logic');
    expect(row.description).toContain('fix: correct retry logic');
    expect(row.suggestion).toEqual(suggestion());
  });

  it('gives two suggestions for the same candidate against different newer nodes distinct row ids', () => {
    const rows = rowsForState({
      kind: 'items',
      items: [suggestion({ againstId: 'b' }), suggestion({ againstId: 'c' })],
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it('omits the reason line from the tooltip when none was recorded', () => {
    const rows = rowsForState({ kind: 'items', items: [suggestion({ reason: null })] });
    expect(rows[0]?.tooltip).not.toContain('reason:');
  });
});
