import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentEvent, redactAgentEvent } from '../src/agent/event.js';
import { MAX_DIGEST_CHARS, MAX_RECALL_CHARS, recallFailure, recallSessionStart } from '../src/agent/recall.js';
import { markInjected, MAX_INJECTIONS_PER_SESSION, shouldInject } from '../src/agent/recall-state.js';
import { collectAgentEvents } from '../src/collectors/agent-events.js';
import { correlateFailures, RESOLVED_BY_DISCUSSION } from '../src/correlate/failure-fix.js';
import { sha256Hex } from '../src/core/ids.js';
import type { MemoryNode } from '../src/core/types.js';
import { MemoryStore } from '../src/store/store.js';

const PROJECT = 'proj-recall';
const ROOT = process.platform === 'win32' ? 'D:/repo' : '/repo';
const HASH = (command: string) => sha256Hex(command).slice(0, 12);

let dir: string;
let store: MemoryStore;
let seq = 0;

const at = (minutes: number) => new Date(Date.parse('2026-09-04T09:00:00.000Z') + minutes * 60_000).toISOString();

const event = (over: Partial<AgentEvent>): AgentEvent =>
  redactAgentEvent({
    agent: 'claude-code',
    sessionId: 'sess-1',
    eventId: `e-${(seq += 1)}`,
    ts: at(0),
    cwd: ROOT,
    kind: 'command',
    outcome: 'fail',
    exitCode: 1,
    durationMs: 10,
    ...over,
  } as AgentEvent);

/** Seeds the Day 1 story: edit, fail, edit, fail, edit, pass -- through the real collector. */
function seedDayOne(command = 'npm test'): void {
  const events = [
    event({ kind: 'edit', filePath: `${ROOT}/src/a.ts`, outcome: 'ok', exitCode: null, ts: at(0) }),
    event({ command, ts: at(1) }),
    event({ kind: 'edit', filePath: `${ROOT}/src/b.ts`, outcome: 'ok', exitCode: null, ts: at(10) }),
    event({ command, ts: at(11) }),
    event({ kind: 'edit', filePath: `${ROOT}/src/c.ts`, outcome: 'ok', exitCode: null, ts: at(20) }),
    event({ command, outcome: 'ok', exitCode: 0, ts: at(21) }),
  ];
  store.upsertNodes(collectAgentEvents(events, PROJECT, { repoRoot: ROOT }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-recall-'));
  store = MemoryStore.open(join(dir, 'memory.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('recallFailure', () => {
  it('says nothing when this command has never failed here', () => {
    seedDayOne();
    expect(recallFailure(store, PROJECT, HASH('cargo build'))).toBeNull();
  });

  it('says nothing when the command only ever succeeded', () => {
    store.upsertNodes(
      collectAgentEvents([event({ command: 'npm run build', outcome: 'ok', exitCode: 0 })], PROJECT, { repoRoot: ROOT }),
    );
    expect(recallFailure(store, PROJECT, HASH('npm run build'))).toBeNull();
  });

  it('says nothing for another project history', () => {
    seedDayOne();
    expect(recallFailure(store, 'someone-else', HASH('npm test'))).toBeNull();
  });

  it('reports past failures with the files that were edited before each', () => {
    seedDayOne();
    const recall = recallFailure(store, PROJECT, HASH('npm test'))!;

    expect(recall.matched).toBe(2);
    expect(recall.text).toContain('failed in this repository before (2 time(s))');
    expect(recall.text).toContain('src/a.ts');
    expect(recall.text).toContain('src/b.ts');
  });

  it('names the fix once correlation has linked one', () => {
    seedDayOne();
    correlateFailures(store, PROJECT);

    const recall = recallFailure(store, PROJECT, HASH('npm test'))!;
    expect(recall.resolved).toBe(true);
    expect(recall.text).toContain('fixed on 2026-09-04 after editing src/c.ts');
    expect(recall.text).toContain('Check what changed in that fix');
  });

  it('is explicit when nothing ever fixed it, which is itself the useful signal', () => {
    store.upsertNodes(collectAgentEvents([event({ command: 'npm test' })], PROJECT, { repoRoot: ROOT }));

    const recall = recallFailure(store, PROJECT, HASH('npm test'))!;
    expect(recall.resolved).toBe(false);
    expect(recall.text).toContain('no fix for it was ever recorded here');
  });

  it('stays inside its character budget even with a long history', () => {
    const events = Array.from({ length: 30 }, (_, i) =>
      event({ command: `npm test -- ${'x'.repeat(300)}`, ts: at(i) }),
    );
    store.upsertNodes(collectAgentEvents(events, PROJECT, { repoRoot: ROOT }));

    const recall = recallFailure(store, PROJECT, HASH(`npm test -- ${'x'.repeat(300)}`))!;
    expect(recall.text.length).toBeLessThanOrEqual(MAX_RECALL_CHARS);
  });

  it('matches on the raw command hash, so two different secrets never look like the same command', () => {
    const a = 'psql postgres://app:secret-one@db/app';
    const b = 'psql postgres://app:secret-two@db/app';
    store.upsertNodes(collectAgentEvents([event({ command: a })], PROJECT, { repoRoot: ROOT }));

    // Both redact to identical text; only the hash keeps them apart.
    expect(recallFailure(store, PROJECT, HASH(a))).not.toBeNull();
    expect(recallFailure(store, PROJECT, HASH(b))).toBeNull();
  });

  it('backward compatibility: a node written before execHash existed is simply never found by it', () => {
    // Simulates a row from before this field existed: meta has commandHash
    // but no execHash. json_extract on a missing path is SQL NULL, so this
    // must fail closed -- no match, no crash -- rather than throw or match
    // on some coerced value of "missing".
    const [node] = collectAgentEvents([event({ command: 'npm test' })], PROJECT, { repoRoot: ROOT });
    store.upsertNodes([node!]); // upsertNodes always writes execHash today
    store.raw.prepare(`UPDATE nodes SET meta = json_remove(meta, '$.execHash') WHERE id = ?`).run(node!.id);

    expect(() => recallFailure(store, PROJECT, HASH('npm test'))).not.toThrow();
    expect(recallFailure(store, PROJECT, HASH('npm test'))).toBeNull();
  });
});

describe('recallSessionStart', () => {
  const NOW = new Date(Date.parse('2026-09-04T12:00:00.000Z'));

  it('says nothing for a repository with no failures', () => {
    store.upsertNodes(
      collectAgentEvents([event({ command: 'npm test', outcome: 'ok', exitCode: 0 })], PROJECT, { repoRoot: ROOT }),
    );
    expect(recallSessionStart(store, PROJECT, NOW)).toBeNull();
  });

  it('shows the resolved chain once every failure has a recorded fix, instead of staying silent', () => {
    // This is the exact case the digest used to hide: `git log`-worthy
    // history that answers the question outright. Silence here was the
    // backwards behaviour the Phase-5 eval flagged -- the tester's own
    // "failure -> fix" case was excluded by definition because it *was*
    // fixed. This replaces the old "says nothing" expectation.
    seedDayOne();
    correlateFailures(store, PROJECT);

    const digest = recallSessionStart(store, PROJECT, NOW);
    expect(digest).not.toBeNull();
    expect(digest!.resolved).toBe(1);
    expect(digest!.text).toContain('npm test');
    expect(digest!.text).toContain('fixed');
  });

  it('ranks a resolved chain ahead of an unrelated unresolved failure, even when the slots are scarce', () => {
    seedDayOne(); // 'npm test': fails, fails, then a fix -- resolved once correlated.
    correlateFailures(store, PROJECT);
    // Four more distinct, unresolved commands -- more than MAX_DIGEST_COMMANDS
    // on their own, so the resolved chain survives only by being preferred.
    store.upsertNodes(
      collectAgentEvents(
        ['cargo build', 'go test', 'make lint', 'pytest'].map((command, i) => event({ command, ts: at(30 + i) })),
        PROJECT,
        { repoRoot: ROOT },
      ),
    );

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.resolved).toBe(1);
    expect(digest.unresolved).toBe(4);
    const lines = digest.text.split('\n').filter((l) => l.startsWith('- '));
    expect(lines[0]).toContain('npm test');
    expect(lines[0]).toContain('fixed');
    expect(digest.text).toContain('other(s)');
  });

  it('marks a fix as stale, rather than repeating it, once the same command has failed again since', () => {
    // The eval's own adversarial scenario: a fix that held once is not
    // evidence it still applies. Saying "fixed" unqualified here would be
    // exactly the confident-false-relationship CLAUDE.md's Evidence section
    // warns against.
    const command = 'npm test';
    store.upsertNodes(collectAgentEvents([event({ command, ts: at(0) })], PROJECT, { repoRoot: ROOT }));
    // An edit before the retry: the retry heuristic only links a pass to an
    // agent-recorded failure when something was actually changed in between
    // (see failure-fix.ts) -- an identical pass with no edit is a flake, not a fix.
    store.upsertNodes(
      collectAgentEvents(
        [event({ kind: 'edit', filePath: `${ROOT}/src/a.ts`, outcome: 'ok', exitCode: null, ts: at(1) }), event({ command, outcome: 'ok', exitCode: 0, ts: at(2) })],
        PROJECT,
        { repoRoot: ROOT },
      ),
    );
    correlateFailures(store, PROJECT); // links the day-1 failure to the day-1 fix
    // The exact same command fails again, later, with nothing recorded as fixing it this time.
    store.upsertNodes(collectAgentEvents([event({ command, ts: at(10) })], PROJECT, { repoRoot: ROOT }));

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.stale).toBe(1);
    expect(digest.resolved).toBe(0);
    expect(digest.text).toContain('npm test');
    expect(digest.text).toContain('no longer holds');
  });

  it('does not let a generic command repeated many times crowd out a resolved chain for something else', () => {
    seedDayOne(); // 'npm test' -- resolved
    correlateFailures(store, PROJECT);
    // Five failures of a different command -- collapses to one line (existing
    // dedup) and must not outrank the resolved chain by sheer repetition.
    store.upsertNodes(
      collectAgentEvents(
        Array.from({ length: 5 }, (_, i) => event({ command: 'npm run build', ts: at(40 + i) })),
        PROJECT,
        { repoRoot: ROOT },
      ),
    );

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.text.match(/npm run build/g)).toHaveLength(1);
    const lines = digest.text.split('\n').filter((l) => l.startsWith('- '));
    expect(lines[0]).toContain('npm test');
    expect(lines[0]).toContain('fixed');
  });

  it('a resolved chain outside the window stays silent, same as an unresolved one would', () => {
    seedDayOne();
    correlateFailures(store, PROJECT);
    const farFuture = new Date(NOW.getTime() + 40 * 86_400_000);
    expect(recallSessionStart(store, PROJECT, farFuture)).toBeNull();
  });

  it('an uncertain relationship (discussion-linked, not retry-linked) is named but never described as fixed', () => {
    // The discussion heuristic measures roughly half wrong when dogfooded
    // (see correlate/failure-fix.ts) -- linked deterministically here rather
    // than through that heuristic, so the test is about the digest's own
    // wording, not about whether the heuristic itself fires.
    const [failNode] = collectAgentEvents([event({ command: 'npm test', ts: at(0) })], PROJECT, { repoRoot: ROOT });
    const [otherNode] = collectAgentEvents([event({ command: 'git log', outcome: 'ok', exitCode: 0, ts: at(5) })], PROJECT, {
      repoRoot: ROOT,
    });
    store.upsertNodes([failNode!, otherNode!]);
    store.linkNodes(failNode!.id, otherNode!.id, RESOLVED_BY_DISCUSSION);

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.uncertain).toBe(1);
    expect(digest.resolved).toBe(0);
    expect(digest.text).toContain('npm test');
    expect(digest.text).toContain('not confirmed');
    // The word this state must never earn on its own.
    expect(digest.text).not.toMatch(/\bfixed\b/);
  });

  it('never lists the same command twice, even across two separate fail/fix cycles in the window', () => {
    const command = 'npm test';
    store.upsertNodes(collectAgentEvents([event({ command, ts: at(0) })], PROJECT, { repoRoot: ROOT }));
    store.upsertNodes(
      collectAgentEvents(
        [
          event({ kind: 'edit', filePath: `${ROOT}/src/a.ts`, outcome: 'ok', exitCode: null, ts: at(1) }),
          event({ command, outcome: 'ok', exitCode: 0, ts: at(2) }),
        ],
        PROJECT,
        { repoRoot: ROOT },
      ),
    );
    correlateFailures(store, PROJECT);
    // A second, later fail/fix cycle of the exact same command, still inside the window.
    store.upsertNodes(collectAgentEvents([event({ command, ts: at(10) })], PROJECT, { repoRoot: ROOT }));
    store.upsertNodes(
      collectAgentEvents(
        [
          event({ kind: 'edit', filePath: `${ROOT}/src/d.ts`, outcome: 'ok', exitCode: null, ts: at(11) }),
          event({ command, outcome: 'ok', exitCode: 0, ts: at(12) }),
        ],
        PROJECT,
        { repoRoot: ROOT },
      ),
    );
    correlateFailures(store, PROJECT);

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.resolved).toBe(1);
    expect(digest.text.match(/npm test/g)).toHaveLength(1);
  });

  it('lists commands that failed with no fix, one line each', () => {
    store.upsertNodes(
      collectAgentEvents(
        [event({ command: 'npm test' }), event({ command: 'npm test' }), event({ command: 'cargo build' })],
        PROJECT,
        { repoRoot: ROOT },
      ),
    );

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.unresolved).toBe(2);
    // Ten failures of one command are one problem, not ten.
    expect(digest.text.match(/npm test/g)).toHaveLength(1);
    expect(digest.text).toContain('cargo build');
    expect(digest.text.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
  });

  it('ignores failures older than the window', () => {
    const old = new Date(Date.parse('2026-09-04T09:01:00.000Z') + 40 * 86_400_000);
    store.upsertNodes(collectAgentEvents([event({ command: 'npm test' })], PROJECT, { repoRoot: ROOT }));
    expect(recallSessionStart(store, PROJECT, old)).toBeNull();
  });
});

/**
 * A digest entry is one execution, not one display string. Agent rows carry
 * execHash (the raw command reduced to its one real execution), so a live
 * `cd "<cwd>" && npm test; echo "exit: $?"` and a bare `npm test` are the same
 * entry, while two commands that only redact to the same text are not.
 */
describe('recallSessionStart: execution identity', () => {
  const NOW = new Date(Date.parse('2026-09-04T12:00:00.000Z'));
  const WRAPPED = `cd "${ROOT}" && npm test; echo "exit: $?"`;
  const seedAgent = (events: AgentEvent[], project = PROJECT) =>
    store.upsertNodes(collectAgentEvents(events, project, { repoRoot: ROOT }));
  const edit = (minutes: number) => event({ kind: 'edit', filePath: `${ROOT}/src/a.ts`, outcome: 'ok', exitCode: null, ts: at(minutes) });
  const entries = (text: string) => text.split('\n').filter((l) => l.startsWith('- '));

  function legacyNode(id: string, command: string, minutes: number, meta: Record<string, unknown> = {}): MemoryNode {
    return {
      id,
      kind: 'shell_command',
      projectId: PROJECT,
      ts: at(minutes),
      sourceTs: at(minutes),
      source: 'shell:pwsh-hook',
      title: `$ ${command}`,
      body: `$ ${command}`,
      files: [],
      signal: 0.3,
      provenance: 'observed',
      meta: { command, cwd: ROOT, exitCode: 1, durationMs: 5, tsApprox: false, ...meta },
    };
  }

  it('shows one entry for the same execution, whether it ran bare, cd-wrapped or behind an exit echo', () => {
    seedAgent([
      event({ command: 'npm test', ts: at(0) }),
      event({ command: `cd "${ROOT}" && npm test`, ts: at(1) }),
      event({ command: WRAPPED, ts: at(2) }),
    ]);

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.unresolved).toBe(1);
    expect(entries(digest.text)).toHaveLength(1);
    expect(digest.text).toContain('npm test');
  });

  it('calls a wrapped fix stale once the bare command fails again, instead of one resolved and one unresolved entry', () => {
    seedAgent([event({ command: WRAPPED, ts: at(0) }), edit(1), event({ command: WRAPPED, outcome: 'ok', exitCode: 0, ts: at(2) })]);
    correlateFailures(store, PROJECT);
    seedAgent([event({ command: 'npm test', ts: at(30) })]);

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest).toMatchObject({ stale: 1, resolved: 0, unresolved: 0 });
    expect(entries(digest.text)).toHaveLength(1);
    expect(digest.text).toContain('no longer holds');
  });

  it('keeps two commands apart when they differ only in a credential that redacts to the same text', () => {
    seedAgent([
      event({ command: 'TOKEN=synthetic-aaaa1111 npm run deploy', ts: at(0) }),
      edit(1),
      event({ command: 'TOKEN=synthetic-aaaa1111 npm run deploy', outcome: 'ok', exitCode: 0, ts: at(2) }),
    ]);
    correlateFailures(store, PROJECT);
    seedAgent([event({ command: 'TOKEN=synthetic-bbbb2222 npm run deploy', ts: at(30) })]);

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    // Not "fixed, but failed again": the later failure is a different execution.
    expect(digest).toMatchObject({ resolved: 1, unresolved: 1, stale: 0 });
    expect(digest.text).not.toContain('synthetic-');
  });

  it('does not spend a digest slot on each spelling of one execution', () => {
    seedAgent([
      event({ command: 'npm test', ts: at(0) }),
      event({ command: `cd "${ROOT}" && npm test`, ts: at(1) }),
      event({ command: WRAPPED, ts: at(2) }),
      ...['cargo build', 'go test', 'make lint'].map((command, i) => event({ command, ts: at(10 + i) })),
    ]);

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.unresolved).toBe(4);
    expect(entries(digest.text)).toHaveLength(3);
    expect(digest.text).toContain('and 1 other(s)');
    expect(digest.text.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
  });

  it('keeps another project history out, even for the same execution', () => {
    seedAgent([event({ command: WRAPPED, ts: at(0) })], 'someone-else');
    seedAgent([event({ command: 'npm test', ts: at(1) })]);

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.unresolved).toBe(1);
    expect(recallSessionStart(store, 'someone-else', NOW)!.unresolved).toBe(1);
  });

  it('still merges a human shell run of the same plain command, which carries only its raw-command hash', () => {
    seedAgent([event({ command: WRAPPED, ts: at(0) })]);
    store.upsertNodes([legacyNode('human-npm-test', 'npm test', 5, { commandHash: HASH('npm test') })]);

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.unresolved).toBe(1);
  });

  it('never merges redacted legacy rows that have no hash to tell them apart', () => {
    store.upsertNodes([
      legacyNode('legacy-a', 'TOKEN: [redacted] npm run deploy', 0),
      legacyNode('legacy-b', 'TOKEN: [redacted] npm run deploy', 1),
    ]);

    expect(recallSessionStart(store, PROJECT, NOW)!.unresolved).toBe(2);
  });

  it('still groups plain legacy rows with no hashes by their command, as before', () => {
    store.upsertNodes([legacyNode('legacy-1', 'npm test', 0), legacyNode('legacy-2', 'npm test', 1)]);

    expect(recallSessionStart(store, PROJECT, NOW)!.unresolved).toBe(1);
  });

  it('keeps a discussion-linked newest run uncertain, never fixed, across spellings', () => {
    seedAgent([event({ command: WRAPPED, ts: at(0) })]);
    const [bare] = collectAgentEvents([event({ command: 'npm test', ts: at(10) })], PROJECT, { repoRoot: ROOT });
    const [other] = collectAgentEvents([event({ command: 'git log', outcome: 'ok', exitCode: 0, ts: at(12) })], PROJECT, { repoRoot: ROOT });
    store.upsertNodes([bare!, other!]);
    store.linkNodes(bare!.id, other!.id, RESOLVED_BY_DISCUSSION);

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest).toMatchObject({ uncertain: 1, resolved: 0, unresolved: 0 });
    expect(entries(digest.text)).toHaveLength(1);
    expect(digest.text).not.toMatch(/\bfixed\b/);
  });
});

describe('recall quota', () => {
  let statePath: string;

  beforeEach(() => {
    statePath = join(dir, 'recall-state.json');
  });

  it('explains one failure once per session', () => {
    expect(shouldInject('s1', 'hash-a', statePath)).toBe(true);
    markInjected('s1', 'hash-a', statePath);

    expect(shouldInject('s1', 'hash-a', statePath)).toBe(false);
    expect(shouldInject('s1', 'hash-b', statePath)).toBe(true);
    expect(shouldInject('s2', 'hash-a', statePath)).toBe(true);
  });

  it('stops after the per-session ceiling', () => {
    for (let i = 0; i < MAX_INJECTIONS_PER_SESSION; i += 1) markInjected('s1', `hash-${i}`, statePath);
    expect(shouldInject('s1', 'hash-new', statePath)).toBe(false);
  });

  it('treats a missing or corrupt state file as an empty one', () => {
    expect(shouldInject('s1', 'hash-a', join(dir, 'nope.json'))).toBe(true);
  });
});

/**
 * The Phase-5 eval's `stale-fix` scenario measured this exactly: every
 * ambient trial was told `node check.js` was "fixed on <date>" while the
 * repository's own history had already reverted that fix. The evidence to
 * know better was there -- a `revert:` commit touching the file the fix
 * edited -- and nothing looked at it.
 *
 * The rule is deliberately narrow. A revert must SAY it is a revert and
 * TOUCH a file the fix edited. Anything weaker (a later commit that happens
 * to touch the file, a refactor that silently undoes the change) leaves the
 * chain resolved, because staleness that cannot be proven is not invented.
 */
describe('a fix that git later reverted', () => {
  const NOW = new Date(Date.parse('2026-09-04T12:00:00.000Z'));

  const commit = (id: string, title: string, minutes: number, files: string[]): MemoryNode => ({
    id,
    kind: 'git_commit',
    projectId: PROJECT,
    ts: at(minutes),
    source: 'git',
    title,
    body: title,
    files: files.map((path) => ({ path, insertions: null, deletions: null, binary: false })),
    signal: 0.5,
    meta: {},
  });

  /** seedDayOne's fix passes at at(21) after editing src/c.ts. */
  const revertOfTheFix = () => commit('c-rv', 'revert: c.ts broke the other suite', 60, ['src/c.ts']);

  it('digest: still says "fixed" when nothing reverted it', () => {
    seedDayOne();
    correlateFailures(store, PROJECT);

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.resolved).toBe(1);
    expect(digest.superseded).toBe(0);
    expect(digest.text).not.toContain('no longer holds');
  });

  it('digest: says the fix was reverted instead of claiming it holds', () => {
    seedDayOne();
    correlateFailures(store, PROJECT);
    store.upsertNodes([revertOfTheFix()]);

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.superseded).toBe(1);
    expect(digest.resolved).toBe(0);
    expect(digest.text).toContain('no longer holds');
    expect(digest.text).toContain('reverted');
  });

  it('recall: reports the fix as history and warns it was backed out', () => {
    seedDayOne();
    correlateFailures(store, PROJECT);
    store.upsertNodes([revertOfTheFix()]);

    const recall = recallFailure(store, PROJECT, HASH('npm test'))!;
    expect(recall.superseded).toBe(true);
    expect(recall.resolved).toBe(false);
    // What was tried is still named -- dropping it would lose the most
    // actionable fact -- but it is no longer offered as today's answer.
    expect(recall.text).toContain('src/c.ts');
    expect(recall.text).toContain('reverted on');
    expect(recall.text).toContain('unlikely to work');
    expect(recall.text).not.toContain('Check what changed in that fix before retrying');
  });

  it('a revert touching an unrelated file leaves the chain resolved', () => {
    seedDayOne();
    correlateFailures(store, PROJECT);
    store.upsertNodes([commit('o-rv', 'revert: unrelated change', 60, ['src/elsewhere.ts'])]);

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.resolved).toBe(1);
    expect(digest.superseded).toBe(0);
    expect(recallFailure(store, PROJECT, HASH('npm test'))!.superseded).toBe(false);
  });

  it('a revert that predates the fix is not evidence against it', () => {
    seedDayOne();
    correlateFailures(store, PROJECT);
    // Same file, same wording -- only the order differs, and order is the
    // whole claim: a revert before the fix was reverted something else.
    store.upsertNodes([commit('early-rv', 'revert: an earlier attempt at c.ts', 5, ['src/c.ts'])]);

    expect(recallSessionStart(store, PROJECT, NOW)!.resolved).toBe(1);
    expect(recallFailure(store, PROJECT, HASH('npm test'))!.superseded).toBe(false);
  });

  it('a commit that merely mentions reverting is not a revert', () => {
    seedDayOne();
    correlateFailures(store, PROJECT);
    store.upsertNodes([commit('n-rv', 'reverting is not what this does, it extends c.ts', 60, ['src/c.ts'])]);

    expect(recallSessionStart(store, PROJECT, NOW)!.resolved).toBe(1);
  });

  it('accepts git\'s own generated revert subject', () => {
    seedDayOne();
    correlateFailures(store, PROJECT);
    store.upsertNodes([commit('g-rv', 'Revert "fix: rework c.ts"', 60, ['src/c.ts'])]);

    expect(recallSessionStart(store, PROJECT, NOW)!.superseded).toBe(1);
  });

  it('uncertain evidence stays uncertain: a discussion link never becomes fixed or reverted', () => {
    const command = 'npm test';
    store.upsertNodes(collectAgentEvents([event({ command, ts: at(0) })], PROJECT, { repoRoot: ROOT }));
    const [failure] = store.raw.prepare(`SELECT id FROM nodes WHERE project_id = ? AND kind = 'shell_command'`).all(PROJECT) as Array<{ id: string }>;
    store.upsertNodes([
      {
        id: 'turn-1',
        kind: 'conversation_turn',
        projectId: PROJECT,
        ts: at(5),
        source: 'conversation:claude-code',
        title: 'about npm test',
        body: 'we talked about npm test',
        files: [],
        signal: 0.5,
        meta: {},
      },
    ]);
    store.linkNodes(failure!.id, 'turn-1', RESOLVED_BY_DISCUSSION);
    store.upsertNodes([commit('u-rv', 'revert: something', 60, ['src/a.ts'])]);

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.uncertain).toBe(1);
    expect(digest.superseded).toBe(0);
    expect(digest.resolved).toBe(0);
    expect(digest.text).not.toContain('fixed');
  });

  it('stays inside the digest budget with a superseded chain', () => {
    seedDayOne();
    correlateFailures(store, PROJECT);
    store.upsertNodes([revertOfTheFix()]);
    store.upsertNodes(
      collectAgentEvents(
        ['cargo build', 'go test', 'make lint'].map((command, i) => event({ command, ts: at(30 + i) })),
        PROJECT,
        { repoRoot: ROOT },
      ),
    );

    const digest = recallSessionStart(store, PROJECT, NOW)!;
    expect(digest.text.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
    expect(recallFailure(store, PROJECT, HASH('npm test'))!.text.length).toBeLessThanOrEqual(MAX_RECALL_CHARS);
  });
});
