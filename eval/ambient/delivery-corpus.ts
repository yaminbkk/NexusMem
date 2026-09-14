import { canonicalizeCommand } from '../../src/agent/event.js';

/**
 * Does the intended memory actually reach the model?
 *
 * Phase 5 answered that empirically and badly: recall fired in 2 of 9 ambient
 * trials, not because the history was missing but because the live command
 * text never matched it. This corpus turns that into something deterministic
 * that can be re-run in a second, without spending a model trial.
 *
 * Every `observed > 0` case below is a command shape Claude Code actually
 * emitted during the Phase-5 eval, with the repository path substituted and
 * the count of how many of the 69 task-execution Bash calls used it. Nothing
 * here is invented to flatter the matcher.
 *
 * The `no-match` cases are the opposite problem and are NOT from the corpus:
 * Claude emitted no unsafe compound at all in those 69 calls, so a false
 * positive cannot be measured against real data. They are constructed
 * adversarially instead, which is stated rather than glossed -- a precision
 * figure derived from cases you wrote yourself is weaker evidence than a
 * recall figure derived from cases you observed, and the report says so.
 *
 * Data and measurement only, with no module-level side effect, so the gate in
 * `tests/agent-delivery-coverage.test.ts` can import it. Run
 * `npx tsx eval/ambient/delivery-report.ts` to print it.
 */

/** The historical execution every case is trying to find in memory. */
export const TARGET = 'node check.js';

export type Expectation = 'match' | 'no-match' | 'unknown';

export interface DeliveryCase {
  /** Built from the cwd so the same shape can be checked against any repository path. */
  command: (cwd: string) => string;
  /** How many of the 69 real Phase-5 task-execution Bash calls used this shape. */
  observed: number;
  expect: Expectation;
  why: string;
}

export const DELIVERY_CASES: readonly DeliveryCase[] = [
  // --- observed: navigation and observation around the target ---------------
  { command: (d) => `cd "${d}" && ${TARGET}`, observed: 11, expect: 'match', why: 'cd to the event cwd is transport' },
  { command: (d) => `cd "${d}" && ${TARGET}; echo "exit: $?"`, observed: 16, expect: 'match', why: 'trailing echo reads the swallowed exit status' },
  { command: (d) => `cd "${d}" && ${TARGET}; echo "exit=$?"`, observed: 6, expect: 'match', why: 'same, "=" spelling' },
  { command: (d) => `cd "${d}" && ${TARGET}; echo "EXIT: $?"`, observed: 5, expect: 'match', why: 'same, upper case' },
  { command: (d) => `cd "${d}" && ${TARGET}; echo "EXIT:$?"`, observed: 4, expect: 'match', why: 'same, no space' },
  { command: (d) => `cd "${d}" && ${TARGET}; echo "Exit: $?"`, observed: 1, expect: 'match', why: 'same, mixed case' },
  { command: (d) => `cd "${d}" && ls && ${TARGET}`, observed: 3, expect: 'match', why: 'ls is read-only' },
  { command: (d) => `cd "${d}" && ls && echo "---" && ${TARGET}`, observed: 2, expect: 'match', why: 'ls + echo separator, both read-only' },
  { command: (d) => `cd "${d}" && ls -la && echo --- && ${TARGET}`, observed: 1, expect: 'match', why: 'unquoted echo argument' },
  { command: () => `${TARGET}; echo "EXIT: $?"`, observed: 3, expect: 'match', why: 'no cd, trailing echo' },
  { command: () => `${TARGET}; echo "exit: $?"`, observed: 2, expect: 'match', why: 'no cd, trailing echo' },
  { command: () => `${TARGET}; echo "EXIT:$?"`, observed: 2, expect: 'match', why: 'no cd, trailing echo' },
  { command: () => TARGET, observed: 1, expect: 'match', why: 'the bare historical form itself' },

  // --- observed: pipelines, deliberately left unresolved ---------------------
  {
    command: (d) => `cd "${d}" && ${TARGET} 2>&1 | head -100`,
    observed: 11,
    expect: 'unknown',
    why: 'head closing the pipe can change the producer, and the exit status becomes head\'s',
  },
  { command: () => `${TARGET} 2>&1 | head -100`, observed: 1, expect: 'unknown', why: 'same, without the cd' },

  // --- constructed: things that must never collapse to the target -----------
  { command: () => `setup && ${TARGET}`, observed: 0, expect: 'no-match', why: 'unrecognised word could do anything' },
  { command: () => `export X=1 && ${TARGET}`, observed: 0, expect: 'no-match', why: 'changes the environment the target runs in' },
  { command: () => `VAR=x ${TARGET}`, observed: 0, expect: 'no-match', why: 'inline env assignment' },
  { command: () => `node build.js && ${TARGET}`, observed: 0, expect: 'no-match', why: 'a second real execution' },
  { command: () => `npm install && ${TARGET}`, observed: 0, expect: 'no-match', why: 'mutates the dependency tree' },
  { command: () => `make && ${TARGET}`, observed: 0, expect: 'no-match', why: 'builds before the target runs' },
  { command: () => `source .env && ${TARGET}`, observed: 0, expect: 'no-match', why: 'loads environment into the shell' },
  { command: () => `. ./env.sh && ${TARGET}`, observed: 0, expect: 'no-match', why: 'dot-source, same as source' },
  { command: () => `sudo ${TARGET}`, observed: 0, expect: 'no-match', why: 'different privileges is a different execution' },
  { command: () => `${TARGET} ; cleanup`, observed: 0, expect: 'no-match', why: 'unrecognised trailing command' },
  { command: () => `${TARGET} && rm -rf dist`, observed: 0, expect: 'no-match', why: 'destructive trailing command' },
  { command: () => `git checkout main && ${TARGET}`, observed: 0, expect: 'no-match', why: 'mutating git subcommand' },
  { command: () => `git stash && ${TARGET}`, observed: 0, expect: 'no-match', why: 'mutating git subcommand' },
  { command: () => `chmod +x run.sh && ${TARGET}`, observed: 0, expect: 'no-match', why: 'changes the working tree' },
  { command: () => `docker run app && ${TARGET}`, observed: 0, expect: 'no-match', why: 'a second real execution' },
  { command: () => `echo seed > fixture.txt && ${TARGET}`, observed: 0, expect: 'no-match', why: 'redirection writes a file' },
  { command: () => `echo $(rm -rf build) && ${TARGET}`, observed: 0, expect: 'no-match', why: 'command substitution executes' },
  { command: () => `server & ${TARGET}`, observed: 0, expect: 'no-match', why: 'backgrounds another process' },
  { command: () => `cd /somewhere/else && ${TARGET}`, observed: 0, expect: 'no-match', why: 'a different directory is a different run' },
  { command: () => `cat fixture.json > input.json && ${TARGET}`, observed: 0, expect: 'no-match', why: 'read-only head word, but the redirection writes' },
];

export interface DeliveryMeasurement {
  /** By distinct command shape. */
  shapes: { matched: number; total: number };
  /** Weighted by how often the shape really occurred in the Phase-5 transcripts. */
  calls: { matched: number; total: number };
  falseMatches: string[];
  unknownThatMatched: string[];
  /** Recognised safe matches / safe matches expected. */
  recall: number;
  /** Recognised safe matches / everything recognised. */
  precision: number;
}

export function measureDelivery(cwd: string, cases: readonly DeliveryCase[] = DELIVERY_CASES): DeliveryMeasurement {
  let shapesMatched = 0;
  let shapesTotal = 0;
  let callsMatched = 0;
  let callsTotal = 0;
  const falseMatches: string[] = [];
  const unknownThatMatched: string[] = [];

  for (const c of cases) {
    const raw = c.command(cwd);
    const matched = canonicalizeCommand(raw, cwd) === TARGET;

    if (c.expect === 'match') {
      shapesTotal += 1;
      callsTotal += c.observed;
      if (matched) {
        shapesMatched += 1;
        callsMatched += c.observed;
      }
    } else if (c.expect === 'no-match') {
      if (matched) falseMatches.push(raw);
    } else if (matched) {
      unknownThatMatched.push(raw);
    }
  }

  const recognised = shapesMatched + falseMatches.length + unknownThatMatched.length;
  return {
    shapes: { matched: shapesMatched, total: shapesTotal },
    calls: { matched: callsMatched, total: callsTotal },
    falseMatches,
    unknownThatMatched,
    recall: shapesTotal === 0 ? 1 : shapesMatched / shapesTotal,
    precision: recognised === 0 ? 1 : shapesMatched / recognised,
  };
}

export function renderDelivery(m: DeliveryMeasurement): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return [
    `execution-match recall   ${m.shapes.matched}/${m.shapes.total} shapes  ${pct(m.recall)}`,
    `  weighted by real calls ${m.calls.matched}/${m.calls.total} calls   ${pct(m.calls.total === 0 ? 1 : m.calls.matched / m.calls.total)}`,
    `execution-match precision ${pct(m.precision)}  (${m.falseMatches.length} false match(es))`,
    ...m.falseMatches.map((c) => `  FALSE MATCH  ${c}`),
    ...m.unknownThatMatched.map((c) => `  UNKNOWN RESOLVED  ${c}`),
  ].join('\n');
}
