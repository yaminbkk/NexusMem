import { basename, join } from 'node:path';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import pc from 'picocolors';
import { getChainStats, type ChainStats } from '../../correlate/failure-fix.js';
import { parsePostCommitSyncState, STATE_PATH } from '../../hooks/git-post-commit.js';
import { gitHookStatus, resolveGitHookTarget } from '../../hooks/install-git-precommit.js';
import { postCommitGitHookStatus, resolvePostCommitHookTarget } from '../../hooks/install-git-postcommit.js';
import { hookStatus, resolveHookTarget, type HookTarget } from '../../hooks/install.js';
import { MemoryStore } from '../../store/store.js';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION } from '../../store/schema.js';
import { loadContext } from '../context.js';
import type { RepoInfo } from '../../git/repo.js';
import type { StoreStats } from '../../store/store.js';

export interface StatusOptions {
  cwd: string;
  /** Where the status report goes. Defaults to real stdout for the CLI. */
  out?: (chunk: string) => void;
  /** Print a plain-text, no-ANSI summary meant to be copy-pasted onto X/Reddit/etc. */
  share?: boolean;
  /** Test-only: skip resolveHookTarget()'s real profile-detection (which can spawn powershell.exe) with an injected target. */
  shellHookTarget?: HookTarget;
  /** Test-only: deterministic "now" for relative-time assertions. Defaults to Date.now. */
  now?: () => number;
}

function daySpan(oldest: string, newest: string): number {
  const oldestDay = Date.parse(oldest.slice(0, 10));
  const newestDay = Date.parse(newest.slice(0, 10));
  return Math.round((newestDay - oldestDay) / 86_400_000) + 1;
}

function buildShareText(repo: RepoInfo, stats: StoreStats, chains: ChainStats): string {
  if (stats.total === 0) {
    return 'Nothing synced yet in this repo -- run `nexusmem sync` first, then `nexusmem status --share`.\n';
  }

  const days = daySpan(stats.oldest ?? stats.newest ?? '', stats.newest ?? stats.oldest ?? '');
  const commits = stats.byKind.git_commit ?? 0;
  const shellCommands = stats.byKind.shell_command ?? 0;
  const docs = stats.byKind.doc_section ?? 0;
  const parts = [`${commits} commit(s)`, `${shellCommands} shell command(s)`, `${docs} doc section(s)`].filter(
    (p) => !p.startsWith('0 '),
  );

  const lines = [
    `NexusMem has been watching ${basename(repo.root)} for ${days} day(s):`,
    `  ${stats.total} memories${parts.length ? ` (${parts.join(', ')})` : ''}`,
  ];
  if (chains.failuresTotal) {
    lines.push(`  ${chains.resolvedTotal}/${chains.failuresTotal} failure -> fix chain(s) linked`);
  }
  lines.push('', 'Local-only SQLite, no cloud, no telemetry.', 'https://github.com/yaminbkk/NexusMem');

  return lines.join('\n').concat('\n');
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function relativeTime(fromMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (diffSec < 60) return `${diffSec} second${diffSec === 1 ? '' : 's'} ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? '' : 's'} ago`;
  const diffDay = Math.round(diffHour / 24);
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

/** Profile detection (e.g. spawning powershell.exe to resolve $PROFILE) can fail on a bare box -- that's "not installed", not a reason to fail the whole status report. */
async function getShellHookStatus(injected?: HookTarget): Promise<{ shell: HookTarget['shell']; installed: boolean } | null> {
  try {
    const target = injected ?? (await resolveHookTarget());
    return { shell: target.shell, installed: (await hookStatus(target)).installed };
  } catch {
    return null;
  }
}

async function readLastAutoSync(repoRoot: string) {
  try {
    const raw = await readFile(join(repoRoot, STATE_PATH), 'utf8');
    return parsePostCommitSyncState(raw);
  } catch {
    return null;
  }
}

export async function runStatus(opts: StatusOptions): Promise<number> {
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const { repo, ws, projectId } = await loadContext(opts.cwd);
  const store = MemoryStore.open(ws.dbPath);

  try {
    const stats = store.stats(projectId);
    const chains = getChainStats(store, projectId);

    if (opts.share) {
      out(buildShareText(repo, stats, chains));
      return 0;
    }

    const sources = store.listSyncState(projectId);
    const gitCursor = sources.find((s) => s.source === 'git')?.cursor ?? null;
    const schema = currentSchemaVersion(store.raw);
    const otherProjectIds = store.listOtherProjectIds(projectId);
    const otherProjectNodes = store.countProjectNodes(otherProjectIds);
    const structure = store.fileEdgeStats(projectId);
    const staleCount = store.countStaleCandidates(projectId);
    const flaggedCount = store.countContradictionSuggestions(projectId);

    const [shellHook, preCommitTarget, postCommitTarget, lastAutoSync] = await Promise.all([
      getShellHookStatus(opts.shellHookTarget),
      resolveGitHookTarget(repo.root),
      resolvePostCommitHookTarget(repo.root),
      readLastAutoSync(repo.root),
    ]);
    const [preCommitStatus, postCommitStatus] = await Promise.all([
      gitHookStatus(preCommitTarget),
      postCommitGitHookStatus(postCommitTarget),
    ]);
    const now = (opts.now ?? Date.now)();

    const hooksPathNote = (target: { hooksPathConfig?: string | null }) =>
      target.hooksPathConfig ? pc.dim(` (core.hooksPath=${target.hooksPathConfig})`) : '';
    const installedLabel = (installed: boolean) => (installed ? pc.green('installed') : pc.yellow('not installed'));
    const lastAutoSyncLabel = lastAutoSync
      ? `${lastAutoSync.ok ? pc.green('ok') : pc.red(`FAILED (exit ${lastAutoSync.exitCode})`)} ${pc.dim(relativeTime(Date.parse(lastAutoSync.ts), now))}`
      : postCommitStatus.installed
        ? pc.dim('never (or hook predates this field -- reinstall with `nexusmem hook git-post install`)')
        : pc.dim('n/a -- hook not installed');

    const hooksLines = [
      pc.dim('hooks'),
      `    ${pc.dim(`shell (${shellHook?.shell ?? '?'})`.padEnd(23))} ${shellHook ? installedLabel(shellHook.installed) : pc.dim('unknown -- could not detect this machine’s shell profile')}`,
      `    ${pc.dim('git pre-commit'.padEnd(23))} ${installedLabel(preCommitStatus.installed)}${hooksPathNote(preCommitTarget)}`,
      `    ${pc.dim('git post-commit'.padEnd(23))} ${installedLabel(postCommitStatus.installed)}${hooksPathNote(postCommitTarget)}`,
      `    ${pc.dim('last auto-sync'.padEnd(23))} ${lastAutoSyncLabel}`,
    ];

    // WAL content counts towards what is actually on disk.
    const dbBytes = fileSize(ws.dbPath) + fileSize(`${ws.dbPath}-wal`);

    const kinds = Object.entries(stats.byKind)
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => `    ${String(n).padStart(6)}  ${kind}`);
    const staleProjectWarning = otherProjectIds.length
      ? `${pc.yellow('stale   ')} ${otherProjectIds.length} prior project ${
          otherProjectIds.length === 1 ? 'identity holds' : 'identities hold'
        } ${otherProjectNodes} node(s) — run ${pc.bold(
          'nexusmem sync --prune-source <name>',
        )} to remove stale source data`
      : '';

    out(
      [
        `${pc.dim('repo    ')} ${repo.root}`,
        `${pc.dim('branch  ')} ${repo.branch ?? pc.yellow('(detached)')}`,
        `${pc.dim('project ')} ${pc.cyan(projectId)}`,
        `${pc.dim('schema  ')} v${schema}${schema === LATEST_SCHEMA_VERSION ? '' : pc.yellow(` (latest is v${LATEST_SCHEMA_VERSION})`)}`,
        `${pc.dim('database')} ${ws.dbPath} ${pc.dim(`(${humanBytes(dbBytes)})`)}`,
        staleProjectWarning,
        '',
        `${pc.bold(String(stats.total))} node(s)${stats.total ? ` ${pc.dim(`${stats.oldest?.slice(0, 10)} .. ${stats.newest?.slice(0, 10)}`)}` : ''}`,
        ...kinds,
        stats.total ? `    ${pc.dim(`${stats.distinctFiles} distinct file path(s)`)}` : '',
        '',
        sources.length ? pc.dim('sources') : pc.yellow('no sources synced yet'),
        ...sources.map((s) => {
          const when = s.lastRunAt ? new Date(s.lastRunAt).toISOString().slice(0, 16).replace('T', ' ') : 'never';
          const cursorLabel = s.source === 'git' ? (s.cursor?.slice(0, 7) ?? '-') : (s.cursor ?? '-');
          return `    ${s.source.padEnd(14)} ${pc.dim(`last run ${when}`)}  ${pc.dim(`cursor ${cursorLabel}`)}`;
        }),
        '',
        gitCursor && gitCursor !== repo.head ? `${pc.yellow('git behind HEAD')} — run ${pc.bold('nexusmem sync')}` : '',
        chains.failuresTotal
          ? `${pc.dim('chains  ')} ${pc.bold(String(chains.resolvedTotal))}/${chains.failuresTotal} failure(s) resolved ${pc.dim(`(${chains.resolvedByRetry} retry, ${chains.resolvedByDiscussion} discussion)`)}${
              chains.resolvedTotal < chains.failuresTotal ? ` — run ${pc.bold('nexusmem sync --link-failures')} to link more` : ''
            }`
          : '',
        structure.edges ? `${pc.dim('structure')} ${pc.bold(String(structure.edges))} import edge(s) across ${structure.files} file(s)` : '',
        staleCount
          ? `${pc.dim('aging   ')} ${pc.bold(String(staleCount))} unconfirmed node(s) worth a look — run ${pc.bold('nexusmem stale')}`
          : '',
        flaggedCount
          ? `${pc.dim('flagged ')} ${pc.bold(String(flaggedCount))} likely-superseded node(s) awaiting review — run ${pc.bold('nexusmem stale')} for detail`
          : '',
        '',
        ...hooksLines,
      ]
        .filter((line) => line !== '')
        .join('\n')
        .concat('\n'),
    );

    return 0;
  } finally {
    store.close();
  }
}
