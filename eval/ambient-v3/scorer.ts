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
 * First attempt at a fix here credited an alternative-fix file whenever the
 * command passed and the designated fix was untouched -- caught in review
 * (CodeRabbit) as still wrong the moment a run touches an alternative file
 * AND the designated fix: crediting "untouched designated fix" as the signal
 * cannot tell a repeat-then-real-fix run apart from a real alternative,
 * because it still never looks at WHEN the command actually turned green.
 * That was a second file-only heuristic patched over the first one, not a
 * fix to the underlying gap.
 *
 * The actual fix needs the one fact file-and-order data cannot supply on its
 * own: `record.passIndex`, the tool-call index the command first passed.
 * `editIndex` on its own says "this file's first edit is here"; it never
 * says which edit is still standing at any later moment, so two edits to one
 * file are indistinguishable by index alone regardless of how the "which
 * file wins" rule is phrased. Given `passIndex`, the scorer looks at every
 * candidate fix file (the designated one, or a named alternative) edited AT
 * OR BEFORE the pass and credits whichever was edited MOST RECENTLY before
 * it -- the one edit that was actually still in effect when the command
 * went green, no matter how many other candidate files were also touched
 * earlier. A dead end that shares a file with a valid alternative is scored
 * correctly regardless of how many other alternatives exist or in what
 * order they were tried, which the file-only heuristic could not promise.
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
  /** The run's own final state: did the command pass at the end, whatever happened in between. */
  commandPassesAfter: boolean;
  /**
   * Tool-call index of the FIRST time the command passed, or null if it
   * never did. Distinct from `commandPassesAfter`: a run can pass once, then
   * break it again later and still end with `commandPassesAfter: false` (or
   * the reverse is impossible -- ending green means it passed at least
   * once). This is what lets the scorer identify *which* edit was actually
   * in effect at the moment the command first went green, instead of only
   * knowing that some edit, at some point, eventually did.
   */
  passIndex: number | null;

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

const editIndexOf = (record: TrialRecord, file: string): number => record.editIndex[file] ?? INFINITY_INDEX;

/** Every file that counts as reaching a real fix: the designated one, then every named alternative. */
const fixCandidateFiles = (scenario: V3Scenario): string[] => [scenario.fix.file, ...scenario.validAlternativeFixes.map((e) => e.file)];

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

interface Solution {
  file: string | null;
  index: number;
}

/**
 * Which edit was actually in effect when the command first went green: among
 * every candidate fix file (the designated one, or a named alternative)
 * edited at or before `passIndex`, the one edited most recently. Any earlier
 * edit to a candidate file was superseded before the pass and explains
 * nothing about it -- credit goes to whatever was still standing at the
 * moment that mattered, not to whichever candidate happens to sort first.
 *
 * A tie (two candidates edited at the same tool-call index, which a real
 * transcript cannot produce but a hand-built test record could) prefers the
 * designated fix, so a degenerate input never silently manufactures an
 * alternative-fix credit.
 */
function findSolution(record: TrialRecord, scenario: V3Scenario): Solution {
  if (record.passIndex === null) return { file: null, index: INFINITY_INDEX };
  const candidates = fixCandidateFiles(scenario)
    .map((file) => ({ file, index: editIndexOf(record, file) }))
    .filter((c) => c.index <= record.passIndex!);
  if (candidates.length === 0) return { file: null, index: INFINITY_INDEX };
  candidates.sort((a, b) => b.index - a.index || (a.file === scenario.fix.file ? -1 : 1));
  return candidates[0]!;
}

export function scoreTrial(record: TrialRecord, scenario: V3Scenario): TrialScore {
  const measured = !record.systemFailure && !record.error;
  const indexOf = (file: string): number => editIndexOf(record, file);

  const solution = findSolution(record, scenario);
  const solutionIndex = solution.index;

  const repeatedBeforeSolution = scenario.deadEnds.filter((e) => indexOf(e.file) < solutionIndex);

  const deliveredBeforeSolution = record.injections.filter((i) => i.index < solutionIndex);
  const usefulMemoryDelivery =
    solutionIndex !== INFINITY_INDEX &&
    repeatedBeforeSolution.length === 0 &&
    deliveredBeforeSolution.some((i) => fixCandidateFiles(scenario).some((f) => names(i.text, f)));

  return {
    scenario: record.scenario,
    arm: record.arm,
    repeat: record.repeat,
    measured,

    repeatedDeadEnd: scenario.deadEnds.length === 0 ? null : repeatedBeforeSolution.length > 0,

    taskSuccess: record.commandPassesAfter,
    editedFixFile: solutionIndex !== INFINITY_INDEX,
    usedAlternativeFix: solution.file !== null && solution.file !== scenario.fix.file,
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
