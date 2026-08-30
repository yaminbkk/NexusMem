import { redact } from '../conversation/redact.js';
import { makeNodeId } from '../core/ids.js';
import { truncate } from '../core/text.js';
import type { MemoryNode } from '../core/types.js';
import type { RawShellEntry } from '../shell/types.js';

export interface ShellCollectorOptions {
  /** Default 1000 -- commands are short; no need for the 4000-char body cap commits use. */
  maxBodyChars?: number;
}

const DEFAULT_MAX_BODY_CHARS = 1000;
const MAX_TITLE_CHARS = 200;

const NOISE = /^(cd|ls|dir|pwd|clear|cls|exit|history|whoami|date|type|cat|more|less|ll|la)\b/i;
const BUILD_TEST =
  /^(npm|pnpm|yarn)\s+(run\s+)?(test|build|lint|typecheck|tsc)\b|^(pytest|go\s+test|cargo\s+(test|build)|mvn\s+test|gradle\s+test|dotnet\s+(test|build))\b/i;
const INSTALL = /^(npm|pnpm|yarn)\s+(install|add|remove|uninstall|ci)\b|^pip\s+install\b|^(cargo\s+add|go\s+get|composer\s+require)\b/i;
const GIT_CMD = /^git\s+/i;
const GIT_DESTRUCTIVE = /^git\s+(push\s+.*--force|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-d)\b/i;
const RISKY = /(rm\s+-rf|remove-item\s+.*-recurse|del\s+\/s|drop\s+(table|database)|--force\b|truncate\s+table)/i;

/**
 * Prior importance by command shape.
 *
 * Kept deliberately coarse: this is a much weaker signal than a commit's
 * conventional-commit type, so scores cluster closer to the middle. `git`
 * commands score low by default because the git collector already captures
 * that history with far richer detail (diff, files, message) -- the shell
 * trace of `git commit -m "..."` would just be redundant noise next to it.
 */
export function scoreShellCommand(entry: RawShellEntry): number {
  const cmd = entry.command.trim();

  let score: number;
  if (NOISE.test(cmd)) score = 0.1;
  else if (RISKY.test(cmd) || GIT_DESTRUCTIVE.test(cmd)) score = 0.75;
  else if (INSTALL.test(cmd)) score = 0.6;
  else if (BUILD_TEST.test(cmd)) score = 0.55;
  else if (GIT_CMD.test(cmd)) score = 0.2;
  else score = 0.35;

  // Exit code is only known from the hook; an unknown code leaves score untouched.
  if (entry.exitCode !== null) {
    score += entry.exitCode !== 0 ? 0.25 : 0.05;
  }

  if (cmd.length > 60) score += 0.05;
  else if (cmd.length <= 3) score -= 0.05;

  return Number(Math.min(1, Math.max(0.05, score)).toFixed(3));
}

function renderBody(entry: RawShellEntry, command: string, maxChars: number): string {
  const parts = [`$ ${command}`];
  const metaLine: string[] = [];
  if (entry.cwd) metaLine.push(`cwd: ${entry.cwd}`);
  if (entry.exitCode !== null) metaLine.push(`exit: ${entry.exitCode}`);
  if (entry.durationMs !== null) metaLine.push(`duration: ${entry.durationMs}ms`);
  if (metaLine.length) parts.push('', metaLine.join('  '));
  return truncate(parts.join('\n'), maxChars);
}

export function toMemoryNode(entry: RawShellEntry, projectId: string, opts: ShellCollectorOptions = {}): MemoryNode {
  const maxBody = opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
  // Redacted separately from `entry.command`: title/body are what actually
  // land in the FTS index and the vector embeddings (see vector/sync.ts),
  // and from there in `search_memory` results -- a secret typed at a prompt
  // (`export TOKEN=...`, a bearer header, a connection string) must not
  // travel that path back into a future LLM context. `meta.command` below is
  // kept raw on purpose: reconcile.ts rehashes it to reproduce the exact id
  // `shell/detect.ts` derives from the live hook log, and
  // correlate/failure-fix.ts exact-matches it against a re-run command --
  // both would silently break (nodes going dark, the way a real project-id
  // rename once did) if this copy stopped matching the raw source text.
  const { text: redactedCommand } = redact(entry.command);
  const titleLine = redactedCommand.split(/\r?\n/)[0] ?? redactedCommand;

  return {
    id: makeNodeId(projectId, 'shell_command', entry.naturalKey),
    kind: 'shell_command',
    projectId,
    ts: entry.ts,
    source: `shell:${entry.shell}`,
    title: truncate(titleLine, MAX_TITLE_CHARS),
    body: renderBody(entry, redactedCommand, maxBody),
    files: [],
    signal: scoreShellCommand(entry),
    provenance: 'observed',
    meta: {
      command: entry.command,
      cwd: entry.cwd,
      exitCode: entry.exitCode,
      durationMs: entry.durationMs,
      tsApprox: entry.tsApprox,
      shell: entry.shell,
    },
  };
}

export function collectShellHistory(
  entries: readonly RawShellEntry[],
  projectId: string,
  opts: ShellCollectorOptions = {},
): MemoryNode[] {
  return entries.map((entry) => toMemoryNode(entry, projectId, opts));
}
