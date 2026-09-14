import { describe, expect, it } from 'vitest';
import { DELIVERY_CASES, measureDelivery, renderDelivery, TARGET } from '../eval/ambient/delivery-corpus.js';
import { canonicalizeCommand } from '../src/agent/event.js';

/**
 * The delivery gate Phase 5 lacked. Phase 5 could only discover that recall
 * never reached the model by spending 27 model trials; this asserts the same
 * property deterministically, from the command shapes those trials actually
 * produced.
 *
 * The targets are asymmetric on purpose: every safe shape must be recognised,
 * no unsafe shape may be, and a shape whose equivalence cannot be argued
 * (a pipeline) must stay unrecognised rather than be forced either way.
 */

const CWD = 'C:\\Users\\dev\\AppData\\Local\\Temp\\workspace-aCFzjL\\app';

describe('execution-match delivery coverage', () => {
  const measurement = measureDelivery(CWD);

  it('recognises every command shape classified SHOULD MATCH', () => {
    expect(measurement.shapes.matched).toBe(measurement.shapes.total);
    expect(measurement.recall).toBe(1);
  });

  it('recognises every real Phase-5 call those shapes account for', () => {
    // 57 of the 69 observed task-execution calls; the other 12 are pipelines.
    expect(measurement.calls.matched).toBe(measurement.calls.total);
    expect(measurement.calls.total).toBe(57);
  });

  it('makes no false match against the adversarial set', () => {
    expect(measurement.falseMatches).toEqual([]);
  });

  it('leaves UNKNOWN shapes unknown rather than resolving them either way', () => {
    expect(measurement.unknownThatMatched).toEqual([]);
  });

  it('reports precision as 1 only because nothing unsafe was recognised', () => {
    expect(measurement.precision).toBe(1);
  });

  it('covers all 69 observed task-execution calls between match and unknown', () => {
    const observed = DELIVERY_CASES.reduce((n, c) => n + c.observed, 0);
    expect(observed).toBe(69);
  });

  it('every observed case is a shape the corpus claims was really emitted', () => {
    // Guards the corpus itself: an `observed` count above zero is a claim
    // about the transcripts, so it may never be attached to a constructed case.
    for (const c of DELIVERY_CASES) {
      if (c.observed > 0) expect(c.expect === 'match' || c.expect === 'unknown').toBe(true);
      if (c.expect === 'no-match') expect(c.observed).toBe(0);
    }
  });

  it('renders a report with both recall figures separated', () => {
    const text = renderDelivery(measurement);
    expect(text).toContain('recall');
    expect(text).toContain('precision');
    expect(text).not.toContain('FALSE MATCH');
  });

  it('the historical bare command is still its own identity', () => {
    expect(canonicalizeCommand(TARGET, CWD)).toBe(TARGET);
  });
});
