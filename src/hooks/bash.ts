/**
 * Generates and manages the block NexusMem inserts into `~/.bashrc` to log
 * every command with its real timestamp, cwd and exit code -- the bash
 * counterpart to `powershell.ts`.
 *
 * Command text and start time both come from a DEBUG trap capturing
 * `$BASH_COMMAND`, not from `fc -ln -1`/`$HISTCMD` read inside precmd --
 * tried that first and found, by actually running it, that history's
 * in-memory view lags PROMPT_COMMAND by one command under a non-tty stdin
 * (and intermittently otherwise), silently pairing each command's *exit
 * code* with the *previous* command's text. A DEBUG trap has no such lag:
 * `$BASH_COMMAND` is exact and current every time it fires. The tradeoff is
 * a DEBUG trap is a single global slot another tool could already hold, so
 * this hook takes it over only when nothing else has -- and simply does not
 * log at all (rather than log with wrong or missing command text) when it
 * can't.
 */

const MARK_START = '# >>> nexusmem shell hook >>>';
const MARK_END = '# <<< nexusmem shell hook <<<';

/** Bash single-quoted strings have exactly one escape rule: a literal `'` doubles to `'\''`. */
function toBashLiteral(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function renderHookSnippet(logPath: string): string {
  return [
    MARK_START,
    `__nxm_log_path=${toBashLiteral(logPath)}`,
    '__nxm_cmd_start=""',
    '__nxm_last_cmd=""',
    '__nxm_debug_trap_owned=""',
    '',
    '__nxm_json_escape() {',
    '  local s=$1',
    '  s=${s//\\\\/\\\\\\\\}',
    '  s=${s//\\"/\\\\\\"}',
    "  s=${s//$'\\n'/\\\\n}",
    "  s=${s//$'\\t'/\\\\t}",
    '  printf \'%s\' "$s"',
    '}',
    '',
    '# Sets $__nxm_ms rather than echoing, to avoid a subshell fork on the bash 5+ fast path.',
    '__nxm_now_ms() {',
    '  if [ -n "${EPOCHREALTIME:-}" ]; then',
    '    local es=${EPOCHREALTIME/./}',
    '    __nxm_ms=$(( es / 1000 ))',
    '  else',
    '    __nxm_ms=$(( $(date -u +%s) * 1000 ))',
    '  fi',
    '}',
    '',
    // A DEBUG trap fires per simple command, so a pipeline sets __nxm_cmd_start
    // once (first stage) and precmd clears it after logging.
    '__nxm_preexec() {',
    '  case "$BASH_COMMAND" in __nxm_*) return ;; esac',
    '  if [ -z "$__nxm_cmd_start" ]; then',
    '    __nxm_now_ms; __nxm_cmd_start=$__nxm_ms',
    '    __nxm_last_cmd=$BASH_COMMAND',
    '  fi',
    '}',
    '',
    '__nxm_precmd() {',
    // Must be first: nothing above may run a command that would overwrite $?.
    '  local __nxm_exit=$?',
    '  [ -z "$__nxm_debug_trap_owned" ] && return',
    '  [ -z "$__nxm_last_cmd" ] && return',
    '',
    '  local __nxm_dur=null',
    '  if [ -n "$__nxm_cmd_start" ]; then',
    '    __nxm_now_ms',
    '    __nxm_dur=$(( __nxm_ms - __nxm_cmd_start ))',
    '  fi',
    '',
    '  local __nxm_dir',
    '  __nxm_dir=$(dirname -- "$__nxm_log_path" 2>/dev/null)',
    '  [ -d "$__nxm_dir" ] || mkdir -p "$__nxm_dir" 2>/dev/null',
    '  printf \'{"ts":"%s","cwd":"%s","exitCode":%s,"durationMs":%s,"command":"%s","shell":"bash-hook"}\\n\' \\',
    '    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$(__nxm_json_escape "$PWD")" "$__nxm_exit" "$__nxm_dur" \\',
    '    "$(__nxm_json_escape "$__nxm_last_cmd")" >> "$__nxm_log_path" 2>/dev/null',
    '',
    '  __nxm_cmd_start=""',
    '  __nxm_last_cmd=""',
    '}',
    '',
    '# Runs first in the chain (before any pre-existing PROMPT_COMMAND) so $? is still the real last-command status above.',
    'case ";$PROMPT_COMMAND;" in',
    '  *";__nxm_precmd;"*) ;;',
    '  *) PROMPT_COMMAND="__nxm_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;',
    'esac',
    '',
    // Installed last, after every other statement in this block has already
    // run once -- otherwise sourcing this file trips our own trap on our own
    // remaining setup statements (confirmed live: the case/esac above got
    // logged as if it were a real command, the one time this was ordered
    // before the trap install).
    '# Only takes over an unset DEBUG trap -- never overwrites one another tool',
    '# (direnv, a debugger, ...) already owns. If something else already holds',
    '# it, precmd above logs nothing rather than log with no command text.',
    'if [ -z "$(trap -p DEBUG)" ]; then',
    '  trap \'__nxm_preexec\' DEBUG',
    '  __nxm_debug_trap_owned=1',
    'fi',
    MARK_END,
    '',
  ].join('\n');
}

export function isHookInstalled(profileContent: string): boolean {
  return profileContent.includes(MARK_START);
}

export function stripHookSnippet(profileContent: string): string {
  const startIdx = profileContent.indexOf(MARK_START);
  const endIdx = profileContent.indexOf(MARK_END);
  if (startIdx === -1 || endIdx === -1) return profileContent;

  const afterBlock = profileContent.slice(endIdx + MARK_END.length).replace(/^\r?\n/, '');
  return profileContent.slice(0, startIdx) + afterBlock;
}

/** Idempotent: strips any existing block first, so re-running with a new log path updates cleanly. */
export function upsertHookSnippet(profileContent: string, logPath: string): string {
  const stripped = stripHookSnippet(profileContent).replace(/\s+$/, '');
  const prefix = stripped.length > 0 ? `${stripped}\n\n` : '';
  return `${prefix}${renderHookSnippet(logPath)}`;
}
