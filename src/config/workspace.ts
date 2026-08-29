import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_SLM_MODEL } from '../slm/provider.js';

/** Everything NexusMem stores lives under this directory in the repo root. */
export const WORKSPACE_DIR = '.nexusmem';

export interface Workspace {
  /** Repository root. */
  root: string;
  /** `<root>/.nexusmem` */
  dir: string;
  dbPath: string;
  configPath: string;
}

export function resolveWorkspace(repoRoot: string): Workspace {
  const dir = join(repoRoot, WORKSPACE_DIR);
  return {
    root: repoRoot,
    dir,
    dbPath: join(dir, 'memory.db'),
    configPath: join(dir, 'config.json'),
  };
}

export function isInitialized(ws: Workspace): boolean {
  return existsSync(ws.configPath);
}

export const ConfigSchema = z.object({
  version: z.literal(1),
  projectId: z.string().min(1),
  sources: z
    .object({
      git: z
        .object({
          enabled: z.boolean().default(true),
          /** Git date expression bounding how far back to ingest; null = all history. */
          since: z.string().nullable().default(null),
          includeMerges: z.boolean().default(true),
        })
        .default({ enabled: true, since: null, includeMerges: true }),
      shell: z
        .object({
          enabled: z.boolean().default(true),
          /** Lines kept from scrape-based (no-hook) history files each sync. */
          tailLines: z.number().int().positive().default(300),
        })
        .default({ enabled: true, tailLines: 300 }),
      /**
       * Opt-in, unlike git/shell: conversation transcripts are the source
       * most likely to contain something sensitive (a pasted credential,
       * confidential discussion), so this must be a deliberate choice, not
       * an automatic default. See docs/phase-2-spec.md.
       */
      conversation: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({ enabled: false }),
      /**
       * One distilled node per finished working session, written by a local
       * small language model.
       *
       * Opt-in for the same reason as `conversation` -- it reads the same
       * transcripts -- and additionally because it is the only source that
       * costs real compute. Independent of `conversation.enabled`: summaries
       * without the raw exchanges is a legitimate, and much smaller, way to
       * remember a session.
       */
      session: z
        .object({
          enabled: z.boolean().default(false),
          /** Ollama model tag. Must be pulled locally; nothing is downloaded automatically. */
          model: z.string().default(DEFAULT_SLM_MODEL),
          /** Minutes of quiet before a session counts as finished and can be summarized. */
          settleMinutes: z.number().int().nonnegative().default(30),
          /** Sessions summarized per sync. Each is a model call measured in seconds. */
          maxSessions: z.number().int().positive().default(10),
          maxPromptChars: z.number().int().positive().default(12_000),
        })
        .default({
          enabled: false,
          model: DEFAULT_SLM_MODEL,
          settleMinutes: 30,
          maxSessions: 10,
          maxPromptChars: 12_000,
        }),
      /** Tracked `.md` files -- README, architecture docs. On by default like git/shell: no secrets risk, just project prose. */
      docs: z
        .object({
          enabled: z.boolean().default(true),
          /** git pathspecs passed to `git ls-files`. */
          include: z.array(z.string()).default(['*.md']),
        })
        .default({ enabled: true, include: ['*.md'] }),
      /**
       * The patch text of each commit, one node per changed file.
       *
       * Bounded by `maxCommits` rather than by `git.since`, because patches
       * are an order of magnitude bulkier than commit messages: an unbounded
       * first sync of a long-lived repository would spend most of its time
       * and database on code nobody will ask about. Later syncs walk only
       * `cursor..HEAD`, so the cap effectively applies to the first run.
       */
      diff: z
        .object({
          enabled: z.boolean().default(true),
          maxCommits: z.number().int().positive().default(200),
          maxFilesPerCommit: z.number().int().positive().default(20),
          contextLines: z.number().int().nonnegative().default(3),
        })
        .default({ enabled: true, maxCommits: 200, maxFilesPerCommit: 20, contextLines: 3 }),
      /**
       * JS/TS import-graph edges (`file_edges` table), derived from the
       * working tree. On by default like git/shell/docs: no secrets risk,
       * just structural relationships between files already tracked in git.
       */
      structure: z
        .object({
          enabled: z.boolean().default(true),
        })
        .default({ enabled: true }),
      /**
       * Issue and PR threads (title, body, comments) for this repo's
       * github.com remote, read via the `gh` CLI.
       *
       * Opt-in, unlike git/shell/docs/structure -- not for a sensitivity
       * reason (issue/PR text is usually no more sensitive than a doc file),
       * but because this is the first source with a real external dependency:
       * it needs `gh` installed and authenticated, and makes live network
       * calls instead of reading only what's already on disk. A repo with no
       * github.com remote at all, or an unauthenticated `gh`, must stay a
       * silent no-op either way -- see `syncGithub` in sync.ts.
       */
      github: z
        .object({
          enabled: z.boolean().default(false),
          /** Threads read per sync, newest-updated first. */
          maxThreads: z.number().int().positive().default(100),
          /** Comments read per thread. */
          maxCommentsPerThread: z.number().int().positive().default(100),
        })
        .default({ enabled: false, maxThreads: 100, maxCommentsPerThread: 100 }),
    })
    .default({
      git: { enabled: true, since: null, includeMerges: true },
      shell: { enabled: true, tailLines: 300 },
      conversation: { enabled: false },
      session: {
        enabled: false,
        model: DEFAULT_SLM_MODEL,
        settleMinutes: 30,
        maxSessions: 10,
        maxPromptChars: 12_000,
      },
      docs: { enabled: true, include: ['*.md'] },
      diff: { enabled: true, maxCommits: 200, maxFilesPerCommit: 20, contextLines: 3 },
      structure: { enabled: true },
      github: { enabled: false, maxThreads: 100, maxCommentsPerThread: 100 },
    }),
  limits: z
    .object({
      maxFilesPerNode: z.number().int().positive().default(40),
      maxBodyChars: z.number().int().positive().default(4000),
    })
    .default({ maxFilesPerNode: 40, maxBodyChars: 4000 }),
  /**
   * Automatic contradiction checking during sync. On by default -- unlike the
   * opt-in transcript sources, this reads nothing new, writes only suggestions
   * (never `supersedes`), and stays affordable by construction: at most
   * `maxPerSync` new SLM judgments per run, judged pairs memoized and never
   * re-asked, and an unreachable model degrades to skipping quietly.
   */
  contradictions: z
    .object({
      autoCheck: z.boolean().default(true),
      maxPerSync: z.number().int().nonnegative().default(3),
      /** Ollama model tag. Must be pulled locally, same as `sources.session.model`. */
      model: z.string().default(DEFAULT_SLM_MODEL),
    })
    .default({ autoCheck: true, maxPerSync: 3, model: DEFAULT_SLM_MODEL }),
});

export type NexusConfig = z.infer<typeof ConfigSchema>;

export function defaultConfig(projectId: string): NexusConfig {
  return ConfigSchema.parse({ version: 1, projectId });
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export async function readConfig(ws: Workspace): Promise<NexusConfig> {
  let raw: string;
  try {
    raw = await readFile(ws.configPath, 'utf8');
  } catch {
    throw new ConfigError(`Not initialized: ${ws.configPath} not found. Run \`nexusmem init\` first.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${ws.configPath} is not valid JSON: ${(err as Error).message}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ConfigError(`${ws.configPath} is invalid:\n${issues}`);
  }
  return result.data;
}

export async function writeConfig(ws: Workspace, config: NexusConfig): Promise<void> {
  await mkdir(ws.dir, { recursive: true });
  await writeFile(ws.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * Make the workspace ignore itself.
 *
 * A self-ignoring directory means `init` never has to edit the user's own
 * .gitignore -- one less surprising write into a repo we do not own.
 */
export async function writeWorkspaceGitignore(ws: Workspace): Promise<void> {
  await mkdir(ws.dir, { recursive: true });
  await writeFile(join(ws.dir, '.gitignore'), '# Machine-local derived data.\n*\n', 'utf8');
}
