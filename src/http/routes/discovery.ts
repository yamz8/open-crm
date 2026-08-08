import type { FastifyInstance } from 'fastify';
import { RESOURCE_LIST } from '../../domain/resources.ts';
import { FILTER_OPERATORS } from '../../domain/store.ts';
import { buildOpenApiDocument, jsonSchemaOf } from '../openapi.ts';
import { buildLlmsTxt } from '../llms.ts';
import { isSetupComplete } from '../../domain/auth.ts';
import type { App } from '../../app.ts';

/**
 * A capability map an agent can read once and then use the API correctly without
 * trial and error: what exists, what fields it has, how to filter it, and which
 * call sequences the system is actually designed around.
 */
export function buildDiscovery(app: App): Record<string, unknown> {
  const url = app.config.publicUrl;

  return {
    object: 'discovery',
    name: 'open-crm',
    version: '0.1.0',
    description:
      'Self-hosted CRM with a shared service layer behind REST, MCP, and a CLI. Humans and agents see the same data, the same permissions, and the same audit trail.',
    public_url: url,
    setup_complete: isSetupComplete(app.db),

    start_here: [
      'GET /api/v1/auth/me — confirm who you are and what scopes you hold.',
      'GET /api/v1/insights/work-queue — what needs attention right now.',
      'GET /api/v1/search?q=... — turn a name into an id.',
      'GET /api/v1/{type}/{id}/context — the record, its relations, and its timeline in one call.',
    ],

    authentication: {
      recommended_for_agents: 'bearer_token',
      bearer_token: {
        header: 'Authorization: Bearer ocrm_<prefix>_<secret>',
        how_to_get_one:
          'A signed-in human creates one: POST /api/v1/tokens {"name":"my-agent","scopes":["contacts:write","deals:read"]}',
        note: 'The token value is shown exactly once. Every write it makes is attributed to it in the audit log.',
      },
      session_cookie: {
        how: 'POST /api/v1/auth/login {"email","password"} sets an httpOnly cookie. Used by the web UI.',
      },
      scopes: {
        format: '<resource>:<read|write|admin>, or "*" for everything',
        implications: 'write implies read; admin implies write.',
        resources: [
          ...RESOURCE_LIST.map((r) => r.scope),
          'pipelines',
          'tags',
          'views',
          'audit',
          'insights',
          'webhooks',
          'users',
          'tokens',
          'system',
        ],
      },
    },

    conventions: {
      ids: {
        format: '<prefix>_<26-char ULID>, e.g. cont_01JQ8ZK4M9V2XR7T3B5N6P8QWE',
        why: 'The prefix tells you the record type without a lookup, and sorting by id sorts by creation time.',
        prefixes: Object.fromEntries(RESOURCE_LIST.map((r) => [r.name, r.idKind])),
      },
      envelope: {
        single:
          'The record itself, with an `object` field naming its type and `_label` giving a human-readable name.',
        list: '{ object: "list", data: [...], has_more, next_cursor, total }',
      },
      pagination: {
        style: 'cursor',
        how: 'Pass `limit`, then feed `next_cursor` back as `cursor`. Stop when `has_more` is false.',
        max_limit: 200,
        default_limit: 25,
      },
      filtering: {
        syntax: 'filter[field]=value, or filter[field__operator]=value',
        operators: FILTER_OPERATORS,
        examples: [
          'filter[status]=open',
          'filter[amount__gte]=500000',
          'filter[lifecycle_stage__in]=lead,qualified',
          'filter[owner_id__is_null]=true',
          'filter[email__contains]=@acme.com',
        ],
      },
      sorting: 'sort=field for ascending, sort=-field for descending.',
      money:
        'All amounts are integers in minor units. 150000 means $1,500.00. Responses also include amount_decimal and amount_formatted.',
      timestamps: 'ISO-8601 UTC strings everywhere.',
      soft_delete:
        'DELETE archives (reversible via POST /{type}/{id}/restore). Pass ?hard=true to delete permanently — that cannot be reverted.',
      concurrency:
        'Every record has an integer `version`. Send `If-Match: <version>` on PATCH to get a 409 instead of clobbering a concurrent edit.',
      idempotency: {
        header: 'Idempotency-Key',
        applies_to: 'POST creates, bulk creates, deal move/close, and audit revert.',
        behavior:
          'Same key + same body replays the original response (with `idempotent-replay: true`). Same key + different body is a 409.',
        advice: 'Generate one key per logical action and reuse it across retries.',
      },
      errors: {
        shape: '{ error: { code, message, hint?, details? } }',
        read_the_hint:
          'The `hint` field is written for the caller and usually contains the exact fix.',
        codes: [
          'bad_request',
          'validation_failed',
          'unauthorized',
          'forbidden',
          'not_found',
          'conflict',
          'rate_limited',
          'idempotency_mismatch',
          'internal_error',
        ],
      },
      rate_limits: {
        max: app.config.rateLimitMax,
        window_ms: app.config.rateLimitWindowMs,
        keyed_by: 'API token id, or client IP when unauthenticated',
      },
    },

    resources: RESOURCE_LIST.map((def) => ({
      name: def.name,
      description: def.description,
      collection: `/api/v1/${def.plural}`,
      scope: def.scope,
      create_schema: jsonSchemaOf(def.createSchema),
      update_schema: jsonSchemaOf(def.updateSchema),
      filterable: def.filterable,
      sortable: Object.keys(def.sortable),
      default_sort: def.defaultSort,
      taggable: def.taggable,
      archivable: def.archivable,
      custom_fields:
        'Put anything non-standard in `properties` — it is a free-form JSON object, no schema migration needed.',
      endpoints: [
        `GET /api/v1/${def.plural}`,
        `POST /api/v1/${def.plural}`,
        `POST /api/v1/${def.plural}/bulk`,
        `GET /api/v1/${def.plural}/{id}`,
        `GET /api/v1/${def.plural}/{id}/context`,
        `PATCH /api/v1/${def.plural}/{id}`,
        `DELETE /api/v1/${def.plural}/{id}`,
        `POST /api/v1/${def.plural}/{id}/restore`,
        ...(def.taggable
          ? [
              `POST /api/v1/${def.plural}/{id}/tags`,
              `DELETE /api/v1/${def.plural}/{id}/tags/{name}`,
            ]
          : []),
        ...(def.name === 'deal'
          ? ['POST /api/v1/deals/{id}/move', 'POST /api/v1/deals/{id}/close']
          : []),
        ...(def.name === 'task' ? ['POST /api/v1/tasks/{id}/complete'] : []),
      ],
    })),

    workflows: [
      {
        name: 'Log a conversation against a person',
        steps: [
          'GET /api/v1/search?q=<name or email>&types=contact',
          'If nothing matches: POST /api/v1/contacts {"first_name","last_name","email"}',
          'POST /api/v1/activities {"type":"call","subject":"...","body":"...","contact_id":"cont_..."}',
        ],
      },
      {
        name: 'Advance a deal',
        steps: [
          'GET /api/v1/deals/{id}/context — see the current stage and recent history',
          'GET /api/v1/pipelines — read the stage ids for that pipeline',
          'POST /api/v1/deals/{id}/move {"stage_id":"stg_...","note":"why"}',
        ],
        note: 'Moving a deal writes its own timeline entry. Do not also POST an activity describing the move.',
      },
      {
        name: 'Import a list of people',
        steps: [
          'POST /api/v1/companies/bulk {"records":[...]} — companies first, so contacts can reference them',
          'POST /api/v1/contacts/bulk {"records":[...],"on_error":"skip"}',
          'Read `errors[]` in the response for rows that were rejected',
        ],
        note: 'Send an Idempotency-Key so a retry after a timeout does not duplicate the import.',
      },
      {
        name: 'Daily agent loop',
        steps: [
          'GET /api/v1/insights/work-queue',
          'Handle overdue tasks: POST /api/v1/tasks/{id}/complete',
          'For each stale deal: log an activity or move the stage',
          'GET /api/v1/insights/overview to report what changed',
        ],
      },
      {
        name: 'Review and undo what an agent did',
        steps: [
          'GET /api/v1/audit?actor_id=tok_...&since=<iso>',
          'Inspect `changes` on each entry (field-level before/after)',
          'POST /api/v1/audit/{id}/revert to undo one change',
        ],
      },
    ],

    interfaces: {
      rest: { openapi: `${url}/openapi.json`, base: `${url}/api/v1` },
      mcp: {
        stdio: 'npm run mcp  (env: OPEN_CRM_URL, OPEN_CRM_TOKEN)',
        http: `${url}/mcp`,
        note: 'The MCP server exposes the same operations as tools, with the same scopes and audit trail.',
      },
      cli: 'npm run cli -- --help',
      llms_txt: `${url}/llms.txt`,
      webhooks: 'POST /api/v1/webhooks to subscribe. Payloads are HMAC-signed.',
    },

    events: [
      ...RESOURCE_LIST.flatMap((r) => [
        `${r.name}.created`,
        `${r.name}.updated`,
        `${r.name}.archived`,
        `${r.name}.restored`,
        `${r.name}.deleted`,
      ]),
      'deal.stage_changed',
      'deal.won',
      'deal.lost',
      'task.completed',
      'pipeline.created',
    ],
  };
}

export async function registerDiscoveryRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.app;
  fastify.get('/discover', async () => buildDiscovery(app));
  fastify.get('/openapi.json', async () => buildOpenApiDocument(app.config.publicUrl));
}

/** Root-level documents that tools look for at fixed, unprefixed paths. */
export async function registerRootDocs(fastify: FastifyInstance): Promise<void> {
  const app = fastify.app;

  fastify.get('/openapi.json', async () => buildOpenApiDocument(app.config.publicUrl));

  fastify.get('/llms.txt', async (_request, reply) => {
    reply.type('text/plain; charset=utf-8');
    return buildLlmsTxt(app.config.publicUrl);
  });
}
