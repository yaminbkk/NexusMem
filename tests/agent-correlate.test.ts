import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentEvent, redactAgentEvent } from '../src/agent/event.js';
import { collectAgentEvents } from '../src/collectors/agent-events.js';
import { correlateFailures, RESOLVED_BY_RETRY } from '../src/correlate/failure-fix.js';
import { makeNodeId } from '../src/core/ids.js';
import type { MemoryNode } from '../src/core/types.js';
import { MemoryStore } from '../src/store/store.js';

/**
 * An attempt is files changed + execution + result, not a command string.
 *
 * Agent capture records all three, so a command that passes with nothing
 * edited in between is a flake or a change of environment -- not a fix. These
 * tests pin that distinction, and pin that human shell history, which records
 * no files at all, is unaffected by it.
 */

const PROJECT = 'proj-correlate';
const ROOT = process.platform === 'win32' ? 'D:/repo' : '/repo';
const COMMAND = 'npm test';
const at = (minutes: number) => new Date(Date.parse('2026-09-12T09:00:00.000Z') + minutes * 60_000).toISOString();

let dir: string;
let store: MemoryStore;
let seq = 0;

const agentEvent = (over: Partial<AgentEvent>): AgentEvent =>
  redactAgentEvent({
    agent: 'claude-code',
    sessionId: 'sess-1',
    eventId: `e-${(seq += 1)}`,
    ts: at(0),
    cwd: ROOT,
    kind: 'command',
    command: COMMAND,
    outcome: 'fail',
    exitCode: 1,
    durationMs: 10,
    ...over,
  } as AgentEvent);

function shellNode(key: string, opts: { minutes: number; exitCode: number }): MemoryNode {
  return {
    id: makeNodeId(PROJECT, 'shell_command', key),
    kind: 'shell_command',
    projectId: PROJECT,
    ts: at(opts.minutes),
    sourceTs: at(opts.minutes),
    source: 'shell:pwsh-hook',
    title: `$ ${COMMAND}`,
    body: `$ ${COMMAND}`,
    files: [],
    signal: 0.3,
    provenance: 'observed',
    meta: { command: COMMAND, cwd: ROOT, exitCode: opts.exitCode, durationMs: 100, tsApprox: false },
  };
}

const seed = (events: AgentEvent[]) => store.upsertNodes(collectAgentEvents(events, PROJECT, { repoRoot: ROOT }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-correlate-'));
  store = MemoryStore.open(join(dir, 'memory.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('correlateFailures: agent attempts', () => {
  it('links a failure to a pass that followed a real edit', () => {
    seed([
      agentEvent({ ts: at(0) }),
      agentEvent({ kind: 'edit', filePath: `${ROOT}/src/a.ts`, outcome: 'ok', exitCode: null, ts: at(5) }),
      agentEvent({ outcome: 'ok', exitCode: 0, ts: at(6) }),
    ]);

    const stats = correlateFailures(store, PROJECT);

    expect(stats).toMatchObject({ failuresExamined: 1, linkedByRetry: 1, unexplainedRetries: 0 });
  });

  it('refuses to call an unexplained pass a fix, and counts it instead', () => {
    seed([agentEvent({ ts: at(0) }), agentEvent({ outcome: 'ok', exitCode: 0, ts: at(6) })]);

    const stats = correlateFailures(store, PROJECT);

    expect(stats).toMatchObject({ failuresExamined: 1, linkedByRetry: 0, unexplainedRetries: 1 });
    const [failure] = store.raw
      .prepare(`SELECT id FROM nodes WHERE project_id = ? AND json_extract(meta,'$.exitCode') = 1`)
      .all(PROJECT) as Array<{ id: string }>;
    expect(store.getLinkedNodeIds(failure!.id, RESOLVED_BY_RETRY)).toEqual([]);
  });

  it('does not credit a later edited pass once the command already passed without an edit', () => {
    // fail -> pass (no edit) -> edit -> pass: the failure was gone before the edit happened,
    // so linking the edited pass would claim a cause the evidence does not show.
    seed([
      agentEvent({ ts: at(0) }),
      agentEvent({ outcome: 'ok', exitCode: 0, ts: at(2) }),
      agentEvent({ kind: 'edit', filePath: `${ROOT}/src/a.ts`, outcome: 'ok', exitCode: null, ts: at(5) }),
      agentEvent({ outcome: 'ok', exitCode: 0, ts: at(6) }),
    ]);

    expect(correlateFailures(store, PROJECT)).toMatchObject({ failuresExamined: 1, linkedByRetry: 0, unexplainedRetries: 1 });
    const [failure] = store.raw
      .prepare(`SELECT id FROM nodes WHERE project_id = ? AND json_extract(meta,'$.exitCode') = 1`)
      .all(PROJECT) as Array<{ id: string }>;
    expect(store.getLinkedNodeIds(failure!.id, RESOLVED_BY_RETRY)).toEqual([]);
  });

  it('still links the edited pass to a failure that came back after the unexplained one', () => {
    seed([
      agentEvent({ ts: at(0) }),
      agentEvent({ outcome: 'ok', exitCode: 0, ts: at(2) }),
      agentEvent({ ts: at(3) }),
      agentEvent({ kind: 'edit', filePath: `${ROOT}/src/a.ts`, outcome: 'ok', exitCode: null, ts: at(5) }),
      agentEvent({ outcome: 'ok', exitCode: 0, ts: at(6) }),
    ]);

    expect(correlateFailures(store, PROJECT)).toMatchObject({ failuresExamined: 2, linkedByRetry: 1, unexplainedRetries: 1 });
  });

  describe('the same execution in different spellings', () => {
    const WRAPPED = `cd "${ROOT}" && ${COMMAND}; echo "exit: $?"`;
    const failureId = () =>
      (store.raw.prepare(`SELECT id FROM nodes WHERE project_id = ? AND json_extract(meta,'$.exitCode') = 1`).get(PROJECT) as { id: string }).id;

    it('links a cd-wrapped agent failure to the bare pass that followed a real edit', () => {
      seed([
        agentEvent({ command: WRAPPED, ts: at(0) }),
        agentEvent({ kind: 'edit', filePath: `${ROOT}/src/a.ts`, outcome: 'ok', exitCode: null, ts: at(5) }),
        agentEvent({ outcome: 'ok', exitCode: 0, ts: at(6) }),
      ]);

      expect(correlateFailures(store, PROJECT)).toMatchObject({ failuresExamined: 1, linkedByRetry: 1, unexplainedRetries: 0 });
      expect(store.getLinkedNodeIds(failureId(), RESOLVED_BY_RETRY)).toHaveLength(1);
    });

    it('links a bare agent failure to a wrapped pass the same way', () => {
      seed([
        agentEvent({ ts: at(0) }),
        agentEvent({ kind: 'edit', filePath: `${ROOT}/src/a.ts`, outcome: 'ok', exitCode: null, ts: at(5) }),
        agentEvent({ command: WRAPPED, outcome: 'ok', exitCode: 0, ts: at(6) }),
      ]);

      expect(correlateFailures(store, PROJECT)).toMatchObject({ linkedByRetry: 1 });
    });

    it('still counts a wrapped pass with no edit as unexplained, never as a fix', () => {
      seed([agentEvent({ ts: at(0) }), agentEvent({ command: WRAPPED, outcome: 'ok', exitCode: 0, ts: at(6) })]);

      expect(correlateFailures(store, PROJECT)).toMatchObject({ linkedByRetry: 0, unexplainedRetries: 1 });
    });

    it('does not link agent runs whose credentials differ, however alike they read once redacted', () => {
      seed([
        agentEvent({ command: 'TOKEN=synthetic-aaaa1111 npm run deploy', ts: at(0) }),
        agentEvent({ kind: 'edit', filePath: `${ROOT}/src/a.ts`, outcome: 'ok', exitCode: null, ts: at(5) }),
        agentEvent({ command: 'TOKEN=synthetic-bbbb2222 npm run deploy', outcome: 'ok', exitCode: 0, ts: at(6) }),
      ]);

      expect(correlateFailures(store, PROJECT)).toMatchObject({ linkedByRetry: 0, unexplainedRetries: 0 });
    });

    it('does not link a different execution that happens to share the wrapper', () => {
      seed([
        agentEvent({ command: WRAPPED, ts: at(0) }),
        agentEvent({ kind: 'edit', filePath: `${ROOT}/src/a.ts`, outcome: 'ok', exitCode: null, ts: at(5) }),
        agentEvent({ command: `cd "${ROOT}" && npm run build; echo "exit: $?"`, outcome: 'ok', exitCode: 0, ts: at(6) }),
      ]);

      expect(correlateFailures(store, PROJECT)).toMatchObject({ linkedByRetry: 0 });
    });
  });

  it('still links human shell history, which never records files', () => {
    store.upsertNodes([shellNode('fail', { minutes: 0, exitCode: 1 }), shellNode('pass', { minutes: 30, exitCode: 0 })]);

    const stats = correlateFailures(store, PROJECT);

    expect(stats).toMatchObject({ linkedByRetry: 1, unexplainedRetries: 0 });
    expect(store.getLinkedNodeIds(makeNodeId(PROJECT, 'shell_command', 'fail'), RESOLVED_BY_RETRY)).toEqual([
      makeNodeId(PROJECT, 'shell_command', 'pass'),
    ]);
  });

  it('links an agent failure resolved by a human run, where no file evidence can exist', () => {
    seed([agentEvent({ ts: at(0) })]);
    store.upsertNodes([shellNode('human-pass', { minutes: 30, exitCode: 0 })]);

    expect(correlateFailures(store, PROJECT)).toMatchObject({ linkedByRetry: 1, unexplainedRetries: 0 });
  });

  it('is idempotent: correlating twice neither duplicates a link nor double-counts', () => {
    seed([
      agentEvent({ ts: at(0) }),
      agentEvent({ kind: 'edit', filePath: `${ROOT}/src/a.ts`, outcome: 'ok', exitCode: null, ts: at(5) }),
      agentEvent({ outcome: 'ok', exitCode: 0, ts: at(6) }),
    ]);

    const first = correlateFailures(store, PROJECT);
    const second = correlateFailures(store, PROJECT);

    expect(second).toEqual(first);
    const [failure] = store.raw
      .prepare(`SELECT id FROM nodes WHERE project_id = ? AND json_extract(meta,'$.exitCode') = 1`)
      .all(PROJECT) as Array<{ id: string }>;
    expect(store.getLinkedNodeIds(failure!.id, RESOLVED_BY_RETRY)).toHaveLength(1);
  });
});
