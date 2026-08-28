/**
 * Retrieval-quality eval harness.
 *
 * `scripts/benchmark.ts` measures token savings assuming the ranker's own
 * candidate set is correct -- it never checks whether that set is actually
 * right. This script does: a fixed set of (query, correct node ids) pairs,
 * scored against what `runHybridQuery` actually packs, so a ranking change
 * can be judged by a number instead of a handful of anecdotes.
 *
 * Node ids are content-addressed sha256 hashes -- nobody labels those by
 * hand. `--label` runs a query, shows the packed candidates with a number
 * next to each, and turns picked numbers into ids for you.
 *
 * Usage:
 *   tsx scripts/eval.ts
 *   tsx scripts/eval.ts --label "windows spawn failure"
 *   tsx scripts/eval.ts --label "windows spawn failure" --pick 1,3 --id q005
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadContext } from '../src/cli/context.js';
import { runHybridQuery } from '../src/retrieval/query-pipeline.js';
import { MemoryStore } from '../src/store/store.js';
import { OllamaEmbeddingProvider } from '../src/vector/embed.js';

interface QueryCase {
  id: string;
  query: string;
  relevantNodeIds: string[];
  note?: string;
}

interface CaseResult {
  id: string;
  query: string;
  rank: number | null;
  mrr: number;
  recallAtK: number;
  packedNodeIds: string[];
}

const DEFAULT_BUDGET = 2000;
const DEFAULT_CANDIDATES = 30;
const RECALL_K = 5;
const PREVIEW_COUNT = 12;

function loadQueries(path: string): QueryCase[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as QueryCase[];
}

function saveQueries(path: string, queries: readonly QueryCase[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(queries, null, 2)}\n`, 'utf8');
}

function nextId(queries: readonly QueryCase[]): string {
  return `q${String(queries.length + 1).padStart(3, '0')}`;
}

function firstRelevantRank(nodeIds: readonly string[], relevant: ReadonlySet<string>): number | null {
  const idx = nodeIds.findIndex((id) => relevant.has(id));
  return idx === -1 ? null : idx + 1;
}

async function labelQuery(
  store: MemoryStore,
  projectId: string,
  embeddingProvider: OllamaEmbeddingProvider | null,
  query: string,
  budget: number,
  candidates: number,
  queriesPath: string,
  pick: string | null,
  idArg: string | null,
  noteArg: string | null,
): Promise<void> {
  const { packed } = await runHybridQuery(store, projectId, query, { budget, candidates, embeddingProvider });
  const preview = packed.nodes.slice(0, PREVIEW_COUNT);

  console.log(`Query: "${query}"`);
  if (preview.length === 0) {
    console.log('  (no candidates -- nothing to label)');
    return;
  }
  preview.forEach((n, i) => {
    console.log(
      `${String(i + 1).padStart(2)}. [${n.provenance}] ${n.kind.padEnd(16)} ${n.id.slice(0, 8)}  ${n.title.slice(0, 70)}  score=${n.score.toFixed(3)}`,
    );
  });

  let pickInput = pick;
  if (pickInput === null) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    pickInput = (await rl.question('Enter numbers of correct answers (comma-separated), or blank to cancel: ')).trim();
    if (pickInput.length === 0) {
      rl.close();
      console.log('cancelled, nothing saved.');
      return;
    }
    rl.close();
  }

  const indices = pickInput
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= preview.length);
  if (indices.length === 0) {
    console.log('no valid numbers parsed, nothing saved.');
    return;
  }
  const pickedIds = indices.map((i) => preview[i - 1]!.id);

  const queries = loadQueries(queriesPath);
  const existing = queries.find((q) => q.query === query);
  if (existing) {
    existing.relevantNodeIds = [...new Set([...existing.relevantNodeIds, ...pickedIds])];
    saveQueries(queriesPath, queries);
    console.log(`merged ${pickedIds.length} id(s) into existing case "${existing.id}".`);
    return;
  }

  const entry: QueryCase = {
    id: idArg ?? nextId(queries),
    query,
    relevantNodeIds: pickedIds,
  };
  const note = noteArg ?? (pick === null ? await promptNote() : null);
  if (note) entry.note = note;

  saveQueries(queriesPath, [...queries, entry]);
  console.log(`saved case "${entry.id}" with ${pickedIds.length} relevant id(s) to ${queriesPath}.`);
}

async function promptNote(): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const note = (await rl.question('Optional note (blank to skip): ')).trim();
  rl.close();
  return note.length > 0 ? note : null;
}

async function runEval(
  store: MemoryStore,
  projectId: string,
  embeddingProvider: OllamaEmbeddingProvider | null,
  cases: readonly QueryCase[],
  budget: number,
  candidates: number,
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    if (c.relevantNodeIds.length === 0) continue;
    const relevant = new Set(c.relevantNodeIds);
    const { packed } = await runHybridQuery(store, projectId, c.query, { budget, candidates, embeddingProvider });
    const packedNodeIds = packed.nodes.map((n) => n.id);
    const rank = firstRelevantRank(packedNodeIds, relevant);
    const result: CaseResult = {
      id: c.id,
      query: c.query,
      rank,
      mrr: rank ? 1 / rank : 0,
      recallAtK: packedNodeIds.slice(0, RECALL_K).some((id) => relevant.has(id)) ? 1 : 0,
      packedNodeIds,
    };
    results.push(result);
    const mark = rank ? '✓' : '✗';
    const rankLabel = rank ? `rank ${rank}/${packedNodeIds.length}` : `not found in top ${packedNodeIds.length}`;
    console.log(`[${c.id}] ${rankLabel} ${mark}  "${c.query.slice(0, 60)}"`);
  }
  return results;
}

function printSummary(results: readonly CaseResult[]): void {
  if (results.length === 0) {
    console.log('\nno scoreable cases (every case needs at least one relevantNodeIds entry).');
    return;
  }
  const mrr = results.reduce((sum, r) => sum + r.mrr, 0) / results.length;
  const recall = results.reduce((sum, r) => sum + r.recallAtK, 0) / results.length;
  console.log(`\n=== ${results.length} cases ===`);
  console.log(`  MRR: ${mrr.toFixed(3)}   Recall@${RECALL_K}: ${recall.toFixed(3)}`);
}

interface CliOptions {
  queriesPath: string;
  label: string | null;
  pick: string | null;
  id: string | null;
  note: string | null;
  vector: boolean;
  budget: number;
  candidates: number;
  out: string | null;
}

function parseArgs(argv: readonly string[], repoRoot: string): CliOptions {
  const opts: CliOptions = {
    queriesPath: join(repoRoot, 'eval', 'queries.json'),
    label: null,
    pick: null,
    id: null,
    note: null,
    vector: true,
    budget: DEFAULT_BUDGET,
    candidates: DEFAULT_CANDIDATES,
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--queries') opts.queriesPath = argv[++i] ?? opts.queriesPath;
    else if (arg === '--label') opts.label = argv[++i] ?? null;
    else if (arg === '--pick') opts.pick = argv[++i] ?? null;
    else if (arg === '--id') opts.id = argv[++i] ?? null;
    else if (arg === '--note') opts.note = argv[++i] ?? null;
    else if (arg === '--no-vector') opts.vector = false;
    else if (arg === '--budget') opts.budget = Number.parseInt(argv[++i] ?? String(DEFAULT_BUDGET), 10);
    else if (arg === '--candidates') opts.candidates = Number.parseInt(argv[++i] ?? String(DEFAULT_CANDIDATES), 10);
    else if (arg === '--out') opts.out = argv[++i] ?? null;
  }
  return opts;
}

async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const opts = parseArgs(process.argv.slice(2), repoRoot);

  const { ws, projectId } = await loadContext(repoRoot);
  const store = MemoryStore.open(ws.dbPath);
  const embeddingProvider = opts.vector ? new OllamaEmbeddingProvider() : null;

  try {
    if (opts.label !== null) {
      await labelQuery(
        store,
        projectId,
        embeddingProvider,
        opts.label,
        opts.budget,
        opts.candidates,
        opts.queriesPath,
        opts.pick,
        opts.id,
        opts.note,
      );
      return;
    }

    const cases = loadQueries(opts.queriesPath);
    if (cases.length === 0) {
      console.log(`no queries at ${opts.queriesPath} yet -- seed some with --label "<query>".`);
      return;
    }
    const results = await runEval(store, projectId, embeddingProvider, cases, opts.budget, opts.candidates);
    printSummary(results);

    const outPath = opts.out ?? join(repoRoot, 'eval', 'results', `${Date.now()}.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    console.log(`\nFull per-case results written to ${outPath}`);
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
