import { approxTokens, truncate } from '../core/text.js';
import type { Provenance, TrustState } from '../core/types.js';
import type { RankedHit } from './rank.js';

export interface PackedNode {
  id: string;
  kind: string;
  ts: string;
  title: string;
  signal: number;
  score: number;
  summary: string;
  tokens: number;
  provenance: Provenance;
  trustState: TrustState;
  /** Set only for a cross-project query, where a line's repository is not implied by context. */
  project?: string;
}

export interface PackResult {
  nodes: PackedNode[];
  tokensUsed: number;
  tokensBudget: number;
  consideredNodes: number;
  droppedForBudget: number;
  droppedForDiversity: number;
}

const DEFAULT_SUMMARY_CHARS = 320;
/** Formatting overhead per node (date prefix, bullet, line breaks) counted as tokens. */
const NODE_OVERHEAD_TOKENS = 8;

const CONVERSATION_ANSWER_MARKER = '\n\nA: ';

/**
 * At most this many hits from the same original document may appear in one
 * packed result.
 *
 * `conversation_turn` and `doc_section` both chunk one long reply or file
 * into several nodes that share the *same* `ts` (see
 * `collectors/conversation.ts` and `collectors/docs.ts`) -- there is no
 * per-chunk parent id available at this layer, but the shared timestamp
 * already identifies "pieces of the same original text" in practice, since
 * two unrelated exchanges or files are never indexed in the same
 * millisecond. Verified live: a query for "token" returned 9 of its top 12
 * hits as different chunks of one heavily-sectioned conversation reply,
 * crowding out every other node -- including the actually relevant one.
 * Kept at 2 rather than 1 so a reply that is genuinely relevant in two
 * places still shows both, without letting either dominate.
 */
const MAX_PER_FAMILY = 2;
const CHUNKED_KINDS = new Set(['conversation_turn', 'doc_section']);

/** Start of a hunk, at the beginning of a line. */
const HUNK_BOUNDARY = '\n@@ ';

/**
 * Words carried by almost every question, and therefore by almost every hunk.
 *
 * Only used to choose between hunks of one node -- BM25 has its own view of
 * term weight and is untouched by this list.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'that', 'this', 'with', 'from', 'into', 'not', 'but',
  'what', 'why', 'how', 'when', 'where', 'which', 'who', 'does', 'did', 'has', 'have', 'had', 'can',
  'could', 'would', 'should', 'all', 'any', 'every', 'each', 'its', 'our', 'you', 'your', 'about',
]);

function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)).map(singularize))];
}

/**
 * Word pieces of a line of code.
 *
 * Splitting on case transitions as well as punctuation is what lets a natural
 * question meet an identifier: `RETRY_DELAYS_MS` and `SpawnOptions` become
 * `retry delays ms` and `spawn options`, so "retry delays" and "spawn" find
 * them. A plain `\b` word match finds neither, because `_` is a word character
 * and a camel hump is not a boundary at all.
 */
function codeTokens(text: string): Set<string> {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return new Set((spaced.match(/[a-z0-9]{2,}/g) ?? []).map(singularize));
}

/** Crude, deliberately: enough to let "spawns" meet `spawn`, and nothing more. */
function singularize(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/**
 * The part of a patch worth spending the budget on.
 *
 * A summary is a few hundred characters and a real patch is thousands, so
 * taking the head means showing whichever hunk happens to sit at the top of
 * the file -- an import block, or the licence comment. Dogfooding this on
 * `src/git/exec.ts` returned the right file for "what flags are passed to
 * every git invocation" and then showed a class definition seventy lines above
 * the answer.
 *
 * Term overlap is a crude relevance measure, but it is measured against the
 * *hunks of one already-retrieved node*, where ranking has done its job and
 * the only question left is which few lines to show.
 */
function pickHunk(patch: string, query: string): string {
  const first = patch.indexOf('@@ ');
  if (first === -1) return patch;

  const hunks: string[] = [];
  let rest = patch.slice(first);
  for (;;) {
    const next = rest.indexOf(HUNK_BOUNDARY, 1);
    if (next === -1) {
      hunks.push(rest);
      break;
    }
    hunks.push(rest.slice(0, next));
    rest = rest.slice(next + 1);
  }

  const terms = queryTerms(query);
  if (terms.length === 0) return hunks[0] ?? patch;

  let best = hunks[0] ?? patch;
  let bestScore = 0;
  for (const hunk of hunks) {
    const tokens = codeTokens(hunk);
    // Whole tokens, not substrings: a query about git must not score every
    // hunk in a repository alike because the letters appear inside some
    // longer identifier.
    const score = terms.reduce((n, term) => n + (tokens.has(term) ? 1 : 0), 0);
    if (score > bestScore) {
      best = hunk;
      bestScore = score;
    }
  }
  return focusHunk(best, terms);
}

/**
 * Drop leading context so the summary starts at the change.
 *
 * A hunk opens with up to three unchanged lines, and a 320-character summary
 * is about six lines: taken from the top, a hunk can spend its entire budget
 * on code that did not change and stop one line short of the one that did.
 * The hunk header is kept -- it names the enclosing function, which is how a
 * reader locates the excerpt.
 */
function focusHunk(hunk: string, terms: string[]): string {
  const lines = hunk.split('\n');
  const header = lines[0] ?? '';
  const body = lines.slice(1);
  const isChange = (line: string) => line.startsWith('+') || line.startsWith('-');

  let idx = terms.length
    ? body.findIndex((line) => {
        if (!isChange(line)) return false;
        const tokens = codeTokens(line);
        return terms.some((term) => tokens.has(term));
      })
    : -1;
  if (idx === -1) idx = body.findIndex(isChange);
  if (idx <= 1) return hunk;

  // One line of context above the change, so it does not read as free-floating.
  return [header, ...body.slice(idx - 1)].join('\n');
}

function summarize(hit: RankedHit, maxChars: number, query: string): string {
  // Conversation nodes always shape their body as "Q: <question>\n\nA:
  // <answer>" (collectors/conversation.ts repeats the full original question
  // in every chunk so each node is self-contained). The answer is the part
  // worth showing -- truncating from the start of the body would otherwise
  // spend the whole summary on a long question and never reach it.
  const answerIdx = hit.body.indexOf(CONVERSATION_ANSWER_MARKER);
  if (answerIdx !== -1) {
    const answer = hit.body.slice(answerIdx + CONVERSATION_ANSWER_MARKER.length).trim();
    if (answer) return truncate(answer, maxChars);
  }

  // A diff body is "<subject>\n<file line>\n\n<hunks>": keep the two header
  // lines, which say what changed and by how much, then spend the rest of the
  // budget on the hunk that matches the question.
  if (hit.kind === 'code_diff') {
    const patchStart = hit.body.indexOf(HUNK_BOUNDARY);
    if (patchStart !== -1) {
      const head = hit.body.slice(0, patchStart).trim();
      const hunk = pickHunk(hit.body.slice(patchStart + 1), query);
      return truncate(`${head}\n${hunk}`, maxChars);
    }
  }

  // Body already leads with the title; skip straight to whatever follows it
  // so the summary doesn't repeat text that's already shown as the heading.
  const rest = hit.body.startsWith(hit.title) ? hit.body.slice(hit.title.length).trim() : hit.body;
  return truncate(rest || hit.title, maxChars);
}

/**
 * Greedily fill a token budget with the highest-scoring hits.
 *
 * Nodes are tried strictly in score order. One that doesn't fit is skipped,
 * not a stopping point -- a later, smaller, lower-priority node may still
 * fit the remaining budget. This is best-effort packing, not knapsack-
 * optimal, but it keeps "why is node X included" answerable by score alone.
 */
export function packContext(
  ranked: readonly RankedHit[],
  tokensBudget: number,
  opts: { summaryChars?: number; query?: string } = {},
): PackResult {
  const summaryChars = opts.summaryChars ?? DEFAULT_SUMMARY_CHARS;
  const query = opts.query ?? '';
  const nodes: PackedNode[] = [];
  let tokensUsed = 0;
  let droppedForBudget = 0;
  let droppedForDiversity = 0;
  const familyCounts = new Map<string, number>();

  for (const hit of ranked) {
    const familyKey = CHUNKED_KINDS.has(hit.kind) ? `${hit.kind}:${hit.ts}` : null;
    if (familyKey && (familyCounts.get(familyKey) ?? 0) >= MAX_PER_FAMILY) {
      droppedForDiversity += 1;
      continue;
    }

    const summary = summarize(hit, summaryChars, query);
    const tokens = approxTokens(hit.title) + approxTokens(summary) + NODE_OVERHEAD_TOKENS;

    if (tokensUsed + tokens > tokensBudget) {
      droppedForBudget += 1;
      continue;
    }

    nodes.push({
      id: hit.id,
      kind: hit.kind,
      ts: hit.ts,
      title: hit.title,
      signal: hit.signal,
      score: hit.score,
      summary,
      tokens,
      provenance: hit.provenance,
      trustState: hit.trustState,
      ...(hit.project ? { project: hit.project } : {}),
    });
    tokensUsed += tokens;
    // Only a hit that actually made it in spends its family's slot -- one
    // skipped for budget must not block a smaller sibling later in the list.
    if (familyKey) familyCounts.set(familyKey, (familyCounts.get(familyKey) ?? 0) + 1);
  }

  return { nodes, tokensUsed, tokensBudget, consideredNodes: ranked.length, droppedForBudget, droppedForDiversity };
}

/** Render a packed result as plain text, ready to paste into an agent's context. */
export function renderContextBlock(query: string, result: PackResult): string {
  if (result.nodes.length === 0) return `No remembered context matched "${query}".`;

  const lines = [`Relevant history for: ${query}`, ''];
  for (const node of result.nodes) {
    // The project tag is the whole point of a cross-project answer: without
    // it the reader cannot tell which repository a line describes, and two
    // repositories' conventions read as one contradictory history.
    const project = node.project ? `[${node.project}] ` : '';
    const provenance = `[${node.provenance}] `; // fact vs. inference, one glance
    // Silent for the overwhelming default ('candidate'): only a reviewed node earns a tag.
    const trust = node.trustState !== 'candidate' ? `[${node.trustState}] ` : '';
    lines.push(`- ${node.ts.slice(0, 10)} ${provenance}${trust}${project}${node.title}`);
    if (node.summary && node.summary !== node.title) {
      // A patch is the one body whose line structure *is* the content:
      // flattened onto one line, `-  return a;` and `+  return b;` become an
      // unreadable run of tokens. Every other kind is prose, where collapsing
      // whitespace keeps one node to one line.
      if (node.kind === 'code_diff') {
        for (const line of node.summary.split('\n')) lines.push(`  ${line}`);
      } else {
        lines.push(`  ${node.summary.replace(/\n+/g, ' ')}`);
      }
    }
  }
  return lines.join('\n');
}
