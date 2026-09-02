import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as bashHook from '../src/hooks/bash.js';
import { installHook, hookStatus, removeHook, type HookTarget, type ShellKind } from '../src/hooks/install.js';
import * as zshHook from '../src/hooks/zsh.js';

/**
 * bash and zsh share the same marker/upsert/strip shape as PowerShell's hook
 * (tests/shell.test.ts) -- covered here with describe.each rather than
 * duplicated per shell. Shell-specific internals (bash's DEBUG-trap-conflict
 * guard, zsh's preexec_functions/precmd_functions array membership) get
 * their own describe blocks below since they have no PowerShell counterpart.
 */
const MODULES: Array<{ shell: Extract<ShellKind, 'bash' | 'zsh'>; mod: typeof bashHook }> = [
  { shell: 'bash', mod: bashHook },
  { shell: 'zsh', mod: zshHook },
];

describe.each(MODULES)('$shell hook snippet (pure)', ({ mod }) => {
  it('is not installed in empty content, and empty content is not "foreign" in the sense of already having a block', () => {
    expect(mod.isHookInstalled('')).toBe(false);
  });

  it('installing then checking reports installed', () => {
    const withHook = mod.upsertHookSnippet('', '/log.jsonl');
    expect(mod.isHookInstalled(withHook)).toBe(true);
  });

  it('preserves unrelated profile content around the block', () => {
    const original = '# my custom profile\nalias ll="ls -la"\n';
    const withHook = mod.upsertHookSnippet(original, '/log.jsonl');
    expect(withHook).toContain('alias ll="ls -la"');
    expect(withHook).toContain('__nxm_precmd');
  });

  it('is idempotent: upserting twice does not duplicate the block', () => {
    const once = mod.upsertHookSnippet('# profile\n', '/log.jsonl');
    const twice = mod.upsertHookSnippet(once, '/log.jsonl');
    expect(twice.match(/# >>> nexusmem shell hook >>>/g)).toHaveLength(1);
  });

  it('updates the log path in place when re-installed with a new path', () => {
    const first = mod.upsertHookSnippet('', '/old.jsonl');
    const second = mod.upsertHookSnippet(first, '/new.jsonl');
    expect(second).toContain('/new.jsonl');
    expect(second).not.toContain('/old.jsonl');
  });

  it('strips cleanly back to the original content', () => {
    const original = '# before\necho hi\n# after\n';
    const withHook = mod.upsertHookSnippet(original, '/log.jsonl');
    expect(mod.stripHookSnippet(withHook).replace(/\n+$/, '')).toBe(original.replace(/\n+$/, ''));
  });

  it('escapes an embedded single quote in the log path the shell single-quote way (doubled via close-quote/escape/reopen)', () => {
    const snippet = mod.renderHookSnippet("/home/o'brien/log.jsonl");
    expect(snippet).toContain("'/home/o'\\''brien/log.jsonl'");
  });

  it('captures $? as the first statement of precmd, before anything else could overwrite it', () => {
    const snippet = mod.renderHookSnippet('/log.jsonl');
    const body = snippet.slice(snippet.indexOf('__nxm_precmd() {'));
    const exitLine = body.indexOf('local __nxm_exit=$?');
    expect(exitLine).toBeGreaterThan(-1);
    // Nothing between the function's opening brace and the exit-code capture
    // -- i.e. the capture really is the first statement, not just an early one.
    const firstBraceIdx = body.indexOf('{');
    const between = body.slice(firstBraceIdx + 1, exitLine).trim();
    expect(between).toBe('');
  });

  it('JSON-escapes backslash before quote/newline/tab, so a backslash introduced by quote-escaping is not itself re-escaped', () => {
    const snippet = mod.renderHookSnippet('/log.jsonl');
    const escaper = snippet.slice(snippet.indexOf('__nxm_json_escape() {'), snippet.indexOf('__nxm_json_escape() {') + 300);
    const bsLine = escaper.indexOf('s=${s//\\\\/\\\\\\\\}');
    const quoteLine = escaper.indexOf('s=${s//\\"/');
    expect(bsLine).toBeGreaterThan(-1);
    expect(quoteLine).toBeGreaterThan(bsLine);
  });
});

describe('bash-specific: DEBUG trap ownership', () => {
  it('only takes over an unset DEBUG trap, and records ownership in a flag precmd checks', () => {
    const snippet = bashHook.renderHookSnippet('/log.jsonl');
    expect(snippet).toContain('if [ -z "$(trap -p DEBUG)" ]; then');
    expect(snippet).toContain('__nxm_debug_trap_owned=1');
    expect(snippet).toContain('[ -z "$__nxm_debug_trap_owned" ] && return');
  });

  it('installs the trap-ownership check after the PROMPT_COMMAND wiring, not before -- sourcing the file must not trip the trap on its own remaining setup statements', () => {
    // Regression: this was live-verified to fire on the case/esac statement
    // itself when the trap install came first in file order.
    const snippet = bashHook.renderHookSnippet('/log.jsonl');
    const promptCommandIdx = snippet.indexOf('PROMPT_COMMAND="__nxm_precmd');
    const trapIdx = snippet.indexOf("trap '__nxm_preexec' DEBUG");
    expect(promptCommandIdx).toBeGreaterThan(-1);
    expect(trapIdx).toBeGreaterThan(promptCommandIdx);
  });

  it('command text and start time both come from $BASH_COMMAND in the DEBUG trap, not from fc/history', () => {
    // Regression: an earlier version read `fc -ln -1`/$HISTCMD inside precmd
    // instead, and live testing found it lags PROMPT_COMMAND by one command
    // under a non-tty stdin -- silently pairing each command's real exit
    // code with the *previous* command's text.
    const snippet = bashHook.renderHookSnippet('/log.jsonl');
    expect(snippet).toContain('__nxm_last_cmd=$BASH_COMMAND');
    expect(snippet).not.toContain('fc -ln');
    expect(snippet).not.toContain('HISTCMD');
  });
});

describe('zsh-specific: preexec_functions/precmd_functions membership', () => {
  it('registers via array membership check, not a bare append, so re-sourcing does not register twice', () => {
    const snippet = zshHook.renderHookSnippet('/log.jsonl');
    expect(snippet).toContain('${preexec_functions[(Ie)__nxm_preexec]}');
    expect(snippet).toContain('${precmd_functions[(Ie)__nxm_precmd]}');
  });

  it('prepends rather than appends to precmd_functions, so $? is captured before any other tool\'s precmd can run a command and clobber it', () => {
    const snippet = zshHook.renderHookSnippet('/log.jsonl');
    expect(snippet).toContain('precmd_functions=(__nxm_precmd "${precmd_functions[@]}")');
  });

  it('receives the command via preexec\'s own $1 argument, not a history lookup', () => {
    const snippet = zshHook.renderHookSnippet('/log.jsonl');
    expect(snippet).toContain('__nxm_last_cmd=$1');
  });
});

describe.each(MODULES)('$shell hook install/remove/status (filesystem, scratch profile)', ({ shell }) => {
  let dir: string;
  let profilePath: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `nexusmem-${shell}-profile-`));
    profilePath = join(dir, shell === 'bash' ? '.bashrc' : '.zshrc');
    logPath = join(dir, 'shell-history.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function target(): HookTarget {
    return { shell, profilePath, logPath };
  }

  it('creates the profile file and directory if neither exists', async () => {
    const result = await installHook(target());
    expect(result.changed).toBe(true);
    expect((await hookStatus(target())).installed).toBe(true);
  });

  it('is a no-op the second time with the same log path', async () => {
    await installHook(target());
    const second = await installHook(target());
    expect(second.changed).toBe(false);
    expect(second.alreadyInstalled).toBe(true);
  });

  it('removes cleanly and status reflects it', async () => {
    await installHook(target());
    const removed = await removeHook(target());
    expect(removed.changed).toBe(true);
    expect((await hookStatus(target())).installed).toBe(false);
  });

  it('removing when nothing is installed is a safe no-op', async () => {
    const result = await removeHook(target());
    expect(result.changed).toBe(false);
  });
});
