import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readOwnVersion } from '../core/version.js';
import { getStatus, listRecentMemory, searchMemory, syncProject } from './tools.js';

/**
 * Local-only, stdio-transport MCP server exposing NexusMem's memory to any
 * MCP-capable client (Claude Desktop, Cursor, Windsurf, ...). No auth layer:
 * a client that can spawn this process already has the same filesystem
 * access the process itself would use.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'nexusmem', version: readOwnVersion() });

  server.registerTool(
    'search_memory',
    {
      title: 'Search remembered project history',
      description:
        'Search a NexusMem-tracked repository\'s remembered history: git commits, code diffs (the patch of each changed file), shell commands, tracked markdown docs, and (if enabled) conversation transcripts and per-session summaries. Returns a token-budgeted, ranked context block -- not raw search results.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the repository root'),
        query: z.string().describe('Free-text question or search terms'),
        budget: z.number().int().positive().optional().describe('Max tokens in the returned context block. Default 2000.'),
        allProjects: z
          .boolean()
          .optional()
          .describe(
            'Search every repository NexusMem has been run in on this machine, not just projectRoot. Use when the answer may live in a different project (a pattern solved elsewhere, a tool that failed the same way before). Each result is tagged with its repository.',
          ),
        asOf: z
          .string()
          .optional()
          .describe(
            'ISO-8601 date/time. Restricts results to nodes recorded at or before this instant -- "what did memory hold as of then", not "what happened then". Omit for the normal, unrestricted read.',
          ),
      },
    },
    async ({ projectRoot, query, budget, allProjects, asOf }) => {
      const result = await searchMemory({ projectRoot, query, budget, allProjects, asOf });
      // The packed context block goes in BOTH fields: clients differ on which
      // one they surface to the model, and a client that prefers
      // structuredContent would otherwise see only the match stats -- the
      // block itself (the tool's entire value) silently dropped.
      return {
        content: [{ type: 'text', text: result.text }],
        structuredContent: {
          text: result.text,
          matched: result.matched,
          bm25Matched: result.bm25Matched,
          vectorMatched: result.vectorMatched,
          tokensUsed: result.tokensUsed,
          tokensBudget: result.tokensBudget,
          projectsSearched: result.projectsSearched,
        } as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'sync_project',
    {
      title: 'Sync remembered history',
      description:
        'Ingest new git, diff, shell, docs and (if enabled) conversation history for a NexusMem-tracked repository into its local database. ' +
        'Pass pruneSource or pruneStaleShell instead to delete a dead source\'s nodes (e.g. the pre-hook shell scrape) rather than syncing -- ' +
        'dry-run unless yes is also true, since this is an irreversible full wipe of that source.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the repository root'),
        pruneSource: z.string().optional().describe('Delete every node from this exact source (e.g. "shell:pwsh") instead of syncing'),
        pruneStaleShell: z
          .boolean()
          .optional()
          .describe('Shortcut for pruneSource on shell:pwsh, shell:bash and shell:zsh at once -- the dead pre-hook scrape sources'),
        yes: z.boolean().optional().describe('Confirms the delete. Without it, pruneSource/pruneStaleShell only report the matching count.'),
      },
    },
    async ({ projectRoot, pruneSource, pruneStaleShell, yes }) => {
      const result = await syncProject({ projectRoot, pruneSource, pruneStaleShell, yes });
      return { content: [{ type: 'text', text: result.summary }] };
    },
  );

  server.registerTool(
    'get_status',
    {
      title: 'Show what is remembered',
      description: 'Report how many nodes NexusMem currently remembers for a repository, broken down by kind and source.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the repository root'),
      },
    },
    async ({ projectRoot }) => {
      const result = await getStatus({ projectRoot });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'list_recent_memory',
    {
      title: 'List recently remembered items',
      description:
        'List the most recently remembered items for a NexusMem-tracked repository -- git commits, code diffs, shell commands, tracked docs, and (if enabled) conversation transcripts and session summaries -- newest first. Chronological, not relevance-ranked: use search_memory instead for a specific question.',
      inputSchema: {
        projectRoot: z.string().describe('Absolute path to the repository root'),
        limit: z.number().int().positive().optional().describe('Max items to return, newest first. Default 20.'),
      },
    },
    async ({ projectRoot, limit }) => {
      const result = await listRecentMemory({ projectRoot, limit });
      return {
        content: [{ type: 'text', text: JSON.stringify(result.items, null, 2) }],
        structuredContent: { items: result.items } as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
