import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Turns a finished eval's `results.json` into the rates and medians the
 * comparison is actually made on, and names the runs worth reading.
 *
 * Medians rather than means throughout: with three trials per cell one long
 * run moves a mean and says nothing. Rates are printed as counts over the
 * denominator so a difference can be weighed against the sample rather than
 * quoted as a percentage that sounds larger than it is.
 *
 *   npx tsx eval/ambient/analyse.ts <outDir>
 */

const ARMS = ['baseline', 'mcp', 'ambient'] as const;
type Arm = (typeof ARMS)[number];

/** Rough, and named so nobody reads it as measured: ~4 characters per token. */
const CHARS_PER_TOKEN = 4;

interface Run {
  scenario: string;
  arm: Arm;
  repeat: number;
  systemFailure?: string;
  error?: string;
  repeatedDeadEndA: boolean;
  repeatedDeadEndB: boolean;
  editedStaleFile: boolean;
  editedFixFile: boolean;
  commandPassesAfter: boolean;
  firstEditedFile: string | null;
  firstInvestigationAction: string | null;
  finalChangedFiles: string[];
  toolCallsBeforeFix: number | null;
  msToFix: number | null;
  toolCalls: number;
  failedToolCalls: number;
  durationMs: number;
  costUsd: number;
  injectedChars: number;
  recallItems: number;
  irrelevantRecallItems: number;
  irrelevantInjections: number;
  recallFired: boolean;
  recallFiredCount: number;
  recallContainedABC: boolean;
  digestFired: boolean;
  digestContainedResolvedChain: boolean;
  digestContainedStaleWarning: boolean;
  digestDisplaced: boolean;
  nexusMemToolCalls: number;
  noticedNexusMem: boolean;
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const num = (v: number | null, digits = 1) => (v === null ? '  -- ' : v.toFixed(digits).padStart(5));

interface Summary {
  n: number;
  success: [number, number];
  repeatedA: [number, number];
  repeatedB: [number, number];
  repeatedEither: [number, number];
  discoveredC: [number, number];
  usedCCorrectly: [number, number];
  editedStale: [number, number];
  medianToolCalls: number | null;
  medianCallsToRecovery: number | null;
  medianFailedCalls: number | null;
  medianMsToRecovery: number | null;
  medianMsToSuccess: number | null;
  medianInjectedTokens: number | null;
  recallFired: [number, number];
  /** Recall fired AND actually named the seeded A/B/C evidence -- not just "something". */
  usefulRecall: [number, number];
  totalRecallTriggers: number;
  digestFired: [number, number];
  digestResolved: [number, number];
  digestStaleWarning: [number, number];
  digestDisplaced: [number, number];
  irrelevantMemory: [number, number];
  medianRecallItems: number | null;
  medianIrrelevantItems: number | null;
  mcpToolCalls: number;
  noticed: [number, number];
  medianCostUsd: number | null;
}

function summarize(runs: readonly Run[]): Summary {
  const n = runs.length;
  const count = (p: (r: Run) => boolean): [number, number] => [runs.filter(p).length, n];
  const of = (pick: (r: Run) => number | null) => median(runs.map(pick).filter((v): v is number => v !== null));
  const succeeded = runs.filter((r) => r.commandPassesAfter);
  return {
    n,
    success: count((r) => r.commandPassesAfter),
    repeatedA: count((r) => r.repeatedDeadEndA),
    repeatedB: count((r) => r.repeatedDeadEndB),
    repeatedEither: count((r) => r.repeatedDeadEndA || r.repeatedDeadEndB),
    discoveredC: count((r) => r.editedFixFile),
    // Discovery is editing the right file; correct use is that plus a green check.
    usedCCorrectly: count((r) => r.editedFixFile && r.commandPassesAfter),
    editedStale: count((r) => r.editedStaleFile),
    medianToolCalls: of((r) => r.toolCalls),
    medianCallsToRecovery: of((r) => r.toolCallsBeforeFix),
    medianFailedCalls: of((r) => r.failedToolCalls),
    medianMsToRecovery: of((r) => r.msToFix),
    medianMsToSuccess: median(succeeded.map((r) => r.durationMs)),
    medianInjectedTokens: of((r) => Math.round(r.injectedChars / CHARS_PER_TOKEN)),
    recallFired: count((r) => r.recallFired),
    usefulRecall: count((r) => r.recallFired && r.recallContainedABC),
    totalRecallTriggers: runs.reduce((s, r) => s + r.recallFiredCount, 0),
    digestFired: count((r) => r.digestFired),
    digestResolved: count((r) => r.digestContainedResolvedChain),
    digestStaleWarning: count((r) => r.digestContainedStaleWarning),
    digestDisplaced: count((r) => r.digestDisplaced),
    irrelevantMemory: count((r) => r.irrelevantRecallItems > 0),
    medianRecallItems: of((r) => r.recallItems),
    medianIrrelevantItems: of((r) => r.irrelevantRecallItems),
    mcpToolCalls: runs.reduce((s, r) => s + r.nexusMemToolCalls, 0),
    noticed: count((r) => r.noticedNexusMem),
    medianCostUsd: of((r) => r.costUsd),
  };
}

const rate = ([a, b]: [number, number]) => `${a}/${b}`.padEnd(5);

function row(arm: string, s: Summary): string {
  return [
    `  ${arm.padEnd(9)}`,
    `success ${rate(s.success)}`,
    `A ${rate(s.repeatedA)}`,
    `B ${rate(s.repeatedB)}`,
    `either ${rate(s.repeatedEither)}`,
    `foundC ${rate(s.discoveredC)}`,
    `usedC ${rate(s.usedCCorrectly)}`,
    `stale ${rate(s.editedStale)}`,
    `calls ${num(s.medianToolCalls)}`,
    `toRec ${num(s.medianCallsToRecovery)}`,
    `failed ${num(s.medianFailedCalls)}`,
    `msRec ${num(s.medianMsToRecovery, 0)}`,
    `msWin ${num(s.medianMsToSuccess, 0)}`,
    `tok ${num(s.medianInjectedTokens, 0)}`,
    `items ${num(s.medianRecallItems, 0)}`,
    `noise ${rate(s.irrelevantMemory)}`,
    `recall ${rate(s.recallFired)}`,
    `useful ${rate(s.usefulRecall)}`,
    `digestFix ${rate(s.digestResolved)}`,
    `stale ${rate(s.digestStaleWarning)}`,
    `displaced ${rate(s.digestDisplaced)}`,
    `mcpCalls ${String(s.mcpToolCalls).padStart(3)}`,
    `noticed ${rate(s.noticed)}`,
    `$${num(s.medianCostUsd, 3)}`,
  ].join('  ');
}

/** Ranks a run for the qualitative read: green first, then cheapest recovery. */
function rank(r: Run): number {
  const recovery = r.toolCallsBeforeFix ?? 999;
  return (r.commandPassesAfter ? 0 : 1000) + recovery * 10 + r.toolCalls;
}

function representative(runs: readonly Run[]): Array<[string, Run]> {
  const sorted = [...runs].sort((a, b) => rank(a) - rank(b));
  if (sorted.length === 0) return [];
  return [
    ['best', sorted[0]!],
    ['typical', sorted[Math.floor(sorted.length / 2)]!],
    ['worst', sorted[sorted.length - 1]!],
  ];
}

const OUT_DIR = resolve(process.argv[2] ?? '');
const runs: Run[] = JSON.parse(readFileSync(join(OUT_DIR, 'results.json'), 'utf8'));
const scenarios = [...new Set(runs.map((r) => r.scenario))];

const systemFailures = runs.filter((r) => r.systemFailure);
const harnessErrors = runs.filter((r) => r.error);
process.stdout.write(`runs ${runs.length}   system failures ${systemFailures.length}   harness errors ${harnessErrors.length}\n`);
for (const f of systemFailures) process.stdout.write(`  SYSTEM FAILURE ${f.scenario}/${f.arm}/#${f.repeat}: ${f.systemFailure}\n`);
for (const f of harnessErrors) process.stdout.write(`  HARNESS ERROR  ${f.scenario}/${f.arm}/#${f.repeat}: ${f.error}\n`);

// Only runs that actually measured model behaviour are compared.
const measured = runs.filter((r) => !r.systemFailure && !r.error);

for (const scenario of scenarios) {
  process.stdout.write(`\n${scenario}\n`);
  for (const arm of ARMS) {
    const cell = measured.filter((r) => r.scenario === scenario && r.arm === arm);
    if (cell.length > 0) process.stdout.write(`${row(arm, summarize(cell))}\n`);
  }
}

process.stdout.write('\nall scenarios pooled\n');
const pooled: Record<Arm, Summary> = { baseline: summarize([]), mcp: summarize([]), ambient: summarize([]) };
for (const arm of ARMS) {
  pooled[arm] = summarize(measured.filter((r) => r.arm === arm));
  process.stdout.write(`${row(arm, pooled[arm])}\n`);
}

process.stdout.write('\npairwise, pooled (positive favours the second arm)\n');
const pairs: Array<[Arm, Arm]> = [
  ['baseline', 'mcp'],
  ['mcp', 'ambient'],
  ['baseline', 'ambient'],
];
for (const [a, b] of pairs) {
  const x = pooled[a];
  const y = pooled[b];
  const delta = (l: string, p: (s: Summary) => number | null) => {
    const va = p(x);
    const vb = p(y);
    return va === null || vb === null ? `${l} --` : `${l} ${(va - vb >= 0 ? '+' : '') + (va - vb).toFixed(1)}`;
  };
  process.stdout.write(
    `  ${a} vs ${b}: success ${x.success[0]}->${y.success[0]} of ${x.n}   dead ends ${x.repeatedEither[0]}->${y.repeatedEither[0]}   ` +
      `${delta('calls', (s) => s.medianToolCalls)}   ${delta('toRecovery', (s) => s.medianCallsToRecovery)}   ${delta('failed', (s) => s.medianFailedCalls)}\n`,
  );
}

process.stdout.write('\nrepresentative runs\n');
for (const arm of ARMS) {
  for (const [label, r] of representative(measured.filter((x) => x.arm === arm))) {
    process.stdout.write(
      `  ${arm.padEnd(9)} ${label.padEnd(8)} ${r.scenario}/#${r.repeat}  fixed=${r.commandPassesAfter} toRecovery=${r.toolCallsBeforeFix ?? '-'} calls=${r.toolCalls} failed=${r.failedToolCalls}\n` +
        `${' '.repeat(12)}first: ${r.firstInvestigationAction ?? '-'}\n` +
        `${' '.repeat(12)}changed: ${r.finalChangedFiles.join(', ') || '(nothing)'}\n`,
    );
  }
}
