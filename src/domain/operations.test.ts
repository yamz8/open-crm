import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createHarness, createRecord, OWNER, type Harness } from '../testing.ts';
import { backupDatabase, defaultBackupPath } from './backup.ts';
import { VERSION } from '../core/version.ts';

describe('backups', () => {
  let h: Harness;
  let workDir: string;

  before(async () => {
    h = await createHarness({ seed: true });
    workDir = mkdtempSync(join(tmpdir(), 'open-crm-backup-'));
  });
  after(async () => {
    await h.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  test('produces a verified snapshot that contains the data', async () => {
    const target = join(workDir, 'snapshot.db');
    const result = backupDatabase(h.app.db, target);

    assert.equal(result.integrity, 'ok', 'the copy is checked, not just written');
    assert.ok(result.bytes > 0);
    assert.ok(existsSync(target));

    // The point of a backup is that you can read your records back out of it.
    const restored = new Database(target, { readonly: true });
    try {
      const contacts = restored.prepare('SELECT COUNT(*) AS n FROM contacts').get() as {
        n: number;
      };
      const deals = restored.prepare('SELECT COUNT(*) AS n FROM deals').get() as { n: number };
      assert.equal(contacts.n, 7);
      assert.ok(deals.n >= 7);
      const migrations = restored.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
        n: number;
      };
      assert.ok(migrations.n >= 1, 'schema history travels with the data');
    } finally {
      restored.close();
    }
  });

  test('stays consistent with writes happening around it', async () => {
    await createRecord(h, 'contacts', { first_name: 'Before', email: 'before@example.com' });
    const target = join(workDir, 'consistent.db');
    const result = backupDatabase(h.app.db, target);
    await createRecord(h, 'contacts', { first_name: 'After', email: 'after@example.com' });

    assert.equal(result.integrity, 'ok');
    const restored = new Database(target, { readonly: true });
    try {
      const before = restored
        .prepare(`SELECT COUNT(*) AS n FROM contacts WHERE email = 'before@example.com'`)
        .get() as { n: number };
      const after = restored
        .prepare(`SELECT COUNT(*) AS n FROM contacts WHERE email = 'after@example.com'`)
        .get() as { n: number };
      assert.equal(before.n, 1, 'the snapshot includes everything committed before it');
      assert.equal(after.n, 0, 'and nothing written after it');
    } finally {
      restored.close();
    }
  });

  test('refuses a path it cannot write, with a usable message', () => {
    assert.throws(
      () => backupDatabase(h.app.db, join(workDir, 'nope', "quo'te.db")),
      /single quote/,
    );
  });

  test('the default path is timestamped and lives beside the database', () => {
    const path = defaultBackupPath('/srv/data/open-crm.db', new Date('2026-08-08T19:56:30Z'));
    assert.equal(path, resolve('/srv/data/backups/open-crm-2026-08-08T19-56-30-000.db'));
  });
});

describe('version reporting', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  test('is read from package.json, not hard-coded', async () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/);

    // Every surface must agree, or a release drifts in one of them.
    const info = await h.api('GET', '/api/v1/system/info');
    assert.equal(info.body.version, VERSION);

    const discover = await h.api('GET', '/api/v1/discover', { token: null });
    assert.equal(discover.body.version, VERSION);

    const openapi = await h.api('GET', '/openapi.json', { token: null });
    assert.equal(openapi.body.info.version, VERSION);

    const selfcheck = await h.api('GET', '/api/v1/system/selfcheck');
    assert.equal(selfcheck.body.version, VERSION);
    assert.equal(selfcheck.body.environment, 'test');
  });

  test('the MCP server advertises the same version', async () => {
    const { MCP_SERVER_INFO } = await import('../mcp/server.ts');
    assert.equal(MCP_SERVER_INFO.version, VERSION);
  });
});

describe('login throttling', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ config: { loginRateLimitMax: 3, loginRateLimitWindowMs: 60_000 } });
  });
  after(async () => {
    await h.close();
  });

  test('password guessing is cut off well before the general request budget', async () => {
    const attempt = () =>
      h.server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: OWNER.email, password: 'wrong-password-guess' }),
      });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await attempt()).statusCode);

    assert.ok(statuses.includes(429), `expected a 429 among ${statuses.join(', ')}`);
    assert.ok(
      statuses.indexOf(429) <= 4,
      'the limit should bite within a handful of attempts, not hundreds',
    );

    // The general budget is untouched: reads still work.
    const read = await h.api('GET', '/api/v1/contacts');
    assert.equal(read.status, 200, 'throttling login must not throttle the rest of the API');
  });

  test('the refusal explains itself', async () => {
    const response = await h.server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: OWNER.email, password: 'still-wrong' }),
    });
    assert.equal(response.statusCode, 429);
    const body = JSON.parse(response.body);
    assert.equal(body.error.code, 'rate_limited');
    assert.ok(body.error.hint.includes('Retry-After'));
  });
});
