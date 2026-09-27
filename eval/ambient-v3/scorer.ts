import type { V3Scenario } from './scenario.js';

/**
 * The deterministic scorer for ambient-v3.
 *
 * Same discipline as `eval/ambient-v2/scorer.ts` (pure, file-and-exit-code
 * only, nothing here interprets prose) but with the one rule ambient-v2
 * measured wrong: a dead end is a specific disproved edit, not a file. Editing
 * `src/retention.js` the way `RETENTION_DEAD_COERCE` does never fixes
 * anything; editing the same file the way `RETENTION_ALT_FIX` does genuinely
 * does. A scorer that only asks "was this file touched before the designated
 * fix" cannot tell those apart, and ambient-v2's did not -- it called a run
 * that found a real alternative solution a repeated dead end, which is
 * exactly backwards.
 *
 * The fix: `validAlternativeFixes` names the file(s) a genuine alternative
 * can live in, and a dead-end match on one of those files is only counted
 * when the command still failed. A run whose edit there coincided with the
 * command passing gets credit for a real fix, never a penalty for repeating
 * one.
 */

export const ARMS = ['control', 'mcp', 'ambient'] as const;
export type Arm = (typeof ARMS)[number];

export interface Injection {
  index: number;
  text: string;
}

export interface TrialRecord {
  scenario: string;
  arm: Arm;
  repeat: number;
  order: number;
  systemFailure?: string;
  error?: string;

  editedFiles: readonly string[];
  editIndex: Readonly<Record<string, number>>;
  finalChangedFiles: readonly string[];
  commandPassesAfter: boolean;

  toolCalls: number;
  failedToolCalls: number;
  turns: number;
  costUsd: number;
  durationMs: number;

  injections: readonly Injection[];
  nexusMemToolCalls: number;
}

export interface TrialScore {
  scenario: string;
  arm: Arm;
  repeat: number;
  measured: boolean;

  /**
   * PRIMARY. The run edited a file a *disproved* approach lives in before it
   * reached a real fix (the designated one, or a named valid alternative).
   * Null for scenarios that seed no dead end.
   */
  repeatedDeadEnd: boolean | null;

  taskSuccess: boolean;
  /** Reached a real fix: the designated one, or a named valid alternative that actually passed. */
  editedFixFile: boolean;
  /** True only when the reached fix was a `validAlternativeFixes` entry, not the designated `fix`. */
  usedAlternativeFix: boolean;
  toolCallsBeforeFix: number | null;
  deadEndsRepeated: number;
  followedIrrelevantMemory: boolean;
  toolCalls: number;
  failedToolCalls: number;
  turns: number;
  costUsd: number;
  durationMs: number;
  memoryDelivered: boolean;
  usefulMemoryDelivery: boolean;
  proactiveMcpCalls: number;
}

const INFINITY_INDEX = Number.POSITIVE_INFINITY;

/** Same path-matching rule as ambient-v2's scorer: exact, never a substring. See its own doc comment. */
export function pathTokens(text: string): string[] {
  return (text.match(/[A-Za-z0-9_.\-/\\:~]+/g) ?? [])
    .map((t) => t.split('\\').join('/').replace(/[.:]+$/, '').replace(/^\.\//, ''))
    .filter(Boolean);
}

const leaf = (file: string): string => file.split('/').pop()!;
const absolute = (token: string): boolean => token.startsWith('/') || /^[A-Za-z]:\//.test(token);

export function names(text: string, file: string): boolean {
  return pathTokens(text).some((token) => {
    if (!token.includes('/')) return token === leaf(file);
    return token === file || (absolute(token) && token.endsWith(`/${file}`));
  });
}

export function scoreTrial(record: TrialRecord, scenario: V3Scenario): TrialScore {
  const measured = !record.systemFailure && !record.error;
  const indexOf = (file: string): number => record.editIndex[file] ?? INFINITY_INDEX;

  const alternativeFiles = new Set(scenario.validAlternativeFixes.map((e) => e.file));
  // A designated-fix reach, or the earliest reach of an alternative-fix file
  // that actually coincided with the command passing -- an alternative edit
  // that did NOT make it pass is not a fix, it is just another attempt in
  // the same file as one, and must still be able to count as a dead end.
  const alternativeIndex =
    record.commandPassesAfter && alternativeFiles.size > 0
      ? Math.min(...scenario.validAlternativeFixes.map((e) => indexOf(e.file)), INFINITY_INDEX)
      : INFINITY_INDEX;
  const solutionIndex = Math.min(indexOf(scenario.fix.file), alternativeIndex);

  /**
   * `editIndex` records only the FIRST edit to a file, never each edit's own
   * content -- so a dead end and its file's own valid alternative, if they
   * share a file (`src/retention.js` is both `RETENTION_DEAD_COERCE` and
   * `RETENTION_ALT_FIX` here), are indistinguishable by index alone. This is
   * resolved in the direction the acceptance criterion demands ("the scorer
   * accepts every fix that makes check.js pass"): when the command passed,
   * `alternativeIndex` above already equals that same file's index, which
   * makes `solutionIndex` equal to it too -- so the dead-end entry for that
   * file fails `at < solutionIndex` (`at` cannot be *before* itself) and is
   * excluded here, rather than counted as a repeat. A file with no valid
   * alternative keeps the ordinary, stricter comparison.
   */
  const repeatedBeforeSolution = scenario.deadEnds.filter((e) => indexOf(e.file) < solutionIndex);

  const deliveredBeforeSolution = record.injections.filter((i) => i.index < solutionIndex);
  const usefulMemoryDelivery =
    solutionIndex !== INFINITY_INDEX &&
    repeatedBeforeSolution.length === 0 &&
    deliveredBeforeSolution.some((i) => names(i.text, scenario.fix.file) || [...alternativeFiles].some((f) => names(i.text, f)));

  return {
    scenario: record.scenario,
    arm: record.arm,
    repeat: record.repeat,
    measured,

    repeatedDeadEnd: scenario.deadEnds.length === 0 ? null : repeatedBeforeSolution.length > 0,

    taskSuccess: record.commandPassesAfter,
    editedFixFile: solutionIndex !== INFINITY_INDEX,
    usedAlternativeFix: alternativeIndex !== INFINITY_INDEX && alternativeIndex <= indexOf(scenario.fix.file),
    toolCallsBeforeFix: solutionIndex === INFINITY_INDEX ? null : solutionIndex,
    deadEndsRepeated: scenario.deadEnds.filter((e) => indexOf(e.file) !== INFINITY_INDEX).length,
    followedIrrelevantMemory: scenario.noiseFiles.some((f) => indexOf(f) !== INFINITY_INDEX),
    toolCalls: record.toolCalls,
    failedToolCalls: record.failedToolCalls,
    turns: record.turns,
    costUsd: record.costUsd,
    durationMs: record.durationMs,
    memoryDelivered: record.injections.length > 0,
    usefulMemoryDelivery,
    proactiveMcpCalls: record.nexusMemToolCalls,
  };
}

export interface ArmSummary {
  arm: Arm;
  measured: number;
  excluded: number;
  repeatedDeadEnd: [number, number];
  taskSuccess: [number, number];
  usefulMemoryDelivery: [number, number];
  medianToolCalls: number | null;
  totalCostUsd: number;
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const ratio = (rows: readonly TrialScore[], pick: (s: TrialScore) => boolean | null): [number, number] => {
  const scored = rows.map(pick).filter((v): v is boolean => v !== null);
  return [scored.filter(Boolean).length, scored.length];
};

export function summariseArm(arm: Arm, all: readonly TrialScore[]): ArmSummary {
  const cell = all.filter((s) => s.arm === arm);
  const rows = cell.filter((s) => s.measured);
  return {
    arm,
    measured: rows.length,
    excluded: cell.length - rows.length,
    repeatedDeadEnd: ratio(rows, (s) => s.repeatedDeadEnd),
    taskSuccess: ratio(rows, (s) => s.taskSuccess),
    usefulMemoryDelivery: ratio(rows, (s) => s.usefulMemoryDelivery),
    medianToolCalls: median(rows.map((s) => s.toolCalls)),
    totalCostUsd: rows.reduce((sum, s) => sum + s.costUsd, 0),
  };
}

/**
 * Gate before a full run, not after: ambient-v2's own precondition ("the
 * control arm has to actually hit dead ends sometimes, or no arm can be seen
 * doing better") failed silently and was only found by reading the results
 * of a 63-trial run. This makes that check itself, callable against a small
 * pilot's scores, so a design that cannot discriminate is caught before
 * spending the full sample on it.
 *
 * `minRate` has no formal power calculation behind it either, same
 * disclosure as ambient-v2's own sample-size section: it is a floor picked
 * to catch exactly the ambient-v2 failure mode (1/14 ~= 0.07), not a
 * statistically derived minimum.
 */
export interface PilotGate {
  ok: boolean;
  controlRate: number;
  controlDenominator: number;
  reason?: string;
}

export function checkPilotDiscriminates(pilotScores: readonly TrialScore[], minRate = 0.3): PilotGate {
  const control = pilotScores.filter((s) => s.arm === 'control' && s.measured);
  const [hits, denom] = ratio(control, (s) => s.repeatedDeadEnd);
  if (denom === 0) {
    return { ok: false, controlRate: 0, controlDenominator: 0, reason: 'no measured control-arm trial seeded a dead end' };
  }
  const controlRate = hits / denom;
  if (controlRate < minRate) {
    return {
      ok: false,
      controlRate,
      controlDenominator: denom,
      reason: `control dead-end rate ${hits}/${denom} (${(controlRate * 100).toFixed(0)}%) is below the ${(minRate * 100).toFixed(0)}% floor -- no arm can be seen doing better than a rate this low`,
    };
  }
  return { ok: true, controlRate, controlDenominator: denom };
}
