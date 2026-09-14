import { relative } from 'node:path';
import { type AgentEvent, agentEventNaturalKey } from '../agent/event.js';
import { makeNodeId } from '../core/ids.js';
import { truncate } from '../core/text.js';
import type { FileTouch, MemoryNode } from '../core/types.js';
import { isUnderRoot } from '../shell/detect.js';
import { scoreShellCommand } from './shell-history.js';

/**
 * Turns agent events into `shell_command` nodes.
 *
 * Deliberately no new node kind and no schema change: a command an agent ran
 * is the same kind of fact as a command a human ran, so failure→fix
 * correlation, precheck and retrieval all keep working untouched. What
 * separates them is `source` (`agent:claude-code`) and the agent fields in
 * `meta`.
 *
 * Edits do not become nodes of their own. They are accumulated per session
 * and attached as the `files` of the next command in that session, because
 * "what did the agent change before this test failed" is the question recall
 * has to answer -- "npm test failed twice" on its own is not a dead end
 * anyone can recognise.
 */

const MAX_TITLE_CHARS = 200;
const DEFAULT_MAX_BODY_CHARS = 1000;

export interface AgentCollectorOptions {
  /** Events outside this repo belong to another project's sync. */
  repoRoot: string;
  maxBodyChars?: number;
}

function toFileTouch(path: string, repoRoot: string): FileTouch {
  const rel = relative(repoRoot, path).replace(/\\/g, '/');
  // An agent edit reports no line counts, and NexusMem never reads the file to invent them.
  return { path: rel, insertions: null, deletions: null, binary: false };
}

function renderBody(event: AgentEvent, files: readonly FileTouch[], maxChars: number): string {
  const parts = [`$ ${event.command ?? ''}`];
  const meta: string[] = [];
  if (event.cwd) meta.push(`cwd: ${event.cwd}`);
  if (event.exitCode !== null) meta.push(`exit: ${event.exitCode}`);
  else if (event.outcome === 'interrupted') meta.push('interrupted');
  if (event.durationMs !== null) meta.push(`duration: ${event.durationMs}ms`);
  meta.push(`agent: ${event.agent}`);
  parts.push('', meta.join('  '));
  if (event.errorSignature) parts.push(`error: ${event.errorSignature}`);
  if (files.length > 0) parts.push(`changed before this ran: ${files.map((f) => f.path).join(', ')}`);
  return truncate(parts.join('\n'), maxChars);
}

export function toAgentMemoryNode(
  event: AgentEvent,
  files: readonly FileTouch[],
  projectId: string,
  opts: AgentCollectorOptions,
): MemoryNode {
  const command = event.command ?? '';
  return {
    id: makeNodeId(projectId, 'shell_command', agentEventNaturalKey(event)),
    kind: 'shell_command',
    projectId,
    ts: event.ts,
    sourceTs: event.ts,
    source: `agent:${event.agent}`,
    title: truncate(command.split(/\r?\n/)[0] ?? command, MAX_TITLE_CHARS),
    body: renderBody(event, files, opts.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS),
    files: [...files],
    // The command text is already redacted; scoring only reads its shape and the exit code.
    signal: scoreShellCommand({
      naturalKey: agentEventNaturalKey(event),
      command,
      ts: event.ts,
      tsApprox: false,
      exitCode: event.exitCode,
      cwd: event.cwd,
      durationMs: event.durationMs,
      shell: event.agent,
    }),
    provenance: 'observed',
    meta: {
      // These keys match the shell collector's, so failure-fix and precheck read agent nodes unchanged.
      command,
      commandHash: event.commandHash,
      // Agent-only: the shell collector has no `cd`-prefix habit to normalize.
      execHash: event.execHash,
      cwd: event.cwd,
      exitCode: event.exitCode,
      durationMs: event.durationMs,
      tsApprox: false,
      sourceTimestamp: event.ts,
      shell: event.agent,
      agent: event.agent,
      agentSessionId: event.sessionId,
      toolUseId: event.eventId,
      outcome: event.outcome,
      captureVia: 'hook',
      ...(event.errorSignature ? { errorSignature: event.errorSignature } : {}),
      ...(event.agentId ? { agentId: event.agentId } : {}),
    },
  };
}

export function collectAgentEvents(
  events: readonly AgentEvent[],
  projectId: string,
  opts: AgentCollectorOptions,
): MemoryNode[] {
  const pendingEdits = new Map<string, FileTouch[]>();
  const nodes: MemoryNode[] = [];

  for (const event of events) {
    if (event.kind === 'edit') {
      if (!event.filePath || !isUnderRoot(event.filePath, opts.repoRoot)) continue;
      const pending = pendingEdits.get(event.sessionId) ?? [];
      const touch = toFileTouch(event.filePath, opts.repoRoot);
      if (!pending.some((f) => f.path === touch.path)) pending.push(touch);
      pendingEdits.set(event.sessionId, pending);
      continue;
    }

    if (!event.command || !event.cwd || !isUnderRoot(event.cwd, opts.repoRoot)) continue;
    const files = pendingEdits.get(event.sessionId) ?? [];
    nodes.push(toAgentMemoryNode(event, files, projectId, opts));
    // Cleared after each command: the next run's edits are a new attempt, not a repeat of this one.
    pendingEdits.delete(event.sessionId);
  }

  return nodes;
}
