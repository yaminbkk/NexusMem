import type { Provenance } from '../core/types.js';
import type { SearchHit } from '../store/store.js';

export interface RankedHit extends SearchHit {
  /** 0..1, normalized from bm25 within this result set. 1 = best lexical match. */
  relevance: number;
  /** 0..1, structural importance rescaled so it can never zero out relevance. */
  signalWeight: number;
  /** 0..1, decays with age but never below the floor. */
  recencyFactor: number;
  ageDays: number;
  /**
   * `relevance * signalWeight**SIGNAL_EXPONENT * recencyFactor**RECENCY_EXPONENT`.
   * Sort key, best first. The reported `signalWeight`/`recencyFactor` are the
   * raw factors, not the exponentiated ones, so they stay readable as "how
   * important" and "how fresh" independent of how much weight ranking gives them.
   */
  score: number;
}

export interface RankOptions {
  /** Days for an `observed` node's recency factor to halve. Default 30. */
  halfLifeDays?: number;
  /** Per-tier multipliers on `halfLifeDays`; merged over `HALF_LIFE_RATIO`'s defaults. */
  halfLifeRatios?: Partial<Record<Provenance, number>>;
  /** Injectable for deterministic tests; defaults to the real clock. */
  now?: Date;
  /**
   * Pre-fused relevance (e.g. from `reciprocalRankFusion` over BM25 +
   * vector search), keyed by node id, higher-is-better. When provided, this
   * replaces the BM25-only `relevance` derivation entirely -- vector search
   * changes what counts as relevant, not the rest of the ranking formula.
   */
  relevanceScores?: ReadonlyMap<string, number>;
  /** Node ids some other node's `supersedes` points at (see `MemoryStore.getSupersededIds`) -- down-weighted, never removed. */
  supersededIds?: ReadonlySet<string>;
}

/**
 * Floors on each factor.
 *
 * Every factor lives in [floor, 1] rather than [0, 1]. Multiplying three
 * [0,1] terms lets any single dimension crush the other two to zero -- an
 * old-but-perfect match would lose to a recent-but-mediocre one purely on
 * age. Floors keep the combination a *reordering* within each dimension
 * instead of an on/off gate.
 */
const RELEVANCE_FLOOR = 0.15;
const SIGNAL_FLOOR = 0.2;
const RECENCY_FLOOR = 0.3;
const DEFAULT_HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 86_400_000;

/**
 * Half-life multiplier per trust tier -- the lower the trust, the faster the
 * decay. The exact ratios are judgment calls, not measured optima; only the
 * ordering (observed > authored > recorded > derived) is the design claim.
 */
const HALF_LIFE_RATIO: Record<Provenance, number> = {
  observed: 1,
  authored: 0.75,
  recorded: 0.5,
  derived: 0.35,
};

/** Flat down-weight for a superseded node -- not near-zero, since it must stay reachable if it's still the best match. */
const SUPERSEDED_PENALTY = 0.5;

/** Harsher than SUPERSEDED_PENALTY: a human explicitly rejected this claim, not just a newer node quietly replacing it. Still not zero -- `review` demotes, it doesn't delete. */
const REJECTED_TRUST_PENALTY = 0.3;

/**
 * How far the *priors*, together, may overturn the *query*.
 *
 * `relevance` is the only factor derived from what was asked; `signal` and
 * `recency` are query-independent priors that hold before any query exists.
 * Multiplying all three as equals let the priors win outright: signal spans
 * 5x (0.2 -> 1) and recency 3.33x (0.3 -> 1), while relevance spans 6.7x, so a
 * well-scored recent commit could outrank a document that matched the question
 * far better. Observed on a real query: a `fix:` commit (signal .9) took rank 1
 * from the top-fused doc section (signal .55) on a 44% signal edge against a
 * 15% relevance deficit.
 *
 * Exponents bound that instead of banning it. Priors still order
 * equally-relevant hits exactly as before (the transform is monotonic); they
 * simply cannot overturn a large relevance gap.
 *
 * **The budget is shared, not per-prior.** Capping each prior at
 * `MAX_PRIOR_OVERTURN` separately caps neither the pair: the score multiplies
 * them, so two priors each worth 2x are worth 4x together. That is not a corner
 * case -- it describes every commit made during an active working day, both
 * fresh and high-signal at once, so the failure concentrated on exactly the days
 * with the most worth remembering. Found by dogfooding: a query about the
 * PowerShell hook returned two unrelated same-day `fix:` commits at ranks 3 and
 * 4 while the section that answered it sat at rank 6.
 *
 * So `MAX_PRIOR_OVERTURN` is the budget for all priors *jointly*, split evenly
 * between them (`sqrt(2)` each), and each prior is then raised to the power that
 * makes its entire range worth exactly its share -- solving
 * `span^exponent = PER_PRIOR_OVERTURN`. Adding a third prior re-divides the same
 * budget rather than enlarging it, which is the property that was missing.
 */
const MAX_PRIOR_OVERTURN = 2;
/** signal and recency. Update when a query-independent factor joins the score. */
const PRIOR_COUNT = 2;
const PER_PRIOR_OVERTURN = MAX_PRIOR_OVERTURN ** (1 / PRIOR_COUNT);
const SIGNAL_EXPONENT = Math.log(PER_PRIOR_OVERTURN) / Math.log(1 / SIGNAL_FLOOR);
const RECENCY_EXPONENT = Math.log(PER_PRIOR_OVERTURN) / Math.log(1 / RECENCY_FLOOR);

/**
 * bm25() in SQLite is a *cost*: smaller (more negative) is a better match.
 * Min-max normalize within this result set so the scale is comparable across
 * queries, then rescale into [RELEVANCE_FLOOR, 1].
 */
function normalizeRelevance(hits: readonly SearchHit[]): number[] {
  const costs = hits.map((h) => h.rank);
  const min = Math.min(...costs);
  const max = Math.max(...costs);

  if (min === max) return hits.map(() => 1);

  return costs.map((cost) => {
    const normalized = (max - cost) / (max - min); // best cost -> 1, worst -> 0
    return RELEVANCE_FLOOR + (1 - RELEVANCE_FLOOR) * normalized;
  });
}

/**
 * Same rescale-into-[floor,1] treatment as `normalizeRelevance`, but for an
 * externally supplied score where *higher* is better (RRF's convention),
 * unlike bm25's cost convention.
 */
function normalizeExternalRelevance(hits: readonly SearchHit[], scores: ReadonlyMap<string, number>): number[] {
  const values = hits.map((h) => scores.get(h.id) ?? 0);
  const min = Math.min(...values);
  const max = Math.max(...values);

  if (min === max) return hits.map(() => 1);

  return values.map((v) => {
    const normalized = (v - min) / (max - min); // best (highest) -> 1
    return RELEVANCE_FLOOR + (1 - RELEVANCE_FLOOR) * normalized;
  });
}

function ageDaysOf(ts: string, now: Date): number {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, (now.getTime() - parsed) / MS_PER_DAY);
}

/**
 * Combine lexical match quality, structural importance and recency into one
 * score, and return hits sorted best-first.
 *
 * This is the layer the whole "signal at ingest time" design pays off in:
 * `signalWeight` is what keeps a `fix:` commit ahead of an equally-relevant
 * `chore:` one, without a query-time re-analysis of either.
 */
export function rankHits(hits: readonly SearchHit[], opts: RankOptions = {}): RankedHit[] {
  if (hits.length === 0) return [];

  const halfLife = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const ratios = { ...HALF_LIFE_RATIO, ...opts.halfLifeRatios };
  const now = opts.now ?? new Date();
  const relevances = opts.relevanceScores ? normalizeExternalRelevance(hits, opts.relevanceScores) : normalizeRelevance(hits);

  const ranked = hits.map((hit, i) => {
    const relevance = relevances[i] ?? RELEVANCE_FLOOR;
    const signalWeight = SIGNAL_FLOOR + (1 - SIGNAL_FLOOR) * hit.signal;
    const ageDays = ageDaysOf(hit.ts, now);
    const effectiveHalfLife = halfLife * (ratios[hit.provenance] ?? 1);
    const recencyFactor = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * 2 ** (-ageDays / effectiveHalfLife);

    const rawScore = relevance * signalWeight ** SIGNAL_EXPONENT * recencyFactor ** RECENCY_EXPONENT;
    const supersededScore = opts.supersededIds?.has(hit.id) ? rawScore * SUPERSEDED_PENALTY : rawScore;
    const score = hit.trustState === 'rejected' ? supersededScore * REJECTED_TRUST_PENALTY : supersededScore;

    return { ...hit, relevance, signalWeight, ageDays, recencyFactor, score };
  });

  return ranked.sort((a, b) => b.score - a.score);
}
