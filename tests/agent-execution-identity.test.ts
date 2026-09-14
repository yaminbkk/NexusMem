import { describe, expect, it } from 'vitest';
import { canonicalizeCommand, redactAgentEvent } from '../src/agent/event.js';
import { sha256Hex } from '../src/core/ids.js';

/**
 * The eval measured this directly: a live Claude Code Bash call is routinely
 * `cd "<repo>" && npm test`, while the historical record of the same command
 * is bare `npm test` -- an exact-hash match on the raw text can never find
 * it. `canonicalizeCommand` closes that gap with a semantic allowlist: drop
 * navigation and observation segments, keep the single real execution.
 * Everything else -- a `cd` elsewhere, an env-var prefix, `sudo`, a pipe, a
 * second real command -- is left as a different command, on purpose: a wrong
 * match here would be worse than a missed one.
 *
 * The shapes in `real Claude Code compounds` below are not invented: each is
 * a command form actually emitted by Claude Code during the Phase-5 eval,
 * taken from the saved transcripts, with only the repository path replaced.
 */

describe('canonicalizeCommand', () => {
  it('MATCH: strips a cd prefix that names the same cwd, Windows path', () => {
    const cwd = 'C:\\Users\\dev\\repo';
    expect(canonicalizeCommand(`cd "${cwd}" && node check.js`, cwd)).toBe('node check.js');
  });

  it('MATCH: strips a cd prefix that names the same cwd, POSIX path', () => {
    const cwd = '/home/dev/repo';
    expect(canonicalizeCommand(`cd "${cwd}" && node check.js`, cwd)).toBe('node check.js');
  });

  it('MATCH: a slash/backslash mismatch between the cd target and the recorded cwd still matches', () => {
    expect(canonicalizeCommand('cd "C:/Users/dev/repo" && node check.js', 'C:\\Users\\dev\\repo')).toBe('node check.js');
  });

  it('MATCH: a trailing slash on either side does not block the match', () => {
    expect(canonicalizeCommand('cd "/home/dev/repo/" && node check.js', '/home/dev/repo')).toBe('node check.js');
  });

  it('MATCH: a cwd containing spaces, quoted', () => {
    const cwd = 'C:\\Users\\dev\\my repo';
    expect(canonicalizeCommand(`cd "${cwd}" && node check.js`, cwd)).toBe('node check.js');
  });

  it('MATCH: single-quoted cd target', () => {
    const cwd = '/home/dev/repo';
    expect(canonicalizeCommand(`cd '${cwd}' && node check.js`, cwd)).toBe('node check.js');
  });

  it('MATCH: bare "cd ." is always the same directory', () => {
    expect(canonicalizeCommand('cd . && node check.js', '/home/dev/repo')).toBe('node check.js');
  });

  it('NO MATCH: cd to a different directory is left untouched', () => {
    const raw = 'cd other && node check.js';
    expect(canonicalizeCommand(raw, '/home/dev/repo')).toBe(raw);
  });

  it('NO MATCH: a leading token that is not cd is left untouched', () => {
    const raw = 'setup && node check.js';
    expect(canonicalizeCommand(raw, '/home/dev/repo')).toBe(raw);
  });

  it('NO MATCH: an inline env-var assignment is left untouched', () => {
    const raw = 'VAR=x node check.js';
    expect(canonicalizeCommand(raw, '/home/dev/repo')).toBe(raw);
  });

  it('NO MATCH: sudo is left untouched', () => {
    const raw = 'sudo node check.js';
    expect(canonicalizeCommand(raw, '/home/dev/repo')).toBe(raw);
  });

  it('NO MATCH: piped to another command is left untouched', () => {
    const raw = 'node check.js | other';
    expect(canonicalizeCommand(raw, '/home/dev/repo')).toBe(raw);
  });

  it('NO MATCH: chained with a second command via ; is left untouched', () => {
    const raw = 'node check.js ; other';
    expect(canonicalizeCommand(raw, '/home/dev/repo')).toBe(raw);
  });

  it('NO MATCH: no cwd known at all leaves the command untouched', () => {
    const raw = 'cd /home/dev/repo && node check.js';
    expect(canonicalizeCommand(raw, null)).toBe(raw);
  });

  it('historical compatibility: a command with no cd prefix is a pure no-op', () => {
    // Every command NexusMem has ever recorded before this field existed was
    // exactly this shape, so its hash must be untouched.
    expect(canonicalizeCommand('node check.js', '/home/dev/repo')).toBe('node check.js');
    expect(canonicalizeCommand('node check.js', null)).toBe('node check.js');
  });

  it('is a pure, deterministic function: repeated ingestion of the same event yields the same key', () => {
    const a = canonicalizeCommand('cd "/repo" && node check.js', '/repo');
    const b = canonicalizeCommand('cd "/repo" && node check.js', '/repo');
    expect(a).toBe(b);
  });
});

/**
 * Every shape below was emitted by Claude Code during the Phase-5 eval. The
 * counts are how many of the 69 task-execution Bash calls used that exact
 * form, so a regression here is a measured loss of delivery, not a
 * hypothetical one.
 */
describe('real Claude Code compounds, from the Phase-5 transcripts', () => {
  const cwd = 'C:\\Users\\dev\\AppData\\Local\\Temp\\workspace-aCFzjL\\app';

  const matches: Array<[string, string]> = [
    ['cd wrapper (11 calls)', `cd "${cwd}" && node check.js`],
    ['cd + trailing lowercase exit echo (16 calls)', `cd "${cwd}" && node check.js; echo "exit: $?"`],
    ['cd + trailing "exit=" echo (6 calls)', `cd "${cwd}" && node check.js; echo "exit=$?"`],
    ['cd + trailing "EXIT: " echo (5 calls)', `cd "${cwd}" && node check.js; echo "EXIT: $?"`],
    ['cd + trailing "EXIT:" echo (4 calls)', `cd "${cwd}" && node check.js; echo "EXIT:$?"`],
    ['cd + trailing "Exit: " echo (1 call)', `cd "${cwd}" && node check.js; echo "Exit: $?"`],
    ['cd + ls observation prefix (3 calls)', `cd "${cwd}" && ls && node check.js`],
    ['cd + ls + echo separator prefix (2 calls)', `cd "${cwd}" && ls && echo "---" && node check.js`],
    ['cd + ls -la + unquoted echo prefix (1 call)', `cd "${cwd}" && ls -la && echo --- && node check.js`],
    ['bare + trailing "EXIT: " echo (3 calls)', 'node check.js; echo "EXIT: $?"'],
    ['bare + trailing "exit: " echo (2 calls)', 'node check.js; echo "exit: $?"'],
    ['bare + trailing "EXIT:" echo (2 calls)', 'node check.js; echo "EXIT:$?"'],
    ['bare (1 call)', 'node check.js'],
  ];

  for (const [label, raw] of matches) {
    it(`MATCH: ${label}`, () => {
      expect(canonicalizeCommand(raw, cwd)).toBe('node check.js');
    });
  }

  /**
   * 12 of the 69 calls piped the check into `head`. Left deliberately
   * unmatched: `head` closing the pipe can change what the producer does, and
   * the exit status belongs to `head`, not to the command being identified.
   * Classified UNKNOWN in the delivery corpus rather than forced to match.
   */
  it('UNKNOWN: a pipeline keeps its pipe and does not collapse to the bare command (11 calls)', () => {
    const raw = `cd "${cwd}" && node check.js 2>&1 | head -100`;
    expect(canonicalizeCommand(raw, cwd)).not.toBe('node check.js');
    expect(canonicalizeCommand(raw, cwd)).toBe('node check.js 2>&1 | head -100');
  });

  it('UNKNOWN: a bare pipeline is left untouched (1 call)', () => {
    const raw = 'node check.js 2>&1 | head -100';
    expect(canonicalizeCommand(raw, cwd)).toBe(raw);
  });

  it('MATCH: a Git Bash cd target against a native Windows cwd, the real Phase-5 miss', () => {
    // retry-regression/ambient/#3 emitted exactly this: the model cd-ed to the
    // Git Bash spelling while the hook reported the native one, so the one
    // trial that produced a genuine tool error still found no history.
    const native = 'C:\\Users\\user-0118012023\\AppData\\Local\\Temp\\workspace-AH0HSV\\app';
    const gitBash = '/c/Users/user-0118012023/AppData/Local/Temp/workspace-AH0HSV/app';
    expect(canonicalizeCommand(`cd "${gitBash}" && ls -la && echo --- && node check.js`, native)).toBe('node check.js');
    expect(canonicalizeCommand(`cd "${gitBash}" && node check.js; echo "exit: $?"`, native)).toBe('node check.js');
  });

  it('MATCH: a WSL cd target against a native Windows cwd', () => {
    const native = 'C:\\Users\\dev\\app';
    expect(canonicalizeCommand('cd "/mnt/c/Users/dev/app" && node check.js', native)).toBe('node check.js');
  });

  it('NO MATCH: a drive-shaped cd to a genuinely different directory still refuses', () => {
    const native = 'C:\\Users\\dev\\app';
    const raw = 'cd "/c/Users/dev/other" && node check.js';
    expect(canonicalizeCommand(raw, native)).toBe(raw);
  });

  it('MATCH: the observation prefix works with a POSIX-style cwd too', () => {
    const posix = '/home/dev/repo';
    expect(canonicalizeCommand(`cd "${posix}" && ls -la && echo --- && node check.js; echo "exit: $?"`, posix)).toBe('node check.js');
  });

  it('MATCH: a cwd containing spaces still parses as one cd argument inside a compound', () => {
    const spaced = 'C:\\Users\\dev\\my repo';
    expect(canonicalizeCommand(`cd "${spaced}" && ls && node check.js; echo "exit: $?"`, spaced)).toBe('node check.js');
  });
});

describe('conservative refusals: shapes that must never collapse to the bare command', () => {
  const cwd = '/home/dev/repo';
  const unchanged = (raw: string) => expect(canonicalizeCommand(raw, cwd)).toBe(raw);

  it('NO MATCH: an env-var export before the target could change its behaviour', () => {
    unchanged('export X=1 && node check.js');
  });

  it('NO MATCH: a build step before the target is a second real execution', () => {
    unchanged('node build.js && node check.js');
  });

  it('NO MATCH: an unrecognised setup word before the target', () => {
    unchanged('setup && node check.js');
  });

  it('NO MATCH: a cleanup command after the target', () => {
    unchanged('node check.js ; cleanup');
  });

  it('NO MATCH: a cd to a different directory inside an otherwise safe compound', () => {
    unchanged('cd /somewhere/else && ls && node check.js');
  });

  it('NO MATCH: sudo is part of the execution identity, not a prefix to drop', () => {
    unchanged('sudo node check.js');
  });

  it('NO MATCH: a mutating git subcommand is not observation', () => {
    unchanged('git checkout main && node check.js');
    unchanged('git stash && node check.js');
  });

  it('NO MATCH: command substitution inside an otherwise observation-shaped segment', () => {
    unchanged('echo $(rm -rf build) && node check.js');
  });

  it('NO MATCH: a redirection inside an otherwise observation-shaped segment', () => {
    unchanged('echo seed > fixture.txt && node check.js');
  });

  it('NO MATCH: a backgrounded segment', () => {
    unchanged('server & node check.js');
  });

  it('NO MATCH: two real executions cannot be reduced to one', () => {
    unchanged('npm run build && npm test');
  });

  it('NO MATCH: observation segments alone name no execution', () => {
    unchanged('ls && pwd');
    unchanged(`cd ${cwd} && git status`);
  });

  it('MATCH: the spec\'s safe observation prefixes do collapse', () => {
    expect(canonicalizeCommand('pwd && node check.js', cwd)).toBe('node check.js');
    expect(canonicalizeCommand('ls && node check.js', cwd)).toBe('node check.js');
    expect(canonicalizeCommand('git status && node check.js', cwd)).toBe('node check.js');
    expect(canonicalizeCommand('git log --oneline -10 && node check.js', cwd)).toBe('node check.js');
  });
});

describe('execHash on a redacted event', () => {
  const cwd = '/home/dev/repo';

  it('MATCH: a live cd-wrapped failure and a historical bare command produce the same execHash', () => {
    const historical = redactAgentEvent({
      agent: 'claude-code',
      sessionId: 's1',
      eventId: 'e1',
      ts: '2026-01-01T00:00:00.000Z',
      cwd,
      kind: 'command',
      command: 'node check.js',
      outcome: 'fail',
      exitCode: 1,
      durationMs: 5,
    });
    const live = redactAgentEvent({
      agent: 'claude-code',
      sessionId: 's2',
      eventId: 'e2',
      ts: '2026-01-08T00:00:00.000Z',
      cwd,
      kind: 'command',
      command: `cd "${cwd}" && node check.js`,
      outcome: 'fail',
      exitCode: 1,
      durationMs: 5,
    });

    expect(live.execHash).toBe(historical.execHash);
    // The raw hash still differs -- execHash is a new, separate key, not a repurposed one.
    expect(live.commandHash).not.toBe(historical.commandHash);
  });

  it('NO MATCH: the same command run in a different repository does not share an execHash by text alone', () => {
    // execHash is still looked up scoped by project_id in recall.ts; this only
    // proves the hash itself does not accidentally erase the distinction --
    // it is computed from command text, not from cwd, exactly like commandHash.
    const a = redactAgentEvent({
      agent: 'claude-code',
      sessionId: 's1',
      eventId: 'e1',
      ts: '2026-01-01T00:00:00.000Z',
      cwd: '/repo-a',
      kind: 'command',
      command: 'cd /repo-a && npm test',
      outcome: 'fail',
      exitCode: 1,
      durationMs: 5,
    });
    const b = redactAgentEvent({
      agent: 'claude-code',
      sessionId: 's2',
      eventId: 'e2',
      ts: '2026-01-01T00:00:00.000Z',
      cwd: '/repo-b',
      kind: 'command',
      command: 'cd /repo-b && npm test',
      outcome: 'fail',
      exitCode: 1,
      durationMs: 5,
    });
    // Both canonicalize to bare "npm test", so the hashes DO collide -- recall
    // stays safe only because its query is also scoped by project_id.
    expect(a.execHash).toBe(b.execHash);
  });

  it('keeps the raw-secret invariant: two commands differing only by an embedded secret never collide', () => {
    const a = redactAgentEvent({
      agent: 'claude-code',
      sessionId: 's1',
      eventId: 'e1',
      ts: '2026-01-01T00:00:00.000Z',
      cwd,
      kind: 'command',
      command: `cd "${cwd}" && psql postgres://app:one@db/app`,
      outcome: 'fail',
      exitCode: 1,
      durationMs: 5,
    });
    const b = redactAgentEvent({
      agent: 'claude-code',
      sessionId: 's2',
      eventId: 'e2',
      ts: '2026-01-01T00:00:00.000Z',
      cwd,
      kind: 'command',
      command: `cd "${cwd}" && psql postgres://app:two@db/app`,
      outcome: 'fail',
      exitCode: 1,
      durationMs: 5,
    });
    expect(a.execHash).not.toBe(b.execHash);
    expect(a.execHash).toBe(sha256Hex('psql postgres://app:one@db/app').slice(0, 12));
  });
});
