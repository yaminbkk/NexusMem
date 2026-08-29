import { Command } from 'commander';
import pc from 'picocolors';
import { ConfigError } from '../config/workspace.js';
import { readOwnVersion } from '../core/version.js';
import { GitCrashError, GitSpawnError } from '../git/exec.js';
import { NotAGitRepositoryError } from '../git/repo.js';
import { ProfileNotFoundError } from '../hooks/install.js';
import { ForeignGitHookError } from '../hooks/install-git-precommit.js';
import { DenyListError } from '../store/deny-list.js';
import { runForget } from './commands/forget.js';
import { runHookGitInstall, runHookGitRemove, runHookGitStatus } from './commands/hook-git.js';
import { runHookInstall, runHookRemove, runHookStatus } from './commands/hook.js';
import { runInit } from './commands/init.js';
import { MarkStaleError, runMarkStale } from './commands/mark-stale.js';
import { runProjects } from './commands/projects.js';
import { runMcpServer } from '../mcp/server.js';
import { runPrecheck } from './commands/precheck.js';
import { QueryError, runQuery } from './commands/query.js';
import { ReviewError, runReview } from './commands/review.js';
import { runScanConversation } from './commands/scan-conversation.js';
import { runScanDiff } from './commands/scan-diff.js';
import { runScanDocs } from './commands/scan-docs.js';
import { runScanGit } from './commands/scan-git.js';
import { runScanGithub } from './commands/scan-github.js';
import { runScanSession, SCAN_SESSION_DEFAULT_MODEL } from './commands/scan-session.js';
import { runScanShell } from './commands/scan-shell.js';
import { runScanStructure } from './commands/scan-structure.js';
import { runStale, STALE_DEFAULT_MODEL } from './commands/stale.js';
import { runStatus } from './commands/status.js';
import { runSync } from './commands/sync.js';

/** Failures the user can act on, reported without a stack trace. */
function isExpected(err: unknown): err is Error {
  return (
    err instanceof NotAGitRepositoryError ||
    // "git isn't installed" and "the spawn failed, try again" are both things
    // the user fixes, not stack traces they debug.
    err instanceof GitSpawnError ||
    // Survived every retry, so git is genuinely unstable on this machine
    // (antivirus, a bad install). Actionable, and not our stack to print.
    err instanceof GitCrashError ||
    err instanceof ConfigError ||
    err instanceof ProfileNotFoundError ||
    err instanceof ForeignGitHookError ||
    err instanceof DenyListError ||
    err instanceof MarkStaleError ||
    err instanceof QueryError ||
    err instanceof ReviewError
  );
}

/** Wrap a command so expected failures exit 1 with a clean message. */
function guard(run: () => Promise<number>): () => Promise<void> {
  return async () => {
    try {
      process.exitCode = await run();
    } catch (err) {
      if (isExpected(err)) {
        process.stderr.write(`${pc.red('error')} ${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  };
}

const program = new Command();

program
  .name('nexusmem')
  .description('NexusMem — local-first persistent memory for AI coding agents')
  .version(readOwnVersion());

program
  .command('init')
  .description('Create the .nexusmem workspace and database for this repository')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--force', 'overwrite an existing config (the database is kept)', false)
  .option('--hook', 'also install the opt-in PowerShell hook (cwd + exit code + timestamp)', false)
  .option('--enable-conversation', 'opt in to the conversation-transcript source (off by default -- see docs/phase-2-spec.md)', false)
  .action((options) =>
    guard(() =>
      runInit({ cwd: options.cwd, force: options.force, hook: options.hook, enableConversation: options.enableConversation }),
    )(),
  );

program
  .command('sync')
  .description('Ingest new history into the local database')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--full', 'ignore the stored cursor and re-walk all history', false)
  .option('--rebuild', 'drop this project\'s nodes and re-ingest from scratch', false)
  .option('--since <date>', 'override the configured git cutoff, e.g. 1.year.ago')
  .option('--shell-lines <count>', 'override the configured shell tail-window size', (v) => Number.parseInt(v, 10))
  .option('--conversation', 'force the conversation source on for this run, without persisting it to config', false)
  .option('--no-embed', 'skip the vector-embedding pass for this run')
  .option('--embed-limit <count>', 'stop embedding after this many nodes (default: embed everything pending)', (v) =>
    Number.parseInt(v, 10),
  )
  .option('--prune-source <name>', 'delete every node from this exact source (e.g. shell:pwsh) instead of syncing -- dry-run unless --yes is also given')
  .option(
    '--prune-stale-shell',
    'shortcut for --prune-source on shell:pwsh, shell:bash and shell:zsh at once -- the dead pre-hook scrape sources -- dry-run unless --yes is also given',
    false,
  )
  .option('--yes', 'confirm an irreversible --prune-source/--prune-stale-shell delete', false)
  .option(
    '--link-failures',
    'opt-in (experimental): after ingest, link failed shell commands to whatever later resolved them',
    false,
  )
  .option('-q, --quiet', 'only print the final summary', false)
  .action((options) =>
    guard(() =>
      runSync({
        cwd: options.cwd,
        full: options.full,
        rebuild: options.rebuild,
        since: options.since,
        shellTailLines: options.shellLines,
        conversationOverride: options.conversation ? true : undefined,
        noEmbed: !options.embed,
        embedLimit: options.embedLimit,
        pruneSource: options.pruneSource,
        pruneStaleShell: options.pruneStaleShell,
        yes: options.yes,
        linkFailures: options.linkFailures,
        quiet: options.quiet,
      }),
    )(),
  );

program
  .command('hook')
  .description('Manage the opt-in PowerShell hook that logs cwd + exit code + timestamp')
  .addCommand(
    new Command('install')
      .description('Install (or update) the hook in your PowerShell profile')
      .option('--profile <path>', 'override the auto-detected $PROFILE path')
      .action((options) => guard(() => runHookInstall({ profile: options.profile }))()),
  )
  .addCommand(
    new Command('remove')
      .description('Remove the hook block from your PowerShell profile')
      .option('--profile <path>', 'override the auto-detected $PROFILE path')
      .action((options) => guard(() => runHookRemove({ profile: options.profile }))()),
  )
  .addCommand(
    new Command('status')
      .description('Show whether the hook is installed')
      .option('--profile <path>', 'override the auto-detected $PROFILE path')
      .action((options) => guard(() => runHookStatus({ profile: options.profile }))()),
  )
  .addCommand(
    new Command('git')
      .description('Manage the opt-in git pre-commit hook that runs `nexusmem precheck` before each commit')
      .addCommand(
        new Command('install')
          .description('Install (or update) the hook in .git/hooks/pre-commit')
          .option('-C, --cwd <path>', 'repository path', process.cwd())
          .option('--force', 'append after an existing foreign pre-commit hook instead of refusing', false)
          .action((options) => guard(() => runHookGitInstall({ cwd: options.cwd, force: options.force }))()),
      )
      .addCommand(
        new Command('remove')
          .description("Remove nexusmem's block from .git/hooks/pre-commit")
          .option('-C, --cwd <path>', 'repository path', process.cwd())
          .action((options) => guard(() => runHookGitRemove({ cwd: options.cwd }))()),
      )
      .addCommand(
        new Command('status')
          .description('Show whether the git pre-commit hook is installed')
          .option('-C, --cwd <path>', 'repository path', process.cwd())
          .action((options) => guard(() => runHookGitStatus({ cwd: options.cwd }))()),
      ),
  );

program
  .command('status')
  .description('Show what is currently remembered for this repository')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--share', 'print a plain-text summary formatted for sharing, e.g. on X or Reddit')
  .action((options) => guard(() => runStatus({ cwd: options.cwd, share: options.share }))());

program
  .command('query')
  .description('Search remembered history and print a token-budgeted context block')
  .argument('<text>', 'free-text query')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('-b, --budget <tokens>', 'max tokens in the packed context', (v) => Number.parseInt(v, 10), 2000)
  .option('-n, --candidates <count>', 'how many search hits to rank before packing', (v) => Number.parseInt(v, 10), 30)
  .option('--half-life <days>', 'days for a node\'s recency weight to halve', (v) => Number.parseFloat(v))
  .option('--no-vector', 'BM25 only -- skip embedding the query and vector search')
  .option('-a, --all-projects', 'search every registered repository, not just this one', false)
  .option('--as-of <date>', 'bi-temporal read: only nodes recorded at or before this date -- "what did the store hold then", not "what happened then"')
  .option('--json', 'emit the packed result as JSON on stdout', false)
  .action((text: string, options) =>
    guard(() =>
      runQuery({
        cwd: options.cwd,
        query: text,
        budget: options.budget,
        candidates: options.candidates,
        halfLifeDays: options.halfLife,
        noVector: !options.vector,
        allProjects: options.allProjects,
        asOf: options.asOf,
        json: options.json,
      }),
    )(),
  );

program
  .command('forget')
  .description(
    'Permanently deny-list a value: deletes matching nodes now and blocks it from ever being re-ingested (irreversible)',
  )
  .argument('[value]', 'exact text to forget (see --regex); omit with --list')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--regex', 'treat <value> as a regular expression instead of a literal substring', false)
  .option('--ignore-case', 'case-insensitive match', false)
  .option('--reason <text>', 'free-text note stored with the deny-list entry')
  .option('--list', 'list active deny-list entries instead of forgetting a new value', false)
  .option('--export <path>', 'write this project\'s deny-list to a JSON file, for --import in another checkout')
  .option('--import <path>', 're-apply a deny-list JSON file (from --export) against this project')
  .option('--yes', 'confirm the irreversible delete + deny-list write', false)
  .action((value: string | undefined, options) =>
    guard(() =>
      runForget({
        cwd: options.cwd,
        value,
        regex: options.regex,
        ignoreCase: options.ignoreCase,
        reason: options.reason,
        list: options.list,
        export: options.export,
        import: options.import,
        yes: options.yes,
      }),
    )(),
  );

program
  .command('mark-stale')
  .description(
    'Mark a node as superseded by another -- the ranker down-weights it (never deletes it) so its replacement usually outranks it',
  )
  .argument('<nodeId>', 'id of the node to mark stale')
  .requiredOption('--supersedes <newNodeId>', 'id of the node that supersedes it')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .action((nodeId: string, options) =>
    guard(() => runMarkStale({ cwd: options.cwd, nodeId, supersedesId: options.supersedes }))(),
  );

program
  .command('stale')
  .description('List unconfirmed (non-observed) nodes old enough to be worth double-checking (writes nothing)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--min-age-days <days>', 'only nodes at least this old', (v) => Number.parseFloat(v))
  .option('-n, --limit <count>', 'stop after N candidates', (v) => Number.parseInt(v, 10))
  .option(
    '--check-contradictions',
    'ask the local SLM whether a similar newer node actually contradicts each candidate (needs Ollama)',
  )
  .option('--model <name>', 'Ollama chat model for --check-contradictions', STALE_DEFAULT_MODEL)
  .option('--dismiss <candidateId>', 'reject the open contradiction suggestion for this node id so it stops resurfacing')
  .action((options) =>
    guard(() =>
      runStale({
        cwd: options.cwd,
        minAgeDays: options.minAgeDays,
        limit: options.limit,
        checkContradictions: options.checkContradictions,
        model: options.model,
        dismiss: options.dismiss,
      }),
    )(),
  );

program
  .command('review')
  .description('Record a human verdict on one node: --verify or --reject (a rejected node is down-weighted in ranking, never deleted)')
  .argument('<nodeId>', 'id of the node being reviewed')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--verify', 'mark the node verified (label only, no ranking change)', false)
  .option('--reject', 'mark the node rejected (down-weighted in ranking, still queryable)', false)
  .action((nodeId: string, options) =>
    guard(async () => {
      if (options.verify === options.reject) {
        throw new ReviewError('pass exactly one of --verify or --reject');
      }
      return runReview({ cwd: options.cwd, nodeId, verdict: options.verify ? 'verified' : 'rejected' });
    })(),
  );

program
  .command('projects')
  .description('List the repositories `query --all-projects` would search')
  .option('--prune', 'forget registered projects whose database is no longer on disk', false)
  .option('--json', 'emit the registry as JSON on stdout', false)
  .action((options) => guard(() => runProjects({ prune: options.prune, json: options.json }))());

program
  .command('scan-git')
  .description('Preview the MemoryNodes git history would produce (writes nothing)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--since <date>', 'only commits newer than this git date expression, e.g. 90.days.ago')
  .option('-n, --limit <count>', 'stop after N commits', (v) => Number.parseInt(v, 10))
  .option('--no-merges', 'skip merge commits')
  .option('--min-signal <score>', 'drop nodes below this signal', (v) => Number.parseFloat(v), 0)
  .option('--json', 'emit MemoryNodes as JSON on stdout', false)
  .action((options) =>
    guard(() =>
      runScanGit({
        cwd: options.cwd,
        since: options.since,
        limit: options.limit,
        merges: options.merges,
        json: options.json,
        minSignal: options.minSignal,
      }),
    )(),
  );

program
  .command('scan-diff')
  .description('Preview the MemoryNodes commit patches would produce, one per changed file (writes nothing)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--since <date>', 'only commits newer than this git date expression, e.g. 90.days.ago')
  .option('-n, --limit <count>', 'stop after N commits (not N nodes)', (v) => Number.parseInt(v, 10))
  .option('--min-signal <score>', 'drop nodes below this signal', (v) => Number.parseFloat(v), 0)
  .option('--json', 'emit MemoryNodes as JSON on stdout', false)
  .action((options) =>
    guard(() =>
      runScanDiff({
        cwd: options.cwd,
        since: options.since,
        limit: options.limit,
        json: options.json,
        minSignal: options.minSignal,
      }),
    )(),
  );

program
  .command('scan-shell')
  .description('Preview the MemoryNodes shell history would produce (writes nothing)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('-n, --tail-lines <count>', 'lines kept from each scrape-based source', (v) => Number.parseInt(v, 10), 300)
  .option('--min-signal <score>', 'drop nodes below this signal', (v) => Number.parseFloat(v), 0)
  .option('--json', 'emit MemoryNodes as JSON on stdout', false)
  .action((options) =>
    guard(() =>
      runScanShell({ cwd: options.cwd, tailLines: options.tailLines, minSignal: options.minSignal, json: options.json }),
    )(),
  );

program
  .command('scan-conversation')
  .description('Preview the MemoryNodes the conversation transcript would produce (writes nothing)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--min-signal <score>', 'drop nodes below this signal', (v) => Number.parseFloat(v), 0)
  .option('--json', 'emit MemoryNodes as JSON on stdout', false)
  .action((options) =>
    guard(() => runScanConversation({ cwd: options.cwd, minSignal: options.minSignal, json: options.json }))(),
  );

program
  .command('scan-session')
  .description('Preview the session summaries a local model would produce (writes nothing)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--model <name>', 'Ollama model to summarize with', SCAN_SESSION_DEFAULT_MODEL)
  .option('--settle-minutes <count>', 'minutes of quiet before a session counts as finished', (v) => Number.parseInt(v, 10), 30)
  .option('-n, --max-sessions <count>', 'how many sessions to summarize', (v) => Number.parseInt(v, 10), 3)
  .option('--dry-run', 'print the prompts instead of calling the model', false)
  .option('--json', 'emit as JSON on stdout', false)
  .action((options) =>
    guard(() =>
      runScanSession({
        cwd: options.cwd,
        model: options.model,
        settleMinutes: options.settleMinutes,
        maxSessions: options.maxSessions,
        dryRun: options.dryRun,
        json: options.json,
      }),
    )(),
  );

program
  .command('scan-docs')
  .description('Preview the MemoryNodes tracked .md files would produce (writes nothing)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--min-signal <score>', 'drop nodes below this signal', (v) => Number.parseFloat(v), 0)
  .option('--json', 'emit MemoryNodes as JSON on stdout', false)
  .action((options) => guard(() => runScanDocs({ cwd: options.cwd, minSignal: options.minSignal, json: options.json }))());

program
  .command('scan-github')
  .description('Preview the MemoryNodes github.com issues/PRs would produce (writes nothing, needs `gh` installed and authenticated)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--min-signal <score>', 'drop nodes below this signal', (v) => Number.parseFloat(v), 0)
  .option('--json', 'emit MemoryNodes as JSON on stdout', false)
  .action((options) => guard(() => runScanGithub({ cwd: options.cwd, minSignal: options.minSignal, json: options.json }))());

program
  .command('precheck')
  .description('Warn about staged files with unresolved past failures or high recent churn (advisory, exits 0 unless --strict)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--files <paths...>', 'check exactly these repo-relative paths instead of what is staged')
  .option('--working', 'check the working tree (unstaged changes) instead of what is staged for commit', false)
  .option('--strict', 'exit 1 when any file has an unresolved failure', false)
  .option('-q, --quiet', 'only print output when there is something to warn about', false)
  .action((options) =>
    guard(() =>
      runPrecheck({
        cwd: options.cwd,
        files: options.files,
        working: options.working,
        strict: options.strict,
        quiet: options.quiet,
      }),
    )(),
  );

program
  .command('scan-structure')
  .description('Preview the JS/TS/Python/Go/Rust/Java/PHP import-graph edges a sync would produce (writes nothing)')
  .option('-C, --cwd <path>', 'repository path', process.cwd())
  .option('--json', 'emit edges as JSON on stdout', false)
  .action((options) => guard(() => runScanStructure({ cwd: options.cwd, json: options.json }))());

program
  .command('mcp')
  .description('Start the MCP server (stdio transport) for Claude Desktop, Cursor, Windsurf, etc.')
  .action(() => guard(() => runMcpServer().then(() => 0))());

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${pc.red('error')} ${message}\n`);
  process.exitCode = 1;
});
