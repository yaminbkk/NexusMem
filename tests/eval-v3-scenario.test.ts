import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { passes, passesWith } from '../eval/ambient-v2/verify-fixtures.js';
import { fingerprints as v2Fingerprints } from '../eval/ambient-v2/fingerprint.js';
import { fingerprints as v3Fingerprints } from '../eval/ambient-v3/fingerprint.js';
import { SHADOWED_CONFIG_V3, V3_SCENARIOS } from '../eval/ambient-v3/scenario.js';
import { checkPilotDiscriminates, scoreTrial, type TrialRecord } from '../eval/ambient-v3/scorer.js';

/**
 * Regression coverage for issue #20: ambient-v2's control-arm dead-end rate
 * (1/14) was too low to discriminate between arms because `git log` itself
 * told every arm which approaches had already failed, and the file-level
 * scorer called a genuine alternative fix (raising `MIN_RETENTION_DAYS`) a
 * repeated dead end just because it shared a file with a disproved one.
 */

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

describe('ambient-v3: git carries no trace of a prior attempt', () => {
  const scenario = SHADOWED_CONFIG_V3;
  let dir: string;

  const build = () => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-v3-fixture-'));
    scenario.build(dir);
  };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  it('the command actually fails in the state the agent is handed', () => {
    build();
    try {
      expect(passes(dir, scenario.command)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('git log has exactly the history the scenario declares, no more', () => {
    build();
    try {
      const subjects = git(dir, 'log', '--format=%s').trim().split('\n');
      expect(subjects).toEqual(scenario.history.map((c) => c.message.split('\n')[0]));
    } finally {
      cleanup();
    }
  });

  it('neither dead end, the fix, nor the alternative fix is mentioned in any commit message', () => {
    build();
    try {
      const log = git(dir, 'log', '--format=%B').toLowerCase();
      for (const edit of [...scenario.deadEnds, scenario.fix, ...scenario.validAlternativeFixes]) {
        for (const needle of [edit.file, edit.from, edit.to]) {
          if (needle.trim().length < 4) continue; // too short to be a meaningful leak either way
          expect(log, `commit log should not mention "${needle}"`).not.toContain(needle.toLowerCase());
        }
      }
      // The words a v2 commit narrated its attempts with, gone entirely.
      expect(log).not.toMatch(/attempt|revert|still failing|changed nothing|fixed the failing check/);
    } finally {
      cleanup();
    }
  });

  it('the working tree at HEAD is already the disproved-attempts-free broken state, not a checked-out history', () => {
    build();
    try {
      // Only one commit exists at all -- the working tree cannot possibly
      // carry more than what that one commit wrote, but this is the direct
      // check the acceptance criterion asks for.
      expect(scenario.history.length).toBe(1);
      const content = readFileSync(join(dir, 'src/retention.js'), 'utf8');
      expect(content).toContain('const MIN_RETENTION_DAYS = 1;'); // pre-fix, exactly as day 1 left it
    } finally {
      cleanup();
    }
  });

  it('the seeded agent-event log -- not git -- is where every prior attempt actually lives', () => {
    build();
    try {
      const events = scenario.events(dir, Date.UTC(2026, 0, 2));
      // `events()` builds `filePath` with `node:path`'s `join`, which spells the
      // separator natively (`config\defaults.json` on Windows) -- normalise
      // before comparing against the scenario's own forward-slash spelling,
      // same reason eval/ambient-v2/fingerprint.ts canonicalises event paths.
      const editedFiles = events
        .filter((e) => e.kind === 'edit')
        .map((e) => relative(dir, e.filePath ?? '').split('\\').join('/'));
      for (const deadEnd of scenario.deadEnds) expect(editedFiles).toContain(deadEnd.file);
    } finally {
      cleanup();
    }
  });

  it('both dead ends are genuinely disproved, and the designated fix genuinely works, today', () => {
    build();
    try {
      for (const edit of scenario.deadEnds) expect(passesWith(dir, scenario.command, edit), edit.file).toBe(false);
      expect(passesWith(dir, scenario.command, scenario.fix)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('the retention case: the valid alternative fix genuinely makes the command pass, in the same file as a dead end', () => {
    build();
    try {
      const alt = scenario.validAlternativeFixes[0]!;
      expect(alt.file).toBe('src/retention.js');
      expect(scenario.deadEnds.some((e) => e.file === alt.file)).toBe(true); // same file as RETENTION_DEAD_COERCE, on purpose
      expect(passesWith(dir, scenario.command, alt)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('ambient-v3 scorer: accepts every fix that makes check.js pass', () => {
  const scenario = SHADOWED_CONFIG_V3;

  const record = (over: Partial<TrialRecord>): TrialRecord => ({
    scenario: scenario.name,
    arm: 'ambient',
    repeat: 0,
    order: 0,
    editedFiles: [],
    editIndex: {},
    finalChangedFiles: [],
    commandPassesAfter: false,
    passIndex: null,
    toolCalls: 0,
    failedToolCalls: 0,
    turns: 0,
    costUsd: 0,
    durationMs: 0,
    injections: [],
    nexusMemToolCalls: 0,
    ...over,
  });

  it('the retention case: editing src/retention.js and passing is a fix, never a repeated dead end', () => {
    const score = scoreTrial(
      record({ editIndex: { 'src/retention.js': 1 }, commandPassesAfter: true, passIndex: 2 }),
      scenario,
    );
    expect(score.repeatedDeadEnd).toBe(false);
    expect(score.editedFixFile).toBe(true);
    expect(score.usedAlternativeFix).toBe(true);
    expect(score.taskSuccess).toBe(true);
  });

  it('editing src/retention.js and STILL failing is still a repeated dead end', () => {
    const score = scoreTrial(
      record({ editIndex: { 'src/retention.js': 1 }, commandPassesAfter: false, passIndex: null }),
      scenario,
    );
    expect(score.repeatedDeadEnd).toBe(true);
    expect(score.editedFixFile).toBe(false);
    expect(score.usedAlternativeFix).toBe(false);
  });

  it('the designated fix is still credited normally, and never called an alternative', () => {
    const score = scoreTrial(
      record({ editIndex: { 'config/site.json': 1 }, commandPassesAfter: true, passIndex: 2 }),
      scenario,
    );
    expect(score.editedFixFile).toBe(true);
    expect(score.usedAlternativeFix).toBe(false);
    expect(score.repeatedDeadEnd).toBe(false);
  });

  it('the OTHER dead end (config/defaults.json, no alternative declared there) is unaffected by this fix', () => {
    const score = scoreTrial(
      record({ editIndex: { 'config/defaults.json': 1 }, commandPassesAfter: false, passIndex: null }),
      scenario,
    );
    expect(score.repeatedDeadEnd).toBe(true);
  });

  it('a repeated dead end still counts even when the run eventually passes some other way', () => {
    // config/defaults.json (a dead end with no declared alternative) touched
    // first, then the real fix reached afterwards: still a repeat, because
    // it happened BEFORE the run found the actual answer.
    const score = scoreTrial(
      record({ editIndex: { 'config/defaults.json': 1, 'config/site.json': 2 }, commandPassesAfter: true, passIndex: 3 }),
      scenario,
    );
    expect(score.repeatedDeadEnd).toBe(true);
    expect(score.editedFixFile).toBe(true);
  });

  it('a dead end in the SAME file as a valid alternative still counts when the designated fix is reached separately afterward', () => {
    // The bug CodeRabbit caught reviewing this PR: crediting src/retention.js
    // as "the alternative fix" purely because commandPassesAfter was true
    // ignored that config/site.json (the designated fix) was ALSO reached,
    // later -- which is who almost certainly deserves credit for the pass.
    // Fixed properly (not by special-casing "designated fix untouched", which
    // was itself only a second file-only heuristic): `passIndex` says the
    // command went green at tool call 6, and of the two candidate files
    // edited at or before that, config/site.json (index 5) is the more
    // recent one -- the retention.js edit at index 1 was superseded before
    // the pass and explains nothing about it, so it is scored as the
    // ordinary, unproven dead end it looks like.
    const score = scoreTrial(
      record({ editIndex: { 'src/retention.js': 1, 'config/site.json': 5 }, commandPassesAfter: true, passIndex: 6 }),
      scenario,
    );
    expect(score.repeatedDeadEnd).toBe(true);
    expect(score.editedFixFile).toBe(true);
    expect(score.usedAlternativeFix).toBe(false);
    expect(score.toolCallsBeforeFix).toBe(5);
  });

  it('a genuine alternative reached alone (designated fix never touched) is still never a repeat', () => {
    const score = scoreTrial(record({ editIndex: { 'src/retention.js': 3 }, commandPassesAfter: true, passIndex: 4 }), scenario);
    expect(score.repeatedDeadEnd).toBe(false);
    expect(score.usedAlternativeFix).toBe(true);
  });

  it('an edit after the pass is irrelevant: only what was in effect AT the pass counts', () => {
    // The designated fix reached and passed at tool call 2; a later,
    // unrelated touch to the dead-end-sharing file at tool call 9 (long after
    // the run already succeeded) must not retroactively taint the result.
    const score = scoreTrial(
      record({ editIndex: { 'config/site.json': 2, 'src/retention.js': 9 }, commandPassesAfter: true, passIndex: 2 }),
      scenario,
    );
    expect(score.repeatedDeadEnd).toBe(false);
    expect(score.usedAlternativeFix).toBe(false);
    expect(score.toolCallsBeforeFix).toBe(2);
  });

  it('two valid alternatives: credits whichever was edited most recently before the pass, not whichever sorts first', () => {
    // A synthetic scenario with a SECOND alternative-fix file (an unrelated
    // dead end, config/defaults.json, to keep this test isolated to just the
    // "which alternative wins" question) -- proving the fix generalises
    // beyond the one case CodeRabbit's counter-example gave it: the
    // file-only heuristic this replaced could not have told two alternatives
    // apart either, since it always took the minimum index across every
    // alternative file, in whichever order they happen to sort.
    const twoAltScenario = {
      ...scenario,
      fix: { file: 'config/site.json', from: '', to: '' },
      validAlternativeFixes: [
        { file: 'src/retention.js', from: '', to: '' },
        { file: 'src/archive.js', from: '', to: '' },
      ],
      deadEnds: [{ file: 'config/defaults.json', from: '', to: '' }],
    };
    // src/retention.js edited first, at index 1, then superseded by editing
    // src/archive.js at index 4, right before the command went green at 5.
    // A rule that took the minimum index across alternatives would credit
    // retention.js and report tool call 1; the correct answer is archive.js,
    // tool call 4 -- whatever was actually standing when it passed.
    const score = scoreTrial(
      record({ editIndex: { 'src/retention.js': 1, 'src/archive.js': 4 }, commandPassesAfter: true, passIndex: 5 }),
      twoAltScenario,
    );
    expect(score.usedAlternativeFix).toBe(true);
    expect(score.toolCallsBeforeFix).toBe(4);
    expect(score.repeatedDeadEnd).toBe(false); // config/defaults.json, the only declared dead end here, was never touched
  });
});

describe('ambient-v3 design fingerprint differs from ambient-v2 (results must never pool)', () => {
  it('the design hash differs, even though both cover a "shadowed-config"-shaped fixture', () => {
    expect(v3Fingerprints().design).not.toBe(v2Fingerprints().design);
  });

  it('is stable across two computations (deterministic, not time-of-day dependent)', () => {
    expect(v3Fingerprints().design).toBe(v3Fingerprints().design);
  });
});

describe('checkPilotDiscriminates: the ambient-v2 precondition failure, caught before a full run', () => {
  const trial = (arm: 'control' | 'ambient', repeatedDeadEnd: boolean | null) => ({
    scenario: 'shadowed-config-v3',
    arm,
    repeat: 0,
    measured: true,
    repeatedDeadEnd,
    taskSuccess: true,
    editedFixFile: true,
    usedAlternativeFix: false,
    toolCallsBeforeFix: 1,
    deadEndsRepeated: 0,
    followedIrrelevantMemory: false,
    toolCalls: 1,
    failedToolCalls: 0,
    turns: 1,
    costUsd: 0,
    durationMs: 0,
    memoryDelivered: false,
    usefulMemoryDelivery: false,
    proactiveMcpCalls: 0,
  });

  it('fails exactly the way ambient-v2 would have: 1 of 14 control trials hitting a dead end', () => {
    const pilot = [...Array(1).fill(null).map(() => trial('control', true)), ...Array(13).fill(null).map(() => trial('control', false))];
    const gate = checkPilotDiscriminates(pilot);
    expect(gate.ok).toBe(false);
    expect(gate.controlRate).toBeCloseTo(1 / 14, 5);
  });

  it('passes when the control arm hits dead ends often enough to discriminate', () => {
    const pilot = [...Array(5).fill(null).map(() => trial('control', true)), ...Array(5).fill(null).map(() => trial('control', false))];
    expect(checkPilotDiscriminates(pilot).ok).toBe(true);
  });

  it('refuses rather than divides by zero when no control trial seeded a dead end at all', () => {
    const gate = checkPilotDiscriminates([trial('control', null)]);
    expect(gate.ok).toBe(false);
    expect(gate.controlDenominator).toBe(0);
  });

  it('only ever looks at the control arm', () => {
    const pilot = [trial('ambient', true), trial('ambient', true), trial('control', false)];
    const gate = checkPilotDiscriminates(pilot);
    expect(gate.controlDenominator).toBe(1);
    expect(gate.ok).toBe(false);
  });
});

describe('ambient-v3 scenario set', () => {
  it('every scenario declares at least one valid alternative fix, or none by explicit choice', () => {
    for (const scenario of V3_SCENARIOS) expect(Array.isArray(scenario.validAlternativeFixes)).toBe(true);
  });

  it('a valid alternative fix is never the same edit as the designated fix', () => {
    for (const scenario of V3_SCENARIOS) {
      for (const alt of scenario.validAlternativeFixes) {
        expect(alt).not.toEqual(scenario.fix);
      }
    }
  });
});
