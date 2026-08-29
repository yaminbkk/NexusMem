import type { RecentMemoryItem } from './mcpClient.js';

/**
 * A row's visual content, independent of `vscode.TreeItem` -- kept free of
 * the `vscode` import so it can be unit tested directly, the same split
 * `renderResults.ts` draws for the webview.
 */
export interface RecentMemoryRow {
  id: string;
  label: string;
  description: string;
  tooltip: string;
  iconId: string;
  isPlaceholder: boolean;
  /** Present only on a real item row -- drives the click-to-search command. */
  searchQuery?: string;
}

export type RecentMemoryState =
  | { kind: 'no-workspace' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'items'; items: RecentMemoryItem[] };

const KIND_ICON: Record<string, string> = {
  git_commit: 'git-commit',
  code_diff: 'diff',
  shell_command: 'terminal',
  doc_section: 'book',
  conversation_turn: 'comment-discussion',
  session_summary: 'checklist',
  note: 'note',
  github_thread: 'github',
};

const DEFAULT_ICON = 'circle-small-filled';

/** Codicon id for a NodeKind. Falls back to a generic dot for anything not in the map above. */
export function iconIdForKind(kind: string): string {
  return KIND_ICON[kind] ?? DEFAULT_ICON;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "3 hours ago"-style relative time. Falls back to the raw string for an unparseable timestamp. */
export function formatRelativeTime(ts: string, now: number): string {
  const then = Date.parse(ts);
  if (Number.isNaN(then)) return ts;

  const diffMs = now - then;
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

  if (Math.abs(diffMs) < HOUR_MS) return rtf.format(Math.round(-diffMs / MINUTE_MS), 'minute');
  if (Math.abs(diffMs) < DAY_MS) return rtf.format(Math.round(-diffMs / HOUR_MS), 'hour');
  return rtf.format(Math.round(-diffMs / DAY_MS), 'day');
}

function placeholderRow(id: string, label: string, description = ''): RecentMemoryRow {
  return { id, label, description, tooltip: label, iconId: 'info', isPlaceholder: true };
}

function itemRow(item: RecentMemoryItem, now: number): RecentMemoryRow {
  return {
    id: item.id,
    label: item.title,
    description: `${formatRelativeTime(item.ts, now)} · ${item.source}`,
    tooltip: `${item.kind} · ${item.source}\n${item.ts}\n\n${item.title}`,
    iconId: iconIdForKind(item.kind),
    isPlaceholder: false,
    searchQuery: item.title,
  };
}

/** The sidebar's entire content for a given load state, as data -- no `vscode.TreeItem` yet. */
export function rowsForState(state: RecentMemoryState, now: number = Date.now()): RecentMemoryRow[] {
  switch (state.kind) {
    case 'no-workspace':
      return [placeholderRow('no-workspace', 'Open a folder to see recent memory')];
    case 'loading':
      return [placeholderRow('loading', 'Loading…')];
    case 'error':
      return [placeholderRow('error', 'Could not load recent memory', state.message)];
    case 'items':
      return state.items.length > 0
        ? state.items.map((item) => itemRow(item, now))
        : [placeholderRow('empty', 'No memory recorded yet', 'run "nexusmem sync" in a terminal')];
  }
}
