/**
 * Phase 4 benchmark: real end-to-end token saving, measured at scale.
 *
 * The number the CLI's own `query --json` prints (`tokensUsed` vs the summed
 * bodies of its own candidate set) is *packer efficiency* -- useful for
 * tuning, but not a token-bill claim, since without NexusMem an agent would
 * never have fetched those candidate bodies in the first place. This script
 * measures the number that actually matters: `packed.tokensUsed` against two
 * baselines modelling what an agent would read *instead*, for the same set
 * of files the packed answer draws from --
 *
 *   - full-file-read: `git show HEAD:<path>` for every file the packed
 *     nodes touch (closest to "agent greps, then cats the whole file").
 *   - git-log-p: `git log -p -- <path>` over the same files' full history
 *     (closest to "agent dumps history and reads it all").
 *
 * Holding the file/commit set constant (taken from what NexusMem's own
 * ranking already decided was relevant) isolates the value the packing step
 * adds, without also re-litigating retrieval quality in the same number.
 *
 * The query set is derived mechanically from the corpus itself, not
 * hand-picked, so the benchmark is reproducible by anyone who clones the
 * repo and points this script at a synced corpus:
 *
 *   - a corpus with real assistant conversation history (this repo's own)
 *     uses its `conversation_turn` nodes' original questions verbatim.
 *   - a corpus without one (e.g. a large external repo like vite, synced for
 *     scale but never chatted about) instead uses an even sample of
 *     well-explained fix/feat/perf/refactor commits and rationale-bearing
 *     doc sections, turned into natural "why" questions from their own
 *     conventional-commit description / heading text.
 *
 * Usage:
 *   tsx scripts/benchmark.ts --corpus nexusmem
 *   tsx scripts/benchmark.ts --corpus vite --vite-root D:\ai-projects\bench-vite\vite
 *   tsx scripts/benchmark.ts --corpus nexusmem,vite --vite-root <path> --count 15
 *   tsx scripts/benchmark.ts --corpus flask,redis --root flask=D:\ai-projects\bench-flask\flask --root redis=D:\ai-projects\bench-redis\redis
 *
 * --root <name>=<path> is repeatable and works for any corpus name (not just
 * vite); --vite-root <path> is kept as a backward-compatible alias for
 * `--root vite=<path>`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContext } from '../src/cli/context.js';
import { approxTokens } from '../src/core/text.js';
import { readCommitDiffs } from '../src/git/diff.js';
import { git } from '../src/git/exec.js';
import { runHybridQuery } from '../src/retrieval/query-pipeline.js';
import { MemoryStore } from '../src/store/store.js';
import { OllamaEmbeddingProvider } from '../src/vector/embed.js';

type QuerySource = 'conversation' | 'commit' | 'doc';

interface CorpusSpec {
  name: string;
  root: string;
}

interface QueryResult {
  corpus: string;
  query: string;
  source: QuerySource;
  ms: number;
  packedNodes: number;
  tokensUsed: number;
  droppedForBudget: number;
  droppedForDiversity: number;
  filesTouched: number;
  filesResolved: number;
  baselineFullFileTokens: number;
  baselineGitLogTokens: number;
  savingFullFile: number | null;
  savingGitLog: number | null;
}

const BUDGET = 2000;
const CANDIDATES = 30;
/** Bounds worst-case runtime for a query whose packed nodes touch an unusually large file set. */
const MAX_FILES_PER_QUERY = 30;
const ANSWER_MARKER = '\n\nA: ';
const QUESTION_PREFIX = 'Q: ';
const CONVENTIONAL_PREFIX = /^[a-z]+(\([^)]*\))?!?:\s*/i;
const RATIONALE_COMMIT_TYPES = new Set(['fix', 'feat', 'perf', 'refactor']);
const HEADING_SEPARATOR = ' \u2014 '; // em dash, matches src/collectors/docs.ts's sectionTitle()

/** Repos like spring-boot use capitalized imperative titles ("Refactor BOM link DSL") instead of Conventional
 * Commits -- deliberately narrow to verbs that reliably signal a rationale, so routine titles ("Bump version",
 * "Update changelog", "Merge pull request #123") still fall through and get skipped, same as before. */
const FALLBACK_VERB_TYPES: Record<string, string> = {
  fix: 'fix',
  correct: 'fix',
  resolve: 'fix',
  add: 'feat',
  implement: 'feat',
  introduce: 'feat',
  support: 'feat',
  optimize: 'perf',
  improve: 'perf',
  refactor: 'refactor',
  simplify: 'refactor',
  rework: 'refactor',
  restructure: 'refactor',
  extract: 'refactor',
};

function fallbackConventionalType(title: string): string | null {
  const verb = title.match(/^([A-Za-z]+)\b/)?.[1];
  return verb ? (FALLBACK_VERB_TYPES[verb.toLowerCase()] ?? null) : null;
}

function evenSample<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  if (count <= 1) return items.length > 0 ? [items[0]!] : [];
  const picked = new Set<number>();
  for (let i = 0; i < count; i += 1) picked.add(Math.round((i * (items.length - 1)) / (count - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => items[i]!);
}

function questionsFromConversation(store: MemoryStore, projectId: string): string[] {
  const rows = store.raw
    .prepare(`SELECT body FROM nodes WHERE project_id = ? AND kind = 'conversation_turn' ORDER BY ts_epoch`)
    .all(projectId) as Array<{ body: string }>;

  const seen = new Set<string>();
  const questions: string[] = [];
  for (const { body } of rows) {
    const idx = body.indexOf(ANSWER_MARKER);
    if (idx === -1) continue;
    const question = body.slice(QUESTION_PREFIX.length, idx).trim();
    if (question.length < 12 || seen.has(question)) continue;
    seen.add(question);
    questions.push(question);
  }
  return questions;
}

function questionsFromCommits(store: MemoryStore, projectId: string, subject: string): string[] {
  const rows = store.raw
    .prepare(`SELECT title, meta FROM nodes WHERE project_id = ? AND kind = 'git_commit' AND signal >= 0.6 ORDER BY ts_epoch`)
    .all(projectId) as Array<{ title: string; meta: string }>;

  const questions: string[] = [];
  for (const { title, meta } of rows) {
    let conventionalType: string | null = null;
    try {
      conventionalType = (JSON.parse(meta) as { conventionalType?: string | null }).conventionalType ?? null;
    } catch {
      continue;
    }
    if (!conventionalType) conventionalType = fallbackConventionalType(title);
    if (!conventionalType || !RATIONALE_COMMIT_TYPES.has(conventionalType)) continue;

    const description = CONVENTIONAL_PREFIX.test(title)
      ? title.replace(CONVENTIONAL_PREFIX, '').trim()
      : title.charAt(0).toLowerCase() + title.slice(1);
    if (description.length < 8) continue;
    questions.push(`why does ${subject} ${description}`);
  }
  return questions;
}

function questionsFromDocs(store: MemoryStore, projectId: string): string[] {
  const rows = store.raw
    .prepare(`SELECT title FROM nodes WHERE project_id = ? AND kind = 'doc_section' AND signal >= 0.6 ORDER BY ts_epoch`)
    .all(projectId) as Array<{ title: string }>;

  const questions: string[] = [];
  for (const { title } of rows) {
    const idx = title.indexOf(HEADING_SEPARATOR);
    if (idx === -1) continue;
    const heading = title.slice(idx + HEADING_SEPARATOR.length).trim();
    if (heading.length >= 6) questions.push(heading);
  }
  return questions;
}

/**
 * A corpus with real conversation history uses it verbatim; one without
 * (a repo synced only for scale, never chatted about) falls back to
 * commits/docs. Not both at once for one corpus -- that would silently
 * change which questions are "real" per corpus.
 */
function buildQuerySet(
  store: MemoryStore,
  projectId: string,
  corpusLabel: string,
  count: number,
): Array<{ query: string; source: QuerySource }> {
  const conversational = questionsFromConversation(store, projectId);
  if (conversational.length > 0) {
    return evenSample(conversational, count).map((query) => ({ query, source: 'conversation' as const }));
  }

  const half = Math.ceil(count / 2);
  const commitQs = evenSample(questionsFromCommits(store, projectId, corpusLabel), half);
  const docQs = evenSample(questionsFromDocs(store, projectId), count - commitQs.length);
  return [
    ...commitQs.map((query) => ({ query, source: 'commit' as const })),
    ...docQs.map((query) => ({ query, source: 'doc' as const })),
  ];
}

/** Distinct file paths the packed nodes touch, in score order, capped so one query can't dominate runtime. */
function resolveFiles(store: MemoryStore, nodeIds: readonly string[]): string[] {
  const stmt = store.raw.prepare('SELECT path FROM node_files WHERE node_id = ?');
  const seen = new Set<string>();
  for (const id of nodeIds) {
    if (seen.size >= MAX_FILES_PER_QUERY) break;
    for (const { path } of stmt.all(id) as Array<{ path: string }>) {
      if (seen.size >= MAX_FILES_PER_QUERY) break;
      seen.add(path);
    }
  }
  return [...seen];
}

async function fullFileBaseline(root: string, paths: readonly string[]): Promise<{ tokens: number; resolved: number }> {
  let tokens = 0;
  let resolved = 0;
  for (const path of paths) {
    try {
      const content = await git(root, ['show', `HEAD:${path}`]);
      tokens += approxTokens(content);
      resolved += 1;
    } catch {
      // Deleted since, or a conversation node's heuristically-extracted path
      // mention that was never a real file -- contributes 0, not an error.
    }
  }
  return { tokens, resolved };
}

async function gitLogBaseline(root: string, paths: readonly string[]): Promise<number> {
  if (paths.length === 0) return 0;
  let tokens = 0;
  for await (const commit of readCommitDiffs(root, { paths: [...paths] })) {
    for (const file of commit.files) tokens += approxTokens(file.patch);
  }
  return tokens;
}

function saving(nexusTokens: number, baselineTokens: number): number | null {
  return baselineTokens > 0 ? 1 - nexusTokens / baselineTokens : null;
}

async function benchmarkCorpus(spec: CorpusSpec, count: number, useVector: boolean): Promise<QueryResult[]> {
  const { repo, ws, projectId } = await loadContext(spec.root);
  const store = MemoryStore.open(ws.dbPath);

  try {
    const queries = buildQuerySet(store, projectId, spec.name, count);
    if (queries.length === 0) {
      console.warn(`[${spec.name}] no queries could be derived from this corpus's own nodes -- skipping`);
      return [];
    }

    const embeddingProvider = useVector ? new OllamaEmbeddingProvider() : null;
    const results: QueryResult[] = [];

    for (const { query, source } of queries) {
      const t0 = Date.now();

      const { packed } = await runHybridQuery(store, projectId, query, {
        budget: BUDGET,
        candidates: CANDIDATES,
        embeddingProvider,
      });

      const paths = resolveFiles(
        store,
        packed.nodes.map((n) => n.id),
      );
      const [{ tokens: fullFileTokens, resolved }, gitLogTokens] = await Promise.all([
        fullFileBaseline(repo.root, paths),
        gitLogBaseline(repo.root, paths),
      ]);

      const result: QueryResult = {
        corpus: spec.name,
        query,
        source,
        ms: Date.now() - t0,
        packedNodes: packed.nodes.length,
        tokensUsed: packed.tokensUsed,
        droppedForBudget: packed.droppedForBudget,
        droppedForDiversity: packed.droppedForDiversity,
        filesTouched: paths.length,
        filesResolved: resolved,
        baselineFullFileTokens: fullFileTokens,
        baselineGitLogTokens: gitLogTokens,
        savingFullFile: saving(packed.tokensUsed, fullFileTokens),
        savingGitLog: saving(packed.tokensUsed, gitLogTokens),
      };
      results.push(result);

      console.log(
        `[${spec.name}] (${result.ms}ms) "${query.slice(0, 70)}" -- nexusmem ${result.tokensUsed}t` +
          `, full-file ${fullFileTokens}t (${resolved}/${paths.length} resolved)` +
          `, git-log-p ${gitLogTokens}t`,
      );
    }

    return results;
  } finally {
    store.close();
  }
}

function median(nums: readonly number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function printSummary(results: readonly QueryResult[]): void {
  for (const corpus of new Set(results.map((r) => r.corpus))) {
    const rows = results.filter((r) => r.corpus === corpus);
    const fullFileSavings = rows.map((r) => r.savingFullFile).filter((n): n is number => n !== null);
    const gitLogSavings = rows.map((r) => r.savingGitLog).filter((n): n is number => n !== null);
    const totalNexus = rows.reduce((n, r) => n + r.tokensUsed, 0);
    const totalFullFile = rows.reduce((n, r) => n + r.baselineFullFileTokens, 0);
    const totalGitLog = rows.reduce((n, r) => n + r.baselineGitLogTokens, 0);

    console.log(`\n=== ${corpus}: ${rows.length} queries ===`);
    console.log(
      `  vs full-file-read  median ${pct(median(fullFileSavings))}  ` +
        `aggregate ${pct(totalFullFile > 0 ? 1 - totalNexus / totalFullFile : 0)}  ` +
        `(${totalNexus} vs ${totalFullFile} tokens, ${fullFileSavings.length}/${rows.length} queries had a resolvable baseline)`,
    );
    console.log(
      `  vs git-log-p        median ${pct(median(gitLogSavings))}  ` +
        `aggregate ${pct(totalGitLog > 0 ? 1 - totalNexus / totalGitLog : 0)}  ` +
        `(${totalNexus} vs ${totalGitLog} tokens, ${gitLogSavings.length}/${rows.length} queries had a resolvable baseline)`,
    );
  }
}

interface CliOptions {
  corpora: string[];
  roots: Map<string, string>;
  count: number;
  vector: boolean;
  out: string | null;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    corpora: ['nexusmem', 'vite'],
    roots: new Map<string, string>(),
    count: 12,
    vector: true,
    out: null,
  };
  const envViteRoot = process.env.NEXUSMEM_BENCH_VITE_ROOT;
  if (envViteRoot) opts.roots.set('vite', envViteRoot);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--corpus') opts.corpora = (argv[++i] ?? '').split(',').map((s) => s.trim());
    else if (arg === '--vite-root') {
      const path = argv[++i] ?? null;
      if (path) opts.roots.set('vite', path);
    } else if (arg === '--root') {
      const spec = argv[++i] ?? '';
      const eq = spec.indexOf('=');
      if (eq > 0) opts.roots.set(spec.slice(0, eq).trim(), spec.slice(eq + 1).trim());
    } else if (arg === '--count') opts.count = Number.parseInt(argv[++i] ?? '12', 10);
    else if (arg === '--no-vector') opts.vector = false;
    else if (arg === '--out') opts.out = argv[++i] ?? null;
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));

  const specs: CorpusSpec[] = [];
  for (const name of opts.corpora) {
    if (name === 'nexusmem') {
      specs.push({ name: 'nexusmem', root: repoRoot });
      continue;
    }
    const root = opts.roots.get(name);
    if (!root) {
      console.error(
        `Pass --root ${name}=<path to a synced ${name} clone> (or --vite-root / NEXUSMEM_BENCH_VITE_ROOT for vite), ` +
          `or drop ${name} from --corpus to skip that external corpus.`,
      );
      process.exit(1);
    }
    specs.push({ name, root });
  }

  const all: QueryResult[] = [];
  for (const spec of specs) {
    console.log(`\n--- benchmarking ${spec.name} (${spec.root}) ---`);
    all.push(...(await benchmarkCorpus(spec, opts.count, opts.vector)));
  }

  printSummary(all);

  const outPath = opts.out ?? join(repoRoot, 'bench', 'results', `${Date.now()}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  console.log(`\nFull per-query results written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
