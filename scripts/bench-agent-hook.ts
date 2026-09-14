import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { hrtime } from 'node:process';
import { join, resolve } from 'node:path';
import { parseHookPayloadDetailed } from '../src/adapters/claude-code/payload.js';
import { appendAgentEvent } from '../src/agent/record.js';
import { redact } from '../src/conversation/redact.js';

/**
 * Measures what the agent hook costs per tool call, before anyone optimizes it.
 *
 * The hook runs in front of the agent, so wall time from spawn to exit is the
 * number that matters. It is reported against a bare-interpreter floor,
 * because an interpreter that takes 25ms to start is not a redaction problem,
 * and the stages inside are timed separately so a future regression can be
 * attributed rather than guessed at.
 *
 *   npm run build && npm run bench:hook [spawnsPerPayload]
 *
 * Payloads carry a fake secret, and the run ends by scanning everything it
 * wrote for that string. Nothing here prints payload contents.
 */

const HOOK = resolve('dist/cli/agent-hook.js');
const SPAWNS = Number(process.argv[2] ?? 120);
// NaN or 0 would run every loop zero times and fail later inside the report with a TypeError.
if (!Number.isInteger(SPAWNS) || SPAWNS < 1) {
  process.stderr.write(`spawnsPerPayload must be a positive integer, got ${JSON.stringify(process.argv[2])}\n`);
  process.exit(2);
}
const MICRO_ITERATIONS = 5000;
/** Enough samples that the tail statistics mean something. */
const P99_MINIMUM = 100;
/** Fake, and never printed: the run asserts it reaches no file NexusMem writes. */
const FAKE_SECRET = 'bench-fake-s3cret-VALUE';

const bashFailure = (errorChars = 60) => ({
  session_id: 'bench',
  cwd: process.cwd(),
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Bash',
  tool_input: { command: `psql postgres://app:${FAKE_SECRET}@db/app`, description: 'connect' },
  tool_use_id: 'toolu_bench_fail',
  error: `Exit code 1\n${'FATAL: password authentication failed. '.repeat(Math.ceil(errorChars / 38)).slice(0, errorChars)}`,
  is_interrupt: false,
  duration_ms: 1200,
});

const PAYLOADS: Array<{ name: string; payload: object }> = [
  {
    name: 'SessionStart (not a capture event)',
    payload: { session_id: 'bench', cwd: process.cwd(), hook_event_name: 'SessionStart', source: 'startup' },
  },
  {
    name: 'Edit (PostToolUse)',
    payload: {
      session_id: 'bench',
      cwd: process.cwd(),
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(process.cwd(), 'src/agent/recall.ts'), old_string: 'a'.repeat(400), new_string: 'b'.repeat(400) },
      tool_use_id: 'toolu_bench_edit',
      duration_ms: 4,
    },
  },
  {
    name: 'Bash success',
    payload: {
      session_id: 'bench',
      cwd: process.cwd(),
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: `psql postgres://app:${FAKE_SECRET}@db/app`, description: 'connect' },
      tool_response: { stdout: 'ok\n'.repeat(50), stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
      tool_use_id: 'toolu_bench_ok',
      duration_ms: 900,
    },
  },
  { name: 'Bash failure', payload: bashFailure() },
  { name: 'Bash failure, 256 KB error', payload: bashFailure(256 * 1024) },
];

interface Stats {
  n: number;
  min: number;
  median: number;
  p95: number;
  p99: number | null;
  max: number;
}

function stats(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))]!;
  return {
    n: sorted.length,
    min: sorted[0] ?? Number.NaN,
    median: at(50),
    p95: at(95),
    p99: sorted.length >= P99_MINIMUM ? at(99) : null,
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

const ms = (value: number): string => (Number.isNaN(value) ? '-' : value < 1 ? `${value.toFixed(3)}ms` : `${value.toFixed(1)}ms`);

function report(label: string, samples: readonly number[]): Stats {
  const s = stats(samples);
  process.stdout.write(
    `${label.padEnd(38)} n=${String(s.n).padStart(5)}  min ${ms(s.min).padStart(9)}  median ${ms(s.median).padStart(9)}  p95 ${ms(
      s.p95,
    ).padStart(9)}  p99 ${(s.p99 === null ? `n<${P99_MINIMUM}` : ms(s.p99)).padStart(9)}  max ${ms(s.max).padStart(9)}\n`,
  );
  return s;
}

function runHook(payload: object, logPath: string): Promise<number> {
  const started = hrtime.bigint();
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [HOOK, '--log', logPath], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    child.on('error', fail);
    child.on('close', () => done(Number(hrtime.bigint() - started) / 1e6));
  });
}

/** Interpreter startup alone, so the hook's own work can be read as the difference. */
function runEmptyNode(): Promise<number> {
  const started = hrtime.bigint();
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    child.on('error', fail);
    child.on('close', () => done(Number(hrtime.bigint() - started) / 1e6));
  });
}

/**
 * Running an empty ES module, which is the second floor: the difference from
 * `-e 0` is what the module loader costs, and whatever remains above this is
 * the hook's own bundle.
 */
function runEmptyModule(path: string): Promise<number> {
  const started = hrtime.bigint();
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [path], { stdio: 'ignore' });
    child.on('error', fail);
    child.on('close', () => done(Number(hrtime.bigint() - started) / 1e6));
  });
}

function timeSync(iterations: number, fn: () => void): number[] {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = hrtime.bigint();
    fn();
    samples.push(Number(hrtime.bigint() - started) / 1e6);
  }
  return samples;
}

/** First spawn against the steady state: cold file cache and no V8 code cache. */
function coldVsWarm(label: string, samples: readonly number[]): void {
  if (samples.length < 20) return;
  const cold = samples[0]!;
  const warm = stats(samples.slice(10)).median;
  const delta = ((cold - warm) / warm) * 100;
  process.stdout.write(
    `  ${label}: first spawn ${ms(cold)} vs warm median ${ms(warm)} -- ${
      Math.abs(delta) < 20 ? 'no material difference' : `${delta > 0 ? '+' : ''}${delta.toFixed(0)}% on the first`
    }\n`,
  );
}

/** Files here are NexusMem-owned; none of them may contain the fake secret. */
function scanForSecret(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const hits: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) hits.push(...scanForSecret(path));
    else if (readFileSync(path).includes(FAKE_SECRET)) hits.push(path);
  }
  return hits;
}

async function main(): Promise<void> {
  if (!existsSync(HOOK)) throw new Error(`build first: ${HOOK} is missing`);
  const dir = mkdtempSync(join(tmpdir(), 'nexusmem-bench-'));
  const logPath = join(dir, 'agent-events.jsonl');
  const now = new Date().toISOString();

  process.stdout.write(
    `\nagent-hook benchmark\n  ${platform()} ${release()} ${arch()}, ${cpus().length} cores, node ${process.version}\n` +
      `  ${SPAWNS} spawns per payload, ${MICRO_ITERATIONS} in-process iterations\n\n`,
  );

  try {
    process.stdout.write('end to end (spawn to exit) -- what the agent waits for\n');
    const baseline: number[] = [];
    for (let i = 0; i < SPAWNS; i += 1) baseline.push(await runEmptyNode());
    report('node -e 0 (interpreter floor)', baseline);

    const emptyModule = join(dir, 'empty.mjs');
    writeFileSync(emptyModule, 'process.exit(0);\n');
    const moduleBaseline: number[] = [];
    for (let i = 0; i < SPAWNS; i += 1) moduleBaseline.push(await runEmptyModule(emptyModule));
    const floor = report('node empty.mjs (module-loader floor)', moduleBaseline);

    const totals = new Map<string, Stats>();
    for (const { name, payload } of PAYLOADS) {
      const samples: number[] = [];
      for (let i = 0; i < SPAWNS; i += 1) samples.push(await runHook(payload, logPath));
      totals.set(name, report(name, samples));
      if (name === 'Bash failure') coldVsWarm(name, samples);
    }

    process.stdout.write('\nthe hook\'s own bundle and I/O (median total minus the module-loader floor)\n');
    for (const [name, total] of totals) {
      process.stdout.write(`  ${name.padEnd(38)} ${ms(total.median - floor.median)}\n`);
    }

    process.stdout.write('\nin process, per event -- stages timed separately\n');
    for (const { name, payload } of PAYLOADS) {
      const raw = JSON.stringify(payload);
      report(`JSON.parse only: ${name}`, timeSync(MICRO_ITERATIONS, () => void JSON.parse(raw)));
      report(`parse + normalize + redact: ${name}`, timeSync(MICRO_ITERATIONS, () => void parseHookPayloadDetailed(raw, now)));
    }

    const failure = bashFailure();
    const command = failure.tool_input.command;
    const bigError = bashFailure(256 * 1024).error;
    report('redact() alone: one command', timeSync(MICRO_ITERATIONS, () => void redact(command)));
    report('redact() alone: 256 KB error', timeSync(Math.max(200, MICRO_ITERATIONS / 25), () => void redact(bigError)));

    const parsed = parseHookPayloadDetailed(JSON.stringify(failure), now);
    if (parsed.ok) {
      const appendSamples: number[] = [];
      for (let i = 0; i < 1000; i += 1) {
        const started = hrtime.bigint();
        await appendAgentEvent(parsed.event, logPath);
        appendSamples.push(Number(hrtime.bigint() - started) / 1e6);
      }
      report('append one line (fs)', appendSamples);
    }

    const leaked = scanForSecret(dir);
    process.stdout.write(
      `\nsecurity: fake secret found in ${leaked.length} of the files this run wrote${leaked.length === 0 ? ' (expected 0)' : ' -- LEAK'}\n\n`,
    );
    if (leaked.length > 0) process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
