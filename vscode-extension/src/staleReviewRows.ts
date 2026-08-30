import type { StaleSuggestion } from './mcpClient.js';

/**
 * A row's visual content, independent of `vscode.TreeItem` -- same split
 * `recentMemoryRows.ts` draws, kept free of the `vscode` import so it can be
 * unit tested directly. `contextValue` drives which rows get the
 * accept/dismiss inline buttons in package.json's `view/item/context` menu;
 * `suggestion` carries the ids those commands need and is absent on
 * placeholder rows.
 */
export interface StaleReviewRow {
  id: string;
  label: string;
  description: string;
  tooltip: string;
  iconId: string;
  isPlaceholder: boolean;
  contextValue: string;
  suggestion?: StaleSuggestion;
}

export type StaleReviewState =
  | { kind: 'no-workspace' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'items'; items: StaleSuggestion[] };

function placeholderRow(id: string, label: string, description = ''): StaleReviewRow {
  return { id, label, description, tooltip: label, iconId: 'info', isPlaceholder: true, contextValue: 'placeholder' };
}

/** `id` combines both node ids: a candidate can carry more than one open suggestion, against different newer nodes. */
function suggestionRow(s: StaleSuggestion): StaleReviewRow {
  return {
    id: `${s.candidateId}::${s.againstId}`,
    label: s.candidateTitle,
    description: `superseded by "${s.againstTitle}"`,
    tooltip: [`likely superseded by ${s.againstTitle} (${s.againstId})`, s.reason ? `reason: ${s.reason}` : undefined, s.candidateId]
      .filter((line): line is string => Boolean(line))
      .join('\n'),
    iconId: 'warning',
    isPlaceholder: false,
    contextValue: 'staleSuggestion',
    suggestion: s,
  };
}

/** The review sidebar's entire content for a given load state, as data -- no `vscode.TreeItem` yet. */
export function rowsForState(state: StaleReviewState): StaleReviewRow[] {
  switch (state.kind) {
    case 'no-workspace':
      return [placeholderRow('no-workspace', 'Open a folder to review flagged memory')];
    case 'loading':
      return [placeholderRow('loading', 'Loading…')];
    case 'error':
      return [placeholderRow('error', 'Could not load contradiction suggestions', state.message)];
    case 'items':
      return state.items.length > 0
        ? state.items.map(suggestionRow)
        : [placeholderRow('empty', 'No contradictions flagged', 'run "nexusmem stale --check-contradictions" or a normal sync')];
  }
}
