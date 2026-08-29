import pc from 'picocolors';
import { approxTokens } from '../core/text.js';
import type { MemoryNode } from '../core/types.js';

/**
 * Shared rendering for the `scan-*` commands.
 *
 * These commands all print one line per candidate node, led by its signal, so
 * a user can eyeball what a collector would ingest before committing to a
 * sync. The signal column previously existed as four near-identical private
 * copies, which had already drifted: three graded high signal green while
 * `scan-shell` graded it red, so the same column meant opposite things
 * depending on which command produced it.
 */

/**
 * Cutoffs for the three signal bands, per source.
 *
 * These stay per-source on purpose. Collectors do not score on a shared
 * scale -- a commit's conventional-commit type is much stronger evidence than
 * a command's shape, so `scoreShellCommand` clusters near the middle while
 * git commits use the full range. One global cutoff would paint every shell
 * entry the same color and say nothing.
 */
export interface SignalBands {
  /** At or above this, the signal is high for this source. */
  high: number;
  /** At or above this (but below `high`), middling. */
  medium: number;
}

export const GIT_SIGNAL_BANDS: SignalBands = { high: 0.7, medium: 0.45 };
export const SHELL_SIGNAL_BANDS: SignalBands = { high: 0.6, medium: 0.4 };
export const CONVERSATION_SIGNAL_BANDS: SignalBands = { high: 0.55, medium: 0.35 };
export const DOCS_SIGNAL_BANDS: SignalBands = { high: 0.55, medium: 0.35 };
/** Same cutoffs as git: a diff's score is anchored on its commit's type, so it lives on the same scale. */
export const DIFF_SIGNAL_BANDS: SignalBands = { high: 0.7, medium: 0.45 };
export const GITHUB_SIGNAL_BANDS: SignalBands = { high: 0.6, medium: 0.4 };

export type SignalBand = 'high' | 'medium' | 'low';

/**
 * Which band a signal falls in, given its source's cutoffs.
 *
 * Split out from the coloring so the threshold logic is assertable: under a
 * non-TTY test runner picocolors emits no escape codes, which would make a
 * test of the rendered string blind to exactly the kind of divergence this
 * module exists to prevent.
 */
export function signalBand(signal: number, bands: SignalBands): SignalBand {
  if (signal >= bands.high) return 'high';
  if (signal >= bands.medium) return 'medium';
  return 'low';
}

/**
 * The one place a band becomes a color.
 *
 * Being a single map is the actual fix for the drift: a per-source palette is
 * now unrepresentable rather than merely discouraged, so "high is green" holds
 * for every command by construction. Thresholds vary by source; the color
 * language does not.
 */
const BAND_COLOR: Record<SignalBand, (s: string) => string> = {
  high: pc.green,
  medium: pc.yellow,
  low: pc.dim,
};

/** A node's signal as a fixed-width, color-graded figure. */
export function formatSignal(signal: number, bands: SignalBands): string {
  return BAND_COLOR[signalBand(signal, bands)](signal.toFixed(2));
}

/**
 * The "~N tokens if sent raw" figure every `scan-*` command reports.
 *
 * A single reduce, but the point of pulling it out is that every scan
 * command must count it the same way -- see `tests/cli-scan.test.ts`, which
 * pins this against `scan-git`'s fuller `summarize` output.
 */
export function approxTotalTokens(nodes: readonly MemoryNode[]): number {
  return nodes.reduce((n, x) => n + approxTokens(x.body), 0);
}

/**
 * `scan-git` and `scan-diff`'s multi-line summary: node count, date range,
 * average signal, total tokens, and the files that recur most across the
 * batch. Not used by `scan-conversation`/`scan-docs`/`scan-shell` -- their
 * nodes carry no `files`, so "hottest files" would always be empty.
 *
 * Exported for tests: the token total it reports must match every other
 * scan command's (`approxTotalTokens`, above).
 */
export function summarize(nodes: MemoryNode[]): string {
  if (nodes.length === 0) return pc.yellow('no commits matched');

  const timestamps = nodes.map((n) => n.ts).sort();
  const avgSignal = nodes.reduce((n, x) => n + x.signal, 0) / nodes.length;
  const totalTokens = approxTotalTokens(nodes);

  const fileHits = new Map<string, number>();
  for (const node of nodes) {
    for (const f of node.files) fileHits.set(f.path, (fileHits.get(f.path) ?? 0) + 1);
  }
  const hottest = [...fileHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([path, count]) => `    ${String(count).padStart(3)}x ${path}`);

  return [
    `${pc.bold(String(nodes.length))} nodes  ${pc.dim(`${timestamps[0]?.slice(0, 10)} .. ${timestamps.at(-1)?.slice(0, 10)}`)}`,
    `  avg signal ${avgSignal.toFixed(3)}   ~${totalTokens.toLocaleString()} tokens if sent raw`,
    hottest.length ? `  hottest files:\n${hottest.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
