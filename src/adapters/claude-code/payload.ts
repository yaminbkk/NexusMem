import type { DropFamily, DropReason } from '../../agent/capture-health.js';
import { type AgentEvent, type AgentOutcome, type RawAgentEvent, redactAgentEvent } from '../../agent/event.js';

/**
 * Maps one Claude Code hook payload onto an `AgentEvent`.
 *
 * Every field below was read off a live probe against Claude Code 2.1.226
 * (see tests/agent-payload.test.ts for the captured payloads), not from the
 * docs -- doc summaries claimed a `tool_response.exit_code` that does not
 * exist. What the probe established:
 *
 * - a Bash call that exits non-zero fires `PostToolUseFailure` ONLY, and its
 *   `error` is the text "Exit code N\n<stderr>"; there is no exit-code field
 * - a Bash call that succeeds fires `PostToolUse`, carrying `tool_response`
 * - both carry `tool_use_id`, `cwd`, `session_id` and `duration_ms`
 *
 * Anything that does not match is dropped, never guessed at.
 */

export const AGENT = 'claude-code';

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EXIT_CODE = /^Exit code (\d+)/;

interface HookPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  tool_name?: unknown;
  tool_use_id?: unknown;
  tool_input?: { command?: unknown; file_path?: unknown; notebook_path?: unknown };
  tool_response?: { stdout?: unknown };
  error?: unknown;
  is_interrupt?: unknown;
  duration_ms?: unknown;
  agent_id?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Measured in the Phase-5 eval: 15 of 17 real Bash calls hid the exit status
 * of the command they actually cared about behind one of these -- `cmd;
 * echo "EXIT:$?"`, `cmd; echo "exit: $?"`, `cmd; echo "exit=$?"` -- so the
 * *outer* shell invocation Claude Code's hook sees is `echo`'s own exit code
 * (0), and `PostToolUseFailure` never fires even though `cmd` failed.
 *
 * `tool_response.stdout` is the only place that status can still be found,
 * and only in this literal form: only the LAST non-blank line is examined,
 * and only if it is *exactly* `exit[:=]<digits>` (case-insensitive) with
 * nothing else on it. This is a closed set of known echo spellings, not
 * free-text parsing -- a program whose own output happens to mention "exit
 * code" (e.g. "Process finished with exit code 1") does not match, because
 * that text is not alone on its line and uses neither `:` nor `=`. A
 * malformed or missing echo (`EXIT:`, `EXIT:abc`, no such line at all)
 * yields `null`: no evidence, not a guessed zero and not a guessed failure.
 *
 * Output alone is never evidence: a program can print `exit: 1` itself. The
 * command must end with that echo of `$?`, and nothing before it may make
 * `$?` another command's status -- a pipe (the last stage's), `||` (the
 * fallback's), or another `;` or line (whatever ran last). `cd x && cmd` is
 * fine: `$?` is then cmd's status, or cd's own failure.
 */
const EXIT_ECHO = /^exit\s*[:=]\s*(\d+)\s*$/i;
const EXIT_WRAPPER = /^([\s\S]*?);\s*echo\s+(?:"exit\s*[:=]\s*\$\?"|exit\s*[:=]\s*\$\?)\s*$/i;

function echoesOwnExitStatus(command: string): boolean {
  const body = EXIT_WRAPPER.exec(command.trim())?.[1];
  return body !== undefined && body.trim().length > 0 && !/[|;\r\n]/.test(body);
}

export function recoverExitStatusFromOutput(command: string, stdout: string | undefined): number | null {
  if (!stdout || !echoesOwnExitStatus(command)) return null;
  const lines = stdout.split(/\r?\n/).map((l) => l.trim());
  let last = '';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]) {
      last = lines[i]!;
      break;
    }
  }
  const match = EXIT_ECHO.exec(last);
  return match ? Number(match[1]) : null;
}

/** Splits "Exit code 2\nls: cannot access ..." into its code and the rest. */
function parseError(error: string): { exitCode: number | null; signature: string } {
  const [first = '', ...rest] = error.split(/\r?\n/);
  const match = EXIT_CODE.exec(first);
  if (!match) return { exitCode: null, signature: error.trim() };
  return { exitCode: Number(match[1]), signature: rest.join(' ').trim() };
}

/**
 * `now` is passed in because no hook payload carries a timestamp -- the event
 * is stamped when it is received, which is within milliseconds of the action.
 */
export interface SessionStartPayload {
  sessionId: string;
  cwd: string;
  /** startup | resume | clear | compact, per the live probe. */
  source: string | null;
}

/** SessionStart carries no tool fields, so it gets its own tiny parser rather than bending the event one. */
export function parseSessionStart(rawJson: string): SessionStartPayload | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawJson.trim());
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as HookPayload & { source?: unknown };
  if (str(p.hook_event_name) !== 'SessionStart') return null;

  const sessionId = str(p.session_id);
  const cwd = str(p.cwd);
  if (!sessionId || !cwd) return null;
  return { sessionId, cwd, source: str(p.source) ?? null };
}

/**
 * Why an event was thrown away, so `agent status` can tell a quiet week from
 * a payload shape this adapter no longer understands. The reason is a code
 * from the core's closed set; no payload text ever travels with it.
 */
export type ParseOutcome = { ok: true; event: AgentEvent; family: DropFamily } | { ok: false; reason: DropReason; family: DropFamily };

/** Vendor event name to a normalized family code; the vendor's own string is never stored. */
const FAMILY_BY_EVENT: Record<string, DropFamily> = {
  PostToolUse: 'post-tool-use',
  PostToolUseFailure: 'post-tool-use-failure',
  SessionStart: 'session-start',
};

const familyOf = (event: string | undefined): DropFamily => (event ? (FAMILY_BY_EVENT[event] ?? 'other') : 'other');

/** Thin wrapper: the common callers only care whether there is an event. */
export function parseHookPayload(rawJson: string, now: string): AgentEvent | null {
  const outcome = parseHookPayloadDetailed(rawJson, now);
  return outcome.ok ? outcome.event : null;
}

export function parseHookPayloadDetailed(rawJson: string, now: string): ParseOutcome {
  let payload: unknown;
  try {
    // A JSON.parse error message quotes its input, i.e. the raw command; never let it escape.
    payload = JSON.parse(rawJson.trim());
  } catch {
    // Nothing about the input is known here, and a parser's own message would quote it.
    return { ok: false, reason: 'unparsable-json', family: 'other' };
  }
  if (typeof payload !== 'object' || payload === null) return { ok: false, reason: 'unparsable-json', family: 'other' };
  const p = payload as HookPayload;

  const event = str(p.hook_event_name);
  const family = familyOf(event);
  const sessionId = str(p.session_id);
  const eventId = str(p.tool_use_id);
  const toolName = str(p.tool_name);
  if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') return { ok: false, reason: 'unsupported-event', family };
  if (!sessionId || !eventId || !toolName) return { ok: false, reason: 'missing-fields', family };

  const failed = event === 'PostToolUseFailure';
  const interrupted = failed && p.is_interrupt === true;
  const outcome: AgentOutcome = interrupted ? 'interrupted' : failed ? 'fail' : 'ok';

  const base = {
    agent: AGENT,
    sessionId,
    eventId,
    ts: now,
    cwd: str(p.cwd) ?? null,
    outcome,
    durationMs: num(p.duration_ms),
    ...(str(p.agent_id) ? { agentId: str(p.agent_id) as string } : {}),
  };

  if (toolName === 'Bash') {
    const command = str(p.tool_input?.command);
    if (!command) return { ok: false, reason: 'missing-fields', family };
    const error = failed ? parseError(str(p.error) ?? '') : null;
    // Only checked on the hook's own success path: a failure already carries a
    // real exit code from `error`, and second-guessing a genuine failure would
    // be guessing in the more dangerous direction.
    const recovered = failed ? null : recoverExitStatusFromOutput(command, str(p.tool_response?.stdout));
    const draft: RawAgentEvent = {
      ...base,
      kind: 'command',
      command,
      // Recovered evidence of a non-zero exit overrides the hook's own "it
      // succeeded" -- the outer shell call did, but the command inside it did
      // not. No evidence (recovered === null) leaves the hook's word as-is.
      outcome: recovered !== null && recovered !== 0 ? 'fail' : outcome,
      // A success carries no exit code because success is what it means; a failure hides it in text.
      exitCode: failed ? (error?.exitCode ?? null) : (recovered ?? 0),
      ...(error?.signature ? { errorSignature: error.signature } : {}),
    };
    return { ok: true, event: redactAgentEvent(draft), family };
  }

  if (EDIT_TOOLS.has(toolName)) {
    // Only the path: an edit's payload also holds the file's old and new content, which is never recorded.
    const filePath = str(p.tool_input?.file_path) ?? str(p.tool_input?.notebook_path);
    if (!filePath) return { ok: false, reason: 'missing-fields', family };
    return { ok: true, event: redactAgentEvent({ ...base, kind: 'edit', filePath, exitCode: null }), family };
  }

  return { ok: false, reason: 'unsupported-tool', family };
}
