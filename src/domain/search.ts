import { badRequest, notFound } from '../core/errors.ts';
import { assertCan, can, type Ctx } from './context.ts';
import { RESOURCES, RESOURCE_LIST, type ResourceDef } from './resources.ts';
import { getRow, indexRecord, serialize, toFtsQuery, type Row } from './store.ts';
import { tagsFor } from './tags.ts';

export type SearchHit = {
  object: 'search_hit';
  entity_type: string;
  entity_id: string;
  title: string;
  snippet: string;
  score: number;
  record: Record<string, unknown>;
};

/**
 * One query across every record type. Agents reach for this first — it converts
 * "the Acme renewal" into a concrete id without a guessing game across endpoints.
 */
export function search(
  ctx: Ctx,
  input: { q: string; types?: string[]; limit?: number },
): { object: 'search_results'; query: string; data: SearchHit[]; total: number } {
  const match = toFtsQuery(input.q);
  if (!match) {
    throw badRequest('Search needs at least one letter or digit', {
      hint: 'Try a name, email, domain, or deal title.',
    });
  }

  const requested = input.types?.length ? input.types : RESOURCE_LIST.map((r) => r.name);
  const allowed = requested.filter((type) => {
    const def = RESOURCES[type];
    return def ? can(ctx, def.scope, 'read') : false;
  });
  if (allowed.length === 0) {
    throw badRequest('No searchable record types are readable with these credentials', {
      hint: `Requested: ${requested.join(', ')}`,
    });
  }

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const placeholders = allowed.map(() => '?').join(', ');

  const rows = ctx.db
    .prepare(
      `SELECT entity_type, entity_id, title,
              snippet(search_index, 3, '[', ']', '…', 12) AS snippet,
              bm25(search_index) AS score
       FROM search_index
       WHERE search_index MATCH ? AND entity_type IN (${placeholders})
       ORDER BY score ASC
       LIMIT ?`,
    )
    .all(match, ...allowed, limit) as {
    entity_type: string;
    entity_id: string;
    title: string;
    snippet: string;
    score: number;
  }[];

  const hits: SearchHit[] = [];
  for (const row of rows) {
    const def = RESOURCES[row.entity_type];
    if (!def) continue;
    const record = getRow(ctx, def, row.entity_id);
    if (!record || record['archived_at']) continue;
    hits.push({
      object: 'search_hit',
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      title: row.title || def.label(record),
      snippet: row.snippet,
      // bm25 returns negative numbers where lower is better; flip it so bigger = better.
      score: Math.round(-row.score * 1000) / 1000,
      record: serialize(def, record),
    });
  }

  return { object: 'search_results', query: input.q, data: hits, total: hits.length };
}

/** Rebuilds the full-text index from scratch. Used by the self-check repair path. */
export function reindexAll(ctx: Ctx): { indexed: number; byType: Record<string, number> } {
  assertCan(ctx, 'system', 'admin');
  const byType: Record<string, number> = {};
  let indexed = 0;

  const run = ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM search_index').run();
    for (const def of RESOURCE_LIST) {
      const rows = ctx.db
        .prepare(`SELECT * FROM ${def.table} WHERE archived_at IS NULL`)
        .all() as Row[];
      for (const row of rows) indexRecord(ctx, def, row);
      byType[def.name] = rows.length;
      indexed += rows.length;
    }
  });
  run();
  return { indexed, byType };
}

/**
 * Everything known about one record, in a single round trip: the record, its
 * tags, its related records, its timeline, and its open tasks. Built for agents
 * that would otherwise make six calls and stitch the result together badly.
 */
export function recordContext(
  ctx: Ctx,
  entityType: string,
  entityId: string,
  options: { activityLimit?: number } = {},
): Record<string, unknown> {
  const def = RESOURCES[entityType];
  if (!def) {
    throw badRequest(`Unknown record type "${entityType}"`, {
      hint: `Known types: ${RESOURCE_LIST.map((r) => r.name).join(', ')}`,
    });
  }
  assertCan(ctx, def.scope, 'read');
  const row = getRow(ctx, def, entityId);
  if (!row) throw notFound(def.name, entityId);

  const activityLimit = Math.min(Math.max(options.activityLimit ?? 20, 1), 100);
  const record = serialize(def, row);

  return {
    object: 'record_context',
    record,
    tags: def.taggable ? tagsFor(ctx, def.name, entityId) : [],
    related: relatedRecords(ctx, def, row),
    timeline: timelineFor(ctx, def, entityId, activityLimit),
    open_tasks: openTasksFor(ctx, def, entityId),
  };
}

function relatedRecords(ctx: Ctx, def: ResourceDef, row: Row): Record<string, unknown> {
  const related: Record<string, unknown> = {};
  const id = String(row['id']);

  const attach = (key: string, targetName: string, targetId: unknown) => {
    if (typeof targetId !== 'string' || !targetId) return;
    const targetDef = RESOURCES[targetName];
    if (!targetDef || !can(ctx, targetDef.scope, 'read')) return;
    const target = getRow(ctx, targetDef, targetId);
    if (target) related[key] = serialize(targetDef, target);
  };

  attach('company', 'company', row['company_id']);
  attach('contact', 'contact', row['contact_id']);

  if (def.name === 'company' && can(ctx, 'contacts', 'read')) {
    related['contacts'] = (
      ctx.db
        .prepare(
          'SELECT * FROM contacts WHERE company_id = ? AND archived_at IS NULL ORDER BY last_name LIMIT 50',
        )
        .all(id) as Row[]
    ).map((r) => serialize(RESOURCES['contact']!, r));
  }
  if ((def.name === 'company' || def.name === 'contact') && can(ctx, 'deals', 'read')) {
    const column = def.name === 'company' ? 'company_id' : 'contact_id';
    related['deals'] = (
      ctx.db
        .prepare(
          `SELECT * FROM deals WHERE ${column} = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 50`,
        )
        .all(id) as Row[]
    ).map((r) => serialize(RESOURCES['deal']!, r));
  }
  if (def.name === 'deal') {
    const stage = ctx.db.prepare('SELECT * FROM stages WHERE id = ?').get(row['stage_id']);
    const pipeline = ctx.db.prepare('SELECT * FROM pipelines WHERE id = ?').get(row['pipeline_id']);
    if (stage) related['stage'] = { object: 'stage', ...(stage as object) };
    if (pipeline) related['pipeline'] = { object: 'pipeline', ...(pipeline as object) };
  }
  if (row['owner_id']) {
    const owner = ctx.db
      .prepare('SELECT id, name, email, role FROM users WHERE id = ?')
      .get(row['owner_id']);
    if (owner) related['owner'] = { object: 'user', ...(owner as object) };
  }
  return related;
}

export function timelineFor(
  ctx: Ctx,
  def: ResourceDef,
  entityId: string,
  limit: number,
): Record<string, unknown>[] {
  if (!can(ctx, 'activities', 'read')) return [];
  const activityDef = RESOURCES['activity']!;
  const column =
    def.name === 'contact' ? 'contact_id' : def.name === 'company' ? 'company_id' : 'deal_id';
  if (!['contact', 'company', 'deal'].includes(def.name)) return [];

  const rows = ctx.db
    .prepare(
      `SELECT * FROM activities WHERE ${column} = ? AND archived_at IS NULL
       ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    )
    .all(entityId, limit) as Row[];
  return rows.map((r) => serialize(activityDef, r));
}

function openTasksFor(ctx: Ctx, def: ResourceDef, entityId: string): Record<string, unknown>[] {
  if (!can(ctx, 'tasks', 'read')) return [];
  if (!['contact', 'company', 'deal'].includes(def.name)) return [];
  const column =
    def.name === 'contact' ? 'contact_id' : def.name === 'company' ? 'company_id' : 'deal_id';
  const rows = ctx.db
    .prepare(
      `SELECT * FROM tasks WHERE ${column} = ? AND status = 'open' AND archived_at IS NULL
       ORDER BY COALESCE(due_at, '9999') ASC LIMIT 50`,
    )
    .all(entityId) as Row[];
  return rows.map((r) => serialize(RESOURCES['task']!, r));
}
