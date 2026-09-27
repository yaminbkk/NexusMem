import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Pure, generic helpers only -- nothing scenario-specific, so importing them
// creates no dependency on ambient-v2's own frozen scenarios/scorer/fixtures,
// and touches nothing that would change ambient-v2's own recorded fingerprint.
import { canonical, canonicalEvents, FINGERPRINT_EPOCH, PLACEHOLDER_ROOT, productFingerprints } from '../ambient-v2/fingerprint.js';
import { V3_SCENARIOS, type V3Scenario } from './scenario.js';

/**
 * Stable hashes over everything a v3 trial's meaning depends on.
 *
 * Deliberately its own, separate `design` hash from ambient-v2's: this is the
 * whole point of #20 -- a v3 result must never be pooled with a v2 one, and
 * a shared or coincidentally-equal hash would be exactly the failure mode
 * that guards against.
 *
 *   npx tsx eval/ambient-v3/fingerprint.ts
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
const sourceOf = (file: string): string => readFileSync(join(HERE, file), 'utf8').split('\r\n').join('\n');

export function scenarioShape(scenario: V3Scenario): unknown {
  const events = scenario.events(PLACEHOLDER_ROOT, FINGERPRINT_EPOCH);
  return {
    name: scenario.name,
    command: scenario.command,
    task: scenario.task,
    deadEnds: scenario.deadEnds,
    validAlternativeFixes: scenario.validAlternativeFixes,
    fix: scenario.fix,
    noiseFiles: scenario.noiseFiles,
    primaryEndpoint: scenario.primaryEndpoint,
    history: scenario.history,
    events: canonicalEvents(events),
  };
}

export interface Fingerprints {
  scenarios: string;
  fixtures: string;
  prompts: string;
  scorer: string;
  /** One hash over all of the above. This is the number to quote. */
  design: string;
}

/**
 * Only what actually exists for v3 today: the pilot harness this design still
 * needs (an ambient-v3 `run.ts`, isolation checks, trial order) is deferred
 * pending the authorization to spend on real model trials -- see the issue.
 * Fabricating hashes for pieces that are not written yet would claim more
 * than this fingerprint can back up.
 */
export function fingerprints(): Fingerprints {
  const parts = {
    scenarios: sha(canonical(V3_SCENARIOS.map(scenarioShape))),
    fixtures: sha(`${sourceOf('scenario.ts')}\n${sourceOf('fixture.ts')}`),
    prompts: sha(canonical(V3_SCENARIOS.map((s) => s.task))),
    scorer: sha(sourceOf('scorer.ts')),
  };
  return { ...parts, design: sha(canonical(parts)) };
}

export { productFingerprints };

if (process.argv[1]?.split(/[\\/]/).pop() === 'fingerprint.ts') {
  const printed = fingerprints();
  for (const [name, hash] of Object.entries(printed)) process.stdout.write(`${name.padEnd(11)} ${hash}\n`);
  const product = productFingerprints(join(HERE, '..', '..'));
  process.stdout.write(`\nproduct\n  source    ${product.source ?? 'missing'}\n  build     ${product.build ?? 'missing (run npm run build)'}\n`);
}
