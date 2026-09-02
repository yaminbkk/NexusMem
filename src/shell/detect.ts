import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { sha256Hex } from '../core/ids.js';
import { readHookLog, type HookLogEntry, type HookShellKind } from './hook-log.js';
import { parseBashHistory } from './parse-bash.js';
import { parsePsReadLineHistory } from './parse-psreadline.js';
import { parseZshHistory } from './parse-zsh.js';
import { bashHistoryPath, hookLogPath, psReadLineHistoryPath, zshHistoryPath } from './paths.js';
import type { RawShellEntry } from './types.js';

export interface ShellSourceResult {
  /** The `shell:<name>` suffix used for both MemoryNode.source and the sync_state key. */
  name: string;
  entries: RawShellEntry[];
  /** Hook source only: how far into the log this read reached, to persist as the next cursor. */
  cursorAfter?: string;
}

export interface CollectShellHistoryOptions {
  /** How many lines to keep from scrape-based (non-hook) sources. Default 300. */
  tailLines?: number;
  /** Repo root, for scoping hook-log entries to this project by cwd. */
  repoRoot?: string;
  /** Previous cursor for the hook log (a line count), or null to read from the start. */
  hookCursor?: string | null;
  /**
   * Once the hook is installed, its PowerShell coverage is authoritative --
   * the raw PSReadLine file duplicates the same commands with worse data
   * (no cwd, no exit code) and is skipped. Bash/zsh scraping is unaffected;
   * the hook only covers PowerShell. Default true.
   */
  preferHook?: boolean;
}

function isUnderRoot(cwd: string, root: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const c = norm(cwd);
  const r = norm(root);
  return c === r || c.startsWith(`${r}/`);
}

function hookEntryToRaw(e: HookLogEntry): RawShellEntry {
  // Lines predating the `shell` field are all PowerShell's -- it was the only hook that existed then.
  const shell = e.shell ?? 'pwsh-hook';
  return {
    naturalKey: `${shell}:${e.ts}:${sha256Hex(e.command).slice(0, 12)}`,
    command: e.command,
    ts: e.ts,
    tsApprox: false,
    exitCode: e.exitCode,
    cwd: e.cwd,
    durationMs: e.durationMs,
    shell,
  };
}

async function tryReadScrapeSource(
  path: string,
  parse: (raw: string, mtimeMs: number, opts: { tailLines?: number }) => RawShellEntry[],
  tailLines: number,
): Promise<RawShellEntry[] | null> {
  if (!existsSync(path)) return null;
  const [raw, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
  return parse(raw, stats.mtimeMs, { tailLines });
}

/** Enumerate and read every shell-history source available on this machine. */
export async function collectAvailableShellHistory(opts: CollectShellHistoryOptions = {}): Promise<ShellSourceResult[]> {
  const results: ShellSourceResult[] = [];
  const tailLines = opts.tailLines ?? 300;
  const preferHook = opts.preferHook ?? true;

  const hookPath = hookLogPath();
  const hookExists = existsSync(hookPath);

  // Whether *this shell's* live hook has ever produced a line, across the
  // log's whole history -- not just since the last cursor, since a shell
  // that hasn't run a command since the last sync would otherwise flicker
  // back to "not seen" and re-enable its raw-history scrape every other run.
  let shellsSeen: ReadonlySet<HookShellKind> = new Set();

  if (hookExists) {
    const fromLine = Number(opts.hookCursor ?? '0') || 0;
    const { entries, totalLines, shellsSeen: seen } = await readHookLog(hookPath, fromLine);
    shellsSeen = seen;
    const scoped = opts.repoRoot ? entries.filter((e) => isUnderRoot(e.cwd, opts.repoRoot!)) : entries;
    results.push({ name: 'pwsh-hook', entries: scoped.map(hookEntryToRaw), cursorAfter: String(totalLines) });
  }

  const skipPwshScrape = preferHook && shellsSeen.has('pwsh-hook');
  if (!skipPwshScrape && process.platform === 'win32') {
    const entries = await tryReadScrapeSource(psReadLineHistoryPath(), parsePsReadLineHistory, tailLines);
    if (entries) results.push({ name: 'pwsh', entries });
  }

  const skipBashScrape = preferHook && shellsSeen.has('bash-hook');
  if (!skipBashScrape) {
    const bashEntries = await tryReadScrapeSource(bashHistoryPath(), parseBashHistory, tailLines);
    if (bashEntries) results.push({ name: 'bash', entries: bashEntries });
  }

  const skipZshScrape = preferHook && shellsSeen.has('zsh-hook');
  if (!skipZshScrape) {
    const zshEntries = await tryReadScrapeSource(zshHistoryPath(), parseZshHistory, tailLines);
    if (zshEntries) results.push({ name: 'zsh', entries: zshEntries });
  }

  return results;
}
