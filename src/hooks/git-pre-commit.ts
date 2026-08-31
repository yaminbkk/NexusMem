/**
 * Generates and detects the block NexusMem inserts into `.git/hooks/pre-commit`
 * to run `nexusmem precheck` before each commit.
 *
 * Unlike the PowerShell profile hook (`hooks/powershell.ts`), a git hook file
 * is a script with a shebang that must be its first line, and is a file real
 * tools (husky, lint-staged, lefthook) actively write to -- see
 * `install-git-precommit.ts` for the foreign-hook handling this module's
 * simple marker scheme enables but does not itself decide.
 *
 * The script deliberately never bakes an absolute path to the `nexusmem`
 * binary (unlike, say, resolving it at install time) -- it checks
 * `command -v nexusmem` at runtime and silently no-ops if it's missing.
 * Simpler and safer for a first pass: a missing binary means no warning
 * printed, never a broken commit. `nexusmem precheck` itself is advisory
 * (exits 0 unless `--strict`), and this hook does not pass `--strict`, so
 * installing it can never block a commit on its own.
 *
 * The marker/snippet mechanics (install-detection, strip, upsert, shebang)
 * are generic across every git hook type NexusMem installs -- see
 * `git-hook-snippet.ts`, which this just binds to this hook's own markers.
 */

import {
  ensureShebang as ensureShebangGeneric,
  isForeignHook as isForeignHookGeneric,
  isHookInstalled as isHookInstalledGeneric,
  SHEBANG,
  stripHookSnippet as stripHookSnippetGeneric,
  upsertHookSnippet as upsertHookSnippetGeneric,
  type HookMarkers,
} from './git-hook-snippet.js';

const MARK_START = '# >>> nexusmem precommit hook >>>';
const MARK_END = '# <<< nexusmem precommit hook <<<';
const MARKERS: HookMarkers = { markStart: MARK_START, markEnd: MARK_END };

export function renderHookSnippet(): string {
  return [
    MARK_START,
    '# Runs `nexusmem precheck` before each commit -- advisory only, never',
    '# blocks a commit on its own (this hook does not pass --strict).',
    '# Installed by: nexusmem hook git install',
    '# Remove with:  nexusmem hook git remove',
    'if command -v nexusmem >/dev/null 2>&1; then',
    '  nexusmem precheck',
    'fi',
    MARK_END,
    '',
  ].join('\n');
}

export function isHookInstalled(content: string): boolean {
  return isHookInstalledGeneric(content, MARKERS);
}

export function isForeignHook(content: string): boolean {
  return isForeignHookGeneric(content, MARKERS);
}

export function stripHookSnippet(content: string): string {
  return stripHookSnippetGeneric(content, MARKERS);
}

export function upsertHookSnippet(content: string): string {
  return upsertHookSnippetGeneric(content, MARKERS, renderHookSnippet);
}

export const ensureShebang = ensureShebangGeneric;
export { SHEBANG };
