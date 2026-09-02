import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHookInstall, runHookRemove, runHookStatus } from '../src/cli/commands/hook.js';

/**
 * CLI-level coverage for `nexusmem hook install/remove/status`. Passing both
 * `--profile` and `--logPath` makes `resolveHookTarget` skip
 * `resolvePowerShellProfilePath()` entirely (see hooks/install.ts), so this
 * never spawns `powershell -Command $PROFILE` or touches the real machine's
 * profile -- the same injection tests/shell.test.ts already relies on one
 * layer down, exercised here through the actual CLI wrapper for the first
 * time.
 */

let dir: string;
let profilePath: string;
let logPath: string;
let stdout: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-hook-cli-'));
  profilePath = join(dir, 'profile.ps1');
  logPath = join(dir, 'hook.log');
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(chunk.toString());
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('nexusmem hook', () => {
  it('install creates the profile and reports it as newly installed', async () => {
    const code = await runHookInstall({ profile: profilePath, logPath });

    expect(code).toBe(0);
    // Not one 'installed shell hook' substring: pc.green('installed') colors
    // only that word, leaving an ANSI reset code before ' shell hook'.
    expect(stdout.join('')).toContain('installed');
    expect(stdout.join('')).toContain('shell hook');
    expect(stdout.join('')).toContain(profilePath);
    expect(readFileSync(profilePath, 'utf8')).toContain('nexusmem');
  });

  it('install is idempotent: a second run reports already up to date', async () => {
    await runHookInstall({ profile: profilePath, logPath });
    const before = readFileSync(profilePath, 'utf8');
    stdout.length = 0;

    const code = await runHookInstall({ profile: profilePath, logPath });

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('already up to date');
    expect(readFileSync(profilePath, 'utf8')).toBe(before);
  });

  it('status reports not installed before install, installed after', async () => {
    await runHookStatus({ profile: profilePath, logPath });
    expect(stdout.join('')).toContain('not installed');

    stdout.length = 0;
    await runHookInstall({ profile: profilePath, logPath });
    stdout.length = 0;

    await runHookStatus({ profile: profilePath, logPath });
    expect(stdout.join('')).toContain('installed');
    expect(stdout.join('')).not.toContain('not installed');
  });

  it('remove reports nothing to remove when no hook is installed', async () => {
    const code = await runHookRemove({ profile: profilePath, logPath });

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('nothing to remove');
  });

  it('remove strips the hook after install, leaving status not installed again', async () => {
    await runHookInstall({ profile: profilePath, logPath });
    stdout.length = 0;

    const code = await runHookRemove({ profile: profilePath, logPath });
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('removed');

    stdout.length = 0;
    await runHookStatus({ profile: profilePath, logPath });
    expect(stdout.join('')).toContain('not installed');
  });
});

describe.each(['bash', 'zsh'] as const)('nexusmem hook install/remove/status --shell %s', (shell) => {
  it('installs into the explicitly-chosen shell profile regardless of the host platform default', async () => {
    const code = await runHookInstall({ shell, profile: profilePath, logPath });

    expect(code).toBe(0);
    expect(stdout.join('')).toContain(`shell hook (${shell})`);
    expect(readFileSync(profilePath, 'utf8')).toContain('nexusmem');

    stdout.length = 0;
    await runHookStatus({ shell, profile: profilePath, logPath });
    expect(stdout.join('')).toContain('installed');
    expect(stdout.join('')).toContain(shell);
  });

  it('shows the platform caveat note only for bash, never for zsh', async () => {
    await runHookInstall({ shell, profile: profilePath, logPath });
    const out = stdout.join('');
    if (shell === 'bash') {
      expect(out).toContain('.bash_profile');
    } else {
      expect(out).not.toContain('.bash_profile');
    }
  });
});
