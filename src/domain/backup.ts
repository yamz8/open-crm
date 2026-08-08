import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { badRequest } from '../core/errors.ts';
import type { Db } from '../db/index.ts';

export type BackupResult = {
  object: 'backup';
  path: string;
  bytes: number;
  integrity: 'ok' | string;
  created_at: string;
};

/**
 * A consistent, compacted copy of the database while the server keeps running.
 *
 * `VACUUM INTO` takes a read snapshot, so it is safe against concurrent writes —
 * unlike copying the .db file, which can miss the WAL and produce a subtly
 * corrupt backup. The copy is then reopened and integrity-checked, because a
 * backup nobody has verified is a hope rather than a plan.
 */
export function backupDatabase(db: Db, destination: string): BackupResult {
  const target = resolve(destination);
  mkdirSync(dirname(target), { recursive: true });

  try {
    // The path is a SQL string literal here, so reject quotes rather than escaping.
    if (target.includes("'")) {
      throw badRequest('Backup paths cannot contain a single quote');
    }
    db.exec(`VACUUM INTO '${target}'`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw badRequest(`Could not write the backup: ${message}`, {
      hint: 'Check that the directory is writable and that the target file does not already exist.',
    });
  }

  const copy = new Database(target, { readonly: true });
  let integrity: string;
  try {
    const rows = copy.pragma('integrity_check') as { integrity_check: string }[];
    integrity = rows[0]?.integrity_check ?? 'unknown';
  } finally {
    copy.close();
  }

  return {
    object: 'backup',
    path: target,
    bytes: statSync(target).size,
    integrity: integrity === 'ok' ? 'ok' : integrity,
    created_at: new Date().toISOString(),
  };
}

/** `data/backups/open-crm-2026-08-08T19-20-00.db` */
export function defaultBackupPath(databaseUrl: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const base = databaseUrl === ':memory:' ? resolve('data', 'memory.db') : resolve(databaseUrl);
  return resolve(dirname(base), 'backups', `open-crm-${stamp}.db`);
}
