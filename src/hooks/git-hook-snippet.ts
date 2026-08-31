/**
 * Generic marker-based snippet logic shared by every git hook type NexusMem
 * installs (`git-pre-commit.ts`, `git-post-commit.ts`). Each hook type
 * defines its own marker pair and its own `renderHookSnippet()` body, then
 * re-exports these functions bound to that pair -- the install/remove/status
 * behavior around a marked block is identical regardless of what the block
 * actually runs, so only the markers and the rendered text vary per hook.
 */

export const SHEBANG = '#!/bin/sh';

export interface HookMarkers {
  markStart: string;
  markEnd: string;
}

export function isHookInstalled(content: string, markers: HookMarkers): boolean {
  return content.includes(markers.markStart);
}

/** Real, non-empty content with no NexusMem marker -- i.e. a hook this installer did not write. */
export function isForeignHook(content: string, markers: HookMarkers): boolean {
  return content.trim().length > 0 && !isHookInstalled(content, markers);
}

export function stripHookSnippet(content: string, markers: HookMarkers): string {
  const startIdx = content.indexOf(markers.markStart);
  const endIdx = content.indexOf(markers.markEnd);
  if (startIdx === -1 || endIdx === -1) return content;

  const afterBlock = content.slice(endIdx + markers.markEnd.length).replace(/^\r?\n/, '');
  return content.slice(0, startIdx) + afterBlock;
}

/**
 * Idempotent: strips any existing block first, then appends the current
 * snippet at the end of whatever content remains. Appended, not prepended --
 * for a foreign hook installed with `--force`, this means the existing
 * hook's own commands still run first, so nexusmem's block never reorders or
 * overrides whatever the existing hook already decided. A foreign hook that
 * calls `exit` early will still prevent this block from ever running -- a
 * known limitation, not silently hidden (see the module-level comment on
 * each hook type's installer).
 */
export function upsertHookSnippet(content: string, markers: HookMarkers, renderHookSnippet: () => string): string {
  const stripped = stripHookSnippet(content, markers).replace(/\s+$/, '');
  const prefix = stripped.length > 0 ? `${stripped}\n\n` : '';
  return `${prefix}${renderHookSnippet()}`;
}

/** A git hook file's shebang must be its first line; ensure one exists without disturbing existing content. */
export function ensureShebang(content: string): string {
  if (content.startsWith('#!')) return content;
  return content.length > 0 ? `${SHEBANG}\n${content}` : `${SHEBANG}\n`;
}
