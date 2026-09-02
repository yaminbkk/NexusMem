import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * One line of the opt-in hook log: a JSONL file the installed shell hook
 * appends to on every command. This is the high-quality tier -- exact
 * timestamp, cwd and exit code, none of which the scrape-based fallbacks can
 * offer.
 */
/** Which live hook wrote this line. Absent on lines predating this field -- the only hook that existed then was PowerShell's. */
export type HookShellKind = 'pwsh-hook' | 'bash-hook' | 'zsh-hook';

const HOOK_SHELL_KINDS: ReadonlySet<string> = new Set<HookShellKind>(['pwsh-hook', 'bash-hook', 'zsh-hook']);

export interface HookLogEntry {
  ts: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number | null;
  command: string;
  shell?: HookShellKind;
}

/** A malformed line (typically a torn write from a crash mid-append) is skipped, not fatal. */
export function parseHookLogLine(line: string): HookLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;

  const o = obj as Record<string, unknown>;
  if (typeof o.ts !== 'string' || typeof o.cwd !== 'string' || typeof o.command !== 'string') return null;

  return {
    ts: o.ts,
    cwd: o.cwd,
    exitCode: typeof o.exitCode === 'number' ? o.exitCode : null,
    durationMs: typeof o.durationMs === 'number' ? o.durationMs : null,
    command: o.command,
    shell: typeof o.shell === 'string' && HOOK_SHELL_KINDS.has(o.shell) ? (o.shell as HookShellKind) : undefined,
  };
}

export interface ReadHookLogResult {
  entries: HookLogEntry[];
  /** Total lines currently in the file -- the caller's next cursor. */
  totalLines: number;
  /**
   * Which live hooks have *ever* written to this file, across its full
   * content -- not just the lines returned in `entries`. A cursor-scoped
   * "did I just see a bash-hook line" would flicker true/false across
   * incremental syncs depending on whether bash ran a command since the last
   * one; this reflects the whole file, since the file already has to be read
   * and split in full regardless of `fromLine` (see below).
   */
  shellsSeen: ReadonlySet<HookShellKind>;
}

/**
 * Read lines appended since `fromLine`.
 *
 * `fromLine` beyond the file's current length means the file was rotated or
 * cleared out from under a stale cursor -- treated the same way a stale git
 * cursor is: fall back to reading everything, rather than silently skipping
 * history that is actually new.
 */
export async function readHookLog(path: string, fromLine: number): Promise<ReadHookLogResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { entries: [], totalLines: fromLine, shellsSeen: new Set() };
  }

  // The whole file is already read and split above regardless of `fromLine`,
  // so parsing every line here (not just the slice) to compute `shellsSeen`
  // costs no extra I/O -- only cheap, already-necessary JSON parsing.
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const allParsed = lines.map(parseHookLogLine);

  // A line with no `shell` field predates that field and is implicitly
  // PowerShell's -- the only hook that existed before it was added.
  const shellsSeen = new Set<HookShellKind>();
  for (const e of allParsed) if (e) shellsSeen.add(e.shell ?? 'pwsh-hook');

  const sliceStart = fromLine > 0 && fromLine <= lines.length ? fromLine : 0;
  const entries = allParsed.slice(sliceStart).filter((e): e is HookLogEntry => e !== null);

  return { entries, totalLines: lines.length, shellsSeen };
}

/** Append one entry. Exposed for tests; the real writer is the installed PowerShell hook. */
export async function appendHookLogEntry(path: string, entry: HookLogEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}
