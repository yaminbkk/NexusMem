import pc from 'picocolors';
import { hookStatus, installHook, removeHook, resolveHookTarget, type ShellKind } from '../../hooks/install.js';

export interface HookOptions {
  shell?: ShellKind;
  profile?: string;
  logPath?: string;
}

/**
 * bash's caveats aren't obvious from the installed snippet alone -- surfaced
 * here so they're seen once, at install time, rather than discovered later
 * as "why didn't this work on my Mac."
 */
function shellCaveats(shell: ShellKind): string[] {
  if (shell !== 'bash') return [];
  return [
    `Note: on macOS, Terminal.app opens login shells, which read ~/.bash_profile, not ~/.bashrc --`,
    `if commands aren't being logged there, source this file from your .bash_profile.`,
    `Note: if another tool already owns this shell's DEBUG trap, commands won't be logged at all`,
    `(rather than logged with the wrong exit code) -- check \`nexusmem hook status\` after installing.`,
  ];
}

export async function runHookInstall(opts: HookOptions): Promise<number> {
  const target = await resolveHookTarget(opts.shell, opts.profile, opts.logPath);
  const result = await installHook(target);

  process.stdout.write(
    [
      result.changed
        ? `${pc.green(result.alreadyInstalled ? 'updated' : 'installed')} shell hook (${target.shell})`
        : `${pc.dim('already up to date')}`,
      `  profile ${target.profilePath}`,
      `  log     ${target.logPath}`,
      '',
      `New commands in any ${target.shell} session using this profile will now log their timestamp, cwd and exit code.`,
      target.shell === 'pwsh'
        ? `Open a new PowerShell window (or run \`. $PROFILE\`) for it to take effect.`
        : `Open a new shell (or run \`. ${target.profilePath}\`) for it to take effect.`,
      ...shellCaveats(target.shell),
      `Run ${pc.bold('nexusmem hook remove')} to undo this.`,
      '',
    ].join('\n'),
  );

  return 0;
}

export async function runHookRemove(opts: HookOptions): Promise<number> {
  const target = await resolveHookTarget(opts.shell, opts.profile, opts.logPath);
  const result = await removeHook(target);

  process.stdout.write(
    result.changed
      ? `${pc.green('removed')} shell hook from ${target.profilePath}\n`
      : `${pc.dim('nothing to remove')} — no hook block found in ${target.profilePath}\n`,
  );

  return 0;
}

export async function runHookStatus(opts: HookOptions): Promise<number> {
  const target = await resolveHookTarget(opts.shell, opts.profile, opts.logPath);
  const result = await hookStatus(target);

  process.stdout.write(
    [
      `${pc.dim('shell  ')} ${target.shell}`,
      `${pc.dim('profile')} ${target.profilePath}`,
      `${pc.dim('log    ')} ${target.logPath}`,
      `${pc.dim('status ')} ${result.installed ? pc.green('installed') : pc.yellow('not installed')}`,
      '',
    ].join('\n'),
  );

  return 0;
}
