import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentEventLogPath } from '../src/agent/paths.js';
import { MAX_RECALL_CHARS } from '../src/agent/recall.js';
import { runAgentRecall, runAgentSessionStart } from '../src/cli/commands/agent.js';
import { runInit } from '../src/cli/commands/init.js';
import { runSync } from '../src/cli/commands/sync.js';
import { readConfig, resolveWorkspace, writeConfig } from '../src/config/workspace.js';
import { gitFixture } from './helpers.js';

/**
 * Ambient memory, end to end, through the artifacts that actually ship.
 *
 * Day 1 events go through the built `dist/cli/agent-hook.js` process and its
 * real default log path -- not a function call -- then through sync,
 * collection and correlation. Day 7 asks for recall the way the failure hook
 * does. What this proves is that the seams line up; what it cannot prove is
 * that Claude Code emits these payloads, which is what the live probe
 * fixtures in tests/agent-payload.test.ts are for.
 */

const HOOK = resolve('dist/cli/agent-hook.js'); // built by tests/global-setup.ts
const SECRET = 'e2e-s3cret-VALUE';
const FAILING = 'npm test';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com' };

let repo: string;

function runHook(payload: object): Promise<number | null> {
  const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'] });
  let noise = '';
  child.stdout.on('data', (c) => (noise += c));
  child.stderr.on('data', (c) => (noise += c));
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(payload));
  return new Promise((done) =>
    child.on('close', (code) => {
      // The capture hook must stay invisible to the agent: nothing on either stream, ever.
      expect(noise).toBe('');
      done(code);
    }),
  );
}

const edit = (file: string) => ({
  session_id: 'day-1',
  cwd: repo,
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: join(repo, file), old_string: `secret was ${SECRET}`, new_string: 'redacted' },
  tool_use_id: `edit-${file}`,
  duration_ms: 4,
});

const failed = (command: string, id: string) => ({
  session_id: 'day-1',
  cwd: repo,
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: { command, description: 'run the tests' },
  tool_use_id: id,
  error: 'Exit code 1\nAssertionError: expected 1 to be 2',
  is_interrupt: false,
  duration_ms: 1200,
});

const passed = (command: string, id: string) => ({
  session_id: 'day-1',
  cwd: repo,
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command, description: 'run the tests' },
  tool_response: { stdout: 'ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  tool_use_id: id,
  duration_ms: 900,
});

/** Every file under `dir` whose bytes contain the secret. */
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

const failurePayload = (command: string, session: string) => ({
  session_id: session,
  cwd: repo,
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: { command },
  tool_use_id: `day7-${session}`,
  error: 'Exit code 1\nAssertionError: expected 1 to be 2',
  duration_ms: 1100,
});

beforeEach(async () => {
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexusmem-e2e-')));
  const g = (...args: string[]) => gitFixture(repo, args, { env: GIT_ENV });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  g('add', '.');
  g('commit', '-q', '-m', 'chore: initial commit');

  await runInit({ cwd: repo, force: false, hook: false, enableConversation: false, out: () => {} });
  // Without this a real sync would scrape this machine's own shell history.
  const ws = resolveWorkspace(repo);
  const config = await readConfig(ws);
  await writeConfig(ws, { ...config, sources: { ...config.sources, shell: { ...config.sources.shell, enabled: false } } });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('ambient memory, day 1 to day 7', () => {
  it('captures attempts through the built hook, then answers a repeat failure without being asked', async () => {
    // DAY 1: approach A fails, approach B fails, approach C works.
    for (const payload of [
      edit('a.ts'),
      failed(FAILING, 'run-1'),
      edit('b.ts'),
      failed(FAILING, 'run-2'),
      edit('c.ts'),
      passed(FAILING, 'run-3'),
    ]) {
      expect(await runHook(payload)).toBe(0);
    }

    expect(existsSync(agentEventLogPath())).toBe(true);
    await runSync({ cwd: repo, full: false, rebuild: false, quiet: true, noEmbed: true });

    // DAY 7: a fresh session hits the same failure. Nothing in the prompt asks for memory.
    const out: string[] = [];
    expect(await runAgentRecall({ input: JSON.stringify(failurePayload(FAILING, 'day-7')), out: (c) => out.push(c) })).toBe(0);

    const injected = JSON.parse(out.join('')).hookSpecificOutput;
    expect(injected.hookEventName).toBe('PostToolUseFailure');
    const text: string = injected.additionalContext;

    // It knows both dead ends, and what actually fixed it.
    expect(text).toContain('failed in this repository before');
    expect(text).toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).toContain('fixed on');
    expect(text).toContain('c.ts');
    // And it stays cheap enough to be automatic.
    expect(text.length).toBeLessThanOrEqual(MAX_RECALL_CHARS);
  });

  it('stays silent on an unrelated failure in the same repository', async () => {
    for (const payload of [edit('a.ts'), failed(FAILING, 'run-1'), edit('c.ts'), passed(FAILING, 'run-2')]) {
      expect(await runHook(payload)).toBe(0);
    }
    await runSync({ cwd: repo, full: false, rebuild: false, quiet: true, noEmbed: true });

    const out: string[] = [];
    await runAgentRecall({ input: JSON.stringify(failurePayload('cargo build', 'day-7-other')), out: (c) => out.push(c) });

    expect(out.join('')).toBe('');
  });

  it('opens a later session by naming what is still unfixed, then names the fix once it is one', async () => {
    await runHook(edit('a.ts'));
    await runHook(failed(FAILING, 'run-1'));
    await runSync({ cwd: repo, full: false, rebuild: false, quiet: true, noEmbed: true });

    const unresolved: string[] = [];
    await runAgentSessionStart({
      input: JSON.stringify({ session_id: 's1', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }),
      out: (c) => unresolved.push(c),
      startSync: () => {},
    });
    expect(unresolved.join('')).toContain(FAILING);
    expect(unresolved.join('')).toContain('no recorded fix');

    await runHook(edit('c.ts'));
    await runHook(passed(FAILING, 'run-2'));
    await runSync({ cwd: repo, full: false, rebuild: false, quiet: true, noEmbed: true });

    // Once fixed, the digest now names the fix rather than falling silent --
    // the Phase-5 eval's own finding was that staying silent here excluded the
    // single most useful thing NexusMem can say ("this failed, here's the fix").
    const resolved: string[] = [];
    await runAgentSessionStart({
      input: JSON.stringify({ session_id: 's2', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }),
      out: (c) => resolved.push(c),
      startSync: () => {},
    });
    expect(resolved.join('')).toContain(FAILING);
    expect(resolved.join('')).toContain('fixed');
  });

  it('never writes a raw secret to any NexusMem-owned file, all the way through to what is injected', async () => {
    const withSecret = `psql postgres://app:${SECRET}@db/app`;
    await runHook(edit('a.ts'));
    await runHook(failed(withSecret, 'secret-run-1'));
    await runHook(edit('c.ts'));
    await runHook(failed(withSecret, 'secret-run-2'));
    await runSync({ cwd: repo, full: false, rebuild: false, quiet: true, noEmbed: true });

    const out: string[] = [];
    await runAgentRecall({ input: JSON.stringify(failurePayload(withSecret, 'secret-day-7')), out: (c) => out.push(c) });

    // The recall fired -- so this is proof about live data, not about an empty database.
    expect(out.join('')).toContain('failed in this repository before');
    expect(out.join('')).not.toContain(SECRET);
    expect(filesContaining(join(repo, '.nexusmem'))).toEqual([]);
    expect(filesContaining(dirname(agentEventLogPath()))).toEqual([]);
  });
});
