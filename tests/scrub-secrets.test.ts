import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScrubSecrets } from '../src/cli/commands/scrub-secrets.js';
import { resolveWorkspace } from '../src/config/workspace.js';
import { makeNodeId, sha256Hex } from '../src/core/ids.js';
import type { MemoryNode } from '../src/core/types.js';
import { readRepoInfo } from '../src/git/repo.js';
import { hookLogPath } from '../src/shell/paths.js';
import { reconcileProjectId } from '../src/store/reconcile.js';
import { EMBEDDING_DIM } from '../src/store/schema.js';
import { scrubDatabase, ScrubBackupError } from '../src/store/scrub.js';
import { MemoryStore } from '../src/store/store.js';
import { FakeEmbeddingProvider } from '../src/vector/embed.js';
import { embedPendingNodes } from '../src/vector/sync.js';
import { gitFixture } from './helpers.js';

/**
 * `scrubDatabase` is the remediation for databases written before the
 * redaction fix. The fixture below is exactly what those versions stored.
 */

const P = 'proj-legacy';
const SECRET = 'my-secret';
const TS = '2026-08-01T10:00:00.000Z';
const RAW_CMD = `export DB_PASSWORD=${SECRET}`;
const HOOK_KEY = `pwsh-hook:${TS}:${sha256Hex(RAW_CMD).slice(0, 12)}`;

function node(o: Partial<MemoryNode> & Pick<MemoryNode, 'id' | 'kind' | 'title' | 'body'>): MemoryNode {
  return { projectId: P, ts: TS, source: 'x', files: [], signal: 0.5, meta: {}, ...o };
}

function legacyNodes(projectId = P): MemoryNode[] {
  return [
    node({
      id: makeNodeId(projectId, 'shell_command', HOOK_KEY),
      projectId,
      kind: 'shell_command',
      source: 'shell:pwsh-hook',
      title: RAW_CMD,
      body: `$ ${RAW_CMD}\n\ncwd: D:/r  exit: 0`,
      meta: { command: RAW_CMD, cwd: 'D:/r', exitCode: 0 },
    }),
    // The old rule already hid this title; only meta.command was left raw.
    node({
      id: 'shell-meta-only',
      projectId,
      kind: 'shell_command',
      source: 'shell:bash',
      title: 'export PASSWORD: [redacted]',
      body: '$ export PASSWORD: [redacted]',
      meta: { command: `export PASSWORD=${SECRET}-long` },
    }),
    node({
      id: 'conv',
      projectId,
      kind: 'conversation_turn',
      source: 'conversation:claude-code',
      title: 'db login',
      body: `Q: why does psql postgres://app:${SECRET}@db/app fail\n\nA: check the host`,
      meta: { heading: `Set OPENAI_API_KEY=${SECRET}`, redactedCount: 0 },
    }),
    node({
      id: 'session',
      projectId,
      kind: 'session_summary',
      source: 'session:claude-code',
      title: 'API debugging',
      body: `Ran curl -H "Authorization: Bearer ${SECRET}-9f8e7d" against the API`,
      meta: { sessionKey: 'claude-code:s1', contentHash: 'abc' },
    }),
    node({
      id: 'diff',
      projectId,
      kind: 'code_diff',
      source: 'git',
      title: 'src/db.ts',
      body: `@@ -1 +1,2 @@\n+const url = "postgres://u:${SECRET}@h/db";\n+const password = process.env.DB_PASSWORD;`,
      meta: { path: 'src/db.ts' },
    }),
    node({ id: 'clean', projectId, kind: 'shell_command', source: 'shell:bash', title: 'npm test', body: '$ npm test', meta: { command: 'npm test' } }),
  ];
}

async function seed(dbPath: string, projectId = P): Promise<void> {
  const store = MemoryStore.open(dbPath);
  store.upsertNodes(legacyNodes(projectId));
  store.raw
    .prepare(
      `INSERT INTO contradiction_checks (candidate_id, against_id, contradicts, reason, model, checked_at) VALUES ('conv', 'session', 1, ?, 'm', 0)`,
    )
    .run(`both mention DB_PASSWORD=${SECRET}`);
  await embedPendingNodes(store, new FakeEmbeddingProvider(EMBEDDING_DIM), projectId);
  store.close();
}

/** Raw bytes of the database file and its WAL -- what an attacker with the file would see. */
function onDisk(path: string, needle: string): boolean {
  return [path, `${path}-wal`].filter(existsSync).some((f) => readFileSync(f).includes(needle));
}

function withStore<T>(dbPath: string, fn: (store: MemoryStore) => T): T {
  const store = MemoryStore.open(dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

const dump = (dbPath: string) =>
  withStore(dbPath, (s) => s.raw.prepare('SELECT id, kind, title, body, meta, signal, trust_state FROM nodes ORDER BY id').all());
const vectorCount = (dbPath: string) => withStore(dbPath, (s) => (s.raw.prepare('SELECT COUNT(*) AS c FROM nodes_vec').get() as { c: number }).c);

describe('scrubDatabase', () => {
  let dir: string;
  let dbPath: string;
  const backups = () => readdirSync(dir).filter((n) => n.includes('.backup-')).sort();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-scrub-'));
    dbPath = join(dir, 'memory.db');
    await seed(dbPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to scrub, and leaves no copy behind, when the backup cannot be protected', async () => {
    const before = readFileSync(dbPath);

    await expect(
      scrubDatabase(dbPath, {
        apply: true,
        protectBackup: () => Promise.reject(new Error('EPERM: operation not permitted')),
      }),
    ).rejects.toThrow(ScrubBackupError);

    // Nothing scrubbed, and the unprotected pre-redaction copy is gone rather than left on disk.
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(backups()).toEqual([]);
  });

  it('names the copy it could neither protect nor remove, so it can be deleted by hand', async () => {
    const before = readFileSync(dbPath);

    const err = await scrubDatabase(dbPath, {
      apply: true,
      protectBackup: () => Promise.reject(new Error('EPERM: chmod refused')),
      removeBackup: () => Promise.reject(new Error('EBUSY: resource busy')),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ScrubBackupError);
    const [left] = backups();
    expect(left).toBeDefined();
    const message = (err as Error).message;
    expect(message).toContain(join(dir, left!));
    expect(message).toContain('EPERM: chmod refused');
    expect(message).toContain('EBUSY: resource busy');
    expect(message).not.toContain(SECRET);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  // Windows has no Unix modes (chmod only toggles read-only), so only POSIX can observe this.
  it.skipIf(process.platform === 'win32')('creates the backup owner-only, before a single page is copied into it', async () => {
    let modeBeforeProtect: number | null = null;
    const r = await scrubDatabase(dbPath, {
      apply: true,
      // Observes the file as db.backup left it, before the chmod would mask a world-readable window.
      protectBackup: async (path) => {
        modeBeforeProtect = statSync(path).mode & 0o777;
      },
    });

    expect(r.backupPath).not.toBeNull();
    expect(modeBeforeProtect).toBe(0o600);
  });

  it('still purges on-disk remnants when re-embedding fails', async () => {
    const failing = {
      id: 'failing-provider',
      dimensions: EMBEDDING_DIM,
      embed: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:11434')),
    };

    const r = await scrubDatabase(dbPath, { apply: true, embeddingProvider: failing as never });

    // The redaction is committed either way; skipping the purge would leave the
    // pre-redaction text in the freelist and WAL.
    expect(r.remnantsPurged).toBe(true);
    expect(onDisk(dbPath, SECRET)).toBe(false);
    expect(r.reembedded).toBe(0);
    expect(r.embeddingsPending).toBe(withStore(dbPath, (store) => store.countNodesNeedingEmbedding(P)));
  });

  it('reports pending embeddings as the database counts them when re-embedding fails with a backlog', async () => {
    withStore(dbPath, (store) =>
      store.upsertNodes(
        [1, 2, 3].map((n) => node({ id: `backlog-${n}`, kind: 'note', source: 'x', title: `note ${n}`, body: `unrelated note ${n}` })),
      ),
    );
    const failing = {
      id: 'failing-provider',
      dimensions: EMBEDDING_DIM,
      embed: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:11434')),
    };

    const r = await scrubDatabase(dbPath, { apply: true, embeddingProvider: failing as never });

    expect(r.embeddingsDropped).toBe(4);
    // Not dropped minus re-embedded: a provider change can invalidate other vectors before it fails.
    expect(r.embeddingsPending).toBe(withStore(dbPath, (store) => store.countNodesNeedingEmbedding(P)));
  });

  it('re-embedding drains the project backlog too, and says so instead of clamping the count', async () => {
    // Three nodes that have nothing to do with the secret and were never embedded.
    withStore(dbPath, (store) =>
      store.upsertNodes(
        [1, 2, 3].map((n) =>
          node({ id: `backlog-${n}`, kind: 'note', source: 'x', title: `note ${n}`, body: `unrelated note ${n}` }),
        ),
      ),
    );

    const r = await scrubDatabase(dbPath, { apply: true, embeddingProvider: new FakeEmbeddingProvider(EMBEDDING_DIM) });

    // Documents today's behaviour rather than endorsing it: the work is the project's
    // whole pending set, not just the rows this run changed.
    expect(r.embeddingsDropped).toBe(4);
    expect(r.reembedded).toBe(7);
    expect(r.embeddingsPending).toBe(0);
  });

  it('control: the seeded legacy database really holds the secret on disk', () => {
    expect(onDisk(dbPath, SECRET)).toBe(true);
  });

  it('dry run counts exactly what would change and writes nothing', async () => {
    const before = readFileSync(dbPath);

    const r = await scrubDatabase(dbPath, { apply: false });

    expect(r.byKind).toEqual({
      shell_command: { scanned: 3, changed: 2 },
      conversation_turn: { scanned: 1, changed: 1 },
      session_summary: { scanned: 1, changed: 1 },
      code_diff: { scanned: 1, changed: 1 },
    });
    expect(r.rowsChanged).toBe(5);
    expect(r.contradictionReasonsChanged).toBe(1);
    expect(r.applied).toBe(false);
    expect(r.backupPath).toBeNull();
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(backups()).toEqual([]);
  });

  it('backs up first, redacts every eligible row in place, and leaves no trace of the secret on disk', async () => {
    const idsBefore = dump(dbPath).map((r) => (r as { id: string }).id);
    const vectorsBefore = vectorCount(dbPath);

    const r = await scrubDatabase(dbPath, { apply: true, now: new Date('2026-09-10T00:00:00Z') });

    expect(r.backupPath).toBe(`${dbPath}.backup-2026-09-10T00-00-00-000Z-pre-scrub-secrets`);
    // What the CLI warns about: the backup is a pre-redaction copy.
    expect(onDisk(r.backupPath!, SECRET)).toBe(true);
    expect(r.rowsChanged).toBe(5);
    expect(r.contradictionReasonsChanged).toBe(1);
    // shell-meta-only changed only in meta, so its vector (built from title/body) stays.
    expect(r.embeddingsDropped).toBe(4);
    expect(r.embeddingsPending).toBe(4);
    expect(r.remnantsPurged).toBe(true);

    const rows = dump(dbPath) as Array<{ id: string; title: string; body: string; meta: string }>;
    expect(rows.map((row) => row.id)).toEqual(idsBefore);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    const byId = new Map(rows.map((row) => [row.id, row]));

    const hookMeta = JSON.parse(byId.get(makeNodeId(P, 'shell_command', HOOK_KEY))!.meta);
    expect(hookMeta).toMatchObject({ command: 'export DB_PASSWORD: [redacted]', commandHash: sha256Hex(RAW_CMD).slice(0, 12), cwd: 'D:/r' });
    expect(JSON.parse(byId.get('shell-meta-only')!.meta).commandHash).toBe(sha256Hex(`export PASSWORD=${SECRET}-long`).slice(0, 12));
    expect(byId.get('diff')!.body).toContain('+const url = "postgres://u:[redacted]@h/db";');
    expect(byId.get('diff')!.body).toContain('+const password = process.env.DB_PASSWORD;');
    expect(JSON.parse(byId.get('conv')!.meta).heading).toBe('Set OPENAI_API_KEY: [redacted]');
    expect(JSON.parse(byId.get('session')!.meta).sessionKey).toBe('claude-code:s1');
    expect(byId.get('clean')!.body).toBe('$ npm test');

    withStore(dbPath, (s) => {
      const reason = s.raw.prepare('SELECT reason FROM contradiction_checks').get() as { reason: string };
      expect(reason.reason).toBe('both mention DB_PASSWORD: [redacted]');
      const fts = (q: string) => (s.raw.prepare('SELECT COUNT(*) AS c FROM nodes_fts WHERE nodes_fts MATCH ?').get(q) as { c: number }).c;
      expect(fts('"my secret"')).toBe(0);
      expect(fts('check')).toBe(1);
    });
    expect(vectorCount(dbPath)).toBe(vectorsBefore - 4);
    expect(onDisk(dbPath, SECRET)).toBe(false);
  });

  it('is idempotent: a second run changes nothing, takes no new backup, and leaves every row identical', async () => {
    await scrubDatabase(dbPath, { apply: true });
    const once = dump(dbPath);
    const backupsOnce = backups();

    const again = await scrubDatabase(dbPath, { apply: true });

    expect(again.rowsChanged).toBe(0);
    expect(again.contradictionReasonsChanged).toBe(0);
    expect(again.backupPath).toBeNull();
    expect(again.embeddingsDropped).toBe(0);
    expect(again.remnantsPurged).toBe(true);
    expect(dump(dbPath)).toEqual(once);
    expect(backups()).toEqual(backupsOnce);
    expect(onDisk(dbPath, SECRET)).toBe(false);
  });

  it('keeps reconcile working: a scrubbed legacy hook row still migrates to the id its raw command derives', async () => {
    await scrubDatabase(dbPath, { apply: true });

    withStore(dbPath, (s) => {
      reconcileProjectId(s.raw, P, 'proj-new');
      const row = s.raw.prepare(`SELECT id FROM nodes WHERE project_id = 'proj-new' AND source = 'shell:pwsh-hook'`).get() as { id: string };
      expect(row.id).toBe(makeNodeId('proj-new', 'shell_command', HOOK_KEY));
    });
  });

  it('re-embeds the redacted nodes when given a provider', async () => {
    const vectorsBefore = vectorCount(dbPath);

    const r = await scrubDatabase(dbPath, { apply: true, embeddingProvider: new FakeEmbeddingProvider(EMBEDDING_DIM) });

    expect(r.embeddingsDropped).toBe(4);
    expect(r.reembedded).toBe(4);
    expect(r.embeddingsPending).toBe(0);
    expect(vectorCount(dbPath)).toBe(vectorsBefore);
  });

  it('lists older backups but never modifies or deletes them', async () => {
    const old = `${dbPath}.backup-2026-08-01-before-upgrade`;
    writeFileSync(old, 'old copy');

    const r = await scrubDatabase(dbPath, { apply: true });

    expect(r.existingBackups).toEqual([old]);
    expect(readFileSync(old, 'utf8')).toBe('old copy');
  });

  it('reports remnants as not purged while another connection holds a read, then purges once it is gone', async () => {
    const other = new Database(dbPath);
    other.exec('BEGIN');
    other.prepare('SELECT COUNT(*) FROM nodes').get();

    const blocked = await scrubDatabase(dbPath, { apply: true });
    expect(blocked.rowsChanged).toBe(5);
    expect(blocked.remnantsPurged).toBe(false);

    other.exec('COMMIT');
    other.close();
    const retried = await scrubDatabase(dbPath, { apply: true });
    expect(retried.rowsChanged).toBe(0);
    expect(retried.remnantsPurged).toBe(true);
    expect(onDisk(dbPath, SECRET)).toBe(false);
  }, 30_000);
});

describe('nexusmem scrub-secrets', () => {
  const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
  let dir: string;
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-scrub-cli-'));
    home = mkdtempSync(join(tmpdir(), 'nexusmem-scrub-cli-home-'));
    gitFixture(dir, ['init', '-q', '-b', 'main'], { env: GIT_ENV });
    prevHome = process.env.NEXUSMEM_HOME;
    process.env.NEXUSMEM_HOME = join(home, 'nm');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.NEXUSMEM_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('dry-runs by default, then backs up, prints the exact backup path with a warning, and redacts the hook log', async () => {
    const dbPath = resolveWorkspace((await readRepoInfo(dir)).root).dbPath;
    await seed(dbPath);
    mkdirSync(dirname(hookLogPath()), { recursive: true });
    const hookRaw = `${JSON.stringify({ ts: TS, cwd: dir, exitCode: 0, durationMs: 1, command: RAW_CMD })}\n`;
    writeFileSync(hookLogPath(), hookRaw);

    const dry: string[] = [];
    expect(await runScrubSecrets({ cwd: dir, allProjects: false, yes: false, embed: false, out: (c) => dry.push(c) })).toBe(0);
    const dryText = stripAnsi(dry.join(''));
    expect(dryText).toContain('1 line(s) to redact');
    expect(dryText).toMatch(/shell_command\s+3 scanned\s+2 to redact/);
    expect(dryText).toContain('Dry run');
    expect(readFileSync(hookLogPath(), 'utf8')).toBe(hookRaw);

    const applied: string[] = [];
    expect(await runScrubSecrets({ cwd: dir, allProjects: false, yes: true, embed: false, out: (c) => applied.push(c) })).toBe(0);
    const text = stripAnsi(applied.join(''));
    const backupPath = /backup {2}(\S+pre-scrub-secrets)/.exec(text)?.[1];
    expect(backupPath).toBeDefined();
    expect(existsSync(backupPath!)).toBe(true);
    expect(text).toContain('WARNING that backup was taken BEFORE redaction');
    expect(text).toContain('WAL truncated');
    expect(readFileSync(hookLogPath(), 'utf8')).not.toContain(SECRET);
    expect(onDisk(dbPath, SECRET)).toBe(false);
  });
});
