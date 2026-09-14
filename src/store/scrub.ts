import { chmod, open, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { redact, type RedactProfile } from '../conversation/redact.js';
import { sha256Hex } from '../core/ids.js';
import type { EmbeddingProvider } from '../vector/embed.js';
import { embedPendingNodes } from '../vector/sync.js';
import { MemoryStore } from './store.js';

/**
 * Re-applies today's redaction to rows older versions already stored -- the
 * remediation for secrets that reached `memory.db` before the key/value rule
 * and shell `meta.command` were fixed. Each kind gets exactly the profile its
 * collector applies at ingest, so this never redacts more than a fresh sync
 * would. Rows are updated in place: ids, links, trust state and reconcile
 * keys are untouched.
 */
const KIND_PROFILES = {
  shell_command: 'all',
  conversation_turn: 'all',
  session_summary: 'all',
  code_diff: 'high-confidence',
} as const satisfies Record<string, RedactProfile>;

export type ScrubKind = keyof typeof KIND_PROFILES;
export const SCRUB_KINDS = Object.keys(KIND_PROFILES) as ScrubKind[];

interface RowChange {
  rowid: number;
  title: string;
  body: string;
  meta: string;
  textChanged: boolean;
}

interface Plan {
  byKind: Record<ScrubKind, { scanned: number; changed: number }>;
  rows: RowChange[];
  reasons: Array<{ rowid: number; reason: string }>;
}

export interface ScrubReport {
  dbPath: string;
  applied: boolean;
  byKind: Plan['byKind'];
  rowsChanged: number;
  contradictionReasonsChanged: number;
  embeddingsDropped: number;
  reembedded: number;
  /**
   * Nodes in the touched projects still without a vector; the next `sync` embeds them.
   * Not clamped to the rows this run changed: re-embedding drains whatever the project
   * already owed, so both this and `reembedded` can exceed `embeddingsDropped`.
   */
  embeddingsPending: number;
  /** Written only when rows actually change. It is a pre-redaction copy. */
  backupPath: string | null;
  /** `<db>.backup-*` files already present -- older copies that may still hold secrets. Never touched. */
  existingBackups: string[];
  /** FTS rebuilt, VACUUM done and WAL truncated. False when another open connection blocked that. Null on a dry run. */
  remnantsPurged: boolean | null;
}

export interface ScrubOptions {
  apply: boolean;
  /** Re-embeds the redacted nodes right away; null leaves that to the next sync. */
  embeddingProvider?: EmbeddingProvider | null;
  now?: Date;
  /**
   * Restricts the backup's permissions. Injectable only so the failure path can
   * be tested; production always uses chmod.
   */
  protectBackup?: (path: string) => Promise<void>;
  /** Removes an unprotectable backup. Injectable for the same reason; production uses rm. */
  removeBackup?: (path: string) => Promise<void>;
}

export class ScrubRaceError extends Error {}

/** The pre-redaction copy could not be protected, so nothing was scrubbed. */
export class ScrubBackupError extends Error {}

function scrubMeta(kind: ScrubKind, raw: string): string {
  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch {
    return redact(raw, KIND_PROFILES[kind]).text;
  }
  if (typeof meta !== 'object' || meta === null) return raw;
  const m = meta as Record<string, unknown>;

  let changed = false;
  if (kind === 'shell_command' && typeof m.command === 'string') {
    const command = redact(m.command).text;
    if (command !== m.command) {
      // Hash the raw command while it still exists: reconcile.ts recomputes hook node ids from it.
      if (typeof m.commandHash !== 'string') m.commandHash = sha256Hex(m.command).slice(0, 12);
      m.command = command;
      changed = true;
    }
  }
  if (kind === 'conversation_turn' && typeof m.heading === 'string') {
    const heading = redact(m.heading).text;
    if (heading !== m.heading) {
      m.heading = heading;
      changed = true;
    }
  }
  return changed ? JSON.stringify(m) : raw;
}

function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function plan(db: Database.Database): Plan {
  const byKind = Object.fromEntries(SCRUB_KINDS.map((k) => [k, { scanned: 0, changed: 0 }])) as Plan['byKind'];
  const rows: RowChange[] = [];

  const select = db.prepare(
    `SELECT rowid, kind, title, body, meta FROM nodes WHERE kind IN (${SCRUB_KINDS.map(() => '?').join(', ')})`,
  );
  for (const row of select.iterate(...SCRUB_KINDS) as Iterable<{
    rowid: number;
    kind: ScrubKind;
    title: string;
    body: string;
    meta: string;
  }>) {
    const profile = KIND_PROFILES[row.kind];
    const title = redact(row.title, profile).text;
    const body = redact(row.body, profile).text;
    const meta = scrubMeta(row.kind, row.meta);
    byKind[row.kind].scanned += 1;
    if (title === row.title && body === row.body && meta === row.meta) continue;
    byKind[row.kind].changed += 1;
    rows.push({ rowid: row.rowid, title, body, meta, textChanged: title !== row.title || body !== row.body });
  }

  // A contradiction verdict's reason is model output that can quote either node verbatim.
  const reasons: Plan['reasons'] = [];
  if (hasTable(db, 'contradiction_checks')) {
    const select = db.prepare('SELECT rowid, reason FROM contradiction_checks WHERE reason IS NOT NULL');
    for (const r of select.iterate() as Iterable<{ rowid: number; reason: string }>) {
      const reason = redact(r.reason).text;
      if (reason !== r.reason) reasons.push({ rowid: r.rowid, reason });
    }
  }

  return { byKind, rows, reasons };
}

async function listBackups(dbPath: string): Promise<string[]> {
  const prefix = `${basename(dbPath)}.backup-`;
  try {
    return (await readdir(dirname(dbPath)))
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => join(dirname(dbPath), name));
  } catch {
    return [];
  }
}

/**
 * Old text survives an UPDATE in three places the rows no longer show: FTS5
 * segments (deleted terms linger until a merge), freed SQLite pages, and
 * stale frames past the live end of the WAL. Rebuild the index, VACUUM, then
 * truncate the WAL to zero bytes. Runs even when no row changed, since an
 * earlier sync may already have rewritten a leaked row and left exactly these
 * remnants behind.
 */
function purgeRemnants(db: Database.Database): boolean {
  db.exec(`INSERT INTO nodes_fts (nodes_fts) VALUES ('rebuild')`);
  try {
    db.exec('VACUUM');
  } catch (err) {
    // Another connection mid-read (MCP server, VS Code extension) blocks VACUUM; the redaction itself is already committed.
    if (String((err as { code?: unknown }).code ?? '').startsWith('SQLITE_BUSY')) return false;
    throw err;
  }
  const [checkpoint] = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
  return checkpoint?.busy === 0;
}

export async function scrubDatabase(dbPath: string, opts: ScrubOptions): Promise<ScrubReport> {
  const existingBackups = await listBackups(dbPath);
  const base = { dbPath, existingBackups, embeddingsDropped: 0, reembedded: 0, embeddingsPending: 0 };

  if (!opts.apply) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const p = plan(db);
      return {
        ...base,
        applied: false,
        byKind: p.byKind,
        rowsChanged: p.rows.length,
        contradictionReasonsChanged: p.reasons.length,
        backupPath: null,
        remnantsPurged: null,
      };
    } finally {
      db.close();
    }
  }

  const store = MemoryStore.open(dbPath);
  const db = store.raw;
  try {
    let backupPath: string | null = null;
    const first = plan(db);
    if (first.rows.length + first.reasons.length > 0) {
      const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
      backupPath = `${dbPath}.backup-${stamp}-pre-scrub-secrets`;
      // SQLite creates a new backup file 0644 under a usual umask, readable by others until the
      // chmod below. An existing file keeps its mode, so create it owner-only first; `wx` also
      // refuses to write the copy through anything already at that path.
      await (await open(backupPath, 'wx', 0o600)).close();
      await db.backup(backupPath);
      // The backup holds every secret this run is about to remove. If it cannot be
      // restricted, stop before touching the database: leaving an unprotected copy
      // behind is worse than not scrubbing yet. (On Windows chmod only clears the
      // read-only bit; it is not an ACL, so this is a floor, not a guarantee.)
      try {
        await (opts.protectBackup ?? ((path: string) => chmod(path, 0o600)))(backupPath);
      } catch (err) {
        const protectMessage = (err as Error).message;
        try {
          await (opts.removeBackup ?? ((path: string) => rm(path, { force: true })))(backupPath);
        } catch (cleanupErr) {
          // The unprotected copy is still on disk: say exactly where, so it can be deleted by hand.
          throw new ScrubBackupError(
            `could not restrict permissions on the backup (${protectMessage}) nor remove it ` +
              `(${(cleanupErr as Error).message}) -- nothing was scrubbed, but ${backupPath} still holds the ` +
              'unredacted data; delete it',
          );
        }
        throw new ScrubBackupError(`could not restrict permissions on the backup (${protectMessage}) -- nothing was scrubbed`);
      }
    }

    const updateNode = db.prepare('UPDATE nodes SET title = ?, body = ?, meta = ? WHERE rowid = ?');
    const dropVector = db.prepare('DELETE FROM nodes_vec WHERE rowid = ?');
    const updateReason = db.prepare('UPDATE contradiction_checks SET reason = ? WHERE rowid = ?');
    // Re-planned inside the write transaction so nothing written during the backup is missed or overwritten.
    const { applied, dropped } = db.transaction(() => {
      const p = plan(db);
      if (!backupPath && p.rows.length + p.reasons.length > 0) {
        throw new ScrubRaceError('the database changed while it was being scrubbed -- nothing was modified; re-run');
      }
      let dropped = 0;
      for (const c of p.rows) {
        updateNode.run(c.title, c.body, c.meta, c.rowid);
        if (c.textChanged) dropped += dropVector.run(BigInt(c.rowid)).changes;
      }
      for (const r of p.reasons) updateReason.run(r.reason, r.rowid);
      return { applied: p, dropped };
    })();

    let reembedded = 0;
    let pending = dropped;
    if (opts.embeddingProvider && dropped > 0) {
      const changedRowids = applied.rows.filter((c) => c.textChanged).map((c) => c.rowid);
      const projects = db
        .prepare(`SELECT DISTINCT project_id AS p FROM nodes WHERE rowid IN (${changedRowids.map(() => '?').join(', ')})`)
        .all(...changedRowids) as Array<{ p: string }>;
      pending = 0;
      try {
        for (const { p } of projects) {
          const r = await embedPendingNodes(store, opts.embeddingProvider, p);
          reembedded += r.embedded;
          pending += r.remaining;
        }
      } catch {
        // Re-embedding is best effort -- an unreachable Ollama is the normal case, and the
        // next sync picks it up. What must not be skipped is the purge below: the redaction
        // is already committed, and its pre-redaction text is still in the freelist and WAL
        // until VACUUM and the checkpoint run. Pending is recounted, not derived: earlier
        // projects' backlog and any vectors the attempt invalidated are only known to the database.
        pending = projects.reduce((sum, { p }) => sum + store.countNodesNeedingEmbedding(p), 0);
      }
    }

    const remnantsPurged = purgeRemnants(db);
    return {
      ...base,
      applied: true,
      byKind: applied.byKind,
      rowsChanged: applied.rows.length,
      contradictionReasonsChanged: applied.reasons.length,
      embeddingsDropped: dropped,
      reembedded,
      // Reported as measured: clamping this to the rows scrub changed made a project with
      // an embedding backlog look finished when it was not.
      embeddingsPending: pending,
      backupPath,
      remnantsPurged,
    };
  } finally {
    store.close();
  }
}
