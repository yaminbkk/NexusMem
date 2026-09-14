import { DELIVERY_CASES, measureDelivery, renderDelivery } from './delivery-corpus.js';

/**
 * Prints the execution-match delivery figures for the Phase-5 command corpus.
 * The pass/fail gate lives in `tests/agent-delivery-coverage.test.ts`; this is
 * for reading the numbers, including the per-shape breakdown.
 *
 *   npx tsx eval/ambient/delivery-report.ts [cwd]
 */

const CWD = process.argv[2] ?? 'C:\\Users\\dev\\AppData\\Local\\Temp\\workspace-aCFzjL\\app';
const measurement = measureDelivery(CWD);

process.stdout.write(`\ncwd used for the cd-wrapped shapes:\n  ${CWD}\n\n`);
process.stdout.write(`${renderDelivery(measurement)}\n\n`);

const label: Record<string, string> = { match: 'MATCH  ', 'no-match': 'NO-MATCH', unknown: 'UNKNOWN' };
for (const c of DELIVERY_CASES) {
  const raw = c.command(CWD).replace(CWD, '<cwd>');
  const seen = c.observed > 0 ? `${String(c.observed).padStart(2)} calls` : ' constructed';
  process.stdout.write(`  ${label[c.expect]}  ${seen}  ${raw}\n`);
}
process.stdout.write('\n');
