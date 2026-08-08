import { pendingMigrations } from '../db/index.ts';
import type { AppConfig } from '../core/config.ts';
import { assertCan, type Ctx } from './context.ts';
import { RESOURCE_LIST } from './resources.ts';
import { indexRecord, type Row } from './store.ts';
import { purgeExpiredSessions } from './auth.ts';
import { VERSION } from '../core/version.ts';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export type Check = {
  name: string;
  status: CheckStatus;
  message: string;
  /** What a human or agent should do about it. */
  remedy?: string;
  details?: unknown;
  /** True when `repair: true` can fix this automatically. */
  repairable?: boolean;
};

export type SelfCheckReport = {
  object: 'selfcheck';
  status: CheckStatus;
  checked_at: string;
  version: string;
  environment: string;
  repaired: string[];
  checks: Check[];
};

/**
 * A single endpoint that answers "is this instance healthy, and if not, what
 * exactly is wrong and how do I fix it". Every check either passes or explains
 * itself — no check is allowed to fail silently or vaguely.
 */
export function selfCheck(
  ctx: Ctx,
  config: AppConfig,
  options: { repair?: boolean } = {},
): SelfCheckReport {
  assertCan(ctx, 'system', 'read');
  if (options.repair) assertCan(ctx, 'system', 'admin');

  const checks: Check[] = [];
  const repaired: string[] = [];

  // -- Schema ---------------------------------------------------------------
  const migrations = pendingMigrations(ctx.db);
  if (migrations.notApplied.length > 0) {
    checks.push({
      name: 'migrations',
      status: 'fail',
      message: `${migrations.notApplied.length} migration(s) have not been applied`,
      remedy: 'Run `npm run migrate` (or restart the server, which migrates on boot).',
      details: migrations.notApplied,
    });
  } else if (migrations.missingOnDisk.length > 0) {
    checks.push({
      name: 'migrations',
      status: 'warn',
      message: 'The database has migrations that no longer exist in this build',
      remedy:
        'You are probably running an older build against a newer database. Redeploy the matching version.',
      details: migrations.missingOnDisk,
    });
  } else {
    checks.push({ name: 'migrations', status: 'pass', message: 'Schema is up to date' });
  }

  // -- Storage integrity ----------------------------------------------------
  const integrity = ctx.db.pragma('integrity_check') as { integrity_check: string }[];
  const integrityOk = integrity.length === 1 && integrity[0]?.integrity_check === 'ok';
  checks.push({
    name: 'sqlite_integrity',
    status: integrityOk ? 'pass' : 'fail',
    message: integrityOk ? 'SQLite reports no corruption' : 'SQLite integrity check failed',
    ...(integrityOk
      ? {}
      : { remedy: 'Restore from a backup. Do not keep writing to this file.', details: integrity }),
  });

  const fkViolations = ctx.db.pragma('foreign_key_check') as unknown[];
  checks.push({
    name: 'foreign_keys',
    status: fkViolations.length === 0 ? 'pass' : 'fail',
    message:
      fkViolations.length === 0
        ? 'No dangling foreign keys'
        : `${fkViolations.length} row(s) reference records that no longer exist`,
    ...(fkViolations.length === 0
      ? {}
      : {
          remedy: 'Inspect the listed rows and clear or repoint the broken references.',
          details: fkViolations.slice(0, 20),
        }),
  });

  // -- Search index ---------------------------------------------------------
  const indexProblems: Record<string, { expected: number; indexed: number }> = {};
  for (const def of RESOURCE_LIST) {
    const expected = Number(
      (
        ctx.db
          .prepare(`SELECT COUNT(*) AS n FROM ${def.table} WHERE archived_at IS NULL`)
          .get() as {
          n: number;
        }
      ).n,
    );
    const indexed = Number(
      (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM search_index WHERE entity_type = ?')
          .get(def.name) as { n: number }
      ).n,
    );
    if (expected !== indexed) indexProblems[def.name] = { expected, indexed };
  }

  if (Object.keys(indexProblems).length > 0) {
    if (options.repair) {
      rebuildIndex(ctx);
      repaired.push('search_index');
      checks.push({
        name: 'search_index',
        status: 'pass',
        message: 'Search index was out of sync and has been rebuilt',
        details: indexProblems,
      });
    } else {
      checks.push({
        name: 'search_index',
        status: 'warn',
        message: 'Search index does not match the record counts',
        remedy: 'POST /api/v1/system/selfcheck?repair=true, or run `open-crm reindex`.',
        details: indexProblems,
        repairable: true,
      });
    }
  } else {
    checks.push({
      name: 'search_index',
      status: 'pass',
      message: 'Search index matches all records',
    });
  }

  // -- Domain invariants ----------------------------------------------------
  const statusMismatch = ctx.db
    .prepare(
      `SELECT d.id, d.status, s.outcome, s.name AS stage_name
       FROM deals d JOIN stages s ON s.id = d.stage_id
       WHERE d.archived_at IS NULL
         AND ((s.outcome = 'open' AND d.status != 'open')
           OR (s.outcome != 'open' AND d.status != s.outcome))`,
    )
    .all() as Row[];
  checks.push({
    name: 'deal_stage_consistency',
    status: statusMismatch.length === 0 ? 'pass' : 'warn',
    message:
      statusMismatch.length === 0
        ? 'Every deal status matches its stage outcome'
        : `${statusMismatch.length} deal(s) have a status that contradicts their stage`,
    ...(statusMismatch.length === 0
      ? {}
      : {
          remedy: 'Move the deals with POST /api/v1/deals/{id}/move so status and stage agree.',
          details: statusMismatch.slice(0, 20),
        }),
  });

  const orphanActivities = Number(
    (
      ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM activities
           WHERE contact_id IS NULL AND company_id IS NULL AND deal_id IS NULL`,
        )
        .get() as { n: number }
    ).n,
  );
  checks.push({
    name: 'activity_attachment',
    status: orphanActivities === 0 ? 'pass' : 'warn',
    message:
      orphanActivities === 0
        ? 'Every activity is attached to a record'
        : `${orphanActivities} activit(ies) are attached to nothing and will never appear on a timeline`,
    ...(orphanActivities === 0 ? {} : { remedy: 'Attach or archive them.' }),
  });

  // -- Configuration --------------------------------------------------------
  const usingDefaultSecret = config.secret === 'insecure-development-secret-change-me';
  checks.push({
    name: 'instance_secret',
    status: usingDefaultSecret ? (config.env === 'production' ? 'fail' : 'warn') : 'pass',
    message: usingDefaultSecret
      ? 'OPEN_CRM_SECRET is unset, so sessions and API tokens use a well-known development key'
      : 'Instance secret is configured',
    ...(usingDefaultSecret
      ? {
          remedy:
            'Set OPEN_CRM_SECRET to a random 32-byte hex string (`openssl rand -hex 32`) and restart. Existing sessions and tokens will be invalidated.',
        }
      : {}),
  });

  const userCount = Number(
    (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n,
  );
  checks.push({
    name: 'setup',
    status: userCount > 0 ? 'pass' : 'warn',
    message: userCount > 0 ? `${userCount} user account(s)` : 'No user accounts exist yet',
    ...(userCount > 0
      ? {}
      : { remedy: 'Open the web UI, or POST /api/v1/setup to create the first owner.' }),
  });

  // -- Background work ------------------------------------------------------
  const failedDeliveries = Number(
    (
      ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status = 'failed'`)
        .get() as { n: number }
    ).n,
  );
  checks.push({
    name: 'webhook_deliveries',
    status: failedDeliveries === 0 ? 'pass' : 'warn',
    message:
      failedDeliveries === 0
        ? 'No permanently failed webhook deliveries'
        : `${failedDeliveries} webhook deliver(ies) gave up after retrying`,
    ...(failedDeliveries === 0
      ? {}
      : { remedy: 'Check the subscriber URL and inspect GET /api/v1/webhooks/{id}/deliveries.' }),
  });

  const expiredSessions = Number(
    (
      ctx.db
        .prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at < ?')
        .get(new Date().toISOString()) as { n: number }
    ).n,
  );
  if (expiredSessions > 0 && options.repair) {
    purgeExpiredSessions(ctx.db);
    repaired.push('expired_sessions');
    checks.push({
      name: 'expired_sessions',
      status: 'pass',
      message: `Purged ${expiredSessions} expired session(s)`,
    });
  } else {
    checks.push({
      name: 'expired_sessions',
      status: expiredSessions > 0 ? 'warn' : 'pass',
      message:
        expiredSessions > 0
          ? `${expiredSessions} expired session(s) still stored`
          : 'No expired sessions',
      ...(expiredSessions > 0
        ? { remedy: 'Harmless, but run selfcheck with repair=true to clean up.', repairable: true }
        : {}),
    });
  }

  const wildcardTokens = ctx.db
    .prepare(`SELECT id, name FROM api_tokens WHERE revoked_at IS NULL AND scopes = '["*"]'`)
    .all() as { id: string; name: string }[];
  checks.push({
    name: 'token_scopes',
    status: wildcardTokens.length === 0 ? 'pass' : 'warn',
    message:
      wildcardTokens.length === 0
        ? 'No unrestricted API tokens'
        : `${wildcardTokens.length} active token(s) have full access to everything`,
    ...(wildcardTokens.length === 0
      ? {}
      : {
          remedy:
            'Prefer narrow scopes for agents, e.g. ["contacts:write","deals:read"]. Rotate wide tokens when you can.',
          details: wildcardTokens,
        }),
  });

  const orphanTokens = ctx.db
    .prepare(
      `SELECT t.id, t.name,
              CASE WHEN u.id IS NULL THEN 'creator was deleted' ELSE 'creator is disabled' END AS reason
       FROM api_tokens t
       LEFT JOIN users u ON u.id = t.created_by
       WHERE t.revoked_at IS NULL
         AND t.created_by IS NOT NULL
         AND (u.id IS NULL OR u.disabled_at IS NOT NULL)`,
    )
    .all() as { id: string; name: string; reason: string }[];
  checks.push({
    name: 'token_ownership',
    status: orphanTokens.length === 0 ? 'pass' : 'warn',
    message:
      orphanTokens.length === 0
        ? 'Every active token belongs to a live account'
        : `${orphanTokens.length} active token(s) outlived the account that created them`,
    ...(orphanTokens.length === 0
      ? {}
      : {
          remedy:
            'These tokens are already refused at authentication. Revoke them with DELETE /api/v1/tokens/{id} to clear the warning.',
          details: orphanTokens,
        }),
  });

  const status: CheckStatus = checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'pass';

  return {
    object: 'selfcheck',
    status,
    checked_at: ctx.now(),
    version: VERSION,
    environment: config.env,
    repaired,
    checks,
  };
}

function rebuildIndex(ctx: Ctx): void {
  const run = ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM search_index').run();
    for (const def of RESOURCE_LIST) {
      const rows = ctx.db
        .prepare(`SELECT * FROM ${def.table} WHERE archived_at IS NULL`)
        .all() as Row[];
      for (const row of rows) indexRecord(ctx, def, row);
    }
  });
  run();
}
