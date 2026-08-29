import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScanGithub } from '../src/cli/commands/scan-github.js';
import { GithubUnavailableError, type GithubProvider } from '../src/github/read.js';
import type { RawGithubThread } from '../src/github/types.js';
import { gitFixture } from './helpers.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

let dir: string;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-scan-github-'));
  gitFixture(dir, ['init', '-q', '-b', 'main'], { env: GIT_ENV });

  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(chunk.toString());
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(chunk.toString());
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function addGithubRemote(): void {
  gitFixture(dir, ['remote', 'add', 'origin', 'https://github.com/yaminbkk/NexusMem.git'], { env: GIT_ENV });
}

const fakeThread: RawGithubThread = {
  number: 8,
  type: 'issue',
  title: 'add a small labelled retrieval regression corpus',
  body: 'no compact labelled corpus exists yet',
  author: 'yaminbkk',
  state: 'open',
  merged: false,
  labels: ['help wanted'],
  createdAt: '2026-08-14T11:44:30.000Z',
  updatedAt: '2026-08-29T11:58:35.000Z',
  url: 'https://github.com/yaminbkk/NexusMem/issues/8',
  comments: [],
};

function fakeProvider(threads: RawGithubThread[]): GithubProvider {
  return { listThreads: async () => threads };
}

describe('nexusmem scan-github', () => {
  it('reports no github.com remote when the repo has none', async () => {
    const code = await runScanGithub({ cwd: dir, json: false, minSignal: 0 });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('no github.com remote');
  });

  it('lists threads from an injected provider', async () => {
    addGithubRemote();

    const code = await runScanGithub({ cwd: dir, json: false, minSignal: 0, provider: fakeProvider([fakeThread]) });

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('regression corpus');
    expect(stderr.join('')).toContain('yaminbkk/NexusMem');
  });

  it('reports an unavailable gh CLI as a plain warning, not a crash', async () => {
    addGithubRemote();
    const failing: GithubProvider = {
      listThreads: async () => {
        throw new GithubUnavailableError('gh CLI is not authenticated -- run `gh auth login`', null);
      },
    };

    const code = await runScanGithub({ cwd: dir, json: false, minSignal: 0, provider: failing });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('gh auth login');
  });
});
