import { RESOURCES, RESOURCE_LIST } from '../domain/resources.ts';
import { jsonSchemaOf } from '../http/openapi.ts';

export type RestCall = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  idempotencyKey?: string | undefined;
  /** Optimistic-concurrency guard, forwarded as the If-Match header. */
  ifMatch?: string | undefined;
};

export type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True when the tool cannot change data — surfaced to clients as a read-only hint. */
  readOnly: boolean;
  build: (input: Record<string, unknown>) => RestCall;
};

const RECORD_TYPES = RESOURCE_LIST.map((r) => r.name);
const PLURAL_BY_TYPE = Object.fromEntries(RESOURCE_LIST.map((r) => [r.name, r.plural]));

function pluralOf(type: unknown): string {
  const plural = PLURAL_BY_TYPE[String(type)];
  if (!plural) {
    throw new Error(
      `Unknown record type "${String(type)}". Use one of: ${RECORD_TYPES.join(', ')}`,
    );
  }
  return plural;
}

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const str = (description: string, extra: Record<string, unknown> = {}) => ({
  type: 'string',
  description,
  ...extra,
});
const int = (description: string, extra: Record<string, unknown> = {}) => ({
  type: 'integer',
  description,
  ...extra,
});

const LIST_PROPERTIES = {
  q: str('Full-text search within this record type'),
  limit: int('Page size, 1-200', { minimum: 1, maximum: 200, default: 25 }),
  cursor: str('The next_cursor value from a previous call'),
  sort: str('Field name; prefix with "-" for descending'),
  include_archived: { type: 'boolean', description: 'Include archived records', default: false },
  filter: {
    type: 'object',
    description:
      'Field filters. Keys are field names, optionally suffixed with __gte, __lte, __gt, __lt, __ne, __in, __not_in, __contains, __starts_with, or __is_null.',
    additionalProperties: true,
  },
  tag: str('Only records carrying this tag'),
};

function listQueryFrom(input: Record<string, unknown>): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const key of ['q', 'cursor', 'sort', 'tag'] as const) {
    if (input[key] !== undefined) query[key] = String(input[key]);
  }
  if (input['limit'] !== undefined) query['limit'] = String(input['limit']);
  if (input['include_archived'] !== undefined) {
    query['include_archived'] = String(input['include_archived']);
  }
  for (const [key, value] of Object.entries((input['filter'] ?? {}) as Record<string, unknown>)) {
    query[`filter[${key}]`] = value === null ? '' : String(value);
  }
  return query;
}

/** Strip the wrapper keys a tool uses for routing so the rest becomes the request body. */
function bodyWithout(input: Record<string, unknown>, ...omit: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!omit.includes(key) && value !== undefined) out[key] = value;
  }
  return out;
}

function idempotencyOf(input: Record<string, unknown>): string | undefined {
  const key = input['idempotency_key'];
  return typeof key === 'string' && key ? key : undefined;
}

const IDEMPOTENCY_PROPERTY = {
  idempotency_key: str(
    'Optional. Reuse the same key when retrying so the write happens at most once.',
  ),
};

export const TOOLS: ToolDef[] = [
  {
    name: 'crm_discover',
    title: 'Describe this CRM',
    description:
      'Capability map for this instance: every record type, its fields, filters, and the workflows the API is designed around. Call this once before doing unfamiliar work.',
    inputSchema: obj({}),
    readOnly: true,
    build: () => ({ method: 'GET', path: '/api/v1/discover' }),
  },
  {
    name: 'crm_whoami',
    title: 'Who am I',
    description:
      'The identity and scopes of the credentials in use. Call this if a write is refused.',
    inputSchema: obj({}),
    readOnly: true,
    build: () => ({ method: 'GET', path: '/api/v1/auth/me' }),
  },
  {
    name: 'crm_search',
    title: 'Search everything',
    description:
      'Full-text search across contacts, companies, deals, activities, and tasks. The fastest way to turn a name, email, or domain into a record id.',
    inputSchema: obj(
      {
        q: str('What to look for: a name, email, company, or deal title'),
        types: {
          type: 'array',
          items: { type: 'string', enum: RECORD_TYPES },
          description: 'Restrict to these record types',
        },
        limit: int('Maximum hits', { minimum: 1, maximum: 100, default: 20 }),
      },
      ['q'],
    ),
    readOnly: true,
    build: (input) => ({
      method: 'GET',
      path: '/api/v1/search',
      query: {
        q: String(input['q']),
        ...(Array.isArray(input['types']) ? { types: input['types'].join(',') } : {}),
        ...(input['limit'] !== undefined ? { limit: String(input['limit']) } : {}),
      },
    }),
  },
  {
    name: 'crm_get_context',
    title: 'Get everything about one record',
    description:
      'One call that returns a record plus its tags, related records, recent timeline, and open tasks. Prefer this over several separate reads before acting on a record.',
    inputSchema: obj(
      {
        type: str('Record type', { enum: RECORD_TYPES }),
        id: str('The record id, e.g. cont_01JQ...'),
        activity_limit: int('How many timeline entries to include', { default: 20 }),
      },
      ['type', 'id'],
    ),
    readOnly: true,
    build: (input) => ({
      method: 'GET',
      path: `/api/v1/${pluralOf(input['type'])}/${String(input['id'])}/context`,
      query: {
        ...(input['activity_limit'] !== undefined
          ? { activity_limit: String(input['activity_limit']) }
          : {}),
      },
    }),
  },
  {
    name: 'crm_list',
    title: 'List records',
    description:
      'List any record type with filters, sorting, and cursor pagination. Use crm_discover to see which fields each type accepts.',
    inputSchema: obj({ type: str('Record type', { enum: RECORD_TYPES }), ...LIST_PROPERTIES }, [
      'type',
    ]),
    readOnly: true,
    build: (input) => ({
      method: 'GET',
      path: `/api/v1/${pluralOf(input['type'])}`,
      query: listQueryFrom(input),
    }),
  },
  {
    name: 'crm_get',
    title: 'Get one record',
    description:
      'Fetch one record by id. Use crm_get_context instead when you are about to act on the record — it returns the relations and timeline too.',
    inputSchema: obj(
      { type: str('Record type', { enum: RECORD_TYPES }), id: str('The record id') },
      ['type', 'id'],
    ),
    readOnly: true,
    build: (input) => ({
      method: 'GET',
      path: `/api/v1/${pluralOf(input['type'])}/${String(input['id'])}`,
    }),
  },

  // -- Writes ---------------------------------------------------------------

  {
    name: 'crm_create_contact',
    title: 'Create a contact',
    description:
      'Add a person. Search first — creating a duplicate is the most common mistake here. Emails are unique across active contacts.',
    inputSchema: withIdempotency(jsonSchemaOf(RESOURCES['contact']!.createSchema)),
    readOnly: false,
    build: (input) => ({
      method: 'POST',
      path: '/api/v1/contacts',
      body: bodyWithout(input, 'idempotency_key'),
      idempotencyKey: idempotencyOf(input),
    }),
  },
  {
    name: 'crm_create_company',
    title: 'Create a company',
    description: 'Add an organization. Domains are unique across active companies.',
    inputSchema: withIdempotency(jsonSchemaOf(RESOURCES['company']!.createSchema)),
    readOnly: false,
    build: (input) => ({
      method: 'POST',
      path: '/api/v1/companies',
      body: bodyWithout(input, 'idempotency_key'),
      idempotencyKey: idempotencyOf(input),
    }),
  },
  {
    name: 'crm_create_deal',
    title: 'Create a deal',
    description:
      'Open a revenue opportunity. Amounts are integers in minor units (150000 = $1,500.00). Omit pipeline_id and stage_id to use the default pipeline first stage.',
    inputSchema: withIdempotency(jsonSchemaOf(RESOURCES['deal']!.createSchema)),
    readOnly: false,
    build: (input) => ({
      method: 'POST',
      path: '/api/v1/deals',
      body: bodyWithout(input, 'idempotency_key'),
      idempotencyKey: idempotencyOf(input),
    }),
  },
  {
    name: 'crm_log_activity',
    title: 'Log an activity',
    description:
      'Record a note, call, email, or meeting on a record timeline. Must be attached to at least one of contact_id, company_id, or deal_id. Do not use this to describe a stage change — crm_move_deal already writes one.',
    inputSchema: withIdempotency(jsonSchemaOf(RESOURCES['activity']!.createSchema)),
    readOnly: false,
    build: (input) => ({
      method: 'POST',
      path: '/api/v1/activities',
      body: bodyWithout(input, 'idempotency_key'),
      idempotencyKey: idempotencyOf(input),
    }),
  },
  {
    name: 'crm_create_task',
    title: 'Create a task',
    description:
      'Add something that still needs doing, optionally linked to a record and assigned to a user.',
    inputSchema: withIdempotency(jsonSchemaOf(RESOURCES['task']!.createSchema)),
    readOnly: false,
    build: (input) => ({
      method: 'POST',
      path: '/api/v1/tasks',
      body: bodyWithout(input, 'idempotency_key'),
      idempotencyKey: idempotencyOf(input),
    }),
  },
  {
    name: 'crm_update',
    title: 'Update a record',
    description:
      'Partial update: only the fields you send change. Pass `version` (from the record you read) to fail loudly instead of overwriting someone else’s concurrent edit.',
    inputSchema: obj(
      {
        type: str('Record type', { enum: RECORD_TYPES }),
        id: str('The record id'),
        fields: {
          type: 'object',
          description: 'Fields to change. Unknown fields are rejected with the accepted list.',
          additionalProperties: true,
        },
        version: int('The version you read, for optimistic concurrency'),
      },
      ['type', 'id', 'fields'],
    ),
    readOnly: false,
    build: (input) => ({
      method: 'PATCH',
      path: `/api/v1/${pluralOf(input['type'])}/${String(input['id'])}`,
      body: input['fields'],
      ...(input['version'] !== undefined ? { ifMatch: String(input['version']) } : {}),
    }),
  },
  {
    name: 'crm_move_deal',
    title: 'Move a deal to another stage',
    description:
      'Advance or regress a deal. Updates the stage, the won/lost status, and writes a timeline entry in one atomic step. Use crm_list with type "pipeline" alternatives via crm_pipelines to find stage ids.',
    inputSchema: obj(
      {
        id: str('Deal id'),
        stage_id: str('Target stage id, from crm_pipelines'),
        note: str('Why it moved. Worth writing — a human will read this later.'),
        ...IDEMPOTENCY_PROPERTY,
      },
      ['id', 'stage_id'],
    ),
    readOnly: false,
    build: (input) => ({
      method: 'POST',
      path: `/api/v1/deals/${String(input['id'])}/move`,
      body: bodyWithout(input, 'id', 'idempotency_key'),
      idempotencyKey: idempotencyOf(input),
    }),
  },
  {
    name: 'crm_close_deal',
    title: 'Close a deal won or lost',
    description: 'Mark the outcome, optionally with the final amount and a reason.',
    inputSchema: obj(
      {
        id: str('Deal id'),
        outcome: str('won or lost', { enum: ['won', 'lost'] }),
        reason: str('Why, especially for a loss'),
        amount: int('Final amount in minor units, if it changed'),
        ...IDEMPOTENCY_PROPERTY,
      },
      ['id', 'outcome'],
    ),
    readOnly: false,
    build: (input) => ({
      method: 'POST',
      path: `/api/v1/deals/${String(input['id'])}/close`,
      body: bodyWithout(input, 'id', 'idempotency_key'),
      idempotencyKey: idempotencyOf(input),
    }),
  },
  {
    name: 'crm_complete_task',
    title: 'Complete a task',
    description: 'Mark a task done and stamp the completion time.',
    inputSchema: obj({ id: str('Task id') }, ['id']),
    readOnly: false,
    build: (input) => ({ method: 'POST', path: `/api/v1/tasks/${String(input['id'])}/complete` }),
  },
  {
    name: 'crm_bulk_create',
    title: 'Create many records at once',
    description:
      'Up to 200 records in one transaction. Use on_error "abort" to get all-or-nothing, or "skip" to import what you can and read the per-row errors. Always pass an idempotency_key.',
    inputSchema: obj(
      {
        type: str('Record type', { enum: RECORD_TYPES }),
        records: {
          type: 'array',
          maxItems: 200,
          items: { type: 'object', additionalProperties: true },
          description: 'Each item uses the same shape as the matching create tool',
        },
        on_error: str('abort (default) or skip', { enum: ['abort', 'skip'] }),
        ...IDEMPOTENCY_PROPERTY,
      },
      ['type', 'records'],
    ),
    readOnly: false,
    build: (input) => ({
      method: 'POST',
      path: `/api/v1/${pluralOf(input['type'])}/bulk`,
      body: {
        records: input['records'],
        ...(input['on_error'] ? { on_error: input['on_error'] } : {}),
      },
      idempotencyKey: idempotencyOf(input),
    }),
  },
  {
    name: 'crm_archive',
    title: 'Archive a record',
    description:
      'Hide a record without destroying it. Reversible with crm_restore, and the change is in the audit log. Prefer this over deletion.',
    inputSchema: obj(
      { type: str('Record type', { enum: RECORD_TYPES }), id: str('The record id') },
      ['type', 'id'],
    ),
    readOnly: false,
    build: (input) => ({
      method: 'DELETE',
      path: `/api/v1/${pluralOf(input['type'])}/${String(input['id'])}`,
    }),
  },
  {
    name: 'crm_restore',
    title: 'Restore an archived record',
    description:
      'Bring an archived record back into active use, exactly as it was. Safe to call on a record that is not archived.',
    inputSchema: obj(
      { type: str('Record type', { enum: RECORD_TYPES }), id: str('The record id') },
      ['type', 'id'],
    ),
    readOnly: false,
    build: (input) => ({
      method: 'POST',
      path: `/api/v1/${pluralOf(input['type'])}/${String(input['id'])}/restore`,
    }),
  },
  {
    name: 'crm_add_tags',
    title: 'Tag a record',
    description:
      'Attach one or more tags. Tags are created on demand and normalized to lowercase-with-dashes.',
    inputSchema: obj(
      {
        type: str('Record type', { enum: RECORD_TYPES.filter((t) => t !== 'activity') }),
        id: str('The record id'),
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag names' },
      },
      ['type', 'id', 'tags'],
    ),
    readOnly: false,
    build: (input) => ({
      method: 'POST',
      path: `/api/v1/${pluralOf(input['type'])}/${String(input['id'])}/tags`,
      body: { tags: input['tags'] },
    }),
  },

  // -- Orientation ----------------------------------------------------------

  {
    name: 'crm_work_queue',
    title: 'What needs attention',
    description:
      'Overdue tasks, tasks due soon, deals that have gone quiet, and contacts never contacted — plus a suggested next action. A good first call when starting a session.',
    inputSchema: obj({
      assignee_id: str('Only tasks assigned to this user'),
      stale_days: int('How many days of silence makes a deal stale', { default: 14 }),
      limit: int('Max items per section', { default: 20 }),
    }),
    readOnly: true,
    build: (input) => ({
      method: 'GET',
      path: '/api/v1/insights/work-queue',
      query: Object.fromEntries(
        Object.entries(input).map(([k, v]) => [k, v === undefined ? undefined : String(v)]),
      ),
    }),
  },
  {
    name: 'crm_overview',
    title: 'Headline metrics',
    description: 'Counts, revenue, win rate, and activity mix over a recent window.',
    inputSchema: obj({ days: int('Window length in days', { default: 30 }) }),
    readOnly: true,
    build: (input) => ({
      method: 'GET',
      path: '/api/v1/insights/overview',
      query: input['days'] !== undefined ? { days: String(input['days']) } : {},
    }),
  },
  {
    name: 'crm_pipelines',
    title: 'List pipelines and stages',
    description: 'Every pipeline with its stages, stage ids, probabilities, and open deal counts.',
    inputSchema: obj({}),
    readOnly: true,
    build: () => ({ method: 'GET', path: '/api/v1/pipelines' }),
  },
  {
    name: 'crm_pipeline_summary',
    title: 'Pipeline value by stage',
    description: 'Deal count, total value, and probability-weighted value for each stage.',
    inputSchema: obj({ pipeline_id: str('Defaults to the default pipeline') }),
    readOnly: true,
    build: (input) => ({
      method: 'GET',
      path: '/api/v1/insights/pipeline',
      query: input['pipeline_id'] ? { pipeline_id: String(input['pipeline_id']) } : {},
    }),
  },

  // -- Accountability -------------------------------------------------------

  {
    name: 'crm_audit',
    title: 'Read the audit log',
    description:
      'Every mutation with field-level before/after. Filter by actor to review exactly what an agent (including you) changed.',
    inputSchema: obj({
      entity_type: str('Record type', { enum: RECORD_TYPES }),
      entity_id: str('A specific record'),
      actor_id: str('A user id or API token id'),
      action: str('create, update, archive, restore, or delete'),
      since: str('ISO-8601 lower bound'),
      limit: int('Maximum entries', { default: 50, maximum: 200 }),
    }),
    readOnly: true,
    build: (input) => ({
      method: 'GET',
      path: '/api/v1/audit',
      query: Object.fromEntries(
        Object.entries(input).map(([k, v]) => [k, v === undefined ? undefined : String(v)]),
      ),
    }),
  },
  {
    name: 'crm_revert',
    title: 'Undo a change',
    description:
      'Reverse one audit entry, restoring the record to its state before that change. The reversal is itself audited. Hard deletes cannot be reverted.',
    inputSchema: obj(
      { audit_id: str('The audit entry id, from crm_audit'), ...IDEMPOTENCY_PROPERTY },
      ['audit_id'],
    ),
    readOnly: false,
    build: (input) => ({
      method: 'POST',
      path: `/api/v1/audit/${String(input['audit_id'])}/revert`,
      idempotencyKey: idempotencyOf(input),
    }),
  },
  {
    name: 'crm_selfcheck',
    title: 'Check instance health',
    description:
      'Runs schema, integrity, search index, domain invariant, and configuration checks. Each result explains what is wrong and how to fix it. Set repair to true to fix what can be fixed safely.',
    inputSchema: obj({
      repair: { type: 'boolean', description: 'Fix repairable problems', default: false },
    }),
    readOnly: false,
    build: (input) => ({
      method: 'GET',
      path: '/api/v1/system/selfcheck',
      query: { repair: input['repair'] === true ? 'true' : 'false' },
    }),
  },
];

function withIdempotency(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = { ...((schema['properties'] as Record<string, unknown>) ?? {}) };
  properties['idempotency_key'] = IDEMPOTENCY_PROPERTY.idempotency_key;
  return { ...schema, properties, additionalProperties: false };
}

export const TOOLS_BY_NAME: Map<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));
