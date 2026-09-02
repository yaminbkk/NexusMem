/**
 * Generates and manages the block NexusMem inserts into `~/.zshrc` to log
 * every command with its real timestamp, cwd and exit code -- the zsh
 * counterpart to `powershell.ts`/`bash.ts`.
 *
 * Unlike bash, zsh's `preexec`/`precmd` are native, composable arrays
 * (`preexec_functions`/`precmd_functions`) rather than a single global DEBUG
 * trap slot -- multiple tools (starship, oh-my-zsh plugins, ...) already
 * register their own without conflict, so there is no bash-style
 * "only takes over if nothing else has" tradeoff here. `preexec` receives
 * the command as `$1` directly (as typed, no history/`fc` lookup involved),
 * which is also why it doesn't share bash's fix/attempt history: nothing
 * here goes through history at all, so there's no lag to introduce.
 *
 * Prepended, not appended, to `precmd_functions` so this hook's `$?` capture
 * runs before any other tool's precmd could run a command and clobber it --
 * same ordering requirement as bash's PROMPT_COMMAND chaining.
 *
 * Not run against a real zsh in this session (none available on this
 * Windows machine or its WSL2 distro without interactive sudo) -- the
 * escaper is identical to bash's already-verified one (zsh supports the
 * same `${s//pattern/replacement}` and `$'...'` syntax), but the
 * preexec/precmd wiring itself is unverified beyond reading zsh's own docs.
 */

const MARK_START = '# >>> nexusmem shell hook >>>';
const MARK_END = '# <<< nexusmem shell hook <<<';

/** zsh single-quoted strings have exactly one escape rule: a literal `'` doubles to `'\''`. */
function toZshLiteral(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function renderHookSnippet(logPath: string): string {
  return [
    MARK_START,
    `__nxm_log_path=${toZshLiteral(logPath)}`,
    '__nxm_cmd_start=""',
    '__nxm_last_cmd=""',
    'zmodload zsh/datetime 2>/dev/null',
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
    '__nxm_preexec() {',
    '  __nxm_last_cmd=$1',
    '  if [ -n "${EPOCHREALTIME:-}" ]; then',
    '    __nxm_cmd_start=$(printf \'%.0f\' $(( EPOCHREALTIME * 1000 )))',
    '  else',
    '    __nxm_cmd_start=$(( $(date -u +%s) * 1000 ))',
    '  fi',
    '}',
    '',
    '__nxm_precmd() {',
    // Must be first: nothing above may run a command that would overwrite $?.
    '  local __nxm_exit=$?',
    '  [ -z "$__nxm_last_cmd" ] && return',
    '',
    '  local __nxm_dur=null',
    '  if [ -n "$__nxm_cmd_start" ]; then',
    '    local __nxm_now',
    '    if [ -n "${EPOCHREALTIME:-}" ]; then',
    '      __nxm_now=$(printf \'%.0f\' $(( EPOCHREALTIME * 1000 )))',
    '    else',
    '      __nxm_now=$(( $(date -u +%s) * 1000 ))',
    '    fi',
    '    __nxm_dur=$(( __nxm_now - __nxm_cmd_start ))',
    '  fi',
    '',
    '  local __nxm_dir',
    '  __nxm_dir=$(dirname -- "$__nxm_log_path" 2>/dev/null)',
    '  [ -d "$__nxm_dir" ] || mkdir -p "$__nxm_dir" 2>/dev/null',
    '  printf \'{"ts":"%s","cwd":"%s","exitCode":%s,"durationMs":%s,"command":"%s","shell":"zsh-hook"}\\n\' \\',
    '    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$(__nxm_json_escape "$PWD")" "$__nxm_exit" "$__nxm_dur" \\',
    '    "$(__nxm_json_escape "$__nxm_last_cmd")" >> "$__nxm_log_path" 2>/dev/null',
    '',
    '  __nxm_cmd_start=""',
    '  __nxm_last_cmd=""',
    '}',
    '',
    // Membership check (not just append) so re-sourcing this file doesn't register twice.
    'typeset -ga preexec_functions precmd_functions',
    '(( ${preexec_functions[(Ie)__nxm_preexec]} )) || preexec_functions=(__nxm_preexec "${preexec_functions[@]}")',
    '(( ${precmd_functions[(Ie)__nxm_precmd]} )) || precmd_functions=(__nxm_precmd "${precmd_functions[@]}")',
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
