import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactAgentEvent } from '../../src/agent/event.js';
import { MAX_DIGEST_CHARS, MAX_RECALL_CHARS } from '../../src/agent/recall.js';
import { deadEndFiles, revertsDayOneFix, SCENARIOS, type Scenario } from './scenario.js';

/**
 * The deterministic gate before any model eval: proves the Phase-5.1 fixes
 * (execution identity, exit-status recovery, the digest redesign) actually
 * reach a real Claude-Code-shaped payload through the real CLI, before any
 * `claude` process is spawned. No model call anywhere in this file.
 *
 * Twelve checks per scenario:
 *   A. the historical A/B/C chain exists in the seeded database
 *   B. a real Claude-style `cd "<same cwd>" && <command>` failure matches
 *      the historical bare command (the execution-identity fix)
 *   C. the same bare command does NOT match across a different cwd within
 *      the project, or across a wholly different project/database
 *   D. an observed Claude-style wrapped outcome ("; echo EXIT:$?") produces
 *      the correct result: a non-zero echo is recognised as a failure, a
 *      zero one is not, and a pipeline with no echo at all is left as the
 *      hook's own "ok" rather than guessed either way
 *   E. the failure->fix chain is eligible for ambient recall once correlated
 *   F. an unrelated unresolved failure does not crowd the useful chain out
 *      of the session-start digest (the digest redesign)
 *   G. recall output actually names the A/B/C evidence, not just "something"
 *   H. both recall and the digest stay inside their token budgets
 *   I. the synthetic secret this file plants occurs zero times in any
 *      NexusMem-owned durable artifact
 *   J. the observation-prefixed compounds Claude really emits -- an `ls`/
 *      `echo` prefix, a trailing `; echo "exit: $?"` -- reach the same
 *      history as the bare command
 *   K. a compound that changes state before the command (`npm install &&`,
 *      `export X=1 &&`, a pipeline) does NOT match it
 *   L. a chain this fixture's own git history has reverted is labelled as no
 *      longer holding, and one it has not is left alone
 *
 *   npm run build && npx tsx eval/ambient/verify-preflight.ts [repeats]
 */

const CLI = join(process.cwd(), 'dist/cli/index.js');
const SECRET = 'ghp_preflightF4keToken0123456789abcd';
const UNRELATED_COMMAND = 'npm run lint';

function run(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
  if (result.status !== 0 && !opts.input) {
    throw new Error(`nexusmem ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout ?? '';
}

function recall(payload: object, cwd: string, env: NodeJS.ProcessEnv): string {
  return (
    spawnSync(process.execPath, [CLI, 'agent', 'recall', '--trigger', 'failure'], {
      cwd,
      env,
      input: JSON.stringify(payload),
      encoding: 'utf8',
    }).stdout ?? ''
  );
}

function sessionStart(cwd: string, env: NodeJS.ProcessEnv): string {
  return (
    spawnSync(process.execPath, [CLI, 'agent', 'session-start'], {
      cwd,
      env,
      input: JSON.stringify({ session_id: 'preflight-start', cwd, hook_event_name: 'SessionStart', source: 'startup' }),
      encoding: 'utf8',
    }).stdout ?? ''
  );
}

interface Fixture {
  dir: string;
  nmHome: string;
}

/** A real repository, a real NexusMem database, and the day-1 events -- all through the real CLI. */
function buildFixture(scenario: Scenario): Fixture {
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexusmem-preflight-')));
  const dir = join(workspace, 'app');
  const nmHome = join(workspace, 'nmhome');
  scenario.build(dir);
  mkdirSync(nmHome, { recursive: true });

  const env = { ...process.env, NEXUSMEM_HOME: nmHome };
  run(['init', '-C', dir], { env });

  // Without this the sync scrapes this machine's real shell history into the fixture.
  const configPath = join(dir, '.nexusmem', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { sources: { shell: { enabled: boolean } } };
  config.sources.shell.enabled = false;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const events = scenario.events(dir).map(redactAgentEvent);
  // One event carries the synthetic secret, through the same redaction path
  // the real hook applies, so I has something real to check.
  events.push(
    redactAgentEvent({
      agent: 'claude-code',
      sessionId: 'preflight-secret',
      eventId: 'secret-1',
      ts: new Date().toISOString(),
      cwd: dir,
      kind: 'command',
      command: `${UNRELATED_COMMAND} --token=${SECRET}`,
      outcome: 'fail',
      exitCode: 1,
      durationMs: 5,
    }),
  );
  writeFileSync(join(nmHome, 'agent-events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  run(['sync', '-C', dir, '--no-embed', '--quiet'], { env });
  return { dir, nmHome };
}

/**
 * A second, unrelated project: same bare command, own repo, own database
 * (`<repoRoot>/.nexusmem/memory.db` is a separate file per repo, so this is
 * really checking that the query is scoped correctly, not that the files
 * happen not to collide). Exists only for check C's cross-project half.
 */
function buildUnrelatedProject(scenario: Scenario): Fixture {
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexusmem-preflight-other-')));
  const dir = join(workspace, 'app');
  const nmHome = join(workspace, 'nmhome');
  mkdirSync(dir, { recursive: true });
  mkdirSync(nmHome, { recursive: true });
  const env = { ...process.env, NEXUSMEM_HOME: nmHome };

  // `nexusmem init` requires a real git repository; this project's own
  // history is irrelevant, only its identity as a separate project matters.
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'preflight', GIT_AUTHOR_EMAIL: 'preflight@example.com', GIT_COMMITTER_NAME: 'preflight', GIT_COMMITTER_EMAIL: 'preflight@example.com' };
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { env: gitEnv, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), 'unrelated project\n');
  execFileSync('git', ['-C', dir, 'add', '.'], { env: gitEnv, stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init'], { env: gitEnv, stdio: 'ignore' });

  run(['init', '-C', dir], { env });
  const configPath = join(dir, '.nexusmem', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { sources: { shell: { enabled: boolean } } };
  config.sources.shell.enabled = false;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const event = redactAgentEvent({
    agent: 'claude-code',
    sessionId: 'other-project',
    eventId: 'other-1',
    ts: new Date().toISOString(),
    cwd: dir,
    kind: 'command',
    command: scenario.command,
    outcome: 'fail',
    exitCode: 1,
    durationMs: 5,
  });
  writeFileSync(join(nmHome, 'agent-events.jsonl'), `${JSON.stringify(event)}\n`);
  run(['sync', '-C', dir, '--no-embed', '--quiet'], { env });
  return { dir, nmHome };
}

/**
 * Every probe below needs its own `session_id`. `agent recall` explains the
 * same failure only once per session (`shouldInject`/`markInjected`) -- real
 * and correct product behaviour, but it means reusing a session id across
 * two of these checks silently suppresses the second one and makes it look
 * like a match failed when it did not.
 */
let nextSessionId = 0;
const session = () => `preflight-${(nextSessionId += 1)}`;

function failurePayload(dir: string, command: string, errorText: string): object {
  return {
    session_id: session(),
    cwd: dir,
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: `toolu_preflight_${nextSessionId}`,
    error: errorText,
    duration_ms: 5,
  };
}

function hiddenExitPayload(dir: string, command: string, stdout: string): object {
  return {
    session_id: session(),
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout, stderr: '', interrupted: false },
    tool_use_id: `toolu_preflight_${nextSessionId}`,
  };
}

function verify(scenario: Scenario): string[] {
  const problems: string[] = [];
  const { dir, nmHome } = buildFixture(scenario);
  const env = { ...process.env, NEXUSMEM_HOME: nmHome };
  let other: Fixture | null = null;

  try {
    const errorText = `Exit code 1\n${scenario.command} failed`;

    // --- A: the historical A/B/C chain exists ---------------------------
    const bareRecall = recall(failurePayload(dir, scenario.command, errorText), dir, env);
    if (!bareRecall.includes('failed in this repository before')) problems.push('A: no historical failure found for the bare command');
    for (const [label, edit] of [
      ['A', scenario.attemptA],
      ['B', scenario.attemptB],
    ] as const) {
      const leaf = edit.file.split('/').pop()!;
      if (!bareRecall.includes(leaf) && !bareRecall.includes(edit.file)) problems.push(`A: approach ${label} (${edit.file}) is missing from recall`);
    }

    // --- B: a Claude-style cd-wrapped command matches the same history --
    const wrapped = recall(failurePayload(dir, `cd "${dir}" && ${scenario.command}`, errorText), dir, env);
    if (!wrapped.includes('failed in this repository before')) problems.push('B: a "cd <cwd> && <command>" wrapped failure did not match its bare history');

    // --- C: no match across a different cwd, or a different project -----
    const differentDir = recall(failurePayload(dir, `cd /somewhere/unrelated && ${scenario.command}`, errorText), dir, env);
    if (differentDir !== '') problems.push('C: a cd to an unrelated directory within the same project incorrectly matched');

    // A second project, own repo and own `.nexusmem/memory.db`, seeded with
    // one failure of the exact same bare command text (so `execHash` -- which
    // is computed from command text alone, not from cwd -- is identical
    // across the two). Isolation has to come from the query being scoped by
    // `project_id`, not from the hash happening to differ.
    other = buildUnrelatedProject(scenario);
    const otherEnv = { ...process.env, NEXUSMEM_HOME: other.nmHome };
    const crossProject = recall(failurePayload(other.dir, scenario.command, errorText), other.dir, otherEnv);
    const crossProjectCount = /before \((\d+) time/.exec(crossProject)?.[1];
    // The other project has exactly one failure of its own. If the first
    // project's two dead-end failures leaked in, this would read 3.
    if (crossProjectCount !== '1') problems.push(`C: the unrelated project's own recall count was ${crossProjectCount ?? 'absent'}, expected exactly 1`);

    const bareRecallAfter = recall(failurePayload(dir, scenario.command, errorText), dir, env);
    const bareCountAfter = /before \((\d+) time/.exec(bareRecallAfter)?.[1];
    // The first project has exactly two dead-end failures (A and B). If the
    // other project's failure leaked in, this would read 3.
    if (bareCountAfter !== '2') problems.push(`C: the first project's own recall count was ${bareCountAfter ?? 'absent'} after seeding an unrelated project, expected exactly 2`);

    // --- D: an observed Claude-style wrapped outcome is read correctly --
    const echoWrapped = `${scenario.command}; echo "EXIT:$?"`;
    const hiddenFail = recall(hiddenExitPayload(dir, echoWrapped, `${scenario.command} failed\nEXIT:1`), dir, env);
    if (!hiddenFail.includes('failed in this repository before')) problems.push('D: a hidden non-zero exit code ("; echo EXIT:1") was not recognised as a failure');

    const hiddenOk = recall(hiddenExitPayload(dir, echoWrapped, 'ok\nEXIT:0'), dir, env);
    if (hiddenOk !== '') problems.push('D: a genuine "EXIT:0" was incorrectly treated as a failure');

    // Output alone is not evidence: the same "EXIT:1" from a command that never echoed $? stays silent.
    const unwrapped = recall(hiddenExitPayload(dir, scenario.command, 'summary\nEXIT:1'), dir, env);
    if (unwrapped !== '') problems.push('D: "EXIT:1" in the output of an unwrapped command was treated as a failure');

    // A pipeline with no recoverable status: must stay silent (the hook's own
    // "ok"), never guessed as a failure -- the one gap this fix does not close.
    const pipeline = recall(hiddenExitPayload(dir, scenario.command, 'some ordinary program output, no echoed status'), dir, env);
    if (pipeline !== '') problems.push('D: ambiguous output with no status evidence was incorrectly treated as a failure');

    // --- E + G: the fix is eligible for ambient recall, and named -------
    const fixLeaf = scenario.fix.file.split('/').pop()!;
    // `attemptC` is what day 1 actually ended green on; only two scenarios
    // still have that be today's `fix` (`retry-regression`, `stale-fix` do
    // not -- their day-1 answer is what makes them adversarial).
    const day1Leaf = scenario.attemptC.file.split('/').pop()!;
    if (bareRecall.includes('fixed on')) {
      if (!bareRecall.includes(day1Leaf) && !bareRecall.includes(fixLeaf)) problems.push('E/G: recall claims a fix but does not name the file it touched');
    } else {
      problems.push('E: no fix chain was eligible for recall even though day 1 ended green');
    }

    // --- F: an unrelated unresolved failure does not crowd it out -------
    const digest = sessionStart(dir, env);
    const commandLine = scenario.command.split(/\r?\n/)[0]!;
    if (!digest.includes(commandLine) && !digest.includes(fixLeaf) && !digest.includes(day1Leaf)) {
      problems.push('F: the session-start digest does not mention the resolved chain at all');
    }
    // Ranking is only meaningful once the chain is actually present: an
    // indexOf against an absent command returns -1 and silently passes.
    if (!digest.includes(commandLine)) {
      problems.push('F: the session-start digest never names the scenario command itself');
    } else if (digest.includes(UNRELATED_COMMAND) && digest.indexOf(UNRELATED_COMMAND) < digest.indexOf(commandLine)) {
      problems.push('F: an unrelated unresolved failure was ranked ahead of the resolved chain');
    }

    // --- J: the compounds Claude really emits reach the same history -----
    // Each is a shape taken from the Phase-5 transcripts, not an invented one.
    const realCompounds: Array<[string, string]> = [
      ['trailing exit echo', `cd "${dir}" && ${scenario.command}; echo "exit: $?"`],
      ['ls prefix', `cd "${dir}" && ls && ${scenario.command}`],
      ['ls -la + echo separator prefix', `cd "${dir}" && ls -la && echo --- && ${scenario.command}`],
      ['no cd, trailing exit echo', `${scenario.command}; echo "EXIT: $?"`],
    ];
    for (const [label, command] of realCompounds) {
      const text = recall(failurePayload(dir, command, errorText), dir, env);
      if (!text.includes('failed in this repository before')) problems.push(`J: a real Claude compound (${label}) did not match its bare history`);
    }

    // --- K: a compound that could have changed the run does NOT match ----
    const unsafeCompounds: Array<[string, string]> = [
      ['npm install prefix', `npm install && ${scenario.command}`],
      ['env-var export prefix', `export NODE_ENV=test && ${scenario.command}`],
      ['second real execution', `node build.js && ${scenario.command}`],
      ['piped into head', `${scenario.command} 2>&1 | head -100`],
      ['trailing unknown command', `${scenario.command} ; cleanup`],
    ];
    for (const [label, command] of unsafeCompounds) {
      const text = recall(failurePayload(dir, command, errorText), dir, env);
      if (text.includes('failed in this repository before')) problems.push(`K: an unsafe compound (${label}) incorrectly matched the bare history`);
    }

    // --- L: a reverted chain is labelled, an unreverted one is not -------
    const reverted = revertsDayOneFix(dir, scenario);
    const saysStale = (text: string) => text.includes('no longer holds');
    if (reverted) {
      if (!saysStale(bareRecall)) problems.push('L: git reverted the day-1 fix, but recall still presents it as current');
      if (!saysStale(digest)) problems.push('L: git reverted the day-1 fix, but the session-start digest still presents it as current');
    } else {
      if (saysStale(bareRecall)) problems.push('L: recall claims the fix no longer holds, but git contains no revert of it');
      if (saysStale(digest)) problems.push('L: the digest claims the fix no longer holds, but git contains no revert of it');
    }

    // --- H: token budget -------------------------------------------------
    if (bareRecall.length > 0) {
      const injected = (JSON.parse(bareRecall) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
        ?.additionalContext;
      if (injected && injected.length > MAX_RECALL_CHARS) problems.push(`H: recall text exceeded MAX_RECALL_CHARS (${injected.length})`);
    }
    if (digest.length > MAX_DIGEST_CHARS) problems.push(`H: session-start digest exceeded MAX_DIGEST_CHARS (${digest.length})`);

    // --- I: no raw synthetic secret persists anywhere durable ------------
    const dbBytes = readFileSync(join(dir, '.nexusmem', 'memory.db'));
    if (dbBytes.includes(Buffer.from(SECRET))) problems.push('I: the raw synthetic secret is present in the database file');
    const eventLog = readFileSync(join(nmHome, 'agent-events.jsonl'), 'utf8');
    if (eventLog.includes(SECRET)) problems.push('I: the raw synthetic secret is present in the agent event log');
    for (const text of [bareRecall, wrapped, differentDir, crossProject, bareRecallAfter, hiddenFail, hiddenOk, pipeline, digest]) {
      if (text.includes(SECRET)) problems.push('I: the raw synthetic secret was echoed in CLI output');
    }
    if (deadEndFiles(scenario).some((f) => !f)) problems.push('internal: a scenario declared an empty dead-end file');
  } finally {
    // Best-effort: a lingering handle on Windows must not hide real check results.
    for (const d of [dir, other?.dir].filter((x): x is string => x !== undefined)) {
      try {
        rmSync(join(d, '..'), { recursive: true, force: true });
      } catch {
        /* leaked temp dir, not a preflight failure */
      }
    }
  }
  return problems;
}

/**
 * Every pass rebuilds each fixture from scratch, so repeating it is a real
 * stability check rather than a re-read of the same state: a check that only
 * passes sometimes is worse than one that fails, because the model eval
 * downstream would inherit the flake as a result.
 */
const REPEATS = Number(process.argv[2] ?? 1);
let failed = false;

for (let pass = 1; pass <= REPEATS; pass += 1) {
  if (REPEATS > 1) process.stdout.write(`\npass ${pass}/${REPEATS}\n`);
  for (const scenario of SCENARIOS) {
    const problems = verify(scenario);
    process.stdout.write(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${scenario.name}\n`);
    for (const problem of problems) process.stdout.write(`       ${problem}\n`);
    failed ||= problems.length > 0;
  }
}

process.stdout.write(failed ? '\npreflight FAILED -- do not run the model eval\n' : '\npreflight passed -- safe to run the model eval\n');
process.exit(failed ? 1 : 0);
