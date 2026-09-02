import { relative } from 'node:path';
import pc from 'picocolors';
import {
  defaultConfig,
  isInitialized,
  readConfig,
  resolveWorkspace,
  writeConfig,
  writeWorkspaceGitignore,
} from '../../config/workspace.js';
import { recordProject } from '../../config/registry.js';
import { makeProjectId } from '../../core/project.js';
import { readRepoInfo } from '../../git/repo.js';
import { installHook, ProfileNotFoundError, resolveHookTarget } from '../../hooks/install.js';
import { MemoryStore } from '../../store/store.js';
import { LATEST_SCHEMA_VERSION } from '../../store/schema.js';

export interface InitOptions {
  cwd: string;
  force: boolean;
  /** Also install the opt-in PowerShell hook that logs cwd + exit code + timestamp. */
  hook: boolean;
  /** Persist `sources.conversation.enabled = true` in config.json. */
  enableConversation: boolean;
  /**
   * Where the result summary goes. Defaults to real stdout for the CLI.
   *
   * Callers that are not a terminal pass their own sink. The MCP server is
   * the reason this exists rather than a capture wrapper: there, `stdout` is
   * the JSON-RPC transport, so borrowing it for human-readable output is not
   * a formatting choice but a protocol hazard.
   */
  out?: (chunk: string) => void;
}

export async function runInit(opts: InitOptions): Promise<number> {
  const out = opts.out ?? ((chunk: string) => void process.stdout.write(chunk));
  const repo = await readRepoInfo(opts.cwd);
  const ws = resolveWorkspace(repo.root);
  const projectId = makeProjectId({ root: repo.root, originUrl: repo.originUrl });

  const already = isInitialized(ws);
  if (already && !opts.force) {
    const existing = await readConfig(ws);
    process.stderr.write(
      `${pc.yellow('already initialized')} ${relative(process.cwd(), ws.configPath) || ws.configPath}\n` +
        `  project ${pc.cyan(existing.projectId)}\n` +
        `  use ${pc.bold('--force')} to reset the config (the database is kept)\n`,
    );
    return 0;
  }

  await writeWorkspaceGitignore(ws);
  const config = defaultConfig(projectId);
  if (opts.enableConversation) config.sources.conversation.enabled = true;
  await writeConfig(ws, config);

  // Creating the database here means `init` surfaces native-module or
  // filesystem problems immediately, rather than halfway through a long sync.
  const store = MemoryStore.open(ws.dbPath);
  try {
    store.upsertProject({ id: projectId, root: repo.root, originUrl: repo.originUrl });
  } finally {
    store.close();
  }

  // Cross-project recall can only find a database it has been told about --
  // nothing else on the machine points at `<repo>/.nexusmem/`.
  await recordProject({ projectId, root: repo.root, dbPath: ws.dbPath, originUrl: repo.originUrl });

  const lines = [
    `${pc.green('initialized')} ${ws.dir}`,
    `  project  ${pc.cyan(projectId)}`,
    `  repo     ${repo.root}`,
    `  branch   ${repo.branch ?? pc.yellow('(detached)')}`,
    `  schema   v${LATEST_SCHEMA_VERSION}`,
  ];

  if (opts.enableConversation) {
    lines.push(`  ${pc.yellow('conversation source enabled')} -- transcripts will be redacted-but-indexed on sync`);
  }

  if (opts.hook) {
    try {
      const target = await resolveHookTarget();
      const result = await installHook(target);
      lines.push(
        '',
        `${pc.green(result.changed ? 'installed' : 'already installed')} shell hook (${target.shell})`,
        `  profile ${target.profilePath}`,
        `  log     ${target.logPath}`,
        target.shell === 'pwsh'
          ? `  open a new PowerShell window (or run \`. $PROFILE\`) for it to take effect`
          : `  open a new shell (or run \`. ${target.profilePath}\`) for it to take effect`,
      );
    } catch (err) {
      if (err instanceof ProfileNotFoundError) {
        lines.push('', `${pc.yellow('hook not installed')} ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  lines.push('', `Next: ${pc.bold('nexusmem sync')}`, '');
  out(lines.join('\n'));

  return 0;
}
