/**
 * Entry point Claude Code's PostToolUse / PostToolUseFailure hooks run:
 *
 *   <hook payload on stdin> | node agent-hook.js [--log <path>]
 *
 * Its own small bundle, like the shell recorder, so it starts fast and loads
 * no native dependency. Silent by design: nothing on stdout or stderr, no
 * temp file, so no failure path can echo the payload it received. Any event
 * it cannot handle is dropped. It never exits 2, which is the only code that
 * would block the agent.
 */
import { captureDropStatePath as dropStatePath, recordCaptureDrop } from '../../agent/capture-health.js';
import { appendAgentEvent } from '../../agent/record.js';
import { agentEventLogPath } from '../../agent/paths.js';
import { parseHookPayloadDetailed } from './payload.js';

const MAX_EVENT_BYTES = 1_000_000;

const drop = (): never => process.exit(1);
process.on('uncaughtException', drop);
process.on('unhandledRejection', drop);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > MAX_EVENT_BYTES) {
      // Never parsed, so which hook sent it is unknown; an edit carrying a large file can land here.
      recordCaptureDrop('payload-too-large', 'other', dropStatePath());
      drop();
    }
    chunks.push(chunk as Buffer);
  }
  // Windows PowerShell can prepend a BOM to a redirected stdin; the parser trims it.
  const outcome = parseHookPayloadDetailed(Buffer.concat(chunks).toString('utf8'), new Date().toISOString());
  if (!outcome.ok) {
    // A dropped event leaves no other trace, so record why -- two normalized
    // codes and a timestamp, never the payload or a parser's message.
    recordCaptureDrop(outcome.reason, outcome.family, dropStatePath());
    return drop();
  }
  try {
    await appendAgentEvent(outcome.event, arg('--log') ?? agentEventLogPath());
  } catch {
    recordCaptureDrop('write-failed', outcome.family, dropStatePath());
    return drop();
  }
  process.exit(0);
}

main().catch(drop);
