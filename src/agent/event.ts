import { redact } from '../conversation/redact.js';
import { sha256Hex } from '../core/ids.js';
import { normalizePathForCompare } from '../shell/detect.js';

/**
 * One attempt a coding agent made: a command it ran, or a file it edited.
 *
 * Vendor-neutral on purpose. Nothing here names Claude Code, a hook event or
 * a tool_use id -- an adapter maps its own payload onto this shape, so a
 * second agent needs no change in the core. The raw command and error text
 * exist only in `RawAgentEvent`, in memory; `redactAgentEvent` is the only
 * way to get an `AgentEvent`, and what it returns is safe to persist.
 */

export type AgentEventKind = 'command' | 'edit';

/** `interrupted` is a user abort, not a failure: it says nothing about the attempt. */
export type AgentOutcome = 'ok' | 'fail' | 'interrupted' | 'unknown';

export interface RawAgentEvent {
  agent: string;
  sessionId: string;
  /** The agent's own id for this action; makes the event idempotent across delivery paths. */
  eventId: string;
  ts: string;
  cwd: string | null;
  kind: AgentEventKind;
  /** Raw, for a command event. Redacted before it leaves this module. */
  command?: string;
  /** Repo-relative or absolute path, for an edit event. Never file content. */
  filePath?: string;
  outcome: AgentOutcome;
  exitCode: number | null;
  /** Raw first lines of the failure output. Redacted and truncated before persisting. */
  errorSignature?: string;
  durationMs: number | null;
  /** Set when a subagent produced the event. */
  agentId?: string;
}

export interface AgentEvent extends Omit<RawAgentEvent, 'command' | 'errorSignature'> {
  command?: string;
  /** sha256 prefix of the RAW command: correlation matches on this, never on redacted text. */
  commandHash?: string;
  /**
   * sha256 prefix of the raw command reduced to the one execution that
   * identifies it -- see `canonicalizeCommand`. This is what `agent recall`
   * matches on: a live `cd "<cwd>" && ls && npm test; echo "exit: $?"` has to
   * find a historical bare `npm test` in the same project. Equal to
   * `commandHash` whenever the command is already a single execution, which is
   * every command recorded before this field existed.
   */
  execHash?: string;
  errorSignature?: string;
}

/**
 * Reduces a compound shell command to the one execution that identifies it.
 *
 * Claude Code rarely runs a command bare. Measured over the 69 task-execution
 * Bash calls in the Phase-5 eval transcripts, it wrapped the same `node
 * check.js` in fifteen distinct shapes: `cd "<repo>" && node check.js`,
 * `cd "<repo>" && node check.js; echo "exit: $?"`, `cd "<repo>" && ls -la &&
 * echo --- && node check.js`, and so on. An exact-text hash finds none of
 * them in a history that recorded the bare command.
 *
 * The rewrite is a semantic allowlist, never a string-stripper: the command is
 * split into `&&`/`;` segments (quote-aware), each is classified, and the
 * result is the single segment that is neither navigation nor observation.
 * Anything else -- two real commands, an env-var assignment, `sudo`, a
 * pipeline, a `cd` elsewhere, an unrecognised word -- leaves the command
 * untouched, because none of those can be proven not to have changed what
 * ran. A missed match costs a silent recall; a wrong one teaches the model a
 * false fact, so the asymmetry is deliberate.
 *
 * Dropping a *trailing* observation segment matters as much as a leading one:
 * 34 of those 69 calls end in `; echo "exit: $?"` or a case variant, which is
 * how the agent reads an exit status the tool call itself swallowed.
 */

/** Read-only in every flag form they accept, given the metacharacter check below. */
const OBSERVATION_COMMANDS = new Set(['ls', 'pwd', 'echo', 'cat']);
/** `git` is read-only only per subcommand: `branch -d` and `remote add` are not. */
const OBSERVATION_GIT_SUBCOMMANDS = new Set(['status', 'log', 'diff', 'show']);

/**
 * Redirection, pipes, command substitution, subshells and background `&` all
 * mean a dropped segment could have had an effect. A bare `$` is fine and
 * common (`echo "exit: $?"`); only `$(` executes.
 */
const UNSAFE_SEGMENT = /[|&<>`(){}]|\$\(/;

type SegmentKind = 'navigation' | 'observation' | 'target';

/** Splits on top-level `&&` and `;` only. Returns null on unbalanced quotes. */
function splitSegments(command: string): string[] | null {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';') {
      segments.push(current);
      current = '';
      continue;
    }
    if (ch === '&' && command[i + 1] === '&') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
  }

  if (quote) return null;
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Quote-aware so a repository path containing spaces still parses as one argument. */
const CD_SEGMENT = /^cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))$/;

/**
 * `/c/Users/x` (Git Bash) and `/mnt/c/Users/x` (WSL) name the same directory
 * as `C:\Users\x`, and the agent writes whichever spelling its shell handed
 * it -- in one measured Phase-5 run it `cd`-ed to the Git Bash form while the
 * hook reported the native one, and the two could not be related. Folded only
 * for this comparison, not in `normalizePathForCompare`, which other callers
 * use against recorded cwds that never take this form.
 */
const DRIVE_SPELLING = /^\/(?:mnt\/)?([a-zA-Z])\//;
const sameDirectory = (a: string, b: string): boolean => {
  const fold = (p: string) => normalizePathForCompare(p.replace(DRIVE_SPELLING, (_m, drive: string) => `${drive}:/`));
  return fold(a) === fold(b);
};

function classify(segment: string, cwd: string | null): SegmentKind {
  if (UNSAFE_SEGMENT.test(segment)) return 'target';

  const cd = CD_SEGMENT.exec(segment);
  if (cd) {
    // Navigation only when it names the directory the event already carries:
    // a `cd` anywhere else genuinely changes what the next segment runs against.
    if (!cwd) return 'target';
    const to = cd[1] ?? cd[2] ?? cd[3] ?? '';
    if (to === '.') return 'navigation';
    return sameDirectory(to, cwd) ? 'navigation' : 'target';
  }

  const [head, next] = segment.split(/\s+/);
  if (!head) return 'target';
  if (OBSERVATION_COMMANDS.has(head)) return 'observation';
  if (head === 'git' && next !== undefined && OBSERVATION_GIT_SUBCOMMANDS.has(next)) return 'observation';
  return 'target';
}

export function canonicalizeCommand(command: string, cwd: string | null): string {
  const segments = splitSegments(command);
  if (!segments) return command;

  const targets = segments.filter((s) => classify(s, cwd) === 'target');
  // Exactly one real execution, with everything around it proven inert. Zero
  // targets (a pure `ls && pwd`) has no execution to name; two or more cannot
  // be reduced to one without guessing which mattered.
  return targets.length === 1 ? targets[0]! : command;
}

/** Long enough to identify a failure, short enough that a stack trace never lands in the DB. */
export const MAX_ERROR_SIGNATURE_CHARS = 200;

export function agentEventNaturalKey(event: Pick<AgentEvent, 'agent' | 'sessionId' | 'eventId'>): string {
  return `agent:${event.agent}:${event.sessionId}:${event.eventId}`;
}

/** The one gate between raw agent output and anything durable. */
export function redactAgentEvent(raw: RawAgentEvent): AgentEvent {
  const { command, errorSignature, ...rest } = raw;
  return {
    ...rest,
    ...(command === undefined
      ? {}
      : {
          command: redact(command).text,
          commandHash: sha256Hex(command).slice(0, 12),
          execHash: sha256Hex(canonicalizeCommand(command, raw.cwd)).slice(0, 12),
        }),
    ...(errorSignature === undefined ? {} : { errorSignature: redact(errorSignature).text.slice(0, MAX_ERROR_SIGNATURE_CHARS) }),
  };
}
