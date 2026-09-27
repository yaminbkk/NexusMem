import { join } from 'node:path';
import type { RawAgentEvent } from '../../src/agent/event.js';
import { buildRepo, type Commit, type Edit } from './fixture.js';

/**
 * ambient-v3: the ambient-v2 fixture's own commit subjects named what was
 * tried and that it failed ("fix(config): raise the retention default...
 * First attempt at the failing check.", "revert: raising the default did not
 * change the effective value..."), so every arm -- including the memoryless
 * control -- could rediscover the dead ends with a plain `git log`. Measured
 * directly: the ambient-v2 run's control-arm dead-end rate was 1/14, far
 * below what the design needed to discriminate between arms at all.
 *
 * Fixed here two ways:
 *
 * 1. `build()` writes exactly one commit, the current broken state, with a
 *    generic message. `git log` and the working tree contain no trace of any
 *    prior attempt -- verified directly in tests/eval-v3-scenario.test.ts.
 *    Every attempt lives only in `events()`, the agent-event log an installed
 *    hook would have written, which is what NexusMem's ambient memory reads
 *    and a bare `git log` cannot see at all. That gap is the whole product
 *    claim, so the fixture has to actually depend on it to test it.
 *
 * 2. The ambient-v2 scorer also called `src/retention.js` a proven dead end
 *    outright, because one specific edit to it (coercing the configured
 *    value with `Number(...)`) was disproved -- but raising the floor
 *    `MIN_RETENTION_DAYS` in that same file is a different edit that
 *    genuinely makes `check.js` pass, and the file-level scorer could not
 *    tell the two apart. `validAlternativeFixes` names that edit explicitly,
 *    and `scorer.ts` never calls it a repeated dead end when the command
 *    actually passed. See "the retention case" test in
 *    tests/eval-v3-scenario.test.ts.
 */

export const TASK =
  '`node check.js` is failing in this repository. Find out why and fix it so the command exits 0. Do not change check.js itself.';

export interface V3Scenario {
  name: string;
  /** The command the agent is asked to fix, and which scoring re-runs. */
  command: string;
  /** Approaches the seeded agent history proves were tried and left the check failing. */
  deadEnds: readonly Edit[];
  /**
   * Edits that are NOT the scenario's designated `fix` but genuinely make the
   * command pass -- a scorer that calls one of these a "repeated dead end"
   * merely because it shares a file with one is wrong, and this is the fix
   * for that (see `scorer.ts`).
   */
  validAlternativeFixes: readonly Edit[];
  /** The designated route to green. Not the only one -- see `validAlternativeFixes`. */
  fix: Edit;
  /** Files named only by seeded off-topic history. Empty here: out of scope for this fixture's own bug. */
  noiseFiles: readonly string[];
  /** Whether this scenario contributes to a frozen primary endpoint, once one exists for v3. */
  primaryEndpoint: boolean;
  task: string;
  /** Git history: deliberately just enough to exist, never enough to narrate. */
  history: readonly Commit[];
  build(dir: string): void;
  /** Day-1 agent events, as the adapter would hand them over. `now` is explicit so fingerprints are stable. */
  events(repoDir: string, now: number): RawAgentEvent[];
}

/** One day-1 attempt: the file it edited, then the command's result. */
interface Attempt {
  file: string;
  outcome: 'ok' | 'fail';
  errorSignature?: string;
  /** Minutes after the start of day 1. */
  at: number;
}

/**
 * The event log an installed hook would have written on the day this was
 * first worked on. Deliberately a copy of the shape `eval/ambient-v2/scenario.ts`
 * uses internally (that function is not exported, for the same freeze reason
 * `fixture.ts` gives), trimmed to what this fixture needs: no unrelated noise
 * chain, since which-history-is-noise is not the bug this set exists to fix.
 */
function agentEvents(repoDir: string, command: string, attempts: readonly Attempt[], sessionId: string, now: number): RawAgentEvent[] {
  const daysAgo = 7;
  const at = (minutes: number) => new Date(now - (daysAgo * 24 * 60 - minutes) * 60_000).toISOString();
  const base = { agent: 'claude-code', sessionId, cwd: repoDir, durationMs: 1500 };

  const events: RawAgentEvent[] = [];
  let n = 0;
  for (const attempt of attempts) {
    n += 1;
    events.push({
      ...base,
      eventId: `e${n}a`,
      ts: at(attempt.at),
      kind: 'edit',
      filePath: join(repoDir, attempt.file),
      outcome: 'ok',
      exitCode: null,
    });
    events.push({
      ...base,
      eventId: `e${n}b`,
      ts: at(attempt.at + 1),
      kind: 'command',
      command,
      outcome: attempt.outcome,
      exitCode: attempt.outcome === 'ok' ? 0 : 1,
      ...(attempt.errorSignature ? { errorSignature: attempt.errorSignature } : {}),
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// shadowed-config-v3 -- same fixture content as ambient-v2's shadowed-config
// (the shape itself was never the problem), rebuilt so the git side of it
// says nothing and the scorer can tell a real alternative fix from a repeat.
// ---------------------------------------------------------------------------

const LINT_CONFIG = `{
  "root": true,
  "rules": {}
}
`;

const RETENTION_FILES: Record<string, string> = {
  'check.js': `const { loadSettings } = require('./src/config/load.js');
const { effectiveRetention } = require('./src/retention.js');

const days = effectiveRetention(loadSettings(__dirname));
if (days !== 30) {
  console.error('retention must be 30 days, got ' + days);
  process.exit(1);
}
console.log('ok');
`,
  'config/defaults.json': `{
  "retentionDays": 7,
  "archive": true
}
`,
  'config/site.json': `{
  "retentionDays": 7,
  "region": "eu"
}
`,
  'src/config/load.js': `const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

function loadSettings(root) {
  const dir = join(root, 'config');
  const merged = {};
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    Object.assign(merged, JSON.parse(readFileSync(join(dir, name), 'utf8')));
  }
  return merged;
}

module.exports = { loadSettings };
`,
  'src/retention.js': `const MIN_RETENTION_DAYS = 1;

function effectiveRetention(settings) {
  return Math.max(MIN_RETENTION_DAYS, settings.retentionDays);
}

module.exports = { effectiveRetention, MIN_RETENTION_DAYS };
`,
  'src/archive.js': `const { effectiveRetention } = require('./retention.js');

function shouldArchive(settings, ageDays) {
  return settings.archive === true && ageDays > effectiveRetention(settings);
}

module.exports = { shouldArchive };
`,
  '.eslintrc.json': LINT_CONFIG,
  'docs/operations.md': `# Operations runbook

## Rotating a profile

The deployment profile is reviewed every quarter. The steps below describe the
review, not the values themselves.

1. Open the review ticket
2. Confirm the profile owner
3. Record the outcome
`,
};

const RETENTION_FIX: Edit = { file: 'config/site.json', from: '"retentionDays": 7', to: '"retentionDays": 30' };

/** Disproved on day 1: raising the default nothing reads does not change the effective value. */
const RETENTION_DEAD_DEFAULTS: Edit = { file: 'config/defaults.json', from: '"retentionDays": 7', to: '"retentionDays": 30' };
/** Disproved on day 1: coercing the type does not change which value wins. */
const RETENTION_DEAD_COERCE: Edit = {
  file: 'src/retention.js',
  from: 'Math.max(MIN_RETENTION_DAYS, settings.retentionDays)',
  to: 'Math.max(MIN_RETENTION_DAYS, Number(settings.retentionDays))',
};
/**
 * Never tried on day 1, never disproved, and genuinely green: raising the
 * floor itself makes `effectiveRetention` return 30 regardless of any
 * config file. Same file as the disproved coerce edit above -- that is
 * exactly the case a file-level "did it touch a dead-end file" check cannot
 * tell apart from a repeat, which is the bug `validAlternativeFixes` exists
 * to fix.
 */
const RETENTION_ALT_FIX: Edit = { file: 'src/retention.js', from: 'const MIN_RETENTION_DAYS = 1;', to: 'const MIN_RETENTION_DAYS = 30;' };

/**
 * One commit, the broken state, a message that describes nothing. Verified
 * by tests/eval-v3-scenario.test.ts to leave zero trace of either dead end
 * or of the fix in `git log` or the working tree.
 */
const SHADOWED_CONFIG_V3_HISTORY: readonly Commit[] = [{ message: 'chore: initial import', expect: 'fail' }];

export const SHADOWED_CONFIG_V3: V3Scenario = {
  name: 'shadowed-config-v3',
  command: 'node check.js',
  deadEnds: [RETENTION_DEAD_DEFAULTS, RETENTION_DEAD_COERCE],
  validAlternativeFixes: [RETENTION_ALT_FIX],
  fix: RETENTION_FIX,
  noiseFiles: [],
  primaryEndpoint: true,
  task: TASK,
  history: SHADOWED_CONFIG_V3_HISTORY,
  build: (dir) => buildRepo(dir, RETENTION_FILES, SHADOWED_CONFIG_V3_HISTORY),
  events: (repoDir, now) =>
    agentEvents(
      repoDir,
      'node check.js',
      [
        { file: 'config/defaults.json', outcome: 'fail', errorSignature: 'retention must be 30 days, got 7', at: 0 },
        { file: 'src/retention.js', outcome: 'fail', errorSignature: 'retention must be 30 days, got 7', at: 10 },
        { file: 'config/site.json', outcome: 'ok', at: 20 },
      ],
      'eval-v3-day-1-config',
      now,
    ),
};

export const V3_SCENARIOS: readonly V3Scenario[] = [SHADOWED_CONFIG_V3];
