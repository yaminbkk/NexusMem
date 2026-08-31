/**
 * Grep baseline for `scripts/eval.ts`.
 *
 * Answers the "ranking still has to beat just searching the repo yourself"
 * challenge directly: for each labelled query in eval/queries.json, simulate
 * a person using `git log --grep` / `git grep` instead of NexusMem, and score
 * it with the same rank / MRR / Recall@5 the ranker eval uses.
 *
 * A target is only reachable by grep if it actually lives in git history --
 * git_commit and code_diff nodes (via their commit sha) or doc_section nodes
 * (via their file path). shell_command, conversation_turn, session_summary
 * and github_thread nodes have no repo text to grep for at all; those cases
 * are counted as misses (a real grep search could not find them either),
 * and reported separately so that's visible rather than averaged away.
 *
 * Usage:
 *   tsx scripts/eval-baseline-grep.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext } from '../src/cli/context.js';
import { MemoryStore } from '../src/store/store.js';

interface QueryCase {
  id: string;
  query: string;
  relevantNodeIds: string[];
  note?: string;
}

const RECALL_K = 5;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'why', 'how', 'what', 'when', 'where', 'who', 'which', 'does', 'do',
  'did', 'this', 'that', 'these', 'those', 'to', 'of', 'in', 'on', 'at',
  'for', 'and', 'or', 'but', 'not', 'no', 'it', 'its', 'we', 'our', 'i',
  'so', 'if', 'than', 'then', 'with', 'from', 'as', 'by', 'still', 'has',
  'have', 'had', 'just', 'get', 'gets', 'getting', 'can', 'should', 'would',
]);

function extractKeywords(query: string): string[] {
  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9_\-. ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

function runGit(repoRoot: string, args: string[]): string[] {
  try {
    const out = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
    return out.split('\n').filter((l) => l.length > 0);
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1) return (e.stdout ?? '').split('\n').filter((l) => l.length > 0);
    return [];
  }
}

/** Commits whose message matches the keywords, most-recent-first (git log's default order). */
function searchCommits(repoRoot: string, keywords: string[]): string[] {
  if (keywords.length === 0) return [];
  const grepFlags = keywords.flatMap((kw) => ['--grep', kw]);
  const and = keywords.length > 1
    ? runGit(repoRoot, ['log', '--all', '--format=%H', '-i', '--all-match', ...grepFlags])
    : [];
  if (and.length > 0) return and;
  return runGit(repoRoot, ['log', '--all', '--format=%H', '-i', ...grepFlags]);
}

/** Commits whose diff added/removed one of the keywords (`git log -S`, the standard "grep the history" tool for code changes). */
function searchPickaxe(repoRoot: string, keywords: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const kw of keywords) {
    for (const sha of runGit(repoRoot, ['log', '--all', '--format=%H', '-i', `-S${kw}`])) {
      if (!seen.has(sha)) {
        seen.add(sha);
        ordered.push(sha);
      }
    }
  }
  return ordered;
}

/** Files at HEAD whose content matches the keywords, git grep's default order. */
function searchFiles(repoRoot: string, keywords: string[]): string[] {
  if (keywords.length === 0) return [];
  const eFlags = keywords.flatMap((kw) => ['-e', kw]);
  const and = keywords.length > 1
    ? runGit(repoRoot, ['grep', '-l', '-i', ...keywords.flatMap((kw) => ['-e', kw, '--and']).slice(0, -1)])
    : [];
  if (and.length > 0) return and;
  return runGit(repoRoot, ['grep', '-l', '-i', ...eFlags]);
}

function rankOf(list: readonly string[], targets: ReadonlySet<string>): number | null {
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i]!;
    for (const t of targets) {
      if (item === t || item.startsWith(t) || t.startsWith(item)) return i + 1;
    }
  }
  return null;
}

interface CaseResult {
  id: string;
  query: string;
  grepable: boolean;
  ungrepableKinds: string[];
  rank: number | null;
  mrr: number;
  recallAtK: number;
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const queriesPath = join(repoRoot, 'eval', 'queries.json');
  if (!existsSync(queriesPath)) {
    console.log(`no queries at ${queriesPath} -- run scripts/eval.ts --label first.`);
    return;
  }
  const cases = JSON.parse(readFileSync(queriesPath, 'utf8')) as QueryCase[];

  const { ws } = await loadContext(repoRoot);
  const store = MemoryStore.open(ws.dbPath);

  const results: CaseResult[] = [];
  try {
    for (const c of cases) {
      if (c.relevantNodeIds.length === 0) continue;
      const nodes = store.getNodesByIds(c.relevantNodeIds);

      const shaTargets = new Set<string>();
      const pathTargets = new Set<string>();
      const ungrepableKinds: string[] = [];

      for (const id of c.relevantNodeIds) {
        const node = nodes.find((n) => n.id === id);
        const meta = store.getNodeMeta(id);
        const kind = node?.kind;
        if ((kind === 'git_commit' || kind === 'code_diff') && typeof meta?.sha === 'string') {
          shaTargets.add(meta.sha);
        } else if (kind === 'doc_section' && typeof meta?.path === 'string') {
          pathTargets.add(meta.path);
        } else {
          ungrepableKinds.push(kind ?? 'unknown');
        }
      }

      const grepable = shaTargets.size > 0 || pathTargets.size > 0;
      let rank: number | null = null;

      if (grepable) {
        const keywords = extractKeywords(c.query);
        const candidateRanks: number[] = [];

        if (shaTargets.size > 0) {
          const grepHits = searchCommits(repoRoot, keywords);
          const r1 = rankOf(grepHits, shaTargets);
          if (r1 !== null) candidateRanks.push(r1);
          const pickaxeHits = searchPickaxe(repoRoot, keywords);
          const r2 = rankOf(pickaxeHits, shaTargets);
          if (r2 !== null) candidateRanks.push(r2);
        }
        if (pathTargets.size > 0) {
          const fileHits = searchFiles(repoRoot, keywords);
          const r3 = rankOf(fileHits, pathTargets);
          if (r3 !== null) candidateRanks.push(r3);
        }
        rank = candidateRanks.length > 0 ? Math.min(...candidateRanks) : null;
      }

      const result: CaseResult = {
        id: c.id,
        query: c.query,
        grepable,
        ungrepableKinds,
        rank,
        mrr: rank ? 1 / rank : 0,
        recallAtK: rank !== null && rank <= RECALL_K ? 1 : 0,
      };
      results.push(result);
      const mark = rank ? '✓' : '✗';
      const why = !grepable ? `not in repo (${[...new Set(ungrepableKinds)].join(',')})` : rank ? `rank ${rank}` : 'not found';
      console.log(`[${c.id}] ${why} ${mark}  "${c.query.slice(0, 60)}"`);
    }
  } finally {
    store.close();
  }

  const grepableResults = results.filter((r) => r.grepable);
  const notGrepable = results.filter((r) => !r.grepable);

  const summarize = (rows: readonly CaseResult[]) => ({
    n: rows.length,
    mrr: rows.length ? rows.reduce((s, r) => s + r.mrr, 0) / rows.length : 0,
    recall: rows.length ? rows.reduce((s, r) => s + r.recallAtK, 0) / rows.length : 0,
  });

  const overall = summarize(results);
  const grepableOnly = summarize(grepableResults);

  console.log(`\n=== grep baseline: ${results.length} cases ===`);
  console.log(`  overall (counting "not in repo" as a miss, the real-world outcome):`);
  console.log(`    MRR: ${overall.mrr.toFixed(3)}   Recall@${RECALL_K}: ${overall.recall.toFixed(3)}`);
  console.log(`  grep-able subset only (${grepableOnly.n}/${results.length} cases -- answer actually exists in git history):`);
  console.log(`    MRR: ${grepableOnly.mrr.toFixed(3)}   Recall@${RECALL_K}: ${grepableOnly.recall.toFixed(3)}`);
  console.log(`  not grep-able: ${notGrepable.length}/${results.length} -- answer lives outside git history (shell history, chat, GitHub, summaries) and no repo grep could ever find it.`);

  const outPath = join(repoRoot, 'eval', 'results', `baseline-grep-${Date.now()}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ results, overall, grepableOnly, notGrepableCount: notGrepable.length }, null, 2)}\n`, 'utf8');
  console.log(`\nFull per-case results written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
