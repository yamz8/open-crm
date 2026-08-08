import { newId } from '../core/ids.ts';
import { badRequest, notFound } from '../core/errors.ts';
import { assertCan, type Ctx } from './context.ts';
import { RESOURCES } from './resources.ts';
import { getRow, writeAudit } from './store.ts';

export type TagRow = {
  id: string;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
};

const PALETTE = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#64748b',
];

function serializeTag(row: TagRow, count?: number): Record<string, unknown> {
  return {
    object: 'tag',
    ...row,
    ...(count === undefined ? {} : { usage_count: count }),
    _label: row.name,
  };
}

export function normalizeTagName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

export function listTags(ctx: Ctx): Record<string, unknown>[] {
  assertCan(ctx, 'tags', 'read');
  const rows = ctx.db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM taggings g WHERE g.tag_id = t.id) AS usage_count
       FROM tags t ORDER BY t.name ASC`,
    )
    .all() as (TagRow & { usage_count: number })[];
  return rows.map((row) => serializeTag(row, row.usage_count));
}

export function upsertTag(ctx: Ctx, name: string, color?: string): TagRow {
  const normalized = normalizeTagName(name);
  if (!normalized) throw badRequest('Tag names cannot be empty');
  const existing = ctx.db.prepare('SELECT * FROM tags WHERE name = ?').get(normalized) as
    TagRow | undefined;
  if (existing) {
    if (color && color !== existing.color) {
      ctx.db
        .prepare('UPDATE tags SET color = ?, updated_at = ? WHERE id = ?')
        .run(color, ctx.now(), existing.id);
      return { ...existing, color };
    }
    return existing;
  }
  const id = newId('tag');
  const now = ctx.now();
  const chosen = color ?? PALETTE[Math.abs(hash(normalized)) % PALETTE.length]!;
  ctx.db
    .prepare('INSERT INTO tags (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, normalized, chosen, now, now);
  const row = ctx.db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow;
  writeAudit(ctx, 'create', 'tag', id, null, row);
  return row;
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return h;
}

export function createTag(
  ctx: Ctx,
  input: { name: string; color?: string },
): Record<string, unknown> {
  assertCan(ctx, 'tags', 'write');
  return serializeTag(upsertTag(ctx, input.name, input.color));
}

export function updateTag(
  ctx: Ctx,
  id: string,
  input: { name?: string; color?: string },
): Record<string, unknown> {
  assertCan(ctx, 'tags', 'write');
  const before = ctx.db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow | undefined;
  if (!before) throw notFound('tag', id);
  ctx.db
    .prepare(
      'UPDATE tags SET name = COALESCE(?, name), color = COALESCE(?, color), updated_at = ? WHERE id = ?',
    )
    .run(input.name ? normalizeTagName(input.name) : null, input.color ?? null, ctx.now(), id);
  const row = ctx.db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow;
  writeAudit(ctx, 'update', 'tag', id, before, row);
  return serializeTag(row);
}

export function deleteTag(ctx: Ctx, id: string): { deleted: true; id: string } {
  assertCan(ctx, 'tags', 'write');
  const before = ctx.db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow | undefined;
  if (!before) throw notFound('tag', id);
  ctx.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  writeAudit(ctx, 'delete', 'tag', id, before, null);
  return { deleted: true, id };
}

function resolveTaggable(entityType: string) {
  const def = RESOURCES[entityType];
  if (!def || !def.taggable) {
    const taggable = Object.values(RESOURCES)
      .filter((r) => r.taggable)
      .map((r) => r.name);
    throw badRequest(`${entityType} records cannot be tagged`, {
      hint: `Taggable types: ${taggable.join(', ')}`,
    });
  }
  return def;
}

export function tagsFor(ctx: Ctx, entityType: string, entityId: string): Record<string, unknown>[] {
  const rows = ctx.db
    .prepare(
      `SELECT t.* FROM tags t JOIN taggings g ON g.tag_id = t.id
       WHERE g.entity_type = ? AND g.entity_id = ? ORDER BY t.name ASC`,
    )
    .all(entityType, entityId) as TagRow[];
  return rows.map((r) => serializeTag(r));
}

export function addTags(
  ctx: Ctx,
  entityType: string,
  entityId: string,
  names: string[],
): Record<string, unknown>[] {
  const def = resolveTaggable(entityType);
  assertCan(ctx, def.scope, 'write');
  if (!getRow(ctx, def, entityId)) throw notFound(def.name, entityId);

  const run = ctx.db.transaction(() => {
    for (const name of names) {
      const tag = upsertTag(ctx, name);
      ctx.db
        .prepare(
          'INSERT OR IGNORE INTO taggings (tag_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(tag.id, entityType, entityId, ctx.now());
    }
  });
  run();
  return tagsFor(ctx, entityType, entityId);
}

export function removeTag(
  ctx: Ctx,
  entityType: string,
  entityId: string,
  name: string,
): Record<string, unknown>[] {
  const def = resolveTaggable(entityType);
  assertCan(ctx, def.scope, 'write');
  const tag = ctx.db.prepare('SELECT * FROM tags WHERE name = ?').get(normalizeTagName(name)) as
    TagRow | undefined;
  if (tag) {
    ctx.db
      .prepare('DELETE FROM taggings WHERE tag_id = ? AND entity_type = ? AND entity_id = ?')
      .run(tag.id, entityType, entityId);
  }
  return tagsFor(ctx, entityType, entityId);
}
