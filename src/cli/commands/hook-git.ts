import pc from 'picocolors';
import { readRepoInfo } from '../../git/repo.js';
import { gitHookStatus, installGitHook, removeGitHook, resolveGitHookTarget } from '../../hooks/install-git-precommit.js';
import {
  installPostCommitGitHook,
  postCommitGitHookStatus,
  removePostCommitGitHook,
  resolvePostCommitHookTarget,
} from '../../hooks/install-git-postcommit.js';

export interface HookGitOptions {
  cwd: string;
  force?: boolean;
}

/** Surfaces a Husky-v7-style redirect so "installed" can't be mistaken for "will fire from .git/hooks". */
function hooksPathNote(hooksPathConfig: string): string {
  return `  ${pc.dim(`core.hooksPath=${hooksPathConfig}`)}`;
}

export async function runHookGitInstall(opts: HookGitOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const target = await resolveGitHookTarget(repo.root);
  const result = await installGitHook(target, { force: opts.force });

  const lines = [
    result.changed
      ? `${pc.green(result.alreadyInstalled ? 'updated' : 'installed')} git pre-commit hook`
      : `${pc.dim('already up to date')}`,
    `  hook ${target.hookPath}`,
  ];
  if (target.hooksPathConfig) lines.push(hooksPathNote(target.hooksPathConfig));
  if (result.appendedToForeign) {
    lines.push(`  ${pc.yellow('appended after an existing pre-commit hook -- review')} ${target.hookPath}`);
  }
  lines.push(
    '',
    `Runs ${pc.bold('nexusmem precheck')} before each commit -- advisory only, never blocks a commit on its own.`,
    `Run ${pc.bold('nexusmem hook git remove')} to undo this.`,
    '',
  );

  process.stdout.write(lines.join('\n'));

  return 0;
}

export async function runHookGitRemove(opts: HookGitOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const target = await resolveGitHookTarget(repo.root);
  const result = await removeGitHook(target);

  process.stdout.write(
    result.changed
      ? `${pc.green('removed')} nexusmem's block from ${target.hookPath}\n`
      : `${pc.dim('nothing to remove')} — no nexusmem block found in ${target.hookPath}\n`,
  );

  return 0;
}

export async function runHookGitStatus(opts: HookGitOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const target = await resolveGitHookTarget(repo.root);
  const result = await gitHookStatus(target);

  const statusLabel = result.installed
    ? pc.green('installed')
    : result.foreign
      ? pc.yellow('a foreign hook exists (not nexusmem) -- nexusmem hook git install --force to append')
      : pc.yellow('not installed');

  process.stdout.write(
    [
      `${pc.dim('hook  ')} ${target.hookPath}`,
      `${pc.dim('status')} ${statusLabel}`,
      target.hooksPathConfig ? hooksPathNote(target.hooksPathConfig) : '',
      '',
    ]
      .filter((line) => line !== '')
      .concat('')
      .join('\n'),
  );

  return 0;
}

export async function runHookGitPostInstall(opts: HookGitOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const target = await resolvePostCommitHookTarget(repo.root);
  const result = await installPostCommitGitHook(target, { force: opts.force });

  const lines = [
    result.changed
      ? `${pc.green(result.alreadyInstalled ? 'updated' : 'installed')} git post-commit hook`
      : `${pc.dim('already up to date')}`,
    `  hook ${target.hookPath}`,
  ];
  if (target.hooksPathConfig) lines.push(hooksPathNote(target.hooksPathConfig));
  if (result.appendedToForeign) {
    lines.push(`  ${pc.yellow('appended after an existing post-commit hook -- review')} ${target.hookPath}`);
  }
  lines.push(
    '',
    `Runs a full ${pc.bold('nexusmem sync')} (including embedding) in the background after each commit --`,
    `detached, so it never makes ${pc.bold('git commit')} itself wait. Output goes to .nexusmem/post-commit-sync.log.`,
    `Run ${pc.bold('nexusmem hook git-post remove')} to undo this.`,
    '',
  );

  process.stdout.write(lines.join('\n'));

  return 0;
}

export async function runHookGitPostRemove(opts: HookGitOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const target = await resolvePostCommitHookTarget(repo.root);
  const result = await removePostCommitGitHook(target);

  process.stdout.write(
    result.changed
      ? `${pc.green('removed')} nexusmem's block from ${target.hookPath}\n`
      : `${pc.dim('nothing to remove')} — no nexusmem block found in ${target.hookPath}\n`,
  );

  return 0;
}

export async function runHookGitPostStatus(opts: HookGitOptions): Promise<number> {
  const repo = await readRepoInfo(opts.cwd);
  const target = await resolvePostCommitHookTarget(repo.root);
  const result = await postCommitGitHookStatus(target);

  const statusLabel = result.installed
    ? pc.green('installed')
    : result.foreign
      ? pc.yellow('a foreign hook exists (not nexusmem) -- nexusmem hook git-post install --force to append')
      : pc.yellow('not installed');

  process.stdout.write(
    [
      `${pc.dim('hook  ')} ${target.hookPath}`,
      `${pc.dim('status')} ${statusLabel}`,
      target.hooksPathConfig ? hooksPathNote(target.hooksPathConfig) : '',
      '',
    ]
      .filter((line) => line !== '')
      .concat('')
      .join('\n'),
  );

  return 0;
}
