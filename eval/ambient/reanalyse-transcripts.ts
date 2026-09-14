import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIOS } from './scenario.js';

/**
 * Recomputes the injection-derived fields of an already-collected eval run
 * from its saved transcript, without re-invoking `claude`.
 *
 * Exists because `scripts/eval-ambient.ts`'s own `readTranscript` had a real
 * bug (fixed there in the same change that added this script): a hook's
 * output does not arrive in one consistent shape. `SessionStart` prints
 * plain text, which Claude Code records directly in the attachment's
 * `content` field; `PostToolUse`/`PostToolUseFailure` recall instead prints
 * a JSON envelope, and Claude Code leaves `content` EMPTY for that shape,
 * putting the raw stdout in `stdout` instead. The harness checked `content`
 * alone, so it reported recall firing 0/9 in this rerun's first pass when it
 * had actually fired in 2/9 -- invisible only to the analysis, not absent
 * from the transcripts, which is why this replays the same saved data rather
 * than re-running any trial. `scripts/eval-ambient.ts` cannot be imported
 * here to share the fixed function directly: it auto-runs a live eval as a
 * module-level side effect, so `extractHookInjection` below is a deliberate,
 * kept-in-sync-by-hand duplicate of the one now in that file.
 *
 * Usage: npx tsx eval/ambient/reanalyse-transcripts.ts <resultsJsonPath> <transcriptSearchDir...>
 * Overwrites <resultsJsonPath> in place; the original is not touched unless
 * this succeeds for every row.
 */

const UNRELATED_COMMANDS = ['npm run lint', 'npm run typecheck'];
const bullets = (text: string): string[] => text.split(/\r?\n/).filter((l) => l.trimStart().startsWith('- '));

function extractHookInjection(hook: { type?: string; content?: unknown; stdout?: unknown }): string | null {
  if (!hook.type?.startsWith('hook')) return null;
  if (typeof hook.content === 'string' && hook.content.includes('NexusMem:')) return hook.content;
  if (typeof hook.stdout === 'string') {
    try {
      const parsed = JSON.parse(hook.stdout) as { hookSpecificOutput?: { additionalContext?: unknown } };
      const ctx = parsed.hookSpecificOutput?.additionalContext;
      if (typeof ctx === 'string' && ctx.includes('NexusMem:')) return ctx;
    } catch {
      // stdout wasn't JSON -- SessionStart's plain-text form is already handled above.
    }
  }
  return null;
}

interface Row {
  scenario: string;
  arm: string;
  repeat: number;
  injections: number;
  injectedChars: number;
  irrelevantInjections: number;
  recallItems: number;
  irrelevantRecallItems: number;
  recallFired: boolean;
  recallFiredCount: number;
  recallContainedABC: boolean;
  digestFired: boolean;
  digestContainedResolvedChain: boolean;
  digestContainedStaleWarning: boolean;
  digestDisplaced: boolean;
  [key: string]: unknown;
}

function findTranscript(searchDirs: readonly string[], scenario: string, arm: string, repeat: number): string | null {
  for (const dir of searchDirs) {
    const p = join(dir, scenario, arm, String(repeat), 'transcript.jsonl');
    if (existsSync(p)) return p;
  }
  return null;
}

function recompute(row: Row, transcriptPath: string): Row {
  const scenario = SCENARIOS.find((s) => s.name === row.scenario);
  if (!scenario) throw new Error(`unknown scenario in results.json: ${row.scenario}`);

  const injections: string[] = [];
  for (const line of readFileSync(transcriptPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: { attachment?: { type?: string; content?: unknown; stdout?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry.attachment) continue;
    const text = extractHookInjection(entry.attachment);
    if (text) injections.push(text);
  }

  const injectedChars = injections.reduce((sum, i) => sum + i.length, 0);
  const items = injections.flatMap(bullets);
  const firstLine = scenario.command.split(/\r?\n/)[0]!;

  return {
    ...row,
    injections: injections.length,
    injectedChars,
    irrelevantInjections: injections.filter((i) => UNRELATED_COMMANDS.some((c) => i.includes(c)) && !i.includes(scenario.command)).length,
    recallItems: items.length,
    irrelevantRecallItems: items.filter((i) => UNRELATED_COMMANDS.some((c) => i.includes(c))).length,
    recallFired: injections.some((i) => i.includes('failed in this repository before')),
    recallFiredCount: injections.filter((i) => i.includes('failed in this repository before')).length,
    recallContainedABC: injections.some(
      (i) =>
        i.includes('failed in this repository before') &&
        [scenario.attemptA.file, scenario.attemptB.file, scenario.attemptC.file].some((f) => i.includes(f) || i.includes(f.split('/').pop()!)),
    ),
    digestFired: injections.some((i) => i.includes('relevant command(s) from the last')),
    digestContainedResolvedChain: injections.some((i) => i.includes('relevant command(s) from the last') && i.includes('fixed')),
    digestContainedStaleWarning: injections.some((i) => i.includes('no longer holds')),
    digestDisplaced: injections.some((i) => {
      if (!i.includes('relevant command(s) from the last')) return false;
      const ownIndex = i.indexOf(firstLine);
      if (ownIndex === -1) return false;
      return UNRELATED_COMMANDS.some((c) => i.includes(c) && i.indexOf(c) < ownIndex);
    }),
  };
}

async function main(): Promise<void> {
  const [resultsPath, ...searchDirs] = process.argv.slice(2);
  if (!resultsPath || searchDirs.length === 0) {
    throw new Error('usage: reanalyse-transcripts.ts <resultsJsonPath> <transcriptSearchDir...>');
  }
  const rows = JSON.parse(readFileSync(resultsPath, 'utf8')) as Row[];
  const before = { recallFired: 0, digestFired: 0 };
  const after = { recallFired: 0, digestFired: 0 };
  const changed: string[] = [];

  const updated = rows.map((row) => {
    before.recallFired += row.recallFired ? 1 : 0;
    before.digestFired += row.digestFired ? 1 : 0;
    if (row.arm !== 'ambient') return row; // only ambient carries hook injections at all
    const transcriptPath = findTranscript(searchDirs, row.scenario, row.arm, row.repeat);
    if (!transcriptPath) {
      process.stdout.write(`  no transcript found for ${row.scenario}/${row.arm}/${row.repeat}, leaving as-is\n`);
      return row;
    }
    const next = recompute(row, transcriptPath);
    after.recallFired += next.recallFired ? 1 : 0;
    after.digestFired += next.digestFired ? 1 : 0;
    if (next.recallFired !== row.recallFired || next.digestFired !== row.digestFired || next.injectedChars !== row.injectedChars) {
      changed.push(`${row.scenario}/${row.arm}/${row.repeat}: recallFired ${row.recallFired}->${next.recallFired}, digestFired ${row.digestFired}->${next.digestFired}, injectedChars ${row.injectedChars}->${next.injectedChars}`);
    }
    return next;
  });

  writeFileSync(resultsPath, JSON.stringify(updated, null, 2));
  process.stdout.write(`\nrows: ${rows.length}\n`);
  process.stdout.write(`recallFired: ${before.recallFired} -> ${after.recallFired}\n`);
  process.stdout.write(`digestFired: ${before.digestFired} -> ${after.digestFired}\n`);
  process.stdout.write(`\nchanged rows (${changed.length}):\n${changed.map((c) => `  ${c}`).join('\n')}\n`);
  process.stdout.write(`\nwrote: ${resultsPath}\n`);
}

await main();
