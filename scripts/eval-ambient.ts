import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { redactAgentEvent } from '../src/agent/event.js';
import { MAX_DIGEST_CHARS, MAX_RECALL_CHARS } from '../src/agent/recall.js';
import { repoRelative } from '../eval/ambient/paths.js';
import { revertsDayOneFix, SCENARIOS, type Scenario } from '../eval/ambient/scenario.js';

/**
 * Does ambient memory change what the agent does?
 *
 * Three arms against the same repository and the same task:
 *
 *   baseline  git history only, no NexusMem at all
 *   mcp       NexusMem reachable as MCP tools, never mentioned in the prompt
 *   ambient   NexusMem's own hooks installed, nothing reachable by hand
 *
 * The fix is reachable from `git log` in every scenario, so the baseline is
 * never deprived of the answer -- only of anything that puts it in front of
 * the model. The task never mentions memory, and every arm is isolated from
 * this machine's own MCP servers and settings.
 *
 * What the `mcp` arm has measured so far, recorded here because it is a
 * finding rather than a bug: **0 `mcp__nexusmem__*` calls across all 18
 * trials that had the tools available** -- the 9 mcp runs and the 9 ambient
 * runs, which can reach them too. `preflightMcp` speaks the protocol to the
 * server before every mcp trial, so that is model behaviour and not a dead
 * server, and the session digest's own closing line points at the tools
 * explicitly. The arm is deliberately NOT being fixed by prompting the model
 * into calling them: that would measure the prompt, not the product. An MCP
 * tool an agent never chooses to call is a capability, not a memory system,
 * which is the case for ambient injection being the primary path.
 *
 * Scoring is mechanical and read from the session transcript: which files were
 * edited and in what order, how many tool calls, how many of them failed, when
 * the fix was reached, and what NexusMem put into the context. Model behaviour
 * is variable, so this is a measurement, not a test.
 *
 *   npm run build && npx tsx scripts/eval-ambient.ts [repeats] [outDir]
 */

const CLI = resolve('dist/cli/index.js');
const ARMS = ['baseline', 'mcp', 'ambient'] as const;
type Arm = (typeof ARMS)[number];

const REPEATS = Number(process.argv[2] ?? 3);
const OUT_DIR = realpath(resolve(process.argv[3] ?? join(process.env.TEMP ?? '/tmp', 'nexusmem-eval-ambient')));

/**
 * The fixture's own path has to be the one git will report. On Windows `TEMP`
 * is an 8.3 short path (C:\Users\USER-0~1\...) while git resolves the long
 * form, so an event recorded against the short one is filtered out of its own
 * repository and the ambient arm silently measures an empty database.
 */
function realpath(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return realpathSync.native(dir);
}
const MAX_TURNS = 25;
/** Pinned so every arm and repeat is the same model. */
const MODEL = process.env.EVAL_MODEL ?? 'sonnet';
/** Fake, and never a real credential shape anyone could mistake for one. */
const EVAL_SECRET = 'ghp_evalF4keToken0123456789abcd';
/** Commands in the fixture that have nothing to do with the task. Recalling one is noise. */
const UNRELATED_COMMANDS = ['npm run lint', 'npm run typecheck'];

interface RunResult {
  scenario: string;
  arm: Arm;
  repeat: number;
  ok: boolean;
  error?: string;
  /** Set when the deterministic pre-flight failed: model behaviour is then not what was measured. */
  systemFailure?: string;

  // behaviour
  repeatedDeadEndA: boolean;
  repeatedDeadEndB: boolean;
  editedStaleFile: boolean;
  editedFixFile: boolean;
  commandPassesAfter: boolean;
  firstEditedFile: string | null;
  firstEditWasDeadEnd: boolean;
  /** The very first thing the run did, tool name and a short form of its input. */
  firstInvestigationAction: string | null;
  /** What the working tree actually differs by at the end. */
  finalChangedFiles: string[];
  /** Tool calls made before the first edit of the file that actually fixes it. */
  toolCallsBeforeFix: number | null;
  msToFix: number | null;

  // cost
  toolCalls: number;
  failedToolCalls: number;
  turns: number;
  costUsd: number;
  durationMs: number;

  // what NexusMem contributed
  injections: number;
  injectedChars: number;
  /** Injections naming an unrelated command and not the task's own. */
  irrelevantInjections: number;
  /** Bullet lines inside the injections: one recalled item each. */
  recallItems: number;
  irrelevantRecallItems: number;
  /** Did the failure recall -- the feature the tester said they would miss -- actually fire? */
  recallFired: boolean;
  /** How many separate times a real failure during the run triggered recall. */
  recallFiredCount: number;
  /** Among firing recalls, did the text actually name the seeded A/B/C evidence? */
  recallContainedABC: boolean;
  /** Did the session-start digest fire, in any composition (resolved/stale/uncertain/unresolved)? */
  digestFired: boolean;
  /** Did the digest's own resolved/stale wording ("fixed ...") appear? */
  digestContainedResolvedChain: boolean;
  /** Did the digest explicitly flag a fix that stopped holding ("no longer holds")? */
  digestContainedStaleWarning: boolean;
  /** Did an unrelated unresolved command rank ahead of the scenario's own chain in the digest? */
  digestDisplaced: boolean;
  nexusMemToolCalls: number;
  noticedNexusMem: boolean;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  // `input` overrides stdio[0] itself (Node's own documented behaviour), so
  // the 'ignore' default below only ever applies when there is none to send.
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** A NexusMem database holding day 1: two abandoned attempts, the fix, and two unrelated chains. */
function seedMemory(scenario: Scenario, repoDir: string, nmHome: string): void {
  const env = { ...process.env, NEXUSMEM_HOME: nmHome };
  mkdirSync(nmHome, { recursive: true });
  run(process.execPath, [CLI, 'init', '-C', repoDir], { env });

  // Without this the sync scrapes this machine's real shell history into the fixture.
  const configPath = join(repoDir, '.nexusmem', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { sources: { shell: { enabled: boolean } } };
  config.sources.shell.enabled = false;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Through the same redaction the adapter applies, so what lands on disk is
  // what the hook would have written -- including for the one event carrying
  // a fake credential.
  const events = scenario.events(repoDir).map(redactAgentEvent);
  writeFileSync(join(nmHome, 'agent-events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  run(process.execPath, [CLI, 'sync', '-C', repoDir, '--no-embed', '--quiet'], { env });
}

/**
 * Every probe below needs its own `session_id`: `agent recall` explains the
 * same failure only once per session (`shouldInject`/`markInjected`) -- real
 * product behaviour, but reusing an id across two probes here would silently
 * suppress the second and read as a broken match when nothing is broken.
 */
let preflightSessionId = 0;
const preflightSession = () => `preflight-${(preflightSessionId += 1)}`;

function recallOf(repoDir: string, env: NodeJS.ProcessEnv, payload: object): string {
  return (
    spawnSync(process.execPath, [CLI, 'agent', 'recall', '--trigger', 'failure'], {
      cwd: repoDir,
      env,
      input: JSON.stringify(payload),
      encoding: 'utf8',
    }).stdout ?? ''
  );
}

/**
 * Deterministic gate run before every single AMBIENT trial, not just once for
 * the batch: capture, correlation and recall have to actually work on THIS
 * trial's own freshly-seeded fixture, or the trial measures a broken system
 * rather than the model. Covers every item the eval plan requires:
 *   - capture health is not degraded
 *   - the A/B/C chain exists and is reachable
 *   - a live `cd "<cwd>" && <command>` failure matches its bare history
 *   - so do the other compounds Claude really emits: an `ls`/`echo` prefix
 *     and a trailing `; echo "exit: $?"`, which together account for most of
 *     the 69 task-execution calls the Phase-5 transcripts recorded
 *   - a compound that could have changed the run (`npm install &&`, an
 *     export, a second execution, a pipeline, a trailing unknown command)
 *     does NOT match
 *   - a chain this fixture's own git history reverted is labelled as no
 *     longer holding, and one it did not is left alone
 *   - a hidden exit code ("; echo EXIT:$?") is recognised as a failure
 *   - the resolved failure->fix chain is eligible for recall
 *   - an unrelated unresolved failure does not displace it in the digest
 *   - recall names the actual A/B/C evidence
 *   - both recall and the digest stay inside their token budgets
 *   - the synthetic secret occurs zero times in any durable artifact
 */
function preflightAmbient(scenario: Scenario, repoDir: string, nmHome: string): string | null {
  const env = { ...process.env, NEXUSMEM_HOME: nmHome };
  const logPath = join(nmHome, 'agent-events.jsonl');
  const log = readFileSync(logPath, 'utf8');

  if (log.includes(EVAL_SECRET)) return 'security: the raw fake credential reached the event log';
  const dbPath = join(repoDir, '.nexusmem', 'memory.db');
  if (readFileSync(dbPath).includes(Buffer.from(EVAL_SECRET))) return 'security: the raw fake credential reached the database';

  // eslint-disable-next-line no-control-regex
  const status = run(process.execPath, [CLI, 'agent', 'status', '--project', '-C', repoDir], { env }).replace(/\x1b\[[0-9;]*m/g, '');
  if (!/installed\s+yes/.test(status)) return `install: agent status does not report the hooks as installed\n${status}`;
  if (/do not exist here/.test(status)) return 'install: the installed hook points at paths this machine does not have';
  if (/capture\s+degraded/.test(status)) return 'capture: health is degraded, so events are being dropped';

  const failurePayload = (command: string) => ({
    session_id: preflightSession(),
    cwd: repoDir,
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: `toolu_${preflightSessionId}`,
    error: `Exit code 1\n${scenario.command} failed`,
    duration_ms: 1,
  });

  // --- the A/B/C chain exists and recall names it ----------------------
  const text = recallOf(repoDir, env, failurePayload(scenario.command));
  if (!text.includes('failed in this repository before')) return 'recall: no prior failure was returned for the task command';
  // Both abandoned attempts and whatever day 1 ended green on have to be
  // reachable, or the arm is credited with information it never had. Note that
  // is day 1's answer, which in two scenarios is no longer today's.
  for (const file of [scenario.attemptA.file, scenario.attemptB.file, scenario.attemptC.file]) {
    const leaf = file.split('/').pop()!;
    if (!text.includes(leaf) && !text.includes(file)) return `recall: ${file} is missing from the recalled history`;
  }
  for (const unrelated of UNRELATED_COMMANDS) {
    if (text.includes(unrelated)) return `recall: unrelated command "${unrelated}" leaked into the failure recall`;
  }
  // The resolved failure->fix chain must actually be eligible for recall,
  // not merely present as bare failures with nothing correlated to them.
  if (!text.includes('fixed on')) return 'recall: the resolved failure->fix chain is not eligible for recall';
  if (text.length > MAX_RECALL_CHARS) return `recall: text exceeded MAX_RECALL_CHARS (${text.length})`;

  // --- a live cd-wrapped command still matches its bare history ---------
  const wrapped = recallOf(repoDir, env, failurePayload(`cd "${repoDir}" && ${scenario.command}`));
  if (!wrapped.includes('failed in this repository before')) return 'execHash: a "cd <cwd> && <command>" wrapped failure did not match its bare history';

  // --- the compounds Claude actually emits reach the same history -------
  // Every shape here was taken from the Phase-5 transcripts. A cd wrapper
  // alone was never representative: it covered 11 of the 69 task-execution
  // calls, and gating on it is what let the rerun measure recall at 2/9.
  const realCompounds: Array<[string, string]> = [
    ['trailing exit echo', `cd "${repoDir}" && ${scenario.command}; echo "exit: $?"`],
    ['ls prefix', `cd "${repoDir}" && ls && ${scenario.command}`],
    ['ls -la + echo separator prefix', `cd "${repoDir}" && ls -la && echo --- && ${scenario.command}`],
    ['no cd, trailing exit echo', `${scenario.command}; echo "EXIT: $?"`],
  ];
  for (const [label, command] of realCompounds) {
    if (!recallOf(repoDir, env, failurePayload(command)).includes('failed in this repository before')) {
      return `execHash: a real Claude compound (${label}) did not match its bare history`;
    }
  }

  // --- a compound that could have changed the run must NOT match --------
  const unsafeCompounds: Array<[string, string]> = [
    ['npm install prefix', `npm install && ${scenario.command}`],
    ['env-var export prefix', `export NODE_ENV=test && ${scenario.command}`],
    ['second real execution', `node build.js && ${scenario.command}`],
    ['piped into head', `${scenario.command} 2>&1 | head -100`],
    ['trailing unknown command', `${scenario.command} ; cleanup`],
  ];
  for (const [label, command] of unsafeCompounds) {
    if (recallOf(repoDir, env, failurePayload(command)).includes('failed in this repository before')) {
      return `execHash: an unsafe compound (${label}) incorrectly matched the bare history`;
    }
  }

  // --- a hidden exit code is recognised as a failure --------------------
  const hiddenExit = recallOf(repoDir, env, {
    session_id: preflightSession(),
    cwd: repoDir,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: `${scenario.command}; echo "EXIT:$?"` },
    tool_response: { stdout: `${scenario.command} failed\nEXIT:1`, stderr: '', interrupted: false },
    tool_use_id: `toolu_${preflightSessionId}`,
  });
  if (!hiddenExit.includes('failed in this repository before')) return 'exit-status: a hidden non-zero exit code ("; echo EXIT:1") was not recognised as a failure';

  // --- the digest surfaces the resolved chain, not displaced ------------
  // spawnSync, not the execFileSync-based `run()`: found live -- `run()`'s
  // `input` option silently returned empty stdout in this environment even
  // though the child process itself succeeded, which made every ambient
  // trial fail this check regardless of the real (correct) digest content.
  // spawnSync with the identical input and args returns it correctly.
  const digest =
    spawnSync(process.execPath, [CLI, 'agent', 'session-start'], {
      cwd: repoDir,
      env,
      input: JSON.stringify({ session_id: preflightSession(), cwd: repoDir, hook_event_name: 'SessionStart', source: 'startup' }),
      encoding: 'utf8',
    }).stdout ?? '';
  const firstLine = scenario.command.split(/\r?\n/)[0]!;
  const fixLeaf = scenario.fix.file.split('/').pop()!;
  const day1Leaf = scenario.attemptC.file.split('/').pop()!;
  if (!digest.includes(firstLine) && !digest.includes(fixLeaf) && !digest.includes(day1Leaf)) {
    return 'digest: the session-start digest does not mention the resolved chain at all';
  }
  for (const unrelated of UNRELATED_COMMANDS) {
    if (digest.includes(unrelated) && digest.indexOf(unrelated) < digest.indexOf(firstLine)) {
      return `digest: an unrelated unresolved failure ("${unrelated}") was ranked ahead of the resolved chain`;
    }
  }
  if (digest.length > MAX_DIGEST_CHARS) return `digest: text exceeded MAX_DIGEST_CHARS (${digest.length})`;

  // --- a chain git has reverted is labelled, not repeated as current ----
  // Read from the fixture's own history, so the expectation cannot drift:
  // `stale-fix` is the scenario whose day-1 answer was backed out, and it is
  // the one this must fire on.
  const reverted = revertsDayOneFix(repoDir, scenario);
  const saysStale = (t: string) => t.includes('no longer holds');
  if (reverted && !saysStale(text)) return 'stale: git reverted the day-1 fix, but recall still presents it as current';
  if (reverted && !saysStale(digest)) return 'stale: git reverted the day-1 fix, but the digest still presents it as current';
  if (!reverted && (saysStale(text) || saysStale(digest))) {
    return 'stale: a fix is labelled as no longer holding, but git contains no revert of it';
  }

  for (const t of [text, wrapped, hiddenExit, digest]) {
    if (t.includes(EVAL_SECRET)) return 'security: the raw fake credential was echoed in CLI output';
  }
  return null;
}

/**
 * §7 for the other arm: an MCP server that failed to start would make the mcp
 * arm a second baseline without saying so. Speaks the protocol directly rather
 * than trusting that the config file is enough.
 */
function preflightMcp(repoDir: string, nmHome: string): string | null {
  const rpc = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eval', version: '0' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ].join('\n');
  const server = spawnSync(process.execPath, [CLI, 'mcp'], {
    cwd: repoDir,
    env: { ...process.env, NEXUSMEM_HOME: nmHome },
    input: `${rpc}\n`,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const out = server.stdout ?? '';
  if (!out.includes('"tools"')) return `mcp: the server returned no tool list\n${(server.stderr ?? '').slice(0, 200)}`;
  for (const tool of ['search_memory', 'list_recent_memory', 'get_status']) {
    if (!out.includes(`"${tool}"`)) return `mcp: ${tool} is not offered by the server`;
  }
  return null;
}

/**
 * The task goes in on stdin, never as an argument: a prompt passed through a
 * Windows shell shim is concatenated rather than escaped, which silently
 * mangles it -- the first run of this eval scored three arms of a garbled
 * prompt before that showed up.
 */
function claudeArgs(arm: Arm, repoDir: string, runDir: string): string[] {
  // Every arm is isolated from whatever MCP servers and settings this machine
  // has configured, so only the intended one reaches NexusMem.
  const emptyMcp = join(runDir, 'mcp-empty.json');
  writeFileSync(emptyMcp, JSON.stringify({ mcpServers: {} }));
  const emptySettings = join(runDir, 'settings-empty.json');
  writeFileSync(emptySettings, JSON.stringify({}));

  const args = [
    '-p',
    '--model',
    MODEL,
    '--allowedTools',
    'Bash',
    'Edit',
    'Write',
    'Read',
    'Glob',
    'Grep',
    'mcp__nexusmem__search_memory',
    'mcp__nexusmem__get_status',
    'mcp__nexusmem__list_recent_memory',
    '--max-turns',
    String(MAX_TURNS),
    '--output-format',
    'json',
    '--strict-mcp-config',
  ];

  if (arm === 'mcp') {
    const mcpConfig = join(runDir, 'mcp-nexusmem.json');
    writeFileSync(
      mcpConfig,
      JSON.stringify({ mcpServers: { nexusmem: { command: process.execPath, args: [CLI, 'mcp'] } } }),
    );
    args.push('--mcp-config', mcpConfig);
  } else {
    args.push('--mcp-config', emptyMcp);
  }

  // Symmetric on purpose: every arm is handed a settings file, so only its
  // contents differ, not whether one was passed at all.
  args.push('--settings', arm === 'ambient' ? join(repoDir, '.claude', 'settings.local.json') : emptySettings);
  return args;
}

interface Transcript {
  toolCalls: number;
  failedToolCalls: number;
  /** Repo-relative, in the order they were first edited. */
  editedFiles: string[];
  /** Tool-call index (1-based) at which each file was first edited. */
  editIndex: Map<string, number>;
  /** Milliseconds from the first entry to the first edit of each file. */
  editMs: Map<string, number>;
  injections: string[];
  nexusMemToolCalls: number;
  noticedNexusMem: boolean;
  /** The first tool call of the run, as `name: short input`. */
  firstAction: string | null;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EMPTY_TRANSCRIPT: Transcript = {
  toolCalls: 0,
  failedToolCalls: 0,
  editedFiles: [],
  editIndex: new Map(),
  editMs: new Map(),
  injections: [],
  nexusMemToolCalls: 0,
  noticedNexusMem: false,
  firstAction: null,
};

function transcriptPath(sessionId: string): string | null {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return null;
  for (const slug of readdirSync(root)) {
    const path = join(root, slug, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * A hook's output does not arrive as one consistent shape. `SessionStart`
 * prints plain text (`runAgentSessionStart`'s own doc comment: "not JSON --
 * that is the injection form the live probe verified for SessionStart"), and
 * Claude Code records that directly in the attachment's `content` field.
 * `PostToolUse`/`PostToolUseFailure` recall instead prints a JSON envelope
 * (`{"hookSpecificOutput":{"additionalContext":"..."}}`) -- and Claude Code
 * leaves `content` EMPTY for that shape, putting the raw stdout in `stdout`
 * instead. Found live, after the first analysis of this rerun's own data
 * reported recall firing 0/9: it had fired in 2/9, invisible only because
 * this function checked `content` alone. `verify-preflight.ts` never had
 * this bug -- it reads `agent recall`'s own CLI stdout directly, never a
 * Claude Code transcript.
 */
function extractHookInjection(hook: { type?: string; content?: unknown; stdout?: unknown }): string | null {
  if (!hook.type?.startsWith('hook')) return null;
  if (typeof hook.content === 'string' && hook.content.includes('NexusMem:')) return hook.content;
  if (typeof hook.stdout === 'string') {
    try {
      const parsed = JSON.parse(hook.stdout) as { hookSpecificOutput?: { additionalContext?: unknown } };
      const ctx = parsed.hookSpecificOutput?.additionalContext;
      if (typeof ctx === 'string' && ctx.includes('NexusMem:')) return ctx;
    } catch {
      // stdout wasn't JSON -- SessionStart's plain-text form is already
      // handled by the `content` check above, so this genuinely has nothing.
    }
  }
  return null;
}

/** Reads the session transcript for what the model actually did and was shown. */
function readTranscript(path: string, repoDir: string): Transcript {
  const t: Transcript = { ...EMPTY_TRANSCRIPT, editedFiles: [], editIndex: new Map(), editMs: new Map(), injections: [] };
  const shorten = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').slice(0, 90);
  let startedAt: number | null = null;

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: {
      type?: string;
      timestamp?: string;
      message?: { role?: string; content?: unknown };
      attachment?: { type?: string; hookName?: string; content?: unknown; stdout?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = entry.timestamp ? Date.parse(entry.timestamp) : null;
    if (at !== null && startedAt === null) startedAt = at;

    if (entry.attachment) {
      const text = extractHookInjection(entry.attachment);
      if (text) t.injections.push(text);
    }

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use') {
        t.toolCalls += 1;
        const name = String(block.name ?? '');
        if (t.firstAction === null) {
          const input = block.input as Record<string, unknown> | undefined;
          t.firstAction = `${name}: ${shorten(input?.command ?? input?.pattern ?? input?.file_path ?? input?.query ?? '')}`;
        }
        if (name.startsWith('mcp__nexusmem__')) t.nexusMemToolCalls += 1;
        if (EDIT_TOOLS.has(name)) {
          const filePath = String((block.input as Record<string, unknown> | undefined)?.file_path ?? '');
          if (filePath) {
            const rel = repoRelative(repoDir, filePath);
            if (!t.editIndex.has(rel)) {
              t.editedFiles.push(rel);
              t.editIndex.set(rel, t.toolCalls);
              if (at !== null && startedAt !== null) t.editMs.set(rel, at - startedAt);
            }
          }
        }
      } else if (block.type === 'tool_result') {
        if (block.is_error === true) t.failedToolCalls += 1;
      } else if (block.type === 'text') {
        const text = String(block.text ?? '');
        // Injections arrive as user-role text; anything the assistant says
        // about NexusMem is the model noticing, not the hook speaking.
        if (text.includes('NexusMem:')) {
          if (entry.message?.role === 'assistant') t.noticedNexusMem = true;
          else for (const match of text.matchAll(/NexusMem:[\s\S]{0,1500}/g)) t.injections.push(match[0]);
        } else if (entry.message?.role === 'assistant' && /nexusmem/i.test(text)) {
          t.noticedNexusMem = true;
        }
      }
    }
  }
  return t;
}

function scoreRepo(repoDir: string, scenario: Scenario): { commandPasses: boolean; changed: string[] } {
  const [exe, ...rest] = scenario.command.split(' ');
  const changed = run('git', ['-C', repoDir, 'diff', '--name-only', 'HEAD'])
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return { commandPasses: spawnSync(exe!, rest, { cwd: repoDir, encoding: 'utf8' }).status === 0, changed };
}

/** One recalled fact per bullet, which is what "how many memories" means here. */
const bullets = (text: string): string[] => text.split(/\r?\n/).filter((l) => l.trimStart().startsWith('- '));

async function runOnce(scenario: Scenario, arm: Arm, repeat: number): Promise<RunResult> {
  const runDir = join(OUT_DIR, scenario.name, arm, String(repeat));
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  // The model sees its own working directory in every shell command it writes.
  // Under OUT_DIR that path spelled out the scenario name and the arm -- and
  // "lost-writes" says where to look. The repository lives somewhere neutral;
  // the run directory keeps only the outputs.
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'workspace-')));
  const repoDir = join(workspace, 'app');
  const nmHome = join(workspace, 'nmhome');
  writeFileSync(join(runDir, 'workspace.txt'), workspace);

  scenario.build(repoDir);
  if (arm !== 'baseline') seedMemory(scenario, repoDir, nmHome);

  const empty: RunResult = {
    scenario: scenario.name,
    arm,
    repeat,
    ok: false,
    repeatedDeadEndA: false,
    repeatedDeadEndB: false,
    editedStaleFile: false,
    editedFixFile: false,
    commandPassesAfter: false,
    firstEditedFile: null,
    firstEditWasDeadEnd: false,
    firstInvestigationAction: null,
    finalChangedFiles: [],
    toolCallsBeforeFix: null,
    msToFix: null,
    toolCalls: 0,
    failedToolCalls: 0,
    turns: 0,
    costUsd: 0,
    durationMs: 0,
    injections: 0,
    injectedChars: 0,
    irrelevantInjections: 0,
    recallItems: 0,
    irrelevantRecallItems: 0,
    recallFired: false,
    recallFiredCount: 0,
    recallContainedABC: false,
    digestFired: false,
    digestContainedResolvedChain: false,
    digestContainedStaleWarning: false,
    digestDisplaced: false,
    nexusMemToolCalls: 0,
    noticedNexusMem: false,
  };

  if (arm === 'ambient') {
    run(process.execPath, [CLI, 'agent', 'install', '--project', '-C', repoDir], { env: { ...process.env, NEXUSMEM_HOME: nmHome } });
    const problem = preflightAmbient(scenario, repoDir, nmHome);
    if (problem) return { ...empty, ok: false, systemFailure: problem };
  }
  if (arm === 'mcp') {
    const problem = preflightMcp(repoDir, nmHome);
    if (problem) return { ...empty, ok: false, systemFailure: problem };
  }

  const started = Date.now();
  const result = spawnSync('claude', claudeArgs(arm, repoDir, runDir), {
    cwd: repoDir,
    env: { ...process.env, NEXUSMEM_HOME: nmHome },
    encoding: 'utf8',
    input: scenario.task,
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });

  let parsed: { session_id?: string; num_turns?: number; total_cost_usd?: number; duration_ms?: number; is_error?: boolean } | null = null;
  try {
    parsed = JSON.parse(result.stdout ?? '');
  } catch {
    return { ...empty, ok: false, durationMs: Date.now() - started, error: (result.stderr ?? result.stdout ?? '').slice(0, 300) };
  }

  const path = parsed?.session_id ? transcriptPath(parsed.session_id) : null;
  const t = path ? readTranscript(path, repoDir) : EMPTY_TRANSCRIPT;
  if (path) writeFileSync(join(runDir, 'transcript.jsonl'), readFileSync(path)); // kept for the qualitative read

  const { commandPasses, changed } = scoreRepo(repoDir, scenario);
  const injectedChars = t.injections.reduce((sum, i) => sum + i.length, 0);
  const items = t.injections.flatMap(bullets);

  return {
    ...empty,
    ok: parsed?.is_error !== true,
    repeatedDeadEndA: t.editIndex.has(scenario.attemptA.file),
    repeatedDeadEndB: t.editIndex.has(scenario.attemptB.file),
    editedStaleFile: scenario.staleAttempt?.file ? t.editIndex.has(scenario.staleAttempt?.file) : false,
    editedFixFile: t.editIndex.has(scenario.fix.file),
    commandPassesAfter: commandPasses,
    firstEditedFile: t.editedFiles[0] ?? null,
    firstEditWasDeadEnd: t.editedFiles[0] === scenario.attemptA.file || t.editedFiles[0] === scenario.attemptB.file,
    toolCallsBeforeFix: t.editIndex.get(scenario.fix.file) ?? null,
    msToFix: t.editMs.get(scenario.fix.file) ?? null,
    toolCalls: t.toolCalls,
    failedToolCalls: t.failedToolCalls,
    turns: parsed?.num_turns ?? 0,
    costUsd: parsed?.total_cost_usd ?? 0,
    durationMs: parsed?.duration_ms ?? Date.now() - started,
    injections: t.injections.length,
    injectedChars,
    irrelevantInjections: t.injections.filter(
      (i) => UNRELATED_COMMANDS.some((c) => i.includes(c)) && !i.includes(scenario.command),
    ).length,
    recallItems: items.length,
    irrelevantRecallItems: items.filter((i) => UNRELATED_COMMANDS.some((c) => i.includes(c))).length,
    firstInvestigationAction: t.firstAction,
    finalChangedFiles: changed,
    // "failed in this repository before" is `recallFailure`'s own fixed header
    // text -- fires once per real PostToolUseFailure/recovered-exit-status
    // hook invocation during the run, so counting occurrences (not just
    // whether at least one fired) is what "how many actual failures
    // triggered recall" (Phase-5.1 eval plan §5) actually asks for.
    recallFired: t.injections.some((i) => i.includes('failed in this repository before')),
    recallFiredCount: t.injections.filter((i) => i.includes('failed in this repository before')).length,
    recallContainedABC: t.injections.some(
      (i) =>
        i.includes('failed in this repository before') &&
        [scenario.attemptA.file, scenario.attemptB.file, scenario.attemptC.file].some(
          (f) => i.includes(f) || i.includes(f.split('/').pop()!),
        ),
    ),
    // The digest's header ("N relevant command(s) from the last N days") is
    // present in every composition since the Phase-5.1 redesign -- keying
    // detection on "with no recorded fix" alone (the old, unresolved-only
    // wording) would silently miss a digest that fired showing only a
    // resolved or stale chain, which is exactly the case this rerun exists
    // to measure. Fixed here as the deterministic harness bug it is, before
    // any trial ran.
    digestFired: t.injections.some((i) => i.includes('relevant command(s) from the last')),
    digestContainedResolvedChain: t.injections.some((i) => i.includes('relevant command(s) from the last') && i.includes('fixed')),
    digestContainedStaleWarning: t.injections.some((i) => i.includes('no longer holds')),
    digestDisplaced: t.injections.some((i) => {
      if (!i.includes('relevant command(s) from the last')) return false;
      const ownIndex = i.indexOf(scenario.command.split(/\r?\n/)[0]!);
      if (ownIndex === -1) return false;
      return UNRELATED_COMMANDS.some((c) => i.includes(c) && i.indexOf(c) < ownIndex);
    }),
    nexusMemToolCalls: t.nexusMemToolCalls,
    noticedNexusMem: t.noticedNexusMem,
  };
}

function summarize(results: readonly RunResult[]): string {
  const lines: string[] = [];
  for (const scenario of SCENARIOS) {
    lines.push('', scenario.name);
    for (const arm of ARMS) {
      const runs = results.filter((r) => r.scenario === scenario.name && r.arm === arm);
      if (runs.length === 0) continue;
      const n = runs.length;
      const rate = (p: (r: RunResult) => boolean) => `${runs.filter(p).length}/${n}`;
      const mean = (pick: (r: RunResult) => number) => runs.reduce((s, r) => s + pick(r), 0) / n;
      const meanOf = (pick: (r: RunResult) => number | null) => {
        const vals = runs.map(pick).filter((v): v is number => v !== null);
        return vals.length === 0 ? '  -- ' : (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1).padStart(5);
      };
      lines.push(
        [
          `  ${arm.padEnd(9)}`,
          `fixed ${rate((r) => r.commandPassesAfter).padEnd(4)}`,
          `deadA ${rate((r) => r.repeatedDeadEndA).padEnd(4)}`,
          `deadB ${rate((r) => r.repeatedDeadEndB).padEnd(4)}`,
          `stale ${rate((r) => r.editedStaleFile).padEnd(4)}`,
          `1st-edit-dead ${rate((r) => r.firstEditWasDeadEnd).padEnd(4)}`,
          `calls ${mean((r) => r.toolCalls).toFixed(1).padStart(5)}`,
          `failed ${mean((r) => r.failedToolCalls).toFixed(1).padStart(4)}`,
          `to-fix ${meanOf((r) => r.toolCallsBeforeFix)}`,
          `inj ${mean((r) => r.injectedChars).toFixed(0).padStart(5)}ch`,
          `recall ${rate((r) => r.recallFired).padEnd(4)}`,
          `digest ${rate((r) => r.digestFired).padEnd(4)}`,
          `noise ${mean((r) => r.irrelevantInjections).toFixed(1)}`,
          `noticed ${rate((r) => r.noticedNexusMem).padEnd(4)}`,
          `$${mean((r) => r.costUsd).toFixed(3)}`,
        ].join('  '),
      );
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  if (!existsSync(CLI)) throw new Error(`build first: ${CLI} is missing`);
  const only = process.env.EVAL_SCENARIO;
  const scenarios = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
  const results: RunResult[] = [];

  mkdirSync(OUT_DIR, { recursive: true });
  process.stdout.write(
    `\nambient-memory eval: ${scenarios.length} scenario(s), ${REPEATS} run(s) per arm, model ${MODEL}\n  out: ${OUT_DIR}\n\n`,
  );
  for (const scenario of scenarios) {
    for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
      for (const arm of ARMS) {
        process.stdout.write(`  ${scenario.name.padEnd(18)} ${arm.padEnd(9)} #${repeat} ... `);
        const result = await runOnce(scenario, arm, repeat);
        results.push(result);
        writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
        process.stdout.write(
          result.systemFailure
            ? `SYSTEM FAILURE: ${result.systemFailure}\n`
            : `${result.ok ? '' : 'ERROR '}fixed=${result.commandPassesAfter} deadA=${result.repeatedDeadEndA} deadB=${result.repeatedDeadEndB} stale=${result.editedStaleFile} calls=${result.toolCalls} inj=${result.injectedChars}\n`,
        );
      }
    }
  }

  process.stdout.write(`\n${summarize(results)}\n\nraw: ${join(OUT_DIR, 'results.json')}\n\n`);
}

await main();
