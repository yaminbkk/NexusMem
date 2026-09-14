import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The qualitative half of the ambient eval: what each run actually did, read
 * back from the transcripts the harness saved next to its numbers.
 *
 * Prints, per run, the shell commands in order, the files edited in order, and
 * anything NexusMem put into the context. The metrics say whether behaviour
 * differed; this says how.
 *
 *   npx tsx eval/ambient/read-runs.ts <outDir> [scenario] [arm]
 */

const OUT_DIR = resolve(process.argv[2] ?? '');
const ONLY_SCENARIO = process.argv[3];
const ONLY_ARM = process.argv[4];

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

interface Block {
  type?: string;
  name?: string;
  input?: { command?: string; file_path?: string };
  text?: string;
}

function describe(path: string): string[] {
  const lines: string[] = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: { message?: { role?: string; content?: unknown }; attachment?: { type?: string; hookName?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const hook = entry.attachment;
    if (hook?.type?.startsWith('hook') && typeof hook.content === 'string' && hook.content.includes('NexusMem:')) {
      lines.push(`    INJECTED (${hook.hookName ?? '?'}): ${hook.content.replace(/\s+/g, ' ').slice(0, 220)}`);
    }

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Block[]) {
      if (block.type !== 'tool_use') continue;
      const name = String(block.name ?? '');
      if (name === 'Bash') lines.push(`    bash: ${String(block.input?.command ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
      else if (EDIT_TOOLS.has(name)) lines.push(`    EDIT: ${String(block.input?.file_path ?? '').split(/[\\/]/).slice(-2).join('/')}`);
      else if (name.startsWith('mcp__nexusmem__')) lines.push(`    MCP: ${name.replace('mcp__nexusmem__', '')}`);
    }
  }
  return lines;
}

if (!existsSync(OUT_DIR)) throw new Error(`no such directory: ${OUT_DIR}`);
for (const scenario of readdirSync(OUT_DIR).filter((d) => existsSync(join(OUT_DIR, d, 'baseline')))) {
  if (ONLY_SCENARIO && scenario !== ONLY_SCENARIO) continue;
  for (const arm of readdirSync(join(OUT_DIR, scenario))) {
    if (ONLY_ARM && arm !== ONLY_ARM) continue;
    for (const repeat of readdirSync(join(OUT_DIR, scenario, arm))) {
      const path = join(OUT_DIR, scenario, arm, repeat, 'transcript.jsonl');
      process.stdout.write(`\n${scenario} / ${arm} / #${repeat}\n`);
      if (!existsSync(path)) {
        process.stdout.write('    (no transcript)\n');
        continue;
      }
      for (const line of describe(path)) process.stdout.write(`${line}\n`);
    }
  }
}
