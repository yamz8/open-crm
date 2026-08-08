import { newId } from '../core/ids.ts';
import { forbidden, notFound } from '../core/errors.ts';
import { assertCan, type Ctx } from './context.ts';
import { writeAudit } from './store.ts';

export type SavedViewRow = {
  id: string;
  name: string;
  entity_type: string;
  query: string;
  owner_id: string | null;
  shared: number;
  created_at: string;
  updated_at: string;
};

function serializeView(row: SavedViewRow): Record<string, unknown> {
  return {
    object: 'saved_view',
    id: row.id,
    name: row.name,
    entity_type: row.entity_type,
    query: JSON.parse(row.query) as Record<string, unknown>,
    owner_id: row.owner_id,
    shared: Boolean(row.shared),
    created_at: row.created_at,
    updated_at: row.updated_at,
    _label: row.name,
  };
}

export function listViews(ctx: Ctx, entityType?: string): Record<string, unknown>[] {
  assertCan(ctx, 'views', 'read');
  const params: unknown[] = [ctx.actor.id ?? ''];
  let sql = 'SELECT * FROM saved_views WHERE (shared = 1 OR owner_id = ?)';
  if (entityType) {
    sql += ' AND entity_type = ?';
    params.push(entityType);
  }
  sql += ' ORDER BY name ASC';
  return (ctx.db.prepare(sql).all(...params) as SavedViewRow[]).map(serializeView);
}

export function createView(
  ctx: Ctx,
  input: { name: string; entity_type: string; query?: Record<string, unknown>; shared?: boolean },
): Record<string, unknown> {
  assertCan(ctx, 'views', 'write');
  const id = newId('view');
  const now = ctx.now();
  ctx.db
    .prepare(
      `INSERT INTO saved_views (id, name, entity_type, query, owner_id, shared, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name.trim(),
      input.entity_type,
      JSON.stringify(input.query ?? {}),
      ctx.actor.type === 'user' ? ctx.actor.id : null,
      input.shared === false ? 0 : 1,
      now,
      now,
    );
  const row = ctx.db.prepare('SELECT * FROM saved_views WHERE id = ?').get(id) as SavedViewRow;
  writeAudit(ctx, 'create', 'saved_view', id, null, row);
  return serializeView(row);
}

function loadOwned(ctx: Ctx, id: string): SavedViewRow {
  const row = ctx.db.prepare('SELECT * FROM saved_views WHERE id = ?').get(id) as
    SavedViewRow | undefined;
  if (!row) throw notFound('saved_view', id);
  const isOwner = row.owner_id === ctx.actor.id;
  if (!isOwner && ctx.actor.role !== 'owner' && ctx.actor.role !== 'admin') {
    throw forbidden('Only the view owner or an admin can change this saved view');
  }
  return row;
}

export function updateView(
  ctx: Ctx,
  id: string,
  input: { name?: string; query?: Record<string, unknown>; shared?: boolean },
): Record<string, unknown> {
  assertCan(ctx, 'views', 'write');
  const before = loadOwned(ctx, id);
  ctx.db
    .prepare(
      `UPDATE saved_views SET name = COALESCE(?, name), query = COALESCE(?, query),
       shared = COALESCE(?, shared), updated_at = ? WHERE id = ?`,
    )
    .run(
      input.name?.trim() ?? null,
      input.query ? JSON.stringify(input.query) : null,
      input.shared === undefined ? null : input.shared ? 1 : 0,
      ctx.now(),
      id,
    );
  const row = ctx.db.prepare('SELECT * FROM saved_views WHERE id = ?').get(id) as SavedViewRow;
  writeAudit(ctx, 'update', 'saved_view', id, before, row);
  return serializeView(row);
}

export function deleteView(ctx: Ctx, id: string): { deleted: true; id: string } {
  assertCan(ctx, 'views', 'write');
  const before = loadOwned(ctx, id);
  ctx.db.prepare('DELETE FROM saved_views WHERE id = ?').run(id);
  writeAudit(ctx, 'delete', 'saved_view', id, before, null);
  return { deleted: true, id };
}
