import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/mcp/server.js';
import { getStatus, listRecentMemory, listStaleSuggestions, resolveStaleSuggestion, searchMemory, syncProject } from '../src/mcp/tools.js';
import { MemoryStore } from '../src/store/store.js';
import { makeProjectId } from '../src/core/project.js';
import { resolveWorkspace } from '../src/config/workspace.js';
import { gitFixture } from './helpers.js';

const BUILT_CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * These exercise the MCP tool handlers directly (as plain async functions),
 * not through the MCP protocol/transport -- that layer is a thin,
 * SDK-owned wire format the SDK's own tests already cover. What's ours to
 * test is that these wrappers call the right underlying pipeline with the
 * right project scoping.
 */

function initGitRepo(dir: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const g = (...args: string[]) => gitFixture(dir, args, { env });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-q', '-m', 'fix: handle the retry timeout correctly\n\nThe old code retried forever instead of giving up after N attempts.');
}

function denyFetchPreload(dir: string): string {
  const path = join(dir, 'deny-fetch.mjs');
  writeFileSync(
    path,
    [
      'globalThis.fetch = async (input) => {',
      '  const target = typeof input === "string" ? input : input?.url ?? String(input);',
      '  throw new Error(`unexpected network access in stdio MCP test: ${target}`);',
      '};',
      '',
    ].join('\n'),
  );
  return path;
}

async function flushTransportEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function connectStdioClient(repoDir: string, preloadPath: string): Promise<{
  client: Client;
  close: () => Promise<void>;
  protocolErrors: Error[];
  stderr: () => string;
}> {
  const protocolErrors: Error[] = [];
  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUILT_CLI, 'mcp'],
    cwd: repoDir,
    stderr: 'pipe',
    env: {
      NEXUSMEM_HOME: join(repoDir, '.test-home'),
      NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
    },
  });

  transport.onerror = (error) => {
    protocolErrors.push(error);
  };
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const client = new Client({ name: 'stdio-e2e-test', version: '0.0.0' });
  client.onerror = (error) => {
    protocolErrors.push(error);
  };

  await client.connect(transport, { timeout: 10_000 });
  await flushTransportEvents();

  return {
    client,
    protocolErrors,
    stderr: () => stderr,
    close: async () => {
      await client.close();
    },
  };
}

describe('mcp tools', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'nexusmem-mcp-'));
    initGitRepo(repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('sync_project ingests git history and reports it in the summary', async () => {
    const result = await syncProject({ projectRoot: repoDir, noEmbed: true });
    expect(result.summary).toContain('synced');
    expect(result.summary).toContain('1 commit');
  });

  it('get_status reflects what sync_project just ingested', async () => {
    await syncProject({ projectRoot: repoDir, noEmbed: true });
    const status = await getStatus({ projectRoot: repoDir });
    expect(status.total).toBeGreaterThanOrEqual(1);
    expect(status.byKind.git_commit).toBe(1);
    expect(status.sources.some((s) => s.source === 'git')).toBe(true);
  });

  it('search_memory finds a synced commit by keyword, BM25-only when no embedding provider is reachable', async () => {
    await syncProject({ projectRoot: repoDir, noEmbed: true });
    const result = await searchMemory({ projectRoot: repoDir, query: 'retry timeout', noVector: true });
    expect(result.text).toContain('retry timeout');
    expect(result.bm25Matched).toBeGreaterThan(0);
  });

  it('search_memory on an uninitialized project returns no matches instead of throwing', async () => {
    const result = await searchMemory({ projectRoot: repoDir, query: 'anything', noVector: true });
    expect(result.matched).toBe(0);
  });

  it('list_recent_memory reflects a sync, newest first', async () => {
    await syncProject({ projectRoot: repoDir, noEmbed: true });
    writeFileSync(join(repoDir, 'b.txt'), 'x\n');
    gitFixture(repoDir, ['add', '.']);
    gitFixture(repoDir, ['commit', '-q', '-m', 'feat: a second, later commit'], {
      // Explicit, far-future dates rather than relying on wall-clock timing:
      // git commit dates have 1-second resolution, so two commits made
      // back-to-back in a fast test run can tie, making ts_epoch ordering
      // between them undefined instead of actually testing "newest first".
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@example.com',
        GIT_AUTHOR_DATE: '2030-01-01T00:00:00+00:00',
        GIT_COMMITTER_DATE: '2030-01-01T00:00:00+00:00',
      },
    });
    await syncProject({ projectRoot: repoDir, noEmbed: true });

    const result = await listRecentMemory({ projectRoot: repoDir });
    expect(result.items.length).toBeGreaterThanOrEqual(2);
    expect(result.items[0]?.title).toContain('a second, later commit');
  });

  it('list_recent_memory respects limit', async () => {
    await syncProject({ projectRoot: repoDir, noEmbed: true });
    const result = await listRecentMemory({ projectRoot: repoDir, limit: 1 });
    expect(result.items).toHaveLength(1);
  });

  it('list_stale_suggestions surfaces a recorded contradiction, resolve_stale_suggestion accepts it', async () => {
    await syncProject({ projectRoot: repoDir, noEmbed: true });
    const candidateId = (await listRecentMemory({ projectRoot: repoDir })).items[0]!.id;

    writeFileSync(join(repoDir, 'b.txt'), 'x\n');
    gitFixture(repoDir, ['add', '.']);
    gitFixture(repoDir, ['commit', '-q', '-m', 'fix: a newer, superseding commit'], {
      // Explicit, far-future dates: two commits made back-to-back in a fast
      // test run can tie at git's 1-second resolution otherwise, making
      // listRecentMemory's "newest first" order undefined between them --
      // same fix as the "reflects a sync, newest first" case above.
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@example.com',
        GIT_AUTHOR_DATE: '2030-01-01T00:00:00+00:00',
        GIT_COMMITTER_DATE: '2030-01-01T00:00:00+00:00',
      },
    });
    await syncProject({ projectRoot: repoDir, noEmbed: true });
    const againstId = (await listRecentMemory({ projectRoot: repoDir })).items[0]!.id;
    expect(againstId).not.toBe(candidateId);

    const store = MemoryStore.open(resolveWorkspace(repoDir).dbPath);
    try {
      store.recordContradictionCheck({ candidateId, againstId, contradicts: true, reason: 'superseded in test', model: 'test-model' });
    } finally {
      store.close();
    }

    const before = await listStaleSuggestions({ projectRoot: repoDir });
    expect(before.suggestions).toHaveLength(1);
    expect(before.suggestions[0]).toMatchObject({ candidateId, againstId, reason: 'superseded in test' });

    const accepted = await resolveStaleSuggestion({ projectRoot: repoDir, candidateId, action: 'accept', againstId });
    expect(accepted.summary).toContain('marked stale');

    // Accepted -> setSupersedes was written, so the suggestion is no longer "open".
    const after = await listStaleSuggestions({ projectRoot: repoDir });
    expect(after.suggestions).toHaveLength(0);
  });

  it('resolve_stale_suggestion with action "dismiss" silences the suggestion without touching ranking', async () => {
    await syncProject({ projectRoot: repoDir, noEmbed: true });
    const candidateId = (await listRecentMemory({ projectRoot: repoDir })).items[0]!.id;

    writeFileSync(join(repoDir, 'b.txt'), 'x\n');
    gitFixture(repoDir, ['add', '.']);
    gitFixture(repoDir, ['commit', '-q', '-m', 'fix: another superseding commit'], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@example.com',
        GIT_AUTHOR_DATE: '2030-01-01T00:00:00+00:00',
        GIT_COMMITTER_DATE: '2030-01-01T00:00:00+00:00',
      },
    });
    await syncProject({ projectRoot: repoDir, noEmbed: true });
    const againstId = (await listRecentMemory({ projectRoot: repoDir })).items[0]!.id;

    const store = MemoryStore.open(resolveWorkspace(repoDir).dbPath);
    try {
      store.recordContradictionCheck({ candidateId, againstId, contradicts: true, reason: null, model: 'test-model' });
    } finally {
      store.close();
    }

    const dismissed = await resolveStaleSuggestion({ projectRoot: repoDir, candidateId, action: 'dismiss' });
    expect(dismissed.summary).toContain('dismissed');

    const after = await listStaleSuggestions({ projectRoot: repoDir });
    expect(after.suggestions).toHaveLength(0);

    // Dismissing again reports nothing left to dismiss, not a false success.
    const secondDismiss = await resolveStaleSuggestion({ projectRoot: repoDir, candidateId, action: 'dismiss' });
    expect(secondDismiss.summary).toContain('no open contradiction suggestion');
  });

  it('resolve_stale_suggestion rejects "accept" without an againstId', async () => {
    await syncProject({ projectRoot: repoDir, noEmbed: true });
    const candidateId = (await listRecentMemory({ projectRoot: repoDir })).items[0]!.id;

    await expect(resolveStaleSuggestion({ projectRoot: repoDir, candidateId, action: 'accept' })).rejects.toThrow('againstId is required');
  });

  it('scopes tool calls to the correct project via projectRoot, not any implicit cwd', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'nexusmem-mcp-other-'));
    initGitRepo(otherDir);
    writeFileSync(join(otherDir, 'b.txt'), 'x\n');
    gitFixture(otherDir, ['add', '.']);
    gitFixture(otherDir, ['commit', '-q', '-m', 'feat: unrelated other-project change'], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' },
    });

    try {
      await syncProject({ projectRoot: repoDir, noEmbed: true });
      await syncProject({ projectRoot: otherDir, noEmbed: true });

      const statusA = await getStatus({ projectRoot: repoDir });
      const statusB = await getStatus({ projectRoot: otherDir });

      const idA = makeProjectId({ root: repoDir, originUrl: null });
      const idB = makeProjectId({ root: otherDir, originUrl: null });
      expect(idA).not.toBe(idB);
      expect(statusA.byKind.git_commit).toBe(1);
      expect(statusB.byKind.git_commit).toBe(2); // initGitRepo's commit + the extra one above
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  /**
   * `stdout` is not a free-for-all log here -- it is the MCP transport itself.
   *
   * `StdioServerTransport` stores the *stream object*
   * (`server/stdio.js:11  this._stdout = _stdout`, defaulting to
   * `process.stdout`) and resolves `.write` at call time
   * (`server/stdio.js:72  this._stdout.write(json)`). So anything that
   * reassigns `process.stdout.write` also reassigns the transport's outbound
   * path: a JSON-RPC response sent while a sync is in flight is swallowed by
   * the capture buffer, and the SDK sees the patched `return true` as proof it
   * was delivered. Two overlapping syncs additionally leave the restore
   * chain broken, because the second one saves the first one's patch as
   * "the original".
   *
   * Capturing the summary is a legitimate need; taking it from a shared global
   * is not. The invariant is that the tool layer routes output explicitly.
   */
  it('never reassigns process.stdout.write, because stdout is the MCP transport', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'write');
    let current = process.stdout.write;
    let assignments = 0;

    Object.defineProperty(process.stdout, 'write', {
      configurable: true,
      get: () => current,
      // Record, then apply, so today's behavior is unchanged and the test
      // observes rather than breaks it.
      set: (fn) => {
        assignments += 1;
        current = fn;
      },
    });

    let summary: string;
    try {
      summary = (await syncProject({ projectRoot: repoDir, noEmbed: true })).summary;
    } finally {
      if (descriptor) Object.defineProperty(process.stdout, 'write', descriptor);
      else Reflect.deleteProperty(process.stdout, 'write');
    }

    expect(assignments).toBe(0);
    // The capture must keep working -- the point is to change where it reads
    // from, not to give up reporting the sync summary.
    expect(summary).toContain('synced');
  });
});

describe('mcp server result shaping (protocol round trip)', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'nexusmem-mcp-proto-'));
    initGitRepo(repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  /**
   * Regression test for a live failure (2026-08-09): search_memory's packed
   * context block lived only in content[0].text, while structuredContent
   * carried just the match stats. An MCP client that surfaces
   * structuredContent in preference to content (Claude Code does) showed the
   * model `{matched: 38, ...}` and silently dropped the block -- the tool's
   * entire value. The block must therefore be present in BOTH fields.
   */
  it('search_memory exposes the context block in content AND structuredContent', async () => {
    await syncProject({ projectRoot: repoDir, noEmbed: true });

    const server = createServer();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = (await client.callTool({
        name: 'search_memory',
        arguments: { projectRoot: repoDir, query: 'retry timeout' },
      })) as {
        content: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      };

      expect(result.isError).toBeFalsy();

      const contentText = result.content[0]?.text ?? '';
      expect(contentText).toContain('retry timeout');

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent?.text).toBe(contentText);
      expect(result.structuredContent?.matched).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  /**
   * Same shape as the search_memory regression above, for list_recent_memory:
   * `server.ts` wraps it in `structuredContent: { items: result.items }`
   * separately from `content[0].text`, and tests/mcp.test.ts's other
   * list_recent_memory cases call `listRecentMemory` from tools.ts directly --
   * never through the real registered tool, so this specific wrapping had no
   * protocol-level coverage.
   */
  it('list_recent_memory exposes its items in content AND structuredContent', async () => {
    await syncProject({ projectRoot: repoDir, noEmbed: true });

    const server = createServer();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = (await client.callTool({
        name: 'list_recent_memory',
        arguments: { projectRoot: repoDir },
      })) as {
        content: Array<{ type: string; text: string }>;
        structuredContent?: { items?: unknown[] };
        isError?: boolean;
      };

      expect(result.isError).toBeFalsy();

      const parsed = JSON.parse(result.content[0]?.text ?? '[]');
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);

      expect(result.structuredContent?.items).toBeDefined();
      expect(result.structuredContent?.items).toEqual(parsed);
    } finally {
      await client.close();
      await server.close();
    }
  });

  /**
   * Tool descriptions enumerate the sources NexusMem indexes, and that list is
   * the only thing a model reads when deciding whether this tool can answer a
   * question. It had already gone stale: the docs collector shipped in
   * `ce658c6` and is on by default, but both descriptions still advertised
   * only git, shell and conversation -- so a question about project prose
   * looked out of scope for a tool that could in fact answer it.
   *
   * Prose drifts silently in a way code does not, hence this guard.
   */
  it('advertises every source the sync pipeline actually ingests', async () => {
    const server = createServer();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const { tools } = await client.listTools();
      const describing = (name: string) => tools.find((t) => t.name === name)?.description ?? '';

      for (const name of ['search_memory', 'sync_project', 'list_recent_memory']) {
        const description = describing(name).toLowerCase();
        expect(description, `${name} has no description`).not.toBe('');
        for (const source of ['git', 'diff', 'shell', 'docs', 'conversation']) {
          expect(description, `${name} does not mention the ${source} source`).toContain(source);
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('mcp server over real stdio child process', () => {
  let repoDir: string;
  let preloadPath: string;

  // CLI is built once, before any test file runs -- see tests/global-setup.ts.
  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'nexusmem-mcp-stdio-'));
    initGitRepo(repoDir);
    preloadPath = denyFetchPreload(repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('initializes the built CLI over stdio and calls get_status and search_memory', async () => {
    const session = await connectStdioClient(repoDir, preloadPath);

    try {
      expect(session.protocolErrors).toEqual([]);
      expect(session.client.getServerVersion()?.name).toBe('nexusmem');

      const syncResult = (await session.client.callTool(
        { name: 'sync_project', arguments: { projectRoot: repoDir } },
        undefined,
        { timeout: 15_000 },
      )) as ToolTextResult;
      await flushTransportEvents();

      expect(syncResult.isError).toBeFalsy();
      expect(syncResult.content[0]?.type).toBe('text');
      expect(syncResult.content[0]?.text).toContain('synced');
      /**
       * Real finding, not a hypothetical: a live MCP client (the VS Code
       * extension's Output channel) rendered this summary with literal
       * "esc[32m"-style text instead of colored output. `runInit`/`runSync`
       * format their `out` stream with picocolors for terminal display, and
       * picocolors' own source treats `platform === 'win32'` as sufficient
       * evidence of color support on its own -- it never checks
       * `process.stdout.isTTY`. Correct for a real terminal; wrong here,
       * since this process's stdout is the MCP JSON-RPC channel, never a
       * terminal. Must be asserted here, over the real stdio transport, not
       * via a direct `syncProject()` call: `StdioClientTransport` spawns the
       * child with the SDK's own curated env allowlist, not a full
       * `process.env` passthrough, so a `NO_COLOR` set in the *developer's*
       * shell (as it is on this machine) does not reach the spawned server
       * and cannot mask the bug here the way it would in-process.
       */
      expect(syncResult.content[0]?.text).not.toMatch(/\x1b\[/);
      expect(session.protocolErrors, session.stderr()).toEqual([]);

      const statusResult = (await session.client.callTool(
        { name: 'get_status', arguments: { projectRoot: repoDir } },
        undefined,
        { timeout: 10_000 },
      )) as ToolTextResult;
      await flushTransportEvents();

      const status = statusResult.structuredContent as
        | { total?: number; byKind?: Record<string, number> }
        | undefined;
      expect(statusResult.isError).toBeFalsy();
      expect(status?.total).toBeGreaterThanOrEqual(1);
      expect(status?.byKind?.git_commit).toBe(1);
      expect(session.protocolErrors, session.stderr()).toEqual([]);

      const searchResult = (await session.client.callTool(
        {
          name: 'search_memory',
          arguments: { projectRoot: repoDir, query: 'retry timeout', budget: 800 },
        },
        undefined,
        { timeout: 10_000 },
      )) as ToolTextResult;
      await flushTransportEvents();

      const search = searchResult.structuredContent as
        | { text?: string; bm25Matched?: number; vectorMatched?: number }
        | undefined;
      expect(searchResult.isError).toBeFalsy();
      expect(searchResult.content[0]?.type).toBe('text');
      expect(searchResult.content[0]?.text).toContain('retry timeout');
      expect(search?.text).toBe(searchResult.content[0]?.text);
      expect(search?.bm25Matched).toBeGreaterThan(0);
      expect(search?.vectorMatched).toBe(0);
      expect(session.protocolErrors, session.stderr()).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

describe('vector coverage sanity via store (used by search_memory)', () => {
  it('EMBEDDING_DIM-shaped nodes_vec table exists on a freshly opened store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexusmem-mcp-store-'));
    const store = MemoryStore.open(join(dir, 'memory.db'));
    const row = store.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'nodes_vec'").get();
    expect(row).toBeDefined();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
