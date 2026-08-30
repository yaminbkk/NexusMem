import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface ServerOptions {
  /** Executable that starts NexusMem's MCP server, e.g. "nexusmem" or an absolute path to it. */
  command: string;
  /** Args before the trailing "mcp", e.g. a script path when `command` is a bare node binary. Empty for the normal `nexusmem` shim. */
  commandArgs?: string[];
  /** Repository root to scope the call to -- NexusMem scopes every tool call by this, not any implicit cwd. */
  projectRoot: string;
  /** Extra env vars for the spawned server, merged on top of the SDK's fixed inherited allowlist (PATH, APPDATA, ...). */
  env?: Record<string, string>;
}

export interface SearchMemoryOptions extends ServerOptions {
  query: string;
  budget?: number;
}

export interface SearchMemoryResult {
  text: string;
  matched: number;
  bm25Matched: number;
  vectorMatched: number;
  tokensUsed: number;
  tokensBudget: number;
  projectsSearched: string[];
}

export interface ListRecentMemoryOptions extends ServerOptions {
  /** Max items to return, newest first. Default 20 (matches the server's own default). */
  limit?: number;
}

export interface RecentMemoryItem {
  id: string;
  kind: string;
  ts: string;
  source: string;
  title: string;
  signal: number;
}

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Thrown when the connection never completed its initial handshake, so the
 * caller can point at the nexusmem.cliPath setting instead of a raw protocol
 * error.
 *
 * Not just an ENOENT check: on Windows, a missing command doesn't surface as
 * ENOENT here at all. `cross-spawn` (used internally by the SDK's stdio
 * transport) resolves a bare command through `cmd.exe`, which spawns
 * successfully -- so the transport's 'spawn' event fires and `connect()`
 * proceeds to the handshake -- and only then does cmd.exe print "'x' is not
 * recognized..." and exit, which the SDK reports as `McpError -32000
 * Connection closed`. Confirmed by a real failing run against this exact
 * scenario before this class existed, not just reasoned about: any failure
 * before the handshake finishes is treated the same way, since the fix for
 * the user is identical either way.
 */
export class ServerNotFoundError extends Error {
  constructor(public readonly command: string, cause: unknown) {
    super(`Could not start "${command} mcp". Is NexusMem installed and on PATH?`, { cause });
    this.name = 'ServerNotFoundError';
  }
}

/**
 * Spawns `<command> mcp` fresh per call, connects, and hands the client to
 * `fn` -- shared by every tool call so the connect/error-classify/close
 * boilerplate exists once. One-shot rather than a kept-alive connection:
 * simplest correct thing for a command fired every so often from the command
 * palette or sidebar, not a hot path.
 */
async function withServer<T>(options: ServerOptions, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: options.command,
    args: [...(options.commandArgs ?? []), 'mcp'],
    cwd: options.projectRoot,
    env: options.env,
  });

  const client = new Client({ name: 'nexusmem-vscode', version: '0.0.1' });

  let connected = false;
  try {
    await client.connect(transport, { timeout: 10_000 });
    connected = true;
    return await fn(client);
  } catch (error) {
    if (!connected) {
      throw new ServerNotFoundError(options.command, error);
    }
    throw error;
  } finally {
    await client.close();
  }
}

function firstTextContent(result: ToolCallResult): string | undefined {
  return result.content.find((c) => c.type === 'text')?.text;
}

/** The same protocol/server Claude Desktop and Cursor already exercise against this codebase (see the root project's tests/mcp.test.ts). */
export async function searchMemory(options: SearchMemoryOptions): Promise<SearchMemoryResult> {
  return withServer(options, async (client) => {
    const result = (await client.callTool(
      {
        name: 'search_memory',
        arguments: { projectRoot: options.projectRoot, query: options.query, budget: options.budget },
      },
      undefined,
      { timeout: 20_000 },
    )) as ToolCallResult;

    if (result.isError) {
      throw new Error(firstTextContent(result) ?? 'search_memory returned an error');
    }

    const structured = result.structuredContent as Partial<SearchMemoryResult> | undefined;

    return {
      text: structured?.text ?? firstTextContent(result) ?? '',
      matched: structured?.matched ?? 0,
      bm25Matched: structured?.bm25Matched ?? 0,
      vectorMatched: structured?.vectorMatched ?? 0,
      tokensUsed: structured?.tokensUsed ?? 0,
      tokensBudget: structured?.tokensBudget ?? options.budget ?? 2000,
      projectsSearched: structured?.projectsSearched ?? [],
    };
  });
}

/** Chronological, not relevance-ranked: "what has this project remembered lately," no query needed. */
export async function listRecentMemory(options: ListRecentMemoryOptions): Promise<RecentMemoryItem[]> {
  return withServer(options, async (client) => {
    const result = (await client.callTool(
      {
        name: 'list_recent_memory',
        arguments: { projectRoot: options.projectRoot, limit: options.limit },
      },
      undefined,
      { timeout: 15_000 },
    )) as ToolCallResult;

    if (result.isError) {
      throw new Error(firstTextContent(result) ?? 'list_recent_memory returned an error');
    }

    const structured = result.structuredContent as { items?: RecentMemoryItem[] } | undefined;
    return structured?.items ?? [];
  });
}

export interface SyncProjectResult {
  summary: string;
}

/**
 * Ingests new git/diff/shell/docs (and, if enabled, conversation and
 * github.com issue/PR) history and embeds pending nodes -- the same work `nexusmem sync` does from a
 * terminal, just triggered from the editor. `sync_project` has no
 * `structuredContent` (see the root project's src/mcp/server.ts), only a
 * text summary, so this reads `content` directly rather than preferring a
 * structured field that doesn't exist here.
 *
 * A generous 120s tool-call timeout, well above search's 20s: embedding a
 * large first-time corpus genuinely takes a while (measured elsewhere in
 * this project at ~76s for 12.5k nodes), and this is a foreground,
 * user-initiated action with its own progress notification, not a
 * background check that needs to stay snappy.
 */
export interface ListStaleSuggestionsOptions extends ServerOptions {
  /** Max suggestions to return, most recently judged first. Default 50. */
  limit?: number;
}

export interface StaleSuggestion {
  candidateId: string;
  candidateTitle: string;
  againstId: string;
  againstTitle: string;
  reason: string | null;
  checkedAt: number;
}

/** Open contradiction verdicts (from `stale --check-contradictions` or sync's automatic leg) nothing has acted on yet. */
export async function listStaleSuggestions(options: ListStaleSuggestionsOptions): Promise<StaleSuggestion[]> {
  return withServer(options, async (client) => {
    const result = (await client.callTool(
      { name: 'list_stale_suggestions', arguments: { projectRoot: options.projectRoot, limit: options.limit } },
      undefined,
      { timeout: 15_000 },
    )) as ToolCallResult;

    if (result.isError) {
      throw new Error(firstTextContent(result) ?? 'list_stale_suggestions returned an error');
    }

    const structured = result.structuredContent as { suggestions?: StaleSuggestion[] } | undefined;
    return structured?.suggestions ?? [];
  });
}

export interface ResolveStaleSuggestionOptions extends ServerOptions {
  candidateId: string;
  action: 'accept' | 'dismiss';
  /** Required for 'accept', ignored for 'dismiss'. */
  againstId?: string;
}

/** 'accept' writes the supersede link (same effect as `mark-stale`); 'dismiss' silences the suggestion without touching ranking. */
export async function resolveStaleSuggestion(options: ResolveStaleSuggestionOptions): Promise<string> {
  return withServer(options, async (client) => {
    const result = (await client.callTool(
      {
        name: 'resolve_stale_suggestion',
        arguments: { projectRoot: options.projectRoot, candidateId: options.candidateId, action: options.action, againstId: options.againstId },
      },
      undefined,
      { timeout: 15_000 },
    )) as ToolCallResult;

    if (result.isError) {
      throw new Error(firstTextContent(result) ?? 'resolve_stale_suggestion returned an error');
    }

    return firstTextContent(result) ?? '';
  });
}

export async function syncProject(options: ServerOptions): Promise<SyncProjectResult> {
  return withServer(options, async (client) => {
    const result = (await client.callTool(
      { name: 'sync_project', arguments: { projectRoot: options.projectRoot } },
      undefined,
      { timeout: 120_000 },
    )) as ToolCallResult;

    if (result.isError) {
      throw new Error(firstTextContent(result) ?? 'sync_project returned an error');
    }

    return { summary: firstTextContent(result) ?? '' };
  });
}
