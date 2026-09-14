import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { correlateFailures, getChainStats, RESOLVED_BY_DISCUSSION, RESOLVED_BY_RETRY } from '../src/correlate/failure-fix.js';
import type { MemoryNode } from '../src/core/types.js';
import { toHookLogLine } from '../src/shell/recorder.js';
import { MemoryStore } from '../src/store/store.js';

/**
 * Phase 7's first correlation pass: link a failed shell_command to whatever
 * later resolved it. Both heuristics are new and unvalidated against real
 * data (see the module's own doc comment) -- these tests pin the narrow,
 * deliberately conservative behavior as built, not a claim that the
 * heuristics are the right ones.
 */

const PROJECT = 'proj-a';
const T0 = Date.parse('2026-01-01T00:00:00Z');
const HOUR = 60 * 60 * 1000;

function shellNode(
  id: string,
  opts: { ts: number; command: string; exitCode: number; cwd?: string; commandHash?: string },
): MemoryNode {
  return {
    id,
    kind: 'shell_command',
    projectId: PROJECT,
    ts: new Date(opts.ts).toISOString(),
    source: 'shell:pwsh-hook',
    title: `$ ${opts.command}`,
    body: `$ ${opts.command}`,
    files: [],
    signal: 0.3,
    meta: {
      command: opts.command,
      cwd: opts.cwd ?? '/repo',
      exitCode: opts.exitCode,
      durationMs: 100,
      tsApprox: false,
      ...(opts.commandHash ? { commandHash: opts.commandHash } : {}),
    },
  };
}

/** A node as the real recorder stores a raw command: redacted text, hash of the raw command. */
function recordedShellNode(id: string, opts: { ts: number; raw: string; exitCode: number }): MemoryNode {
  const line = JSON.parse(
    toHookLogLine(JSON.stringify({ ts: new Date(opts.ts).toISOString(), cwd: '/repo', command: opts.raw }), 'pwsh-hook')!,
  ) as { command: string; commandHash: string };
  return shellNode(id, { ts: opts.ts, command: line.command, exitCode: opts.exitCode, commandHash: line.commandHash });
}

function conversationNode(id: string, opts: { ts: number; body: string }): MemoryNode {
  return {
    id,
    kind: 'conversation_turn',
    projectId: PROJECT,
    ts: new Date(opts.ts).toISOString(),
    source: 'conversation:claude-code',
    title: 'a conversation turn',
    body: opts.body,
    files: [],
    signal: 0.5,
    meta: {},
  };
}

describe('correlateFailures', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-correlate-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('links a failure to a later successful retry of the exact same command in the same cwd', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1 }),
      shellNode('retry', { ts: T0 + HOUR, command: 'npm test', exitCode: 0 }),
    ]);

    const stats = correlateFailures(store, PROJECT);

    expect(stats).toEqual({ failuresExamined: 1, linkedByRetry: 1, linkedByDiscussion: 0, unexplainedRetries: 0 });
    expect(store.getLinkedNodeIds('fail', RESOLVED_BY_RETRY)).toEqual(['retry']);
  });

  describe('when redaction makes different commands read the same', () => {
    it('does not link a pass whose raw command differed, even though the stored text is identical', () => {
      const fail = recordedShellNode('fail', { ts: T0, raw: 'TOKEN=synthetic-aaaa1111 npm test', exitCode: 1 });
      const pass = recordedShellNode('retry', { ts: T0 + HOUR, raw: 'TOKEN=synthetic-bbbb2222 npm test', exitCode: 0 });
      expect(fail.meta.command).toBe(pass.meta.command);
      store.upsertNodes([fail, pass]);

      expect(correlateFailures(store, PROJECT)).toMatchObject({ linkedByRetry: 0 });
      expect(store.getLinkedNodeIds('fail', RESOLVED_BY_RETRY)).toEqual([]);
    });

    it('still links a real retry of the same raw command', () => {
      store.upsertNodes([
        recordedShellNode('fail', { ts: T0, raw: 'TOKEN=synthetic-aaaa1111 npm test', exitCode: 1 }),
        recordedShellNode('retry', { ts: T0 + HOUR, raw: 'TOKEN=synthetic-aaaa1111 npm test', exitCode: 0 }),
      ]);

      expect(correlateFailures(store, PROJECT)).toMatchObject({ linkedByRetry: 1 });
      expect(store.getLinkedNodeIds('fail', RESOLVED_BY_RETRY)).toEqual(['retry']);
    });

    it('does not link a redacted legacy row that has no raw-command hash to compare', () => {
      const pass = recordedShellNode('retry', { ts: T0 + HOUR, raw: 'TOKEN=synthetic-aaaa1111 npm test', exitCode: 0 });
      store.upsertNodes([
        shellNode('fail', { ts: T0, command: String(pass.meta.command), exitCode: 1 }),
        pass,
        shellNode('fail-2', { ts: T0 + 2 * HOUR, command: 'TOKEN: [redacted] npm run build', exitCode: 1 }),
        shellNode('retry-2', { ts: T0 + 3 * HOUR, command: 'TOKEN: [redacted] npm run build', exitCode: 0 }),
      ]);

      expect(correlateFailures(store, PROJECT)).toMatchObject({ failuresExamined: 2, linkedByRetry: 0 });
    });

    it('keeps linking legacy rows without hashes when nothing in the command was redacted', () => {
      store.upsertNodes([
        shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1 }),
        shellNode('retry', { ts: T0 + HOUR, command: 'npm test', exitCode: 0, commandHash: 'aaaaaaaaaaaa' }),
      ]);

      expect(correlateFailures(store, PROJECT)).toMatchObject({ linkedByRetry: 1 });
    });
  });

  it('does not link a retry outside the configured retry window', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1 }),
      shellNode('retry', { ts: T0 + 3 * HOUR, command: 'npm test', exitCode: 0 }),
    ]);

    const stats = correlateFailures(store, PROJECT, { retryWindowMs: HOUR }); // discriminating: window shorter than the gap

    expect(stats.linkedByRetry).toBe(0);
    expect(store.getLinkedNodeIds('fail', RESOLVED_BY_RETRY)).toEqual([]);
  });

  it('does not link a successful retry run in a different working directory', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1, cwd: '/repo-a' }),
      shellNode('retry', { ts: T0 + HOUR, command: 'npm test', exitCode: 0, cwd: '/repo-b' }),
    ]);

    correlateFailures(store, PROJECT);

    expect(store.getLinkedNodeIds('fail', RESOLVED_BY_RETRY)).toEqual([]); // discriminating: same command, wrong cwd
  });

  it('does not link a textually different command, even a near-duplicate (exact match only, by design)', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1 }),
      shellNode('retry', { ts: T0 + HOUR, command: 'npm test -- --watch', exitCode: 0 }),
    ]);

    correlateFailures(store, PROJECT);

    expect(store.getLinkedNodeIds('fail', RESOLVED_BY_RETRY)).toEqual([]);
  });

  it('links a failure to a later conversation that discusses it', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm run typecheck', exitCode: 2 }),
      conversationNode('discussion', { ts: T0 + HOUR, body: 'Q: why does npm run typecheck fail\n\nA: a stray import' }),
    ]);

    const stats = correlateFailures(store, PROJECT);

    expect(stats.linkedByDiscussion).toBe(1);
    expect(store.getLinkedNodeIds('fail', RESOLVED_BY_DISCUSSION)).toEqual(['discussion']);
  });

  it('does not link a discussion that shares only one generic token with the command (the real dogfooding false positive)', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm whoami', exitCode: 1 }),
      conversationNode('unrelated', {
        ts: T0 + HOUR,
        body: 'Updated NexusMem versioning strategy using npm commands (npx, npm install -g)',
      }),
    ]);

    const stats = correlateFailures(store, PROJECT);

    expect(stats.linkedByDiscussion).toBe(0); // discriminating: shares "npm" only, nothing else
    expect(store.getLinkedNodeIds('fail', RESOLVED_BY_DISCUSSION)).toEqual([]);
  });

  it('does not link when every token of the failing command is boilerplate across the project\'s own history (re-dogfooding at scale, 2026-08-16)', () => {
    // 9 filler nodes plus the coincidence node below = 10 discussable nodes,
    // meeting the frequency filter's minimum-corpus floor -- both "widget"
    // and "sync" appear in all 10, so both measure 100% document frequency,
    // comfortably over the 20% boilerplate threshold.
    const filler = Array.from({ length: 9 }, (_, i) =>
      conversationNode(`filler-${i}`, { ts: T0 - (i + 1) * HOUR, body: `widget sync deployment notes #${i}` }),
    );
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'widget sync', exitCode: 1 }),
      ...filler,
      conversationNode('coincidence', { ts: T0 + HOUR, body: 'Q: push\n\nA: periodically run widget sync to refresh' }),
    ]);

    const stats = correlateFailures(store, PROJECT);

    // discriminating: "coincidence" textually AND-matches "widget sync" and
    // sits inside the discussion window, so the pre-fix heuristic would have
    // linked it -- both tokens being corpus-wide boilerplate must suppress
    // the match instead.
    expect(stats.linkedByDiscussion).toBe(0);
    expect(store.getLinkedNodeIds('fail', RESOLVED_BY_DISCUSSION)).toEqual([]);
  });

  it('still links via a rare token even when a common token from the same command is filtered as boilerplate', () => {
    // "npm" saturates 9 of the 10 discussable nodes (90%, filtered as
    // boilerplate); "whoami" appears only in the real discussion (10%,
    // kept) -- the remaining single token must still find the right node.
    const filler = Array.from({ length: 9 }, (_, i) =>
      conversationNode(`filler-${i}`, { ts: T0 - (i + 1) * HOUR, body: `npm scripts and tooling notes #${i}` }),
    );
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm whoami', exitCode: 1 }),
      ...filler,
      conversationNode('discussion', { ts: T0 + HOUR, body: 'Q: why did npm whoami fail\n\nA: you were logged out, run npm login' }),
    ]);

    const stats = correlateFailures(store, PROJECT);

    expect(stats.linkedByDiscussion).toBe(1);
    expect(store.getLinkedNodeIds('fail', RESOLVED_BY_DISCUSSION)).toEqual(['discussion']);
  });

  it('does not link a discussion outside the configured discussion window', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm run typecheck', exitCode: 2 }),
      conversationNode('discussion', { ts: T0 + 3 * HOUR, body: 'Q: why does npm run typecheck fail\n\nA: a stray import' }),
    ]);

    correlateFailures(store, PROJECT, { discussionWindowMs: HOUR });

    expect(store.getLinkedNodeIds('fail', RESOLVED_BY_DISCUSSION)).toEqual([]);
  });

  it('a failure can be linked by both heuristics at once, as two separate relations', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1 }),
      shellNode('retry', { ts: T0 + HOUR, command: 'npm test', exitCode: 0 }),
      conversationNode('discussion', { ts: T0 + 2 * HOUR, body: 'Q: npm test is failing\n\nA: found it' }),
    ]);

    correlateFailures(store, PROJECT);

    expect(store.getLinkedNodeIds('fail', RESOLVED_BY_RETRY)).toEqual(['retry']);
    expect(store.getLinkedNodeIds('fail', RESOLVED_BY_DISCUSSION)).toEqual(['discussion']);
  });

  it('a node with a passing exit code is never treated as a failure to correlate', () => {
    store.upsertNodes([
      shellNode('pass', { ts: T0, command: 'npm test', exitCode: 0 }),
      shellNode('retry', { ts: T0 + HOUR, command: 'npm test', exitCode: 0 }),
    ]);

    const stats = correlateFailures(store, PROJECT);

    expect(stats.failuresExamined).toBe(0); // discriminating: exitCode 0 must never be scanned as a failure
  });

  it('is safe to run twice: re-running does not error or duplicate the link', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1 }),
      shellNode('retry', { ts: T0 + HOUR, command: 'npm test', exitCode: 0 }),
    ]);

    correlateFailures(store, PROJECT);
    correlateFailures(store, PROJECT);

    expect(store.getLinkedNodeIds('fail', RESOLVED_BY_RETRY)).toEqual(['retry']);
  });
});

/**
 * `getChainStats` is what `nexusmem status` reads to surface the failure->fix
 * chain feature -- Phase 9's moat-visibility work (ROADMAP.local.md), making
 * an otherwise-invisible internal capability visible to anyone running the
 * CLI, not just someone who already knows to query `node_links` by hand.
 */
describe('getChainStats', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-chainstats-'));
    store = MemoryStore.open(join(dir, 'memory.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports all zeros for a project with no recorded failures', () => {
    expect(getChainStats(store, PROJECT)).toEqual({
      failuresTotal: 0,
      resolvedByRetry: 0,
      resolvedByDiscussion: 0,
      resolvedTotal: 0,
    });
  });

  it('counts a failure as unresolved until correlateFailures actually links it', () => {
    store.upsertNodes([shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1 })]);

    expect(getChainStats(store, PROJECT)).toEqual({
      failuresTotal: 1,
      resolvedByRetry: 0,
      resolvedByDiscussion: 0,
      resolvedTotal: 0,
    });
  });

  it('counts resolvedTotal once per failure even when both heuristics link the same one (not double-counted)', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1 }),
      shellNode('retry', { ts: T0 + HOUR, command: 'npm test', exitCode: 0 }),
      conversationNode('discussion', { ts: T0 + 2 * HOUR, body: 'Q: npm test is failing\n\nA: found it' }),
    ]);

    correlateFailures(store, PROJECT);

    expect(getChainStats(store, PROJECT)).toEqual({
      failuresTotal: 1,
      resolvedByRetry: 1,
      resolvedByDiscussion: 1,
      resolvedTotal: 1, // discriminating: one failure, two links, must not report resolvedTotal: 2
    });
  });

  it('distinguishes failures resolved by retry from those resolved by discussion', () => {
    store.upsertNodes([
      shellNode('fail-a', { ts: T0, command: 'npm test', exitCode: 1 }),
      shellNode('retry-a', { ts: T0 + HOUR, command: 'npm test', exitCode: 0 }),
      shellNode('fail-b', { ts: T0, command: 'npm run typecheck', exitCode: 2, cwd: '/repo-b' }),
      conversationNode('discussion-b', { ts: T0 + HOUR, body: 'Q: why does npm run typecheck fail\n\nA: a stray import' }),
      shellNode('fail-c', { ts: T0, command: 'npm run build', exitCode: 1, cwd: '/repo-c' }), // discriminating: left unresolved
    ]);

    correlateFailures(store, PROJECT);

    expect(getChainStats(store, PROJECT)).toEqual({
      failuresTotal: 3,
      resolvedByRetry: 1,
      resolvedByDiscussion: 1,
      resolvedTotal: 2,
    });
  });

  it('scopes counts to the given project, not the whole database', () => {
    store.upsertNodes([
      shellNode('fail', { ts: T0, command: 'npm test', exitCode: 1 }),
      shellNode('retry', { ts: T0 + HOUR, command: 'npm test', exitCode: 0 }),
    ]);
    correlateFailures(store, PROJECT);

    expect(getChainStats(store, 'proj-other')).toEqual({
      failuresTotal: 0,
      resolvedByRetry: 0,
      resolvedByDiscussion: 0,
      resolvedTotal: 0,
    });
  });
});
