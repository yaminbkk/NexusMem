import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectShellHistory, scoreShellCommand, toMemoryNode } from '../src/collectors/shell-history.js';
import { appendHookLogEntry, parseHookLogLine, readHookLog } from '../src/shell/hook-log.js';
import { parseBashHistory } from '../src/shell/parse-bash.js';
import { parsePsReadLineHistory } from '../src/shell/parse-psreadline.js';
import { parseZshHistory } from '../src/shell/parse-zsh.js';
import type { RawShellEntry } from '../src/shell/types.js';
import { installHook, hookStatus, removeHook } from '../src/hooks/install.js';
import { isHookInstalled, renderHookSnippet, stripHookSnippet, upsertHookSnippet } from '../src/hooks/powershell.js';

const MTIME = new Date('2026-08-08T12:00:00Z').getTime();

describe('parsePsReadLineHistory', () => {
  it('treats each non-empty line as one command', () => {
    const entries = parsePsReadLineHistory('git status\n\nnpm test\n', MTIME);
    expect(entries.map((e) => e.command)).toEqual(['git status', 'npm test']);
  });

  it('marks every timestamp as approximate and orders them ascending toward mtime', () => {
    const entries = parsePsReadLineHistory('a\nb\nc\n', MTIME);
    expect(entries.every((e) => e.tsApprox)).toBe(true);
    expect(Date.parse(entries[0]!.ts)).toBeLessThan(Date.parse(entries[2]!.ts));
    expect(entries[2]!.ts).toBe(new Date(MTIME).toISOString());
  });

  it('keeps only the tail window when requested, preserving absolute position in the id', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `cmd${i}`).join('\n');
    const entries = parsePsReadLineHistory(raw, MTIME, { tailLines: 3 });
    expect(entries.map((e) => e.command)).toEqual(['cmd7', 'cmd8', 'cmd9']);
    expect(entries[0]!.naturalKey).toContain('pwsh:7:');
  });

  it('derives a stable, content-addressed naturalKey', () => {
    const a = parsePsReadLineHistory('npm test\n', MTIME);
    const b = parsePsReadLineHistory('npm test\n', MTIME);
    expect(a[0]!.naturalKey).toBe(b[0]!.naturalKey);
  });
});

describe('parseBashHistory', () => {
  it('uses real epoch timestamps when HISTTIMEFORMAT comments are present', () => {
    const raw = '#1700000000\nls -la\n#1700000100\nnpm test\n';
    const entries = parseBashHistory(raw, MTIME);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.ts).toBe(new Date(1700000000 * 1000).toISOString());
    expect(entries[0]!.tsApprox).toBe(false);
    expect(entries[1]!.ts).toBe(new Date(1700000100 * 1000).toISOString());
  });

  it('falls back to mtime-derived timestamps without epoch comments', () => {
    const entries = parseBashHistory('ls\ncd src\n', MTIME);
    expect(entries.every((e) => e.tsApprox)).toBe(true);
  });

  it('handles a mix of timestamped and untimestamped lines', () => {
    const raw = 'plain command\n#1700000000\ntimestamped command\n';
    const entries = parseBashHistory(raw, MTIME);
    expect(entries[0]!.tsApprox).toBe(true);
    expect(entries[1]!.tsApprox).toBe(false);
  });
});

describe('parseZshHistory', () => {
  it('parses the extended-history format with real timestamps and duration', () => {
    const entries = parseZshHistory(': 1700000000:2;npm test\n', MTIME);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.command).toBe('npm test');
    expect(entries[0]!.ts).toBe(new Date(1700000000 * 1000).toISOString());
    expect(entries[0]!.durationMs).toBe(2);
    expect(entries[0]!.tsApprox).toBe(false);
  });

  it('reassembles a backslash-continued multi-line command', () => {
    const raw = ': 1700000000:0;echo one \\\necho two\n';
    const entries = parseZshHistory(raw, MTIME);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.command).toBe('echo one \necho two');
  });

  it('falls back gracefully when extended history is off', () => {
    const entries = parseZshHistory('npm run build\n', MTIME);
    expect(entries[0]!.command).toBe('npm run build');
    expect(entries[0]!.tsApprox).toBe(true);
  });
});

describe('scoreShellCommand', () => {
  const entry = (overrides: Partial<RawShellEntry>): RawShellEntry => ({
    naturalKey: 'k',
    command: 'echo hi',
    ts: '2026-08-08T00:00:00Z',
    tsApprox: false,
    exitCode: null,
    cwd: null,
    durationMs: null,
    shell: 'pwsh',
    ...overrides,
  });

  it('scores navigation noise near zero', () => {
    expect(scoreShellCommand(entry({ command: 'cd src' }))).toBeLessThan(0.2);
    expect(scoreShellCommand(entry({ command: 'ls' }))).toBeLessThan(0.2);
  });

  it('scores installs and build/test commands higher than noise', () => {
    const install = scoreShellCommand(entry({ command: 'npm install left-pad' }));
    const test = scoreShellCommand(entry({ command: 'npm run test' }));
    const noise = scoreShellCommand(entry({ command: 'cd ..' }));
    expect(install).toBeGreaterThan(noise);
    expect(test).toBeGreaterThan(noise);
  });

  it('deprioritizes plain git commands relative to a risky one', () => {
    const status = scoreShellCommand(entry({ command: 'git status' }));
    const forcePush = scoreShellCommand(entry({ command: 'git push origin main --force' }));
    expect(forcePush).toBeGreaterThan(status);
  });

  it('boosts a nonzero exit code and only when the exit code is known', () => {
    const unknown = scoreShellCommand(entry({ command: 'npm run build', exitCode: null }));
    const failed = scoreShellCommand(entry({ command: 'npm run build', exitCode: 1 }));
    const passed = scoreShellCommand(entry({ command: 'npm run build', exitCode: 0 }));
    expect(failed).toBeGreaterThan(unknown);
    expect(failed).toBeGreaterThan(passed);
  });

  it('stays inside 0.05..1', () => {
    for (const cmd of ['cd', 'rm -rf node_modules', 'npm run build']) {
      const s = scoreShellCommand(entry({ command: cmd, exitCode: 1 }));
      expect(s).toBeGreaterThanOrEqual(0.05);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

describe('toMemoryNode (shell)', () => {
  const entry: RawShellEntry = {
    naturalKey: 'pwsh:3:abc123',
    command: 'npm run build',
    ts: '2026-08-08T10:00:00Z',
    tsApprox: false,
    exitCode: 1,
    cwd: 'D:/ai-projects/NexusMem',
    durationMs: 4200,
    shell: 'pwsh',
  };

  it('is content-addressed via the strategy-provided naturalKey', () => {
    const a = toMemoryNode(entry, 'proj1');
    const b = toMemoryNode(entry, 'proj1');
    expect(a.id).toBe(b.id);
  });

  it('tags the node source with the shell family', () => {
    expect(toMemoryNode(entry, 'proj1').source).toBe('shell:pwsh');
  });

  it('embeds cwd, exit code and duration in the body when known', () => {
    const node = toMemoryNode(entry, 'proj1');
    expect(node.body).toContain('exit: 1');
    expect(node.body).toContain('cwd: D:/ai-projects/NexusMem');
    expect(node.body).toContain('duration: 4200ms');
  });

  it('omits the meta line entirely when nothing is known', () => {
    const bare: RawShellEntry = { ...entry, cwd: null, exitCode: null, durationMs: null };
    expect(toMemoryNode(bare, 'proj1').body).not.toContain('exit:');
  });

  it('has no files, unlike a git commit node', () => {
    expect(toMemoryNode(entry, 'proj1').files).toEqual([]);
  });

  it('redacts a secret out of title/body -- the fields that reach the FTS index and embeddings -- while keeping meta.command raw for reconcile/failure-fix matching', () => {
    const withSecret: RawShellEntry = { ...entry, command: 'export API_KEY=sk_live_abcdef1234567890' };
    const node = toMemoryNode(withSecret, 'proj1');

    expect(node.title).not.toContain('sk_live_abcdef1234567890');
    expect(node.body).not.toContain('sk_live_abcdef1234567890');
    expect(node.title).toContain('[redacted]');
    expect(node.body).toContain('[redacted]');

    // meta.command must stay byte-for-byte the raw command: reconcile.ts
    // rehashes it to reproduce the id shell/detect.ts derives from the live
    // hook log, and correlate/failure-fix.ts exact-matches it against a
    // re-run command. Redacting this copy too would silently break both.
    expect(node.meta.command).toBe('export API_KEY=sk_live_abcdef1234567890');
  });
});

describe('collectShellHistory', () => {
  it('maps every entry to a node in order', () => {
    const entries: RawShellEntry[] = [
      { naturalKey: 'a', command: 'ls', ts: '2026-08-08T00:00:00Z', tsApprox: true, exitCode: null, cwd: null, durationMs: null, shell: 'pwsh' },
      { naturalKey: 'b', command: 'npm test', ts: '2026-08-08T00:01:00Z', tsApprox: true, exitCode: null, cwd: null, durationMs: null, shell: 'pwsh' },
    ];
    expect(collectShellHistory(entries, 'proj1').map((n) => n.title)).toEqual(['ls', 'npm test']);
  });
});

describe('hook log', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-hook-'));
    logPath = join(dir, 'shell-history.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a malformed line without throwing', () => {
    expect(parseHookLogLine('not json')).toBeNull();
    expect(parseHookLogLine('{"ts": 5, "cwd": "x", "command": "y"}')).toBeNull(); // wrong types
    expect(parseHookLogLine('')).toBeNull();
  });

  it('round-trips a written entry', async () => {
    await appendHookLogEntry(logPath, { ts: '2026-08-08T00:00:00Z', cwd: 'D:/x', exitCode: 0, durationMs: 12, command: 'npm test' });
    const { entries, totalLines } = await readHookLog(logPath, 0);
    expect(totalLines).toBe(1);
    expect(entries[0]?.command).toBe('npm test');
  });

  it('reads only lines appended since the cursor', async () => {
    await appendHookLogEntry(logPath, { ts: 't1', cwd: 'c', exitCode: null, durationMs: null, command: 'one' });
    const first = await readHookLog(logPath, 0);
    await appendHookLogEntry(logPath, { ts: 't2', cwd: 'c', exitCode: null, durationMs: null, command: 'two' });
    const second = await readHookLog(logPath, first.totalLines);
    expect(second.entries.map((e) => e.command)).toEqual(['two']);
  });

  it('falls back to a full re-read when the cursor is beyond the current file (rotated/cleared)', async () => {
    await appendHookLogEntry(logPath, { ts: 't1', cwd: 'c', exitCode: null, durationMs: null, command: 'one' });
    const result = await readHookLog(logPath, 999);
    expect(result.entries.map((e) => e.command)).toEqual(['one']);
  });

  it('returns empty for a file that does not exist yet, without throwing', async () => {
    const result = await readHookLog(join(dir, 'missing.jsonl'), 0);
    expect(result).toEqual({ entries: [], totalLines: 0 });
  });

  it('skips a torn write but keeps reading the rest', async () => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(
      logPath,
      `${JSON.stringify({ ts: 't1', cwd: 'c', exitCode: null, durationMs: null, command: 'good-1' })}\n{"ts": "t2", "cwd":\n${JSON.stringify(
        { ts: 't3', cwd: 'c', exitCode: null, durationMs: null, command: 'good-2' },
      )}\n`,
      'utf8',
    );
    const { entries } = await readHookLog(logPath, 0);
    expect(entries.map((e) => e.command)).toEqual(['good-1', 'good-2']);
  });
});

describe('PowerShell hook snippet', () => {
  it('is not installed in empty content', () => {
    expect(isHookInstalled('')).toBe(false);
  });

  it('installing then checking reports installed', () => {
    const withHook = upsertHookSnippet('', 'C:/log.jsonl');
    expect(isHookInstalled(withHook)).toBe(true);
  });

  it('preserves unrelated profile content around the block', () => {
    const original = '# my custom profile\nSet-Alias ll Get-ChildItem\n';
    const withHook = upsertHookSnippet(original, 'C:/log.jsonl');
    expect(withHook).toContain('Set-Alias ll Get-ChildItem');
    expect(withHook).toContain('__ssd_original_prompt');
  });

  it('is idempotent: upserting twice does not duplicate the block', () => {
    // The marker string appears legitimately more than once within one
    // correct block (declaration, check, reassignment) -- what matters is
    // that a second upsert doesn't add a second copy of the whole block.
    const once = upsertHookSnippet('# profile\n', 'C:/log.jsonl');
    const twice = upsertHookSnippet(once, 'C:/log.jsonl');
    expect(twice.match(/__ssd_last_history_id/g)?.length).toBe(once.match(/__ssd_last_history_id/g)?.length);
    expect(twice.match(/# >>> nexusmem shell hook >>>/g)).toHaveLength(1);
  });

  it('updates the log path in place when re-installed with a new path', () => {
    const first = upsertHookSnippet('', 'C:/old.jsonl');
    const second = upsertHookSnippet(first, 'C:/new.jsonl');
    expect(second).toContain('C:/new.jsonl');
    expect(second).not.toContain('C:/old.jsonl');
  });

  it('strips cleanly back to the original content', () => {
    const original = '# before\nGet-Date\n# after\n';
    const withHook = upsertHookSnippet(original, 'C:/log.jsonl');
    expect(stripHookSnippet(withHook).replace(/\n+$/, '')).toBe(original.replace(/\n+$/, ''));
  });

  it('embeds the log path as a PowerShell single-quoted literal, safe for spaces and backslashes', () => {
    const snippet = renderHookSnippet('C:\\Users\\A B\\log.jsonl');
    // Not JSON-escaped: PowerShell has no backslash-escaping in strings, so a
    // JSON.stringify'd path would corrupt into doubled backslashes here.
    expect(snippet).toContain("'C:\\Users\\A B\\log.jsonl'");
    expect(snippet).not.toContain('\\\\');
  });

  it('doubles an embedded single quote, the one character that is special in a PS single-quoted string', () => {
    const snippet = renderHookSnippet("C:\\Users\\O'Brien\\log.jsonl");
    expect(snippet).toContain("'C:\\Users\\O''Brien\\log.jsonl'");
  });

  it('captures $? and $LASTEXITCODE as the first statements of prompt(), before Get-History can overwrite $?', () => {
    const snippet = renderHookSnippet('C:/log.jsonl');
    const body = snippet.slice(snippet.indexOf('function global:prompt {'));
    const okLine = body.indexOf('$__ssd_ok = $?');
    const exitLine = body.indexOf('$__ssd_exit = $LASTEXITCODE');
    const historyLine = body.indexOf('Get-History');
    expect(okLine).toBeGreaterThan(-1);
    expect(exitLine).toBeGreaterThan(okLine);
    expect(historyLine).toBeGreaterThan(exitLine);
  });

  it('forces exitCode to 0 on a successful command regardless of a stale nonzero $LASTEXITCODE from an earlier native failure', () => {
    // The bug: $LASTEXITCODE is only ever set by a native exe, so it stays
    // stuck at an old failing value through any number of later successful
    // cmdlets. Reading $? (which every command updates) as well is what
    // stops that stale value from being reported as this command's outcome.
    const snippet = renderHookSnippet('C:/log.jsonl');
    expect(snippet).toContain('exitCode = if ($__ssd_ok) { 0 } elseif ($__ssd_exit) { $__ssd_exit } else { 1 }');
  });
});

describe('hook install/remove/status (filesystem, scratch profile)', () => {
  let dir: string;
  let profilePath: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-profile-'));
    profilePath = join(dir, 'Microsoft.PowerShell_profile.ps1');
    logPath = join(dir, 'shell-history.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the profile file and directory if neither exists', async () => {
    const result = await installHook({ profilePath, logPath });
    expect(result.changed).toBe(true);
    expect((await hookStatus({ profilePath, logPath })).installed).toBe(true);
  });

  it('is a no-op the second time with the same log path', async () => {
    await installHook({ profilePath, logPath });
    const second = await installHook({ profilePath, logPath });
    expect(second.changed).toBe(false);
    expect(second.alreadyInstalled).toBe(true);
  });

  it('removes cleanly and status reflects it', async () => {
    await installHook({ profilePath, logPath });
    const removed = await removeHook({ profilePath, logPath });
    expect(removed.changed).toBe(true);
    expect((await hookStatus({ profilePath, logPath })).installed).toBe(false);
  });

  it('removing when nothing is installed is a safe no-op', async () => {
    const result = await removeHook({ profilePath, logPath });
    expect(result.changed).toBe(false);
  });
});
