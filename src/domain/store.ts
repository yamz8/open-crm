import { newId } from '../core/ids.ts';
import { AppError, badRequest, conflict, notFound } from '../core/errors.ts';
import { assertCan, type Ctx } from './context.ts';
import type { ResourceDef } from './resources.ts';
import { emitDomainEvent } from './events.ts';

export type Row = Record<string, unknown>;

// -- Serialization ------------------------------------------------------------

export function serialize(def: ResourceDef, row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = { object: def.name };
  for (const [key, value] of Object.entries(row)) {
    if (def.jsonColumns.includes(key)) {
      out[key] = typeof value === 'string' ? safeJson(value) : {};
    } else {
      out[key] = value;
    }
  }
  out['_label'] = def.label(row);
  if (def.name === 'deal') {
    const amount = Number(row['amount'] ?? 0);
    out['amount_decimal'] = amount / 100;
    out['amount_formatted'] = formatMoney(amount, String(row['currency'] ?? 'USD'));
  }
  if (def.name === 'contact') {
    out['full_name'] = def.label(row);
  }
  return out;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function formatMoney(minorUnits: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(minorUnits / 100);
  } catch {
    return `${(minorUnits / 100).toFixed(2)} ${currency}`;
  }
}

// -- Full-text search ---------------------------------------------------------

/**
 * FTS5 has its own query syntax, and raw user input ("acme@example.com", "C++")
 * is a syntax error more often than not. Tokenize and quote instead of trusting.
 */
export function toFtsQuery(input: string): string | null {
  const tokens = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens
    .map((token, i) => {
      const quoted = `"${token.replace(/"/g, '""')}"`;
      return i === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(' AND ');
}

export function indexRecord(ctx: Ctx, def: ResourceDef, row: Row): void {
  const id = String(row['id']);
  ctx.db
    .prepare('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?')
    .run(def.name, id);
  if (row['archived_at']) return;
  const text = def.searchText(row);
  if (!text) return;
  ctx.db
    .prepare('INSERT INTO search_index (entity_type, entity_id, title, body) VALUES (?, ?, ?, ?)')
    .run(def.name, id, text.title, text.body);
}

export function unindexRecord(ctx: Ctx, def: ResourceDef, id: string): void {
  ctx.db
    .prepare('DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?')
    .run(def.name, id);
}

// -- Filters ------------------------------------------------------------------

const OPERATORS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'starts_with',
  'in',
  'not_in',
  'is_null',
] as const;
export type Operator = (typeof OPERATORS)[number];

export const FILTER_OPERATORS: readonly string[] = OPERATORS;

type Clause = { sql: string; params: unknown[] };

function buildFilterClause(
  def: ResourceDef,
  rawKey: string,
  value: string | number | boolean | null,
): Clause {
  const separator = rawKey.lastIndexOf('__');
  const field = separator === -1 ? rawKey : rawKey.slice(0, separator);
  const op = (separator === -1 ? 'eq' : rawKey.slice(separator + 2)) as Operator;

  const allowed = new Set<string>([...def.filterable, 'id', 'created_at', 'updated_at']);
  if (!allowed.has(field)) {
    throw badRequest(`Cannot filter ${def.plural} by "${field}"`, {
      hint: `Filterable fields: ${[...allowed].sort().join(', ')}`,
    });
  }
  if (!OPERATORS.includes(op)) {
    throw badRequest(`Unknown filter operator "${op}"`, {
      hint: `Supported operators: ${OPERATORS.join(', ')}. Use them as filter[field__op]=value.`,
    });
  }

  const col = `t.${field}`;
  switch (op) {
    case 'eq':
      return value === null
        ? { sql: `${col} IS NULL`, params: [] }
        : { sql: `${col} = ?`, params: [value] };
    case 'ne':
      return value === null
        ? { sql: `${col} IS NOT NULL`, params: [] }
        : { sql: `(${col} IS NULL OR ${col} != ?)`, params: [value] };
    case 'gt':
      return { sql: `${col} > ?`, params: [value] };
    case 'gte':
      return { sql: `${col} >= ?`, params: [value] };
    case 'lt':
      return { sql: `${col} < ?`, params: [value] };
    case 'lte':
      return { sql: `${col} <= ?`, params: [value] };
    case 'contains':
      return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [`%${escapeLike(String(value))}%`] };
    case 'starts_with':
      return { sql: `${col} LIKE ? ESCAPE '\\'`, params: [`${escapeLike(String(value))}%`] };
    case 'in':
    case 'not_in': {
      const values = String(value)
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      if (values.length === 0) throw badRequest(`filter[${rawKey}] needs a comma-separated list`);
      const placeholders = values.map(() => '?').join(', ');
      return {
        sql: `${col} ${op === 'in' ? 'IN' : 'NOT IN'} (${placeholders})`,
        params: values,
      };
    }
    case 'is_null': {
      const wantNull = value === true || value === 'true' || value === 1 || value === '1';
      return { sql: `${col} IS ${wantNull ? '' : 'NOT '}NULL`, params: [] };
    }
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

// -- Sorting & cursors --------------------------------------------------------

type ParsedSort = { field: string; desc: boolean; spec: { expr: string; type: 'text' | 'number' } };

function parseSort(def: ResourceDef, sort: string | undefined): ParsedSort {
  const raw = sort ?? def.defaultSort;
  const desc = raw.startsWith('-');
  const field = desc ? raw.slice(1) : raw;
  const spec = def.sortable[field];
  if (!spec) {
    throw badRequest(`Cannot sort ${def.plural} by "${field}"`, {
      hint: `Sortable fields: ${Object.keys(def.sortable).join(', ')}. Prefix with "-" for descending.`,
    });
  }
  return { field, desc, spec };
}

function encodeCursor(value: unknown, id: string): string {
  return Buffer.from(JSON.stringify([value, id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): [unknown, string] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[1] !== 'string') {
      throw new Error('shape');
    }
    return [parsed[0], parsed[1]];
  } catch {
    throw badRequest('Invalid cursor', {
      hint: 'Pass back the exact `next_cursor` value from the previous response, or omit it to start over.',
    });
  }
}

// -- Queries ------------------------------------------------------------------

export type ListInput = {
  q?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  sort?: string | undefined;
  include_archived?: boolean | undefined;
  filter?: Record<string, string | number | boolean | null> | undefined;
  tag?: string | undefined;
};

export type ListResult = {
  object: 'list';
  data: Record<string, unknown>[];
  has_more: boolean;
  next_cursor: string | null;
  total: number;
};

export const DEFAULT_LIMIT = 25;

export function list(ctx: Ctx, def: ResourceDef, input: ListInput = {}): ListResult {
  assertCan(ctx, def.scope, 'read');

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 200);
  const where: string[] = [];
  const params: unknown[] = [];

  if (def.archivable && !input.include_archived) where.push('t.archived_at IS NULL');

  for (const [key, value] of Object.entries(input.filter ?? {})) {
    const clause = buildFilterClause(def, key, value);
    where.push(clause.sql);
    params.push(...clause.params);
  }

  if (input.tag) {
    where.push(
      `EXISTS (SELECT 1 FROM taggings tg JOIN tags g ON g.id = tg.tag_id
               WHERE tg.entity_type = ? AND tg.entity_id = t.id AND g.name = ?)`,
    );
    params.push(def.name, input.tag);
  }

  if (input.q) {
    const match = toFtsQuery(input.q);
    if (!match) {
      return { object: 'list', data: [], has_more: false, next_cursor: null, total: 0 };
    }
    where.push(
      `t.id IN (SELECT entity_id FROM search_index WHERE entity_type = ? AND search_index MATCH ?)`,
    );
    params.push(def.name, match);
  }

  const sort = parseSort(def, input.sort);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = Number(
    (
      ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${def.table} t ${whereSql}`).get(...params) as {
        n: number;
      }
    ).n,
  );

  const pageWhere = [...where];
  const pageParams = [...params];
  if (input.cursor) {
    const [lastValue, lastId] = decodeCursor(input.cursor);
    const cmp = sort.desc ? '<' : '>';
    pageWhere.push(`(${sort.spec.expr} ${cmp} ? OR (${sort.spec.expr} = ? AND t.id ${cmp} ?))`);
    pageParams.push(lastValue, lastValue, lastId);
  }
  const pageWhereSql = pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : '';
  const direction = sort.desc ? 'DESC' : 'ASC';

  const rows = ctx.db
    .prepare(
      `SELECT t.* FROM ${def.table} t ${pageWhereSql}
       ORDER BY ${sort.spec.expr} ${direction}, t.id ${direction}
       LIMIT ?`,
    )
    .all(...pageParams, limit + 1) as Row[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  let nextCursor: string | null = null;
  if (hasMore && last) {
    const sortValue = ctx.db
      .prepare(`SELECT ${sort.spec.expr} AS v FROM ${def.table} t WHERE t.id = ?`)
      .get(String(last['id'])) as { v: unknown };
    nextCursor = encodeCursor(sortValue.v, String(last['id']));
  }

  return {
    object: 'list',
    data: page.map((row) => serialize(def, row)),
    has_more: hasMore,
    next_cursor: nextCursor,
    total,
  };
}

export function getRow(ctx: Ctx, def: ResourceDef, id: string): Row | undefined {
  return ctx.db.prepare(`SELECT * FROM ${def.table} WHERE id = ?`).get(id) as Row | undefined;
}

export function get(ctx: Ctx, def: ResourceDef, id: string): Record<string, unknown> {
  assertCan(ctx, def.scope, 'read');
  const row = getRow(ctx, def, id);
  if (!row) throw notFound(def.name, id);
  return serialize(def, row);
}

// -- Mutations ----------------------------------------------------------------

function toColumnValue(def: ResourceDef, key: string, value: unknown): unknown {
  if (def.jsonColumns.includes(key)) return JSON.stringify(value ?? {});
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

export function assertReferencesExist(ctx: Ctx, values: Record<string, unknown>): void {
  const refs: Array<[string, string, string]> = [
    ['company_id', 'companies', 'company'],
    ['contact_id', 'contacts', 'contact'],
    ['deal_id', 'deals', 'deal'],
    ['owner_id', 'users', 'user'],
    ['assignee_id', 'users', 'user'],
    ['pipeline_id', 'pipelines', 'pipeline'],
    ['stage_id', 'stages', 'stage'],
  ];
  for (const [field, table, label] of refs) {
    const value = values[field];
    if (typeof value !== 'string' || value === '') continue;
    const found = ctx.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(value);
    if (!found) {
      throw new AppError(
        'validation_failed',
        `${field} references a ${label} that does not exist`,
        {
          details: { field, value },
          hint: `List ${table} to find a valid id, or omit ${field}.`,
        },
      );
    }
  }
}

export type MutationOptions = {
  /** Extra columns set by business logic rather than by the client. */
  extra?: Record<string, unknown>;
  /** Skip emitting a domain event (used when a wrapper emits a richer one). */
  silent?: boolean;
  eventType?: string;
};

export function create(
  ctx: Ctx,
  def: ResourceDef,
  input: Record<string, unknown>,
  options: MutationOptions = {},
): Record<string, unknown> {
  assertCan(ctx, def.scope, 'write');
  const now = ctx.now();
  const id = newId(def.idKind);

  const values: Record<string, unknown> = { id, created_at: now, updated_at: now, version: 1 };
  for (const key of def.writable) {
    if (input[key] !== undefined) values[key] = toColumnValue(def, key, input[key]);
  }
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    values[key] = value;
  }
  assertReferencesExist(ctx, values);

  const columns = Object.keys(values);
  const placeholders = columns.map(() => '?').join(', ');

  const run = ctx.db.transaction(() => {
    try {
      ctx.db
        .prepare(`INSERT INTO ${def.table} (${columns.join(', ')}) VALUES (${placeholders})`)
        .run(...columns.map((c) => values[c] as never));
    } catch (error) {
      throw translateSqliteError(error, def, values);
    }
    const row = getRow(ctx, def, id)!;
    indexRecord(ctx, def, row);
    writeAudit(ctx, 'create', def.name, id, null, row);
    return row;
  });

  const row = run();
  const serialized = serialize(def, row);
  if (!options.silent) {
    publish(ctx, options.eventType ?? `${def.name}.created`, def.name, id, serialized);
  }
  return serialized;
}

export function update(
  ctx: Ctx,
  def: ResourceDef,
  id: string,
  input: Record<string, unknown>,
  options: MutationOptions & { expectedVersion?: number } = {},
): Record<string, unknown> {
  assertCan(ctx, def.scope, 'write');
  const before = getRow(ctx, def, id);
  if (!before) throw notFound(def.name, id);

  if (
    options.expectedVersion !== undefined &&
    Number(before['version']) !== options.expectedVersion
  ) {
    throw conflict(
      `${def.name} ${id} has changed since you read it (expected version ${options.expectedVersion}, found ${before['version']})`,
      { hint: 'Re-read the record, reapply your change, and retry.' },
    );
  }

  const values: Record<string, unknown> = {};
  for (const key of def.writable) {
    if (input[key] !== undefined) values[key] = toColumnValue(def, key, input[key]);
  }
  for (const [key, value] of Object.entries(options.extra ?? {})) values[key] = value;

  if (Object.keys(values).length === 0) return serialize(def, before);

  values['updated_at'] = ctx.now();
  assertReferencesExist(ctx, values);

  const assignments = Object.keys(values)
    .map((c) => `${c} = ?`)
    .join(', ');

  const run = ctx.db.transaction(() => {
    try {
      ctx.db
        .prepare(`UPDATE ${def.table} SET ${assignments}, version = version + 1 WHERE id = ?`)
        .run(...Object.keys(values).map((c) => values[c] as never), id);
    } catch (error) {
      throw translateSqliteError(error, def, values);
    }
    const row = getRow(ctx, def, id)!;
    indexRecord(ctx, def, row);
    writeAudit(ctx, 'update', def.name, id, before, row);
    return row;
  });

  const row = run();
  const serialized = serialize(def, row);
  if (!options.silent) {
    publish(ctx, options.eventType ?? `${def.name}.updated`, def.name, id, serialized, {
      changed: Object.keys(values).filter((k) => k !== 'updated_at'),
    });
  }
  return serialized;
}

export function archive(ctx: Ctx, def: ResourceDef, id: string): Record<string, unknown> {
  assertCan(ctx, def.scope, 'write');
  if (!def.archivable) throw badRequest(`${def.plural} cannot be archived`);
  const before = getRow(ctx, def, id);
  if (!before) throw notFound(def.name, id);
  if (before['archived_at']) return serialize(def, before);

  const run = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `UPDATE ${def.table} SET archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      )
      .run(ctx.now(), ctx.now(), id);
    const row = getRow(ctx, def, id)!;
    unindexRecord(ctx, def, id);
    writeAudit(ctx, 'archive', def.name, id, before, row);
    return row;
  });

  const row = run();
  const serialized = serialize(def, row);
  publish(ctx, `${def.name}.archived`, def.name, id, serialized);
  return serialized;
}

export function restore(ctx: Ctx, def: ResourceDef, id: string): Record<string, unknown> {
  assertCan(ctx, def.scope, 'write');
  const before = getRow(ctx, def, id);
  if (!before) throw notFound(def.name, id);
  if (!before['archived_at']) return serialize(def, before);

  const run = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `UPDATE ${def.table} SET archived_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?`,
      )
      .run(ctx.now(), id);
    const row = getRow(ctx, def, id)!;
    indexRecord(ctx, def, row);
    writeAudit(ctx, 'restore', def.name, id, before, row);
    return row;
  });

  const row = run();
  const serialized = serialize(def, row);
  publish(ctx, `${def.name}.restored`, def.name, id, serialized);
  return serialized;
}

/** Hard delete. Archiving is the default everywhere else; this is the escape hatch. */
export function remove(ctx: Ctx, def: ResourceDef, id: string): { deleted: true; id: string } {
  assertCan(ctx, def.scope, 'write');
  const before = getRow(ctx, def, id);
  if (!before) throw notFound(def.name, id);

  const run = ctx.db.transaction(() => {
    unindexRecord(ctx, def, id);
    ctx.db
      .prepare('DELETE FROM taggings WHERE entity_type = ? AND entity_id = ?')
      .run(def.name, id);
    ctx.db.prepare(`DELETE FROM ${def.table} WHERE id = ?`).run(id);
    writeAudit(ctx, 'delete', def.name, id, before, null);
  });

  run();
  publish(ctx, `${def.name}.deleted`, def.name, id, { object: def.name, id });
  return { deleted: true, id };
}

// -- Audit & events -----------------------------------------------------------

export function writeAudit(
  ctx: Ctx,
  action: 'create' | 'update' | 'archive' | 'restore' | 'delete',
  entityType: string,
  entityId: string,
  before: Row | null,
  after: Row | null,
  reverts?: string,
): string {
  const id = newId('audit');
  ctx.db
    .prepare(
      `INSERT INTO audit_log
       (id, at, actor_type, actor_id, actor_label, action, entity_type, entity_id, before, after, source, request_id, idempotency_key, reverts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.now(),
      ctx.actor.type,
      ctx.actor.id,
      ctx.actor.label,
      action,
      entityType,
      entityId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      ctx.source,
      ctx.requestId,
      ctx.idempotencyKey ?? null,
      reverts ?? null,
    );
  return id;
}

export function publish(
  ctx: Ctx,
  type: string,
  entityType: string,
  entityId: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): void {
  emitDomainEvent({
    id: newId('audit'),
    type,
    at: ctx.now(),
    actor: { type: ctx.actor.type, id: ctx.actor.id, label: ctx.actor.label },
    source: ctx.source,
    entity_type: entityType,
    entity_id: entityId,
    data: { ...data, ...extra },
  });
}

// -- Error translation --------------------------------------------------------

function translateSqliteError(
  error: unknown,
  def: ResourceDef,
  values: Record<string, unknown>,
): unknown {
  const message = error instanceof Error ? error.message : String(error);

  const uniqueMatch = /UNIQUE constraint failed: (?:\w+\.)?(\w+)/.exec(message);
  if (uniqueMatch || message.includes('index')) {
    const field = uniqueMatch?.[1] ?? guessUniqueField(message);
    if (field) {
      return conflict(`Another ${def.name} already uses that ${field}`, {
        details: { field, value: values[field] ?? null },
        hint: `Search for the existing record first: GET /api/v1/${def.plural}?filter[${field}]=<value>`,
      });
    }
  }
  if (message.includes('CHECK constraint failed')) {
    return new AppError('validation_failed', `Invalid value for ${def.name}`, {
      details: { message },
    });
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return new AppError('validation_failed', `A referenced record does not exist`, {
      details: { message },
      hint: 'Create the related record first, or pass null.',
    });
  }
  return error;
}

function guessUniqueField(message: string): string | null {
  if (message.includes('idx_contacts_email')) return 'email';
  if (message.includes('idx_companies_domain')) return 'domain';
  return null;
}
