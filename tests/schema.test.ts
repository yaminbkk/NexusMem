import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentSchemaVersion, EMBEDDING_DIM, migrate, MIGRATIONS } from '../src/store/schema.js';

/**
 * Every other test reaches schema V6 by opening a brand-new, empty database,
 * which never actually exercises V6's `UPDATE nodes SET provenance = ...`
 * backfill against a real, already-populated table -- the WHERE-by-kind
 * clause runs against zero rows every time. This replays the real V1..V5
 * migration SQL (from `schema.ts` itself, not retyped) against a fresh db,
 * seeds rows shaped like a genuine pre-V6 database (no provenance/supersedes
 * columns exist yet), then runs the real `migrate()` for the 5->6 step under
 * test -- the same upgrade path an actual user's on-disk database takes.
 */
describe('migrate (V5 -> V6 provenance backfill against real pre-existing data)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexusmem-schema-'));
    dbPath = join(dir, 'memory.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('backfills provenance by kind and leaves existing columns untouched', () => {
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    sqliteVec.load(db);

    for (const m of MIGRATIONS) {
      if (m.version > 5) continue;
      db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    }
    expect(currentSchemaVersion(db)).toBe(5);

    const insert = db.prepare(`
      INSERT INTO nodes (id, kind, project_id, ts, ts_epoch, source, title, body, signal, meta, created_at)
      VALUES (@id, @kind, @project_id, @ts, @ts_epoch, @source, @title, @body, @signal, @meta, @created_at)
    `);
    const base = {
      project_id: 'proj-a',
      ts: '2026-01-01T00:00:00+00:00',
      ts_epoch: 1,
      source: 'git',
      title: 'real pre-V6 title',
      body: 'real pre-V6 body',
      signal: 0.5,
      meta: '{}',
      created_at: 1,
    };
    insert.run({ ...base, id: 'n-git', kind: 'git_commit' });
    insert.run({ ...base, id: 'n-diff', kind: 'code_diff' });
    insert.run({ ...base, id: 'n-shell', kind: 'shell_command' });
    insert.run({ ...base, id: 'n-conv', kind: 'conversation_turn' });
    insert.run({ ...base, id: 'n-summary', kind: 'session_summary' });
    insert.run({ ...base, id: 'n-doc', kind: 'doc_section' });

    // Replay only step 6 (not `migrate()`, which would run V7's re-backfill
    // on top and hide what V6 itself wrote) -- V6's own output is the claim.
    const v6 = MIGRATIONS.find((m) => m.version === 6)!;
    db.transaction(() => {
      v6.up(db);
      db.pragma('user_version = 6');
    })();
    expect(currentSchemaVersion(db)).toBe(6);

    const rows = db
      .prepare('SELECT id, kind, provenance, supersedes, title, body, signal FROM nodes ORDER BY id')
      .all() as Array<{ id: string; kind: string; provenance: string; supersedes: string | null; title: string; body: string; signal: number }>;

    const provenanceByKind = Object.fromEntries(rows.map((r) => [r.kind, r.provenance]));
    expect(provenanceByKind).toEqual({
      git_commit: 'observed',
      code_diff: 'observed',
      shell_command: 'observed',
      conversation_turn: 'inferred',
      session_summary: 'inferred',
      doc_section: 'inferred',
    });

    for (const row of rows) {
      expect(row.supersedes).toBeNull();
      expect(row.title).toBe('real pre-V6 title');
      expect(row.body).toBe('real pre-V6 body');
      expect(row.signal).toBe(0.5);
    }

    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'nodes'`).all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_nodes_supersedes');

    db.close();
  });

  it('widens 2-tier provenance to 4 tiers on a real, already-backfilled V6 database (V6 -> V7)', () => {
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    sqliteVec.load(db);

    for (const m of MIGRATIONS) {
      if (m.version > 6) continue;
      db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    }
    expect(currentSchemaVersion(db)).toBe(6);

    // Seeded *after* V6 ran, so every row carries the exact 2-tier values a
    // real upgrading user's database holds: observed by kind, else inferred.
    const insert = db.prepare(`
      INSERT INTO nodes (id, kind, project_id, ts, ts_epoch, source, title, body, signal, meta, provenance, created_at)
      VALUES (@id, @kind, 'proj-a', '2026-01-01T00:00:00+00:00', 1, 'git', 't', 'b', 0.5, '{}', @provenance, 1)
    `);
    insert.run({ id: 'n-git', kind: 'git_commit', provenance: 'observed' });
    insert.run({ id: 'n-conv', kind: 'conversation_turn', provenance: 'inferred' });
    insert.run({ id: 'n-summary', kind: 'session_summary', provenance: 'inferred' });
    insert.run({ id: 'n-doc', kind: 'doc_section', provenance: 'inferred' });
    insert.run({ id: 'n-note', kind: 'note', provenance: 'inferred' });
    // Unknown kind still marked inferred -- the catch-all's target.
    insert.run({ id: 'n-mystery', kind: 'mystery', provenance: 'inferred' });

    const result = migrate(db);
    expect(result.from).toBe(6);
    expect(result.to).toBeGreaterThanOrEqual(7);

    const rows = db.prepare('SELECT id, provenance FROM nodes ORDER BY id').all() as Array<{ id: string; provenance: string }>;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.provenance]))).toEqual({
      'n-git': 'observed',
      'n-conv': 'recorded',
      'n-summary': 'derived',
      'n-doc': 'authored',
      'n-note': 'authored',
      'n-mystery': 'recorded',
    });

    db.close();
  });

  it('backfills trust_state to candidate on a real, already-populated pre-V10 database (V9 -> V10)', () => {
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    sqliteVec.load(db);

    for (const m of MIGRATIONS) {
      if (m.version > 9) continue;
      db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    }
    expect(currentSchemaVersion(db)).toBe(9);

    // Pre-V10 shape: no trust_state column exists yet, same as a real
    // upgrading user's on-disk database.
    db.prepare(
      `INSERT INTO nodes (id, kind, project_id, ts, ts_epoch, source, title, body, signal, meta, provenance, created_at)
       VALUES ('n-a', 'git_commit', 'proj-a', '2026-01-01T00:00:00+00:00', 1, 'git', 't', 'b', 0.5, '{}', 'observed', 1)`,
    ).run();

    const result = migrate(db);
    expect(result.from).toBe(9);
    expect(result.to).toBeGreaterThanOrEqual(10);

    const row = db.prepare('SELECT trust_state AS trustState FROM nodes WHERE id = ?').get('n-a') as { trustState: string };
    expect(row.trustState).toBe('candidate');

    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'nodes'`).all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_nodes_trust_state');

    db.close();
  });

  it('rebuilds nodes_vec with a project_id partition key, preserving real embeddings across two projects (V10 -> V11)', () => {
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    sqliteVec.load(db);

    for (const m of MIGRATIONS) {
      if (m.version > 10) continue;
      db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    }
    expect(currentSchemaVersion(db)).toBe(10);

    // Pre-V11 shape: nodes_vec has no project_id column, same as a real
    // upgrading user's on-disk database with an already-embedded corpus.
    const insertNode = db.prepare(`
      INSERT INTO nodes (id, kind, project_id, ts, ts_epoch, source, title, body, signal, meta, provenance, created_at)
      VALUES (@id, 'git_commit', @projectId, '2026-01-01T00:00:00+00:00', 1, 'git', 't', 'b', 0.5, '{}', 'observed', 1)
    `);
    const insertVec = db.prepare('INSERT INTO nodes_vec (rowid, embedding) VALUES (?, ?)');
    const vecOf = (fill: number) => new Float32Array(EMBEDDING_DIM).fill(fill);

    insertNode.run({ id: 'a1', projectId: 'proj-a' });
    const a1 = (db.prepare('SELECT rowid FROM nodes WHERE id = ?').get('a1') as { rowid: number }).rowid;
    insertVec.run(BigInt(a1), vecOf(0.1));

    insertNode.run({ id: 'b1', projectId: 'proj-b' });
    const b1 = (db.prepare('SELECT rowid FROM nodes WHERE id = ?').get('b1') as { rowid: number }).rowid;
    insertVec.run(BigInt(b1), vecOf(0.9));

    const result = migrate(db);
    expect(result.from).toBe(10);
    expect(result.to).toBeGreaterThanOrEqual(11);

    // rowid alignment and the embedding bytes both survived the rebuild --
    // not just the count.
    const rows = db.prepare('SELECT rowid, project_id AS projectId FROM nodes_vec ORDER BY rowid').all();
    expect(rows).toEqual([
      { rowid: a1, projectId: 'proj-a' },
      { rowid: b1, projectId: 'proj-b' },
    ]);

    const projectAHits = db
      .prepare('SELECT rowid, distance FROM nodes_vec WHERE embedding MATCH ? AND k = ? AND project_id = ? ORDER BY distance')
      .all(vecOf(0.1), 5, 'proj-a') as Array<{ rowid: number; distance: number }>;
    expect(projectAHits).toEqual([{ rowid: a1, distance: 0 }]);

    db.close();
  });
});
