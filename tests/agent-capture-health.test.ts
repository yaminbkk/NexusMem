import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactAgentEvent } from '../src/agent/event.js';
import { HEALTHY_WINDOW_MS, readCaptureStatus, recordCaptureDrop } from '../src/agent/capture-health.js';

/**
 * Capture health has to separate "quiet because nobody was coding" from
 * "quiet because the payload shape changed and every event is being dropped".
 * Installed configuration proves neither, and neither does silence on its own.
 */

const NOW = new Date('2026-09-12T12:00:00.000Z');
const SECRET = 'health-s3cret-VALUE';
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const WINDOW_MINUTES = HEALTHY_WINDOW_MS / 60_000;

let dir: string;
let logPath: string;
let dropPath: string;

const paths = () => ({ logPath, dropStatePath: dropPath, now: NOW });

function writeEvent(minutes: number, over: Record<string, unknown> = {}): void {
  const event = redactAgentEvent({
    agent: 'claude-code',
    sessionId: 's1',
    eventId: `e-${minutes}`,
    ts: minutesAgo(minutes).toISOString(),
    cwd: 'D:/repo',
    kind: 'command',
    command: `psql postgres://app:${SECRET}@db/app`,
    outcome: 'fail',
    exitCode: 1,
    durationMs: 5,
    ...over,
  });
  writeFileSync(logPath, `${JSON.stringify(event)}\n`, { flag: 'a' });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-health-'));
  logPath = join(dir, 'agent-events.jsonl');
  dropPath = join(dir, 'agent-capture-drops.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readCaptureStatus', () => {
  it('reports healthy from a recent event, naming its kind but never its content', () => {
    writeEvent(10);

    const status = readCaptureStatus(paths());

    expect(status).toMatchObject({ health: 'healthy', lastEventKind: 'command', lastEventOutcome: 'fail', drops: 0 });
    expect(status.lastEventAt).toBe(minutesAgo(10).toISOString());
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(JSON.stringify(status)).not.toContain('psql');
  });

  it('records a drop even when the workspace directory does not exist yet', () => {
    // The first hook run on a machine can drop before anything else has created the directory.
    dropPath = join(dir, 'not-yet', 'created', 'agent-capture-drops.json');
    recordCaptureDrop('unparsable-json', 'other', dropPath, minutesAgo(1));

    expect(readCaptureStatus(paths())).toMatchObject({ health: 'degraded', lastDropReason: 'unparsable-json', drops: 1 });
  });

  it('reports never-observed when the hook has never written anything', () => {
    expect(readCaptureStatus(paths())).toMatchObject({ health: 'never-observed', lastEventAt: null, drops: 0 });
  });

  it('reports stale once the last event falls outside the healthy window', () => {
    writeEvent(WINDOW_MINUTES + 60);

    expect(readCaptureStatus(paths()).health).toBe('stale');
  });

  it('reports degraded when events are arriving, being dropped, and none was ever captured', () => {
    recordCaptureDrop('unsupported-event', 'post-tool-use-failure', dropPath, minutesAgo(1));

    expect(readCaptureStatus(paths())).toMatchObject({
      health: 'degraded',
      lastEventAt: null,
      lastDropReason: 'unsupported-event',
      lastDropFamily: 'post-tool-use-failure',
      drops: 1,
    });
  });

  it('reports degraded when capture worked before but has been dropping since', () => {
    writeEvent(30);
    recordCaptureDrop('missing-fields', 'post-tool-use', dropPath, minutesAgo(1));

    const status = readCaptureStatus(paths());
    expect(status.health).toBe('degraded');
    // The last success is still reported: that is what says when it broke.
    expect(status.lastEventAt).toBe(minutesAgo(30).toISOString());
  });

  it('returns to healthy once a valid event arrives after a drop', () => {
    recordCaptureDrop('unparsable-json', 'other', dropPath, minutesAgo(30));
    writeEvent(5);

    const status = readCaptureStatus(paths());
    expect(status.health).toBe('healthy');
    // The drop is still counted; it is simply no longer the newest evidence.
    expect(status.drops).toBe(1);
  });

  it('does not call capture broken just because an old drop was never followed by anything', () => {
    recordCaptureDrop('unsupported-tool', 'post-tool-use', dropPath, minutesAgo(WINDOW_MINUTES + 600));

    // Silence plus stale evidence is not proof of a break.
    expect(readCaptureStatus(paths())).toMatchObject({ health: 'never-observed', drops: 1 });
  });

  it('reports stale, not degraded, when both the last event and the last drop are old', () => {
    writeEvent(WINDOW_MINUTES + 300);
    recordCaptureDrop('missing-fields', 'post-tool-use', dropPath, minutesAgo(WINDOW_MINUTES + 120));

    expect(readCaptureStatus(paths()).health).toBe('stale');
  });

  it('counts repeated drops without letting the state file grow', () => {
    recordCaptureDrop('unparsable-json', 'other', dropPath, NOW);
    const afterFirst = statSync(dropPath).size;
    for (let i = 0; i < 500; i += 1) recordCaptureDrop('unparsable-json', 'other', dropPath, NOW);

    const status = readCaptureStatus(paths());
    expect(status.drops).toBe(501);
    // Same four fields every time: a hook dropping every event cannot grow this.
    expect(statSync(dropPath).size).toBeLessThanOrEqual(afterFirst + 4);
  });

  it('treats a corrupt drop-state file as no evidence rather than failing', () => {
    writeFileSync(dropPath, '{ not json');
    writeEvent(10);

    expect(readCaptureStatus(paths())).toMatchObject({ health: 'healthy', lastDropReason: null, lastDropFamily: null, drops: 0 });
  });

  it('ignores a reason or family that is not one of the known codes', () => {
    writeFileSync(
      dropPath,
      JSON.stringify({ lastDropAt: NOW.toISOString(), lastDropReason: `leaked ${SECRET}`, lastDropFamily: SECRET, drops: 1 }),
    );

    const status = readCaptureStatus(paths());
    expect(status.lastDropReason).toBeNull();
    expect(status.lastDropFamily).toBeNull();
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  it('never writes anything but known codes, even when handed something else', () => {
    recordCaptureDrop(`unparsable-json ${SECRET}` as never, `family ${SECRET}` as never, dropPath, NOW);

    expect(readCaptureStatus(paths())).toMatchObject({ lastDropReason: 'missing-fields', lastDropFamily: 'other' });
    expect(readFileSync(dropPath, 'utf8')).not.toContain(SECRET);
  });

  it('reports unknown when the log exists but nothing in it can be parsed', () => {
    writeFileSync(logPath, 'garbage\nmore garbage\n');

    expect(readCaptureStatus(paths()).health).toBe('unknown');
  });

  it('skips a torn final line and reports the last line that does parse', () => {
    writeEvent(10);
    writeFileSync(logPath, '{"agent":"claude-code","sessi', { flag: 'a' });

    expect(readCaptureStatus(paths())).toMatchObject({ health: 'healthy', lastEventKind: 'command' });
  });
});
