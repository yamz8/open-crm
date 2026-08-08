import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function openDatabase(databaseUrl: string): Db {
  if (databaseUrl !== ':memory:') {
    mkdirSync(dirname(databaseUrl), { recursive: true });
  }
  const db = new Database(databaseUrl);
  // WAL keeps readers (the UI polling a list) from blocking writers (an agent
  // batch-importing contacts). NORMAL synchronous is the right trade for a CRM.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export type Migration = { name: string; sql: string };

export function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

export type MigrationResult = { applied: string[]; alreadyApplied: string[] };

export function migrate(db: Db): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const done = new Set(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((r) => (r as { name: string }).name),
  );

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of loadMigrations()) {
    if (done.has(migration.name)) {
      alreadyApplied.push(migration.name);
      continue;
    }
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        migration.name,
        new Date().toISOString(),
      );
    });
    run();
    applied.push(migration.name);
  }

  return { applied, alreadyApplied };
}

/** Migrations that exist in the database but not on disk — a downgrade footgun. */
export function pendingMigrations(db: Db): { missingOnDisk: string[]; notApplied: string[] } {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
    .get();
  if (!tableExists) return { missingOnDisk: [], notApplied: loadMigrations().map((m) => m.name) };

  const applied = new Set(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((r) => (r as { name: string }).name),
  );
  const onDisk = loadMigrations().map((m) => m.name);
  const onDiskSet = new Set(onDisk);
  return {
    missingOnDisk: [...applied].filter((n) => !onDiskSet.has(n)).sort(),
    notApplied: onDisk.filter((n) => !applied.has(n)),
  };
}
