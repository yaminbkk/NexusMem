import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { applyEdit, type Edit, SCENARIOS, type Scenario } from './scenario.js';

/**
 * Proves each eval fixture is internally truthful, before any model runs
 * against it. An eval whose scenario already passes, whose "failed approach"
 * would in fact have worked, or whose task text names the answer produces
 * numbers that mean nothing.
 *
 * Eight claims per scenario:
 *   1. the state the agent is handed fails, reproducibly
 *   2. every commit in the history really produces the state it declares
 *   3. approach A genuinely fails -- at the day-1 state and again today
 *   4. approach B genuinely fails -- likewise
 *   5. approach C was genuinely green on day 1
 *   6. today's fix genuinely passes
 *   7. the day-1 answer no longer fixes it, where the scenario claims a trap
 *   8. no answer leakage: the task, the scenario name and the file names do
 *      not give away the file to change, and the distractors really are
 *      distractors
 *
 *   npx tsx eval/ambient/verify-fixtures.ts
 */

/** Commands the day-1 event log records that have nothing to do with the task. */
const UNRELATED_COMMANDS = ['npm run lint', 'npm run typecheck'];

function passes(dir: string, command: string): boolean {
  const [exe, ...rest] = command.split(' ');
  return spawnSync(exe!, rest, { cwd: dir, encoding: 'utf8' }).status === 0;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

/** Applies an edit to the working tree, runs the check, then restores the file. */
function passesWith(dir: string, command: string, edit: Edit): boolean {
  const path = join(dir, edit.file);
  const before = readFileSync(path, 'utf8');
  writeFileSync(path, applyEdit(before, edit), 'utf8');
  try {
    return passes(dir, command);
  } finally {
    writeFileSync(path, before, 'utf8');
  }
}

/** Every commit, checked out and re-run against the expectation it declares. */
function historyIsTruthful(dir: string, scenario: Scenario): { problems: string[]; day1: string | null } {
  const hashes = git(dir, 'log', '--reverse', '--format=%H').trim().split('\n');
  const head = git(dir, 'rev-parse', 'HEAD').trim();
  const problems: string[] = [];
  let day1: string | null = null;

  if (hashes.length !== scenario.history.length) {
    problems.push(`history has ${hashes.length} commits but ${scenario.history.length} expectations`);
    return { problems, day1 };
  }

  hashes.forEach((hash, i) => {
    const commit = scenario.history[i]!;
    if (commit.tag === 'day1-broken') day1 = hash;
    git(dir, 'checkout', '-q', hash);
    const green = passes(dir, scenario.command);
    if (green !== (commit.expect === 'pass')) {
      problems.push(`${hash.slice(0, 7)} declares ${commit.expect} but the check ${green ? 'passes' : 'fails'}: ${commit.message.split('\n')[0]}`);
    }
  });
  git(dir, 'checkout', '-q', head);
  return { problems, day1 };
}

/** The task, the scenario name and the tree must not hand the answer over. */
function leakage(dir: string, scenario: Scenario): string[] {
  const problems: string[] = [];
  const answer = scenario.fix.file.split('/').pop()!.replace(/\.js$/, '');
  const haystacks: Array<[string, string]> = [
    ['the task text', scenario.task],
    ['the scenario name', scenario.name],
  ];
  for (const [where, text] of haystacks) {
    if (text.toLowerCase().includes(answer.toLowerCase())) problems.push(`${where} contains "${answer}", the file to change`);
    if (/nexusmem|memory|recall/i.test(text)) problems.push(`${where} mentions memory`);
  }
  if (scenario.task.includes(scenario.fix.to)) problems.push('the task text contains the change itself');

  // The two abandoned approaches must exist as real files, or "repeated dead
  // end" is scoring something the agent could not have done.
  for (const edit of [scenario.attemptA, scenario.attemptB]) {
    try {
      statSync(join(dir, edit.file));
    } catch {
      problems.push(`${edit.file} does not exist, so it cannot be a dead end`);
    }
  }

  // Distractors: commits that touch nothing the answer depends on, and docs
  // that reuse the answer's vocabulary without describing runtime behaviour.
  const subjects = git(dir, 'log', '--format=%s').trim().split('\n');
  const touchingFix = git(dir, 'log', '--format=%h', '--', scenario.fix.file).trim().split('\n').filter(Boolean);
  if (subjects.length - touchingFix.length < 3) problems.push('fewer than three commits that do not touch the file to change');

  const docs = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.md'));
  if (docs.length === 0) problems.push('no documentation distractor');

  return problems;
}

/** The day-1 log must carry A, B and C, and the unrelated chains must stay unrelated. */
function eventsAreIntended(dir: string, scenario: Scenario): string[] {
  const problems: string[] = [];
  const events = scenario.events(dir);
  const edited = events.filter((e) => e.kind === 'edit').map((e) => relative(dir, e.filePath ?? '').split('\\').join('/'));
  for (const [label, edit] of [
    ['A', scenario.attemptA],
    ['B', scenario.attemptB],
    ['C', scenario.attemptC],
  ] as const) {
    if (!edited.includes(edit.file)) problems.push(`the day-1 log never records approach ${label} (${edit.file})`);
  }

  const commands = events.filter((e) => e.kind === 'command');
  const own = commands.filter((e) => e.command === scenario.command);
  if (own.filter((e) => e.outcome === 'fail').length < 2) problems.push('the day-1 log records fewer than two failures of the task command');
  if (own.filter((e) => e.outcome === 'ok').length < 1) problems.push('the day-1 log records no successful run of the task command');

  const unrelated = commands.filter((e) => UNRELATED_COMMANDS.some((c) => (e.command ?? '').startsWith(c)));
  if (unrelated.length === 0) problems.push('no unrelated failure chain, so retrieval noise cannot be measured');
  if (!unrelated.some((e) => e.outcome === 'fail' && !commands.some((o) => o.command === e.command && o.outcome === 'ok'))) {
    problems.push('no unrelated chain left unresolved, so the session digest has nothing off-topic it could name');
  }
  return problems;
}

function verify(scenario: Scenario): { problems: string[]; commits: number } {
  const problems: string[] = [];
  // Named for the check, not the scenario: this path is not what the model sees,
  // but there is no reason for it to carry the answer either.
  const dir = mkdtempSync(join(tmpdir(), 'nexusmem-fixture-'));
  try {
    scenario.build(dir);

    // 1 + 2
    if (passes(dir, scenario.command)) problems.push('the command already passes in the state the agent is handed');
    const { problems: historyProblems, day1 } = historyIsTruthful(dir, scenario);
    problems.push(...historyProblems);

    // 3 + 4 + 5, at the state day 1 was actually working against
    if (day1 === null) problems.push('no commit is tagged as the day-1 broken state');
    else {
      const head = git(dir, 'rev-parse', 'HEAD').trim();
      git(dir, 'checkout', '-q', day1);
      if (passes(dir, scenario.command)) problems.push('the day-1 state does not fail');
      if (passesWith(dir, scenario.command, scenario.attemptA)) problems.push('approach A fixes the check on day 1, so it was not a dead end');
      if (passesWith(dir, scenario.command, scenario.attemptB)) problems.push('approach B fixes the check on day 1, so it was not a dead end');
      if (!passesWith(dir, scenario.command, scenario.attemptC)) problems.push('approach C does not fix the check on day 1, so day 1 never ended green');
      git(dir, 'checkout', '-q', head);
    }

    // 3 + 4 again, today: repeating either has to be worthless now as well
    if (passesWith(dir, scenario.command, scenario.attemptA)) problems.push('approach A fixes the check today, so repeating it is not a dead end');
    if (passesWith(dir, scenario.command, scenario.attemptB)) problems.push('approach B fixes the check today, so repeating it is not a dead end');

    // 7
    if (scenario.staleAttempt && passesWith(dir, scenario.command, scenario.staleAttempt)) {
      problems.push(`the day-1 answer applied to ${scenario.staleAttempt.file} still fixes it today, so the trap is not a trap`);
    }

    // 6, last: it is the only one that must be green
    if (!passesWith(dir, scenario.command, scenario.fix)) problems.push(`${scenario.fix.file}: the recorded fix does not make the command pass`);

    // 8
    problems.push(...leakage(dir, scenario));
    problems.push(...eventsAreIntended(dir, scenario));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { problems, commits: scenario.history.length };
}

let failed = false;
for (const scenario of SCENARIOS) {
  const { problems, commits } = verify(scenario);
  process.stdout.write(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${scenario.name.padEnd(18)} ${commits} commits re-run\n`);
  for (const problem of problems) process.stdout.write(`       ${problem}\n`);
  failed ||= problems.length > 0;
}
process.stdout.write(failed ? '\nfixtures are NOT sound -- do not run the eval\n' : '\nall fixtures sound\n');
process.exit(failed ? 1 : 0);
