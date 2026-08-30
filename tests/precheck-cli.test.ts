import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/commands/init.js';
import { runPrecheck } from '../src/cli/commands/precheck.js';
import { runSync } from '../src/cli/commands/sync.js';
import { makeNodeId } from '../src/core/ids.js';
import { makeProjectId } from '../src/core/project.js';
import { resolveWorkspace, readConfig, writeConfig } from '../src/config/workspace.js';
import type { MemoryNode } from '../src/core/types.js';
import { MemoryStore } from '../src/store/store.js';
import { gitFixture } from './helpers.js';

/**
 * CLI-level coverage for `nexusmem precheck`: advisory by default (always
 * exits 0), `--strict` turns an unresolved failure into a non-zero exit, and
 * `--files` lets a caller (or a future git hook, WS2b) check exact paths
 * without needing real staged changes.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const REMOTE = 'https://example.com/acme/precheck.git';

function shellNode(projectId: string, id: string, opts: { ts: number; command: string; exitCode: number }): MemoryNode {
  return {
    id: makeNodeId(projectId, 'shell_command', id),
    kind: 'shell_command',
    projectId,
    ts: new Date(opts.ts).toISOString(),
    source: 'shell:pwsh-hook',
    title: `$ ${opts.command}`,
    body: `$ ${opts.command}`,
    files: [],
    signal: 0.3,
    meta: { command: opts.command, cwd: '/repo', exitCode: opts.exitCode, durationMs: 100, tsApprox: false },
  };
}

describe('nexusmem precheck', () => {
  let dir: string;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-precheck-cli-'));
    const g = (...args: string[]) => gitFixture(dir, args, { env: GIT_ENV });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'widget.ts'), 'export const widget = 1;\n');
    g('add', '.');
    g('commit', '-q', '-m', 'chore: initial commit');
    g('remote', 'add', 'origin', REMOTE);

    await runInit({ cwd: dir, force: false, hook: false, enableConversation: false, out: () => {} });
    const ws = resolveWorkspace(dir);
    const config = await readConfig(ws);
    // No hook is installed for this throwaway repo -- disable the shell
    // source so a real sync doesn't scrape this machine's own history
    // (same trick tests/sync-link-failures.test.ts uses).
    await writeConfig(ws, { ...config, sources: { ...config.sources, shell: { ...config.sources.shell, enabled: false } } });
    await runSync({ cwd: dir, full: false, rebuild: false, quiet: true, noEmbed: true });

    projectId = makeProjectId({ root: dir, originUrl: REMOTE });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is advisory by default: exits 0 even with an unresolved failure', async () => {
    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    store.upsertNodes([shellNode(projectId, 'fail', { ts: Date.now() - 60_000, command: 'npm run widget', exitCode: 1 })]);
    store.close();

    const chunks: string[] = [];
    const code = await runPrecheck({ cwd: dir, files: ['widget.ts'], out: (c) => chunks.push(c) });

    expect(code).toBe(0);
    expect(chunks.join('')).toMatch(/commands naming this file failed/);
    expect(chunks.join('')).toMatch(/npm run widget/);
  });

  it('--strict exits 1 when a file has an unresolved failure', async () => {
    const ws = resolveWorkspace(dir);
    const store = MemoryStore.open(ws.dbPath);
    store.upsertNodes([shellNode(projectId, 'fail', { ts: Date.now() - 60_000, command: 'npm run widget', exitCode: 1 })]);
    store.close();

    const code = await runPrecheck({ cwd: dir, files: ['widget.ts'], strict: true, out: () => {} });

    expect(code).toBe(1);
  });

  it('reports no warnings for a file with no matching failures or churn', async () => {
    const chunks: string[] = [];
    const code = await runPrecheck({ cwd: dir, files: ['widget.ts'], out: (c) => chunks.push(c) });

    expect(code).toBe(0);
    expect(chunks.join('')).toMatch(/no warnings/);
  });
});
