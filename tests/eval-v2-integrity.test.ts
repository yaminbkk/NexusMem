import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawAgentEvent } from '../src/agent/event.js';
import {
  canonical,
  canonicalEventPath,
  FINGERPRINT_EPOCH,
  PLACEHOLDER_ROOT,
  shapeWithEvents,
} from '../eval/ambient-v2/fingerprint.js';
import { checkDistinctWorkspaces, isWithin, pathKey } from '../eval/ambient-v2/isolation.js';
import { V2_SCENARIOS, type V2Scenario } from '../eval/ambient-v2/scenario.js';
import { names } from '../eval/ambient-v2/scorer.js';
import { changedFiles, parseChangedFiles } from '../eval/ambient-v2/workspace.js';

/**
 * Regression coverage for the five findings on 71b31f3. Every vector below
 * is written out explicitly rather than produced by the host it runs on, so
 * a Windows runner and a POSIX runner check the same thing.
 */

// --- F1: the fingerprint must not depend on the host ----------------------

/** The same event log, spelled the way a given host's `join` would spell it. */
function spelledBy(impl: typeof win32 | typeof posix, events: readonly RawAgentEvent[]): RawAgentEvent[] {
  return events.map((e) => {
    if (!e.filePath) return e;
    // The part under the placeholder root, recovered without the code under test.
    const rel = e.filePath.split(/[\\/]/).slice(3).join('/');
    return { ...e, filePath: impl.join(PLACEHOLDER_ROOT, ...rel.split('/')) };
  });
}

const hostShape = (scenario: V2Scenario, impl: typeof win32 | typeof posix): string =>
  canonical(shapeWithEvents(scenario, spelledBy(impl, scenario.events(PLACEHOLDER_ROOT, FINGERPRINT_EPOCH))));

describe('F1 cross-platform fingerprint', () => {
  it('spells one event path the same way from either host', () => {
    const windows = '\\eval\\app\\config\\defaults.json';
    const posixPath = '/eval/app/config/defaults.json';
    expect(windows).not.toBe(posixPath);
    expect(canonicalEventPath(windows)).toBe('<root>/config/defaults.json');
    expect(canonicalEventPath(posixPath)).toBe('<root>/config/defaults.json');
    expect(canonicalEventPath('\\eval\\app')).toBe('<root>');
  });

  it('gives every scenario one shape whether Windows or POSIX generated its events', () => {
    for (const scenario of V2_SCENARIOS) {
      const windows = spelledBy(win32, scenario.events(PLACEHOLDER_ROOT, FINGERPRINT_EPOCH));
      const posixEvents = spelledBy(posix, scenario.events(PLACEHOLDER_ROOT, FINGERPRINT_EPOCH));
      // The inputs really do differ, or this proves nothing.
      expect(JSON.stringify(windows)).not.toBe(JSON.stringify(posixEvents));
      expect(hostShape(scenario, win32), scenario.name).toBe(hostShape(scenario, posix));
    }
  });

  it('does not merge paths that could mean different things', () => {
    // Case, a drive, a UNC share, Git Bash and WSL spellings, a sibling root.
    expect(canonicalEventPath('/eval/app/Config/x.json')).not.toBe(canonicalEventPath('/eval/app/config/x.json'));
    expect(canonicalEventPath('C:\\eval\\app\\x.json')).toBe('C:/eval/app/x.json');
    expect(canonicalEventPath('\\\\server\\share\\x.json')).toBe('//server/share/x.json');
    expect(canonicalEventPath('\\\\server\\share\\x.json')).not.toBe(canonicalEventPath('/server/share/x.json'));
    expect(canonicalEventPath('/c/eval/app/x.json')).toBe('/c/eval/app/x.json');
    expect(canonicalEventPath('/mnt/c/eval/app/x.json')).toBe('/mnt/c/eval/app/x.json');
    expect(canonicalEventPath('/eval/app2/x.json')).toBe('/eval/app2/x.json');
  });

  it('still moves when the experiment moves', () => {
    const base = V2_SCENARIOS[0]!;
    const shape = (s: V2Scenario, events = s.events(PLACEHOLDER_ROOT, FINGERPRINT_EPOCH)) => canonical(shapeWithEvents(s, events));
    const original = shape(base);
    const variants: Array<[string, string]> = [
      ['task prompt', shape({ ...base, task: `${base.task} ` })],
      ['seeded command', shape({ ...base, command: 'node check.js --strict' })],
      ['dead-end file', shape({ ...base, deadEnds: [{ ...base.deadEnds[0]!, file: 'config/other.json' }, ...base.deadEnds.slice(1)] })],
      ['history content', shape({ ...base, history: base.history.map((c, i) => (i === 1 ? { ...c, message: `${c.message}.` } : c)) })],
      [
        'seeded event file',
        shape(
          base,
          base.events(PLACEHOLDER_ROOT, FINGERPRINT_EPOCH).map((e, i) => (i === 0 ? { ...e, filePath: `${PLACEHOLDER_ROOT}/config/other.json` } : e)),
        ),
      ],
    ];
    for (const [what, changed] of variants) expect(changed, what).not.toBe(original);
  });
});

// --- F2: path identity per platform ---------------------------------------

describe('F2 isolation path identity', () => {
  it('folds case on Windows only', () => {
    expect(pathKey('C:\\Temp\\Repo', 'win32')).toBe(pathKey('c:\\temp\\repo', 'win32'));
    expect(pathKey('/tmp/Repo', 'linux')).not.toBe(pathKey('/tmp/repo', 'linux'));
    expect(pathKey('/tmp/Repo', 'darwin')).not.toBe(pathKey('/tmp/repo', 'darwin'));
  });

  it('contains on whole path components', () => {
    expect(isWithin('/tmp/app', '/tmp/app/nmhome', 'linux')).toBe(true);
    expect(isWithin('/tmp/app', '/tmp/app', 'linux')).toBe(true);
    expect(isWithin('/tmp/app', '/tmp/app2', 'linux')).toBe(false);
    expect(isWithin('/tmp/App', '/tmp/app/nmhome', 'linux')).toBe(false);
    expect(isWithin('C:\\Temp\\App', 'c:\\temp\\app\\nmhome', 'win32')).toBe(true);
    expect(isWithin('C:\\Temp\\App', 'C:\\Temp\\App2', 'win32')).toBe(false);
  });

  it('treats two workspaces as one only where the filesystem would', () => {
    expect(checkDistinctWorkspaces(['/tmp/Repo', '/tmp/repo'], 'linux')).toEqual([]);
    expect(checkDistinctWorkspaces(['C:\\Temp\\Repo', 'c:\\temp\\repo'], 'win32')).toHaveLength(1);
  });
});

// --- F4: every change a run made, including new files ---------------------

describe('F4 changed-file accounting', () => {
  it('parses tracked changes, deletions, renames and untracked files, and drops harness state', () => {
    const porcelain = [
      ' M src/a.js',
      '?? config/zz.json',
      ' D old.js',
      'R  new.js',
      'orig.js',
      '?? .nexusmem/memory.db',
      '?? .claude/settings.local.json',
      '',
    ].join('\0');
    expect(parseChangedFiles(porcelain)).toEqual(['config/zz.json', 'new.js', 'old.js', 'orig.js', 'src/a.js']);
  });

  it('keeps a POSIX backslash as part of the name, so it is neither merged nor mistaken for harness state', () => {
    const porcelain = ['?? a\\b', '?? a/b', '?? .git\\file', ''].join('\0');
    expect(parseChangedFiles(porcelain, 'linux')).toEqual(['.git\\file', 'a/b', 'a\\b']);
    expect(parseChangedFiles(porcelain, 'win32')).toEqual(['a/b']);
  });

  it('sees a newly created solution file that git diff alone misses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexusmem-v2-changed-'));
    try {
      V2_SCENARIOS[0]!.build(dir);
      writeFileSync(join(dir, 'config', 'zz.json'), '{ "retentionDays": 30 }\n');
      writeFileSync(join(dir, 'config', 'site.json'), '{}\n');
      unlinkSync(join(dir, 'docs', 'operations.md'));
      mkdirSync(join(dir, '.nexusmem'), { recursive: true });
      writeFileSync(join(dir, '.nexusmem', 'memory.db'), 'x');
      mkdirSync(join(dir, '.claude'), { recursive: true });
      writeFileSync(join(dir, '.claude', 'settings.local.json'), '{}');

      const oldWay = execFileSync('git', ['-C', dir, 'diff', '--name-only', 'HEAD'], { encoding: 'utf8' });
      expect(oldWay).not.toContain('config/zz.json');

      expect(changedFiles(dir)).toEqual(['config/site.json', 'config/zz.json', 'docs/operations.md']);
    } finally {
      // ENOTEMPTY on rmdir('.git') is a real, git-specific cleanup race, not a
      // correctness bug: this only happens to git-initialised temp dirs, never
      // to the git-free fixtures elsewhere in this file. Same treatment as
      // tests/eval-v2-contamination.test.ts's own workspace cleanup.
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });
});

// --- F5: naming a file means naming exactly that file ---------------------

describe('F5 causal file matching', () => {
  const file = 'config/site.json';

  it('matches the exact repo-relative path recall prints', () => {
    const recall = [
      'NexusMem: this exact command has failed in this repository before (2 time(s)).',
      '- 2026-09-14: failed after editing src/retention.js',
      '- 2026-09-14: failed after editing config/defaults.json',
      '- fixed on 2026-09-14 after editing config/site.json',
    ].join('\n');
    expect(names(recall, file)).toBe(true);
    expect(names(recall, 'src/paging.js')).toBe(false);
    expect(names('fixed after editing config/site.json.', file)).toBe(true);
    expect(names('fixed after editing config/site.json, src/a.js', file)).toBe(true);
  });

  it('never matches a longer name that merely contains it', () => {
    expect(names('after editing config/website.json', file)).toBe(false);
    expect(names('after editing website.json', file)).toBe(false);
    expect(names('after editing config/site.json.bak', file)).toBe(false);
  });

  it('never matches the same basename in another directory when the directory is given', () => {
    expect(names('after editing other/site.json', file)).toBe(false);
  });

  it('matches a bare basename only when the text gives nothing more', () => {
    expect(names('touched site.json only', file)).toBe(true);
  });

  it('accepts an absolute spelling that ends in the path on a component boundary', () => {
    expect(names('edited /work/app/config/site.json', file)).toBe(true);
    expect(names('edited C:\\work\\app\\config\\site.json', file)).toBe(true);
    expect(names('edited /work/app/other/site.json', file)).toBe(false);
  });
});
