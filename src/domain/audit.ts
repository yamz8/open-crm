import { badRequest, notFound } from '../core/errors.ts';
import { assertCan, type Ctx } from './context.ts';
import { RESOURCES } from './resources.ts';
import { archive, getRow, indexRecord, restore, serialize, writeAudit } from './store.ts';

export type AuditRow = {
  id: string;
  at: string;
  actor_type: string;
  actor_id: string | null;
  actor_label: string;
  action: 'create' | 'update' | 'archive' | 'restore' | 'delete';
  entity_type: string;
  entity_id: string;
  before: string | null;
  after: string | null;
  source: string;
  request_id: string | null;
  idempotency_key: string | null;
  reverted_by: string | null;
  reverts: string | null;
};

function parse(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Field-level diff, so a reviewer sees "stage_id changed" not a wall of JSON. */
export function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (key === 'updated_at' || key === 'version') continue;
    const from = before?.[key] ?? null;
    const to = after?.[key] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
  }
  return changes;
}

export function serializeAudit(row: AuditRow): Record<string, unknown> {
  const before = parse(row.before);
  const after = parse(row.after);
  return {
    object: 'audit_entry',
    id: row.id,
    at: row.at,
    actor: { type: row.actor_type, id: row.actor_id, label: row.actor_label },
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    source: row.source,
    request_id: row.request_id,
    idempotency_key: row.idempotency_key,
    reverted: Boolean(row.reverted_by),
    reverted_by: row.reverted_by,
    reverts: row.reverts,
    changes: diff(before, after),
    before,
    after,
    reversible: isReversible(row),
    _label: `${row.actor_label} ${row.action}d ${row.entity_type} ${row.entity_id}`,
  };
}

export function isReversible(row: AuditRow): boolean {
  if (row.reverted_by) return false;
  if (!RESOURCES[row.entity_type]) return false;
  return ['create', 'update', 'archive', 'restore'].includes(row.action);
}

export type AuditQuery = {
  entity_type?: string | undefined;
  entity_id?: string | undefined;
  actor_type?: string | undefined;
  actor_id?: string | undefined;
  action?: string | undefined;
  source?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
};

export function listAudit(ctx: Ctx, query: AuditQuery = {}) {
  assertCan(ctx, 'audit', 'read');
  const where: string[] = [];
  const params: unknown[] = [];

  const eq = (column: string, value: string | undefined) => {
    if (!value) return;
    where.push(`${column} = ?`);
    params.push(value);
  };
  eq('entity_type', query.entity_type);
  eq('entity_id', query.entity_id);
  eq('actor_type', query.actor_type);
  eq('actor_id', query.actor_id);
  eq('action', query.action);
  eq('source', query.source);
  if (query.since) {
    where.push('at >= ?');
    params.push(query.since);
  }
  if (query.until) {
    where.push('at <= ?');
    params.push(query.until);
  }
  if (query.cursor) {
    where.push('id < ?');
    params.push(query.cursor);
  }

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(
    (
      ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${whereSql}`).get(...params) as {
        n: number;
      }
    ).n,
  );
  const rows = ctx.db
    .prepare(`SELECT * FROM audit_log ${whereSql} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit + 1) as AuditRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    object: 'list' as const,
    data: page.map(serializeAudit),
    has_more: hasMore,
    next_cursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    total,
  };
}

export function getAudit(ctx: Ctx, id: string): Record<string, unknown> {
  assertCan(ctx, 'audit', 'read');
  const row = ctx.db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id) as
    AuditRow | undefined;
  if (!row) throw notFound('audit_entry', id);
  return serializeAudit(row);
}

/**
 * Undo one recorded change. This is the feature that makes granting an agent
 * write access a decision you can walk back: every mutation carries its own
 * before-image, so reverting is a data operation, not a restore-from-backup.
 */
export function revert(ctx: Ctx, auditId: string): Record<string, unknown> {
  assertCan(ctx, 'audit', 'write');
  const entry = ctx.db.prepare('SELECT * FROM audit_log WHERE id = ?').get(auditId) as
    AuditRow | undefined;
  if (!entry) throw notFound('audit_entry', auditId);
  if (entry.reverted_by) {
    throw badRequest(`Audit entry ${auditId} was already reverted by ${entry.reverted_by}`);
  }

  const def = RESOURCES[entry.entity_type];
  if (!def) {
    throw badRequest(`Cannot revert changes to ${entry.entity_type} records`, {
      hint: `Revertible types: ${Object.keys(RESOURCES).join(', ')}`,
    });
  }
  assertCan(ctx, def.scope, 'write');

  const before = parse(entry.before);
  let result: Record<string, unknown>;

  switch (entry.action) {
    case 'create': {
      const current = getRow(ctx, def, entry.entity_id);
      if (!current) throw badRequest(`${def.name} ${entry.entity_id} no longer exists`);
      result = archive(ctx, def, entry.entity_id);
      break;
    }
    case 'archive': {
      result = restore(ctx, def, entry.entity_id);
      break;
    }
    case 'restore': {
      result = archive(ctx, def, entry.entity_id);
      break;
    }
    case 'update': {
      if (!before) throw badRequest('This audit entry has no before-image to restore');
      const current = getRow(ctx, def, entry.entity_id);
      if (!current) throw notFound(def.name, entry.entity_id);
      const restorable = Object.keys(before).filter(
        (k) => !['id', 'created_at', 'updated_at', 'version'].includes(k),
      );
      const assignments = restorable.map((c) => `${c} = ?`).join(', ');
      const run = ctx.db.transaction(() => {
        ctx.db
          .prepare(
            `UPDATE ${def.table} SET ${assignments}, updated_at = ?, version = version + 1 WHERE id = ?`,
          )
          .run(...restorable.map((c) => before[c] as never), ctx.now(), entry.entity_id);
        const row = getRow(ctx, def, entry.entity_id)!;
        indexRecord(ctx, def, row);
        writeAudit(ctx, 'update', def.name, entry.entity_id, current, row, auditId);
        return row;
      });
      result = serialize(def, run());
      break;
    }
    default:
      throw badRequest(`Cannot revert a "${entry.action}" action`, {
        hint: 'Hard deletes are not reversible. Prefer archiving.',
      });
  }

  const revertingEntry = ctx.db
    .prepare(`SELECT id FROM audit_log WHERE entity_id = ? ORDER BY id DESC LIMIT 1`)
    .get(entry.entity_id) as { id: string } | undefined;

  ctx.db
    .prepare('UPDATE audit_log SET reverted_by = ? WHERE id = ?')
    .run(revertingEntry?.id ?? ctx.requestId, auditId);
  if (revertingEntry) {
    ctx.db.prepare('UPDATE audit_log SET reverts = ? WHERE id = ?').run(auditId, revertingEntry.id);
  }

  return { object: 'revert_result', reverted_audit_id: auditId, record: result };
}

/**
 * Everything a single actor changed in a window — the "what did the agent do
 * last night" query, answerable without grepping logs.
 */
export function actorActivity(
  ctx: Ctx,
  actorId: string,
  options: { since?: string; limit?: number } = {},
) {
  assertCan(ctx, 'audit', 'read');
  const since = options.since ?? new Date(Date.now() - 24 * 3600_000).toISOString();
  const limit = Math.min(options.limit ?? 100, 500);
  const rows = ctx.db
    .prepare('SELECT * FROM audit_log WHERE actor_id = ? AND at >= ? ORDER BY at DESC LIMIT ?')
    .all(actorId, since, limit) as AuditRow[];

  const summary: Record<string, number> = {};
  for (const row of rows) {
    const key = `${row.entity_type}.${row.action}`;
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return {
    object: 'actor_activity',
    actor_id: actorId,
    since,
    total: rows.length,
    summary,
    data: rows.map(serializeAudit),
  };
}
