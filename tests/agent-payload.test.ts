import { describe, expect, it } from 'vitest';
import { agentEventNaturalKey, MAX_ERROR_SIGNATURE_CHARS } from '../src/agent/event.js';
import { parseHookPayload, parseHookPayloadDetailed, recoverExitStatusFromOutput } from '../src/adapters/claude-code/payload.js';
import { sha256Hex } from '../src/core/ids.js';

/**
 * The payloads below are the ones a live Claude Code 2.1.226 probe produced
 * (2026-09-11), field for field -- including the absence of any exit-code
 * field on a failure, which is why the code parses "Exit code N" out of text.
 */

const NOW = '2026-09-11T15:00:00.000Z';

const FAILING_BASH = {
  session_id: 'sess-1',
  transcript_path: 'C:/t/sess-1.jsonl',
  cwd: 'D:/repo',
  prompt_id: 'p1',
  permission_mode: 'default',
  effort: 'medium',
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: { command: 'ls ./no-such-dir-xyz', description: 'List nonexistent directory' },
  tool_use_id: 'toolu_01LptP88hUpbZQXdJNBJek9W',
  error: "Exit code 2\nls: cannot access './no-such-dir-xyz': No such file or directory",
  is_interrupt: false,
  duration_ms: 42,
};

const SUCCEEDING_BASH = {
  session_id: 'sess-1',
  cwd: 'D:/repo',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo probe-ok', description: 'Echo probe-ok string' },
  tool_response: { stdout: 'probe-ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  tool_use_id: 'toolu_01YHV8sripk465tg273QcykC',
  duration_ms: 17,
};

const EDIT = {
  session_id: 'sess-1',
  cwd: 'D:/repo',
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: 'D:/repo/src/a.ts', old_string: 'const apiKey = "sk_live_0000"', new_string: 'const apiKey = env.KEY' },
  tool_response: { filePath: 'D:/repo/src/a.ts' },
  tool_use_id: 'toolu_edit_1',
  duration_ms: 5,
};

const parse = (payload: unknown) => parseHookPayload(JSON.stringify(payload), NOW);

describe('parseHookPayload', () => {
  it('reads a failed Bash call: exit code out of the error text, plus the signature', () => {
    expect(parse(FAILING_BASH)).toEqual({
      agent: 'claude-code',
      sessionId: 'sess-1',
      eventId: 'toolu_01LptP88hUpbZQXdJNBJek9W',
      ts: NOW,
      cwd: 'D:/repo',
      kind: 'command',
      command: 'ls ./no-such-dir-xyz',
      commandHash: sha256Hex('ls ./no-such-dir-xyz').slice(0, 12),
      // No `cd` prefix to strip, so it's the same hash as commandHash.
      execHash: sha256Hex('ls ./no-such-dir-xyz').slice(0, 12),
      outcome: 'fail',
      exitCode: 2,
      errorSignature: "ls: cannot access './no-such-dir-xyz': No such file or directory",
      durationMs: 42,
    });
  });

  it('reads a successful Bash call as exit 0, with no error signature', () => {
    expect(parse(SUCCEEDING_BASH)).toMatchObject({ kind: 'command', command: 'echo probe-ok', outcome: 'ok', exitCode: 0 });
    expect(parse(SUCCEEDING_BASH)).not.toHaveProperty('errorSignature');
  });

  it('treats a user abort as interrupted, not as a failure', () => {
    expect(parse({ ...FAILING_BASH, is_interrupt: true })).toMatchObject({ outcome: 'interrupted' });
  });

  it('records only the path of an edit, never the file content the payload also carries', () => {
    const event = parse(EDIT);
    expect(event).toEqual({
      agent: 'claude-code',
      sessionId: 'sess-1',
      eventId: 'toolu_edit_1',
      ts: NOW,
      cwd: 'D:/repo',
      kind: 'edit',
      filePath: 'D:/repo/src/a.ts',
      outcome: 'ok',
      exitCode: null,
      durationMs: 5,
    });
    expect(JSON.stringify(event)).not.toContain('sk_live_0000');
  });

  it('redacts secrets in the command and in the error signature, keeping the raw hash', () => {
    const command = 'psql postgres://app:my-secret@db/app';
    const event = parse({
      ...FAILING_BASH,
      tool_input: { command },
      error: 'Exit code 1\nFATAL: password authentication failed for postgres://app:my-secret@db/app',
    });

    expect(JSON.stringify(event)).not.toContain('my-secret');
    expect(event).toMatchObject({ exitCode: 1, commandHash: sha256Hex(command).slice(0, 12) });
    expect(event?.errorSignature).toContain('[redacted]');
  });

  it('truncates a long error signature', () => {
    const event = parse({ ...FAILING_BASH, error: `Exit code 1\n${'x'.repeat(500)}` });
    expect(event?.errorSignature).toHaveLength(MAX_ERROR_SIGNATURE_CHARS);
  });

  it('keeps the error text when a failure does not start with an exit code', () => {
    expect(parse({ ...FAILING_BASH, error: 'Command timed out after 2m' })).toMatchObject({
      exitCode: null,
      errorSignature: 'Command timed out after 2m',
    });
  });

  it('gives one natural key per agent action, so both delivery paths land on one node', () => {
    expect(agentEventNaturalKey(parse(FAILING_BASH)!)).toBe('agent:claude-code:sess-1:toolu_01LptP88hUpbZQXdJNBJek9W');
  });

  it('tags a subagent event with its agent id', () => {
    expect(parse({ ...FAILING_BASH, agent_id: 'agent-7' })).toMatchObject({ agentId: 'agent-7' });
  });

  it.each([
    ['unparsable-json', '{"session_id":"s"'],
    ['unparsable-json', '"just a string"'],
    ['unsupported-event', JSON.stringify({ ...FAILING_BASH, hook_event_name: 'PreToolUse' })],
    ['unsupported-tool', JSON.stringify({ ...FAILING_BASH, tool_name: 'WebFetch' })],
    ['missing-fields', JSON.stringify({ ...FAILING_BASH, tool_use_id: undefined })],
    ['missing-fields', JSON.stringify({ ...FAILING_BASH, tool_input: {} })],
    ['missing-fields', JSON.stringify({ ...EDIT, tool_input: {} })],
  ])('reports %s so status can tell a quiet week from a broken payload shape', (reason, json) => {
    const outcome = parseHookPayloadDetailed(json, NOW);

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ reason });
    // The codes travel alone: no payload text rides along with them.
    expect(JSON.stringify(outcome)).not.toContain('DB_PASSWORD');
    expect(JSON.stringify(outcome)).not.toContain('no-such-dir');
  });

  it.each([
    ['post-tool-use-failure', FAILING_BASH],
    ['post-tool-use', SUCCEEDING_BASH],
    ['session-start', { ...FAILING_BASH, hook_event_name: 'SessionStart' }],
    ['other', { ...FAILING_BASH, hook_event_name: 'SomethingNewEntirely' }],
  ])('normalizes the hook family to %s, never storing the vendor string', (family, payload) => {
    expect(parseHookPayloadDetailed(JSON.stringify(payload), NOW)).toMatchObject({ family });
  });

  it.each([
    ['malformed JSON', '{"session_id":"s"'],
    ['a non-object', '"just a string"'],
    ['an unhandled event', JSON.stringify({ ...FAILING_BASH, hook_event_name: 'PreToolUse' })],
    ['an unhandled tool', JSON.stringify({ ...FAILING_BASH, tool_name: 'WebFetch' })],
    ['a missing tool_use_id', JSON.stringify({ ...FAILING_BASH, tool_use_id: undefined })],
    ['a missing session_id', JSON.stringify({ ...FAILING_BASH, session_id: undefined })],
    ['a Bash call with no command', JSON.stringify({ ...FAILING_BASH, tool_input: {} })],
    ['an edit with no path', JSON.stringify({ ...EDIT, tool_input: {} })],
  ])('drops %s', (_label, json) => {
    expect(parseHookPayload(json, NOW)).toBeNull();
  });
});

/**
 * Measured in the Phase-5 eval: 15 of 17 real Bash calls that were meant to
 * be checking `node check.js` instead ran `node check.js; echo "EXIT:$?"` or
 * piped it through `head` -- both exit 0 as far as Claude Code's hook is
 * concerned, so `PostToolUseFailure` never fires and the payload carries no
 * exit-code field at all. `tool_response.stdout` is the only place a real
 * status can still be recovered from, and only in the closed set of literal
 * echo spellings below.
 */
describe('recoverExitStatusFromOutput', () => {
  const WRAPPED = 'node check.js; echo "EXIT:$?"';

  it('direct success: ordinary output with no echo line yields no evidence', () => {
    expect(recoverExitStatusFromOutput(WRAPPED, 'probe-ok\n')).toBeNull();
  });

  it('"; echo EXIT:$?": recovers a non-zero status from the last line', () => {
    expect(recoverExitStatusFromOutput(WRAPPED, 'some output\nEXIT:1')).toBe(1);
  });

  it('"; echo EXIT:$?": recovers a zero status the same way', () => {
    expect(recoverExitStatusFromOutput(WRAPPED, 'ok\nEXIT:0')).toBe(0);
  });

  it('accepts the other observed spellings: "exit: N" and "exit=N", any case, trailing whitespace', () => {
    expect(recoverExitStatusFromOutput('node check.js; echo "exit: $?"', 'exit: 2')).toBe(2);
    expect(recoverExitStatusFromOutput('node check.js; echo "EXIT: $?"', 'EXIT: 3  ')).toBe(3);
    expect(recoverExitStatusFromOutput('node check.js; echo "exit=$?"', 'exit=4')).toBe(4);
  });

  it.each([
    ['cd + lowercase', 'cd "/repo" && node check.js; echo "exit: $?"'],
    ['cd + "=" spelling', 'cd "/repo" && node check.js; echo "exit=$?"'],
    ['cd + upper case', 'cd "/repo" && node check.js; echo "EXIT: $?"'],
    ['cd + no space', 'cd "/repo" && node check.js; echo "EXIT:$?"'],
    ['cd + mixed case', 'cd "/repo" && node check.js; echo "Exit: $?"'],
    ['cd + observation segments', 'cd "/repo" && ls -la && echo --- && node check.js; echo "exit: $?"'],
    ['unquoted echo', 'node check.js; echo EXIT:$?'],
  ])('recovers the status behind an observed wrapper form: %s', (_label, command) => {
    expect(recoverExitStatusFromOutput(command, 'out\nEXIT: 1')).toBe(1);
    expect(recoverExitStatusFromOutput(command, 'out\nEXIT: 0')).toBe(0);
  });

  it.each([
    ['a bare command whose own output ends "exit: 1"', 'node report.js', 'summary\nexit: 1'],
    ['a bare command printing "EXIT:1" as ordinary output', 'node report.js', 'EXIT:1'],
    ['a status echo that is not the last segment', 'echo "EXIT:$?"; node report.js', 'EXIT:1'],
    ['a pipeline, where $? is the last stage\'s status', 'node check.js | head; echo "EXIT:$?"', 'EXIT:1'],
    ['an || fallback, where $? is the fallback\'s status', 'node check.js || true; echo "EXIT:$?"', 'EXIT:0'],
    ['another command between the target and the echo', 'node check.js; ls; echo "EXIT:$?"', 'EXIT:0'],
    ['single quotes, which print $? literally', "node check.js; echo 'EXIT:$?'", 'EXIT:1'],
    ['an echo of something other than $?', 'node check.js; echo "EXIT:1"', 'EXIT:1'],
    ['only the echo, with nothing it reports on', 'echo "EXIT:$?"', 'EXIT:1'],
  ])('does not recover a status from %s', (_label, command, stdout) => {
    expect(recoverExitStatusFromOutput(command, stdout)).toBeNull();
  });

  it('pipeline: 2>&1 | head loses the real status; ordinary program output is not evidence', () => {
    // This function's own answer stays null -- it only ever trusts an explicit
    // echo of $?, and a pipeline never has one worth trusting (see the
    // "$? is the last stage's status" case above). The gap this used to leave
    // open -- the shape falling back to a silently guessed "ok" -- is closed
    // one level up, in parseHookPayloadDetailed: see "pipesIntoOpaqueFilter"
    // below, which records "unknown" instead of trusting this null as a pass.
    expect(recoverExitStatusFromOutput('node check.js 2>&1 | head', 'AssertionError: expected 1 to be 2')).toBeNull();
  });

  it('malformed output: a line that looks like the echo but is not parseable yields no evidence', () => {
    expect(recoverExitStatusFromOutput(WRAPPED, 'EXIT:')).toBeNull();
    expect(recoverExitStatusFromOutput(WRAPPED, 'EXIT:abc')).toBeNull();
  });

  it('no status evidence: undefined or empty stdout yields no evidence', () => {
    expect(recoverExitStatusFromOutput(WRAPPED, undefined)).toBeNull();
    expect(recoverExitStatusFromOutput(WRAPPED, '')).toBeNull();
    expect(recoverExitStatusFromOutput(WRAPPED, '\n\n')).toBeNull();
  });

  it('false-positive text containing "exit code" is not mistaken for the echo', () => {
    expect(recoverExitStatusFromOutput(WRAPPED, 'Process finished with exit code 1')).toBeNull();
    expect(recoverExitStatusFromOutput(WRAPPED, 'build failed\nsee exit code 137 above')).toBeNull();
  });

  it('only the last non-blank line counts: an earlier coincidental match is not the wrapper', () => {
    expect(recoverExitStatusFromOutput(WRAPPED, 'exit:1\nthis is not the wrapper\n')).toBeNull();
  });
});

describe('parseHookPayloadDetailed: exit-status recovery end to end', () => {
  const success = (stdout: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ ...SUCCEEDING_BASH, tool_response: { ...SUCCEEDING_BASH.tool_response, stdout }, ...over });

  it('direct non-zero failure (real PostToolUseFailure) is unaffected: exit code still comes from the error text', () => {
    const outcome = parseHookPayloadDetailed(JSON.stringify(FAILING_BASH), NOW);
    expect(outcome).toMatchObject({ ok: true, event: { outcome: 'fail', exitCode: 2 } });
  });

  it('direct success is unaffected: no echo line, stays ok/0', () => {
    const outcome = parseHookPayloadDetailed(success('probe-ok'), NOW);
    expect(outcome).toMatchObject({ ok: true, event: { outcome: 'ok', exitCode: 0 } });
  });

  const wrapped = { tool_input: { command: 'node check.js; echo "EXIT:$?"' } };

  it('"; echo EXIT:$?" flips a hook-reported success into a recorded failure', () => {
    const outcome = parseHookPayloadDetailed(success('some output\nEXIT:1', wrapped), NOW);
    expect(outcome).toMatchObject({ ok: true, event: { outcome: 'fail', exitCode: 1 } });
  });

  it('"; echo EXIT:$?" with a zero status stays ok, with the recovered exit code', () => {
    const outcome = parseHookPayloadDetailed(success('ok\nEXIT:0', wrapped), NOW);
    expect(outcome).toMatchObject({ ok: true, event: { outcome: 'ok', exitCode: 0 } });
  });

  it('never invents a failure from a command that did not echo its status, whatever its output says', () => {
    // Reported on PR #17: `node report.js` printing "exit: 1" was recorded as outcome fail, exitCode 1.
    for (const stdout of ['summary\nexit: 1', 'EXIT:1']) {
      const outcome = parseHookPayloadDetailed(success(stdout, { tool_input: { command: 'node report.js' } }), NOW);
      expect(outcome).toMatchObject({ ok: true, event: { outcome: 'ok', exitCode: 0 } });
    }
  });

  it('a real failure event is never overridden by anything found in stdout -- recovery only runs on the success path', () => {
    // A PostToolUseFailure carries no tool_response at all in practice, but even
    // if a future payload shape did, `failed` short-circuits recovery before it.
    const outcome = parseHookPayloadDetailed(JSON.stringify({ ...FAILING_BASH, tool_response: { stdout: 'EXIT:0' } }), NOW);
    expect(outcome).toMatchObject({ ok: true, event: { outcome: 'fail', exitCode: 2 } });
  });

  it('pipeline and malformed-output cases fall back to the hook: unknown stays "ok", never a guessed failure', () => {
    expect(parseHookPayloadDetailed(success('AssertionError: expected 1 to be 2'), NOW)).toMatchObject({
      ok: true,
      event: { outcome: 'ok', exitCode: 0 },
    });
    expect(parseHookPayloadDetailed(success('EXIT:abc'), NOW)).toMatchObject({ ok: true, event: { outcome: 'ok', exitCode: 0 } });
  });

  describe('pipesIntoOpaqueFilter: pipelines into head/tail/tee', () => {
    it.each([
      ['head, no flags', 'node check.js 2>&1 | head'],
      ['head with a line count', 'node check.js 2>&1 | head -100'],
      ['tail', 'node check.js 2>&1 | tail -n 50'],
      ['tee', 'node check.js 2>&1 | tee build.log'],
      ['no 2>&1, just the pipe', 'node check.js | head -100'],
      ['cd-wrapped', 'cd "/repo" && node check.js 2>&1 | head -100'],
    ])('%s: recorded as unknown, not a guessed pass, whatever the output says', (_label, command) => {
      const outcome = parseHookPayloadDetailed(success('AssertionError: expected 1 to be 2', { tool_input: { command } }), NOW);
      expect(outcome).toMatchObject({ ok: true, event: { outcome: 'unknown', exitCode: null } });
    });

    it('an unrecognised filter is left alone: still "do not guess for arbitrary pipelines"', () => {
      const outcome = parseHookPayloadDetailed(
        success('AssertionError: expected 1 to be 2', { tool_input: { command: 'node check.js 2>&1 | grep Error' } }),
        NOW,
      );
      expect(outcome).toMatchObject({ ok: true, event: { outcome: 'ok', exitCode: 0 } });
    });

    it.each([
      ['a script that merely starts with "head"', 'node check.js | head-check.sh'],
      ['a script that merely starts with "tail"', 'node check.js | tail.sh --verbose'],
      ['a script that merely starts with "tee"', 'node check.js | tee-my-script'],
      ['a program name that contains "head" as a substring', 'node check.js | headphones'],
      ['a program name that contains "tail" as a substring', 'node check.js | tailwind build'],
    ])('%s: not mistaken for the real head/tail/tee', (_label, command) => {
      const outcome = parseHookPayloadDetailed(success('AssertionError: expected 1 to be 2', { tool_input: { command } }), NOW);
      expect(outcome).toMatchObject({ ok: true, event: { outcome: 'ok', exitCode: 0 } });
    });

    it('a real PostToolUseFailure piped into head is unaffected: the failure already has real evidence', () => {
      const outcome = parseHookPayloadDetailed(
        JSON.stringify({ ...FAILING_BASH, tool_input: { command: 'node check.js 2>&1 | head -100' } }),
        NOW,
      );
      expect(outcome).toMatchObject({ ok: true, event: { outcome: 'fail', exitCode: 2 } });
    });

    it('an echoed status behind the filter is still not trusted as the piped command\'s own: stays unknown', () => {
      // $? here is head's exit code, not check.js's -- echoesOwnExitStatus
      // already refuses a body containing "|", so recovery finds nothing and
      // the pipeline shape decides the outcome instead of a stale "ok".
      const outcome = parseHookPayloadDetailed(
        success('EXIT:1', { tool_input: { command: 'node check.js | head; echo "EXIT:$?"' } }),
        NOW,
      );
      expect(outcome).toMatchObject({ ok: true, event: { outcome: 'unknown', exitCode: null } });
    });
  });

  it('recovers the exit status without ever persisting the raw stdout it came from', () => {
    // Redaction (`redactAgentEvent`) only ever touches `command` and
    // `errorSignature` -- `tool_response.stdout` is read for the echo line
    // and then discarded, so a secret sitting elsewhere in that output can
    // never reach the stored event, redacted or not.
    const secret = 'sk-live-abcdef123456';
    const command = `psql postgres://app:${secret}@db/app; echo "EXIT:$?"`;
    const outcome = parseHookPayloadDetailed(success(`leaked ${secret}\nEXIT:1`, { tool_input: { command } }), NOW);

    expect(outcome).toMatchObject({ ok: true, event: { command: expect.not.stringContaining(secret), outcome: 'fail', exitCode: 1 } });
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });
});
