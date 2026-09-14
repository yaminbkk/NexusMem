import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureDropStatePath, readCaptureStatus } from '../src/agent/capture-health.js';
import { appendAgentEvent, parseAgentEventLine, readAgentEvents } from '../src/agent/record.js';
import { parseHookPayload } from '../src/adapters/claude-code/payload.js';
import { sha256Hex } from '../src/core/ids.js';

/**
 * Same invariant the shell recorder holds, now for agent events: the raw
 * command may pass through memory, but nothing NexusMem writes may contain it.
 */

const HOOK = resolve('dist/cli/agent-hook.js'); // built by tests/global-setup.ts
const SECRET = 'agent-s3cret-VALUE';
const RAW = `psql postgres://app:${SECRET}@db/app`;

const payload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: 'sess-1',
    cwd: 'D:/repo',
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: RAW },
    tool_use_id: 'toolu_1',
    error: `Exit code 1\nFATAL: password authentication failed for ${RAW}`,
    is_interrupt: false,
    duration_ms: 9,
    ...over,
  });

function filesContaining(dir: string, needle = SECRET): string[] {
  if (!existsSync(dir)) return [];
  const hits: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) hits.push(...filesContaining(path, needle));
    else if (readFileSync(path).includes(needle)) hits.push(path);
  }
  return hits;
}

let home: string;
let logPath: string;
let childEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexusmem-agent-')));
  const tmp = join(home, 'tmp');
  mkdirSync(tmp);
  logPath = join(home, 'nm', 'agent-events.jsonl');
  childEnv = { ...process.env, TMP: tmp, TEMP: tmp, TMPDIR: tmp };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('agent event log', () => {
  it('round-trips an event and advances the cursor by line count', async () => {
    const first = parseHookPayload(payload(), '2026-09-11T15:00:00.000Z')!;
    await appendAgentEvent(first, logPath);
    const second = parseHookPayload(payload({ tool_use_id: 'toolu_2' }), '2026-09-11T15:00:01.000Z')!;
    await appendAgentEvent(second, logPath);

    const all = await readAgentEvents(logPath, 0);
    expect(all.totalLines).toBe(2);
    expect(all.events.map((e) => e.eventId)).toEqual(['toolu_1', 'toolu_2']);

    const tail = await readAgentEvents(logPath, 1);
    expect(tail.events.map((e) => e.eventId)).toEqual(['toolu_2']);
    // A cursor past the end means the file was rotated: re-read everything rather than skip history.
    expect((await readAgentEvents(logPath, 99)).events).toHaveLength(2);
  });

  it('is a no-op for a missing log', async () => {
    expect(await readAgentEvents(join(home, 'nope.jsonl'), 3)).toEqual({ events: [], totalLines: 3 });
  });

  it.each([
    ['a torn line', '{"agent":"claude-code"'],
    ['a non-object', '"text"'],
    ['a missing eventId', JSON.stringify({ agent: 'a', sessionId: 's', ts: 't', kind: 'command', outcome: 'ok' })],
    ['an unknown kind', JSON.stringify({ agent: 'a', sessionId: 's', eventId: 'e', ts: 't', kind: 'thinking', outcome: 'ok' })],
    ['an unknown outcome', JSON.stringify({ agent: 'a', sessionId: 's', eventId: 'e', ts: 't', kind: 'command', outcome: 'maybe' })],
  ])('skips %s', (_label, line) => {
    expect(parseAgentEventLine(line)).toBeNull();
  });
});

describe('agent-hook process: success, failure and crash boundaries', () => {
  function run(input: string, args: string[] = ['--log'], opts: { killAfterMs?: number } = {}) {
    const argv = args[0] === '--log' && args.length === 1 ? ['--log', logPath] : args;
    const child = spawn(process.execPath, [HOOK, ...argv], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    // The hook exits as soon as it has enough input, so a later write can EPIPE; that is the expected drop.
    child.stdin.on('error', () => {});
    child.stdin.write(input);
    if (opts.killAfterMs === undefined) child.stdin.end();
    else setTimeout(() => child.kill('SIGKILL'), opts.killAfterMs);
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) =>
      child.on('close', (code) => done({ code, stdout, stderr })),
    );
  }

  it('persists the redacted event and nothing else, anywhere', async () => {
    const r = await run(payload());
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });

    const { events } = await readAgentEvents(logPath, 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: 'claude-code',
      kind: 'command',
      outcome: 'fail',
      exitCode: 1,
      commandHash: sha256Hex(RAW).slice(0, 12),
    });
    expect(events[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // stamped on receipt; no payload carries a timestamp
    expect(filesContaining(home)).toEqual([]);
  });

  it('never echoes a malformed payload -- a parse error message would quote it', async () => {
    const r = await run(`{"tool_input":{"command":"${RAW}"`);
    expect(r).toEqual({ code: 1, stdout: '', stderr: '' });
    expect(existsSync(logPath)).toBe(false);
    expect(filesContaining(home)).toEqual([]);
  });

  // The drop marker lives under this test file's isolated NEXUSMEM_HOME and is shared by
  // every test in it, so these assert movement rather than absolute counts.
  it('records why it dropped an event, as a code with no payload attached', async () => {
    const before = readCaptureStatus().drops;
    await run(`{"tool_input":{"command":"${RAW}"`);

    const after = readCaptureStatus();
    // 'other': an unparsable payload says nothing about which hook sent it.
    expect(after).toMatchObject({ health: 'degraded', lastDropReason: 'unparsable-json', lastDropFamily: 'other' });
    expect(after.drops).toBe(before + 1);
    expect(readFileSync(captureDropStatePath(), 'utf8')).not.toContain(SECRET);
  });

  it('distinguishes an unsupported tool from an unreadable payload', async () => {
    await run(payload({ tool_name: 'WebFetch' }));

    expect(readCaptureStatus()).toMatchObject({ lastDropReason: 'unsupported-tool', lastDropFamily: 'post-tool-use-failure' });
    expect(readFileSync(captureDropStatePath(), 'utf8')).not.toContain(SECRET);
  });

  it('records no new drop when capture succeeds, and reads back as healthy', async () => {
    const before = readCaptureStatus().drops;
    await run(payload());

    const after = readCaptureStatus({ logPath });
    expect(after.drops).toBe(before);
    expect(after).toMatchObject({ health: 'healthy', lastEventKind: 'command', lastEventOutcome: 'fail' });
  });

  it('drops an event it does not handle, without writing', async () => {
    const r = await run(payload({ tool_name: 'WebFetch' }));
    expect(r.code).toBe(1);
    expect(existsSync(logPath)).toBe(false);
  });

  it('fails silently, with no fallback write, when the log cannot be written', async () => {
    const blocker = join(home, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const r = await run(payload(), ['--log', join(blocker, 'agent-events.jsonl')]);
    expect(r).toEqual({ code: 1, stdout: '', stderr: '' });
    expect(filesContaining(home)).toEqual([]);
  });

  it('drops an oversized payload without writing it, and records the drop', async () => {
    const before = readCaptureStatus().drops;
    const r = await run(payload({ error: `Exit code 1\n${'x'.repeat(1_100_000)}` }));
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toBe('');
    expect(existsSync(logPath)).toBe(false);

    // Never parsed, so nothing is known about which hook sent it.
    const after = readCaptureStatus();
    expect(after).toMatchObject({ health: 'degraded', lastDropReason: 'payload-too-large', lastDropFamily: 'other' });
    expect(after.drops).toBe(before + 1);
    const marker = readFileSync(captureDropStatePath(), 'utf8');
    expect(marker).not.toContain(SECRET);
    expect(marker.length).toBeLessThan(300);
  });

  it('crash boundary: killed while holding the raw payload, before persisting, leaves no trace', async () => {
    const r = await run(payload(), ['--log'], { killAfterMs: 500 });
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toBe('');
    expect(existsSync(logPath)).toBe(false);
    expect(filesContaining(home)).toEqual([]);
  });
});
