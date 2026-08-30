import pc from 'picocolors';
import { assessFiles, type FileRisk } from '../../correlate/precheck.js';
import { git } from '../../git/exec.js';
import { MemoryStore } from '../../store/store.js';
import { loadContext } from '../context.js';

export interface PrecheckOptions {
  cwd: string;
  /** Explicit file list, repo-relative. Overrides --working / the staged-files default. */
  files?: string[];
  /** Check the working tree (unstaged) instead of what's staged for commit. */
  working?: boolean;
  /** Exit 1 when any file has an unresolved failure. Off by default -- advisory, like every other opt-in signal this project ships. */
  strict?: boolean;
  quiet?: boolean;
  /** Where the report goes. Defaults to real stderr (stdout is reserved for `--json`-style machine output elsewhere in the CLI). Injectable for tests. */
  out?: (chunk: string) => void;
}

/**
 * A file counts as high-churn at this many git-commit touches within
 * `assessFiles`'s recent window -- a repeatedly-edited file is more likely
 * to still have an unresolved architectural issue than one touched once.
 * Not tuned against real data (unlike the discussion-bridge heuristic's
 * thresholds); a reasonable starting point to dogfood, same as
 * `--link-failures` shipped before its heuristics were trusted.
 */
const HIGH_CHURN_THRESHOLD = 4;

async function stagedFiles(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACM']);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function workingTreeFiles(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, ['diff', '--name-only', '--diff-filter=ACM']);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function runPrecheck(opts: PrecheckOptions): Promise<number> {
  const out = opts.out ?? ((chunk: string) => void process.stderr.write(chunk));
  const { repo, ws, projectId } = await loadContext(opts.cwd);

  const targetFiles = opts.files ?? (opts.working ? await workingTreeFiles(repo.root) : await stagedFiles(repo.root));

  if (targetFiles.length === 0) {
    if (!opts.quiet) out(`${pc.dim('precheck')} no files to check\n`);
    return 0;
  }

  const store = MemoryStore.open(ws.dbPath);
  let risks: FileRisk[];
  try {
    risks = assessFiles(store, projectId, targetFiles);
  } finally {
    store.close();
  }

  const flagged = risks.filter((r) => r.unresolvedFailures.length > 0 || r.commitsRecent >= HIGH_CHURN_THRESHOLD);

  if (flagged.length === 0) {
    if (!opts.quiet) out(`${pc.green('precheck')} no warnings — looking good\n`);
    return 0;
  }

  out(`\n${pc.bold('nexusmem precheck')}\n${pc.dim('-'.repeat(40))}\n\n`);

  for (const risk of flagged) {
    out(`  ${pc.bold(risk.path)}\n`);

    if (risk.unresolvedFailures.length > 0) {
      // "naming this file", not "in this file": the match is against basename
      // word-tokens (tokensForFile), so a failing `npm run precheck` flags
      // every file whose name contains that word, not just the one actually
      // responsible. Overclaiming location here would misdirect exactly the
      // reader this warning is trying to help.
      out(`    ${pc.yellow('WARN')}  commands naming this file failed, still unresolved (${risk.unresolvedFailures.length}):\n`);
      for (const f of risk.unresolvedFailures.slice(0, 3)) {
        out(`           ${pc.dim(`${f.ts.slice(0, 10)}  ${f.command.slice(0, 90)}`)}\n`);
      }
      if (risk.unresolvedFailures.length > 3) {
        out(`           ${pc.dim(`... and ${risk.unresolvedFailures.length - 3} more`)}\n`);
      }
    }

    if (risk.commitsRecent >= HIGH_CHURN_THRESHOLD) {
      // Lower severity and labeled as a heuristic on purpose: HIGH_CHURN_THRESHOLD
      // is an untuned guess (see its own comment), unlike the failure-correlation
      // WARN above, which reuses a threshold actually dogfooded against real
      // links. Presenting both at the same WARN weight would overstate this one.
      out(`    ${pc.dim('note')}  high churn (untuned heuristic): ${risk.commitsRecent} commits touched this file recently\n`);
    }

    out('\n');
  }

  const failureCount = flagged.filter((r) => r.unresolvedFailures.length > 0).length;
  out(`${pc.dim(`${flagged.length} file(s) flagged, ${failureCount} with unresolved failures.`)}\n`);

  if (opts.strict && failureCount > 0) return 1;
  return 0;
}
