import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentEvent, redactAgentEvent } from '../src/agent/event.js';
import { MAX_DIGEST_CHARS, recallSessionStart } from '../src/agent/recall.js';
import { runAgentRecall } from '../src/cli/commands/agent.js';
import { runInit } from '../src/cli/commands/init.js';
import { runQuery } from '../src/cli/commands/query.js';
import { runSync } from '../src/cli/commands/sync.js';
import { collectAgentEvents } from '../src/collectors/agent-events.js';
import { readConfig, resolveWorkspace, writeConfig } from '../src/config/workspace.js';
import { buildScenarioRepo } from '../eval/ambient/scenario.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

/**
 * The weaknesses a real tester reported, pinned where the behaviour is
 * deterministic: injection has to stay silent when the evidence is weak, a
 * digest has to stay small, and a decision that was made and then reversed has
 * to keep both halves of the story.
 *
 * One of these tests documents a limitation rather than a feature -- see
 * "an agent that hides the exit code" below.
 */

const PROJECT = 'proj-quality';
const ROOT = process.platform === 'win32' ? 'D:/repo' : '/repo';
const at = (minutes: number) => new Date(Date.parse('2026-09-12T09:00:00.000Z') + minutes * 60_000).toISOString();

let dir: string;

const agentEvent = (over: Partial<AgentEvent>, seq = Math.random()): AgentEvent =>
  redactAgentEvent({
    agent: 'claude-code',
    sessionId: 'sess-1',
    eventId: `e-${seq}`,
    ts: at(0),
    cwd: ROOT,
    kind: 'command',
    command: 'npm test',
    outcome: 'fail',
    exitCode: 1,
    durationMs: 10,
    ...over,
  } as AgentEvent);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-quality-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('ambient injection stays silent when the evidence is weak', () => {
  let store: MemoryStore;
  let repo: string;
  let session = 0;

  const recallFor = async (command: string): Promise<string> => {
    const out: string[] = [];
    await runAgentRecall({
      input: JSON.stringify({
        session_id: `quality-control-${(session += 1)}`,
        cwd: repo,
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command },
        tool_use_id: `tc${session}`,
        error: 'Exit code 1\nsomething',
      }),
      out: (c) => out.push(c),
    });
    return out.join('');
  };

  // Recall resolves the repository and its workspace database from the payload's cwd, so the
  // history has to live where production looks for it -- a bare temp dir makes every assertion
  // that recall stays silent pass without recall ever running.
  beforeEach(async () => {
    repo = realpathSync.native(dir);
    const g = (...args: string[]) => gitFixture(repo, args, { env: process.env });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    g('add', '.');
    g('-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'init');
    await runInit({ cwd: repo, force: false, hook: false, enableConversation: false, out: () => {} });
    const ws = resolveWorkspace(repo);
    const { projectId } = await readConfig(ws);
    store = MemoryStore.open(ws.dbPath);
    store.upsertNodes(
      collectAgentEvents(
        [
          agentEvent({ kind: 'edit', filePath: `${repo}/src/a.ts`, outcome: 'ok', exitCode: null, cwd: repo, ts: at(0) }, 1),
          agentEvent({ command: 'npm test', cwd: repo, ts: at(1) }, 2),
        ],
        projectId,
        { repoRoot: repo },
      ),
    );
  });

  afterEach(() => store.close());

  it('control: the exact failing command does inject, so the silences below are real', async () => {
    expect(await recallFor('npm test')).toContain('NexusMem:');
  });

  it('does not match a command that merely shares words with a failing one', async () => {
    // Same tool, same words, different run: matching is on the raw command hash,
    // so "npm test" history cannot leak into "npm test -- --watch".
    expect(await recallFor('npm test -- --watch')).toBe('');
  });

  it('KNOWN LIMITATION: a pipe/redirect that swallows the real exit code still gets no recall', async () => {
    // `node check.js 2>&1 | head` exits 0 -- it's `head`'s own exit code, not
    // the command's -- so Claude Code reports success and PostToolUseFailure
    // never fires. Unlike the `cmd; echo "EXIT:$?"` form (see the sibling test
    // below, addressed in the Phase-5.1 exit-status recovery), stdout here
    // carries no recognisable status at all: there is nothing left to recover
    // it from. Pinned so a future change to this remaining gap is deliberate.
    const out: string[] = [];
    await runAgentRecall({
      input: JSON.stringify({
        session_id: 'q2',
        cwd: repo,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { stdout: 'AssertionError: expected 1 to be 2', stderr: '', interrupted: false },
        tool_use_id: 't2',
      }),
      out: (c) => out.push(c),
    });

    expect(out.join('')).toBe('');
  });

  it('keeps the session digest small and deduplicated under a noisy history', () => {
    const noisy = Array.from({ length: 20 }, (_, i) =>
      agentEvent({ command: `npm run task-${i} -- --with-a-fairly-long-argument-list`, ts: at(i) }, 100 + i),
    );
    // Ten failures of one command are one problem, not ten.
    const repeats = Array.from({ length: 10 }, (_, i) => agentEvent({ command: 'npm test', ts: at(50 + i) }, 200 + i));
    store.upsertNodes(collectAgentEvents([...noisy, ...repeats], PROJECT, { repoRoot: ROOT }));

    const digest = recallSessionStart(store, PROJECT, new Date(Date.parse('2026-09-12T12:00:00.000Z')))!;

    expect(digest.text.length).toBeLessThanOrEqual(MAX_DIGEST_CHARS);
    expect(digest.text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3);
    expect(digest.text).toContain('other(s)');
    expect(digest.text.match(/npm test/g) ?? []).toHaveLength(1);
  });
});

describe('a decision that was reversed keeps both halves of its story', () => {
  it('returns the attempt and its revert together, not just the surviving state', async () => {
    // The fixture's history contains "raise the retry budget" and the revert
    // that says it did not work -- the shape the tester said gets lost.
    const repo = join(dir, 'repo');
    buildScenarioRepo(repo);
    await runInit({ cwd: repo, force: false, hook: false, enableConversation: false, out: () => {} });
    const ws = resolveWorkspace(repo);
    const config = await readConfig(ws);
    await writeConfig(ws, { ...config, sources: { ...config.sources, shell: { ...config.sources.shell, enabled: false } } });
    await runSync({ cwd: repo, full: false, rebuild: false, quiet: true, noEmbed: true });

    let printed = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      printed += String(chunk);
      return true;
    });
    const code = await runQuery({ cwd: repo, query: 'retry budget failing check', budget: 3000, candidates: 30, noVector: true, json: false });
    vi.restoreAllMocks();

    expect(code).toBe(0);
    expect(printed).toContain('raise the retry budget');
    expect(printed).toContain('revert');
  });
});
