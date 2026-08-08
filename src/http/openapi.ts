import { z, type ZodType } from 'zod';
import * as S from '../domain/schemas.ts';
import { RESOURCE_LIST } from '../domain/resources.ts';
import { FILTER_OPERATORS } from '../domain/store.ts';

/**
 * The OpenAPI document is generated from the same zod schemas the server
 * validates with, so it cannot drift from the implementation. A test asserts
 * every registered route appears here.
 */
export function jsonSchemaOf(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
}

const ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: {
          type: 'string',
          enum: [
            'bad_request',
            'validation_failed',
            'unauthorized',
            'forbidden',
            'not_found',
            'conflict',
            'precondition_failed',
            'rate_limited',
            'idempotency_mismatch',
            'internal_error',
          ],
        },
        message: { type: 'string' },
        hint: { type: 'string', description: 'How to fix the request. Read this before retrying.' },
        details: {},
      },
    },
  },
};

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const jsonBody = (ref: string) => ({
  required: true,
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } },
});

const jsonResponse = (description: string, schema: unknown = { type: 'object' }) => ({
  description,
  content: { 'application/json': { schema } },
});

const COMMON_ERRORS = {
  '401': errorResponse('Missing or invalid credentials'),
  '403': errorResponse('Authenticated, but not permitted'),
  '422': errorResponse('The payload failed validation; `details` lists the offending fields'),
};

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Prefixed record id',
};

const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string' },
  description:
    'Repeat a write safely. The same key with the same body replays the original response; the same key with a different body is rejected.',
};

export function buildOpenApiDocument(publicUrl: string): Record<string, unknown> {
  const schemas: Record<string, unknown> = { Error: ERROR_SCHEMA };
  const paths: Record<string, Record<string, unknown>> = {};

  const addSchema = (name: string, schema: ZodType) => {
    schemas[name] = jsonSchemaOf(schema);
  };

  addSchema('Setup', S.setupInput);
  addSchema('Login', S.loginInput);
  addSchema('UserCreate', S.userCreate);
  addSchema('UserUpdate', S.userUpdate);
  addSchema('TokenCreate', S.tokenCreate);
  addSchema('DealMove', S.dealMove);
  addSchema('DealClose', S.dealClose);
  addSchema('Tagging', S.taggingInput);
  addSchema('WebhookCreate', S.webhookCreate);
  addSchema('WebhookUpdate', S.webhookUpdate);
  addSchema('SavedViewCreate', S.savedViewCreate);
  addSchema('SavedViewUpdate', S.savedViewUpdate);
  addSchema('PipelineCreate', S.pipelineCreate);
  addSchema('PipelineUpdate', S.pipelineUpdate);
  addSchema('StageCreate', S.stageCreate);
  addSchema('StageUpdate', S.stageUpdate);
  addSchema('TagCreate', S.tagCreate);
  addSchema('TagUpdate', S.tagUpdate);

  for (const def of RESOURCE_LIST) {
    const Create = `${pascal(def.name)}Create`;
    const Update = `${pascal(def.name)}Update`;
    addSchema(Create, def.createSchema);
    addSchema(Update, def.updateSchema);

    const base = `/api/v1/${def.plural}`;
    const tag = def.plural;

    paths[base] = {
      get: {
        tags: [tag],
        operationId: `list${pascal(def.plural)}`,
        summary: `List ${def.plural}`,
        description: `${def.description}\n\nFilterable fields: ${def.filterable.join(', ')}. Operators: ${FILTER_OPERATORS.join(', ')} (use \`filter[field__op]=value\`).`,
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Full-text search' },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
          },
          {
            name: 'cursor',
            in: 'query',
            schema: { type: 'string' },
            description: 'From `next_cursor`',
          },
          {
            name: 'sort',
            in: 'query',
            schema: { type: 'string', enum: Object.keys(def.sortable) },
            description: `Prefix with "-" for descending. Default: ${def.defaultSort}`,
          },
          { name: 'include_archived', in: 'query', schema: { type: 'boolean', default: false } },
          ...(def.taggable
            ? [
                {
                  name: 'tag',
                  in: 'query',
                  schema: { type: 'string' },
                  description: 'Filter by tag name',
                },
              ]
            : []),
        ],
        responses: {
          '200': jsonResponse(`A page of ${def.plural}`, listSchema()),
          ...COMMON_ERRORS,
        },
      },
      post: {
        tags: [tag],
        operationId: `create${pascal(def.name)}`,
        summary: `Create a ${def.name}`,
        parameters: [IDEMPOTENCY_HEADER],
        requestBody: jsonBody(Create),
        responses: {
          '201': jsonResponse(`The created ${def.name}`),
          '409': errorResponse('A conflicting record already exists'),
          ...COMMON_ERRORS,
        },
      },
    };

    paths[`${base}/bulk`] = {
      post: {
        tags: [tag],
        operationId: `bulkCreate${pascal(def.plural)}`,
        summary: `Create up to 200 ${def.plural} in one transaction`,
        parameters: [IDEMPOTENCY_HEADER],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['records'],
                properties: {
                  records: {
                    type: 'array',
                    maxItems: 200,
                    items: { $ref: `#/components/schemas/${Create}` },
                  },
                  on_error: {
                    type: 'string',
                    enum: ['abort', 'skip'],
                    default: 'abort',
                    description:
                      '`abort` rolls the whole batch back; `skip` reports per-record errors.',
                  },
                },
              },
            },
          },
        },
        responses: { '201': jsonResponse('Bulk result'), ...COMMON_ERRORS },
      },
    };

    paths[`${base}/{id}`] = {
      get: {
        tags: [tag],
        operationId: `get${pascal(def.name)}`,
        parameters: [idParam],
        responses: {
          '200': jsonResponse(`One ${def.name}`),
          '404': errorResponse('No such record'),
          ...COMMON_ERRORS,
        },
      },
      patch: {
        tags: [tag],
        operationId: `update${pascal(def.name)}`,
        summary: `Update a ${def.name}`,
        description:
          'Only the fields you send are changed. Send `If-Match: <version>` to fail instead of overwriting a concurrent edit.',
        parameters: [
          idParam,
          {
            name: 'If-Match',
            in: 'header',
            schema: { type: 'integer' },
            description: 'The `version` you read. A mismatch returns 409.',
          },
        ],
        requestBody: jsonBody(Update),
        responses: {
          '200': jsonResponse(`The updated ${def.name}`),
          '409': errorResponse('The record changed since you read it'),
          ...COMMON_ERRORS,
        },
      },
      delete: {
        tags: [tag],
        operationId: `archive${pascal(def.name)}`,
        summary: `Archive a ${def.name}`,
        description: 'Archives by default (reversible). Pass `hard=true` to delete permanently.',
        parameters: [
          idParam,
          { name: 'hard', in: 'query', schema: { type: 'boolean', default: false } },
        ],
        responses: {
          '200': jsonResponse('The archived record, or a deletion receipt'),
          ...COMMON_ERRORS,
        },
      },
    };

    paths[`${base}/{id}/context`] = {
      get: {
        tags: [tag],
        operationId: `get${pascal(def.name)}Context`,
        summary: `Everything about one ${def.name} in a single call`,
        description:
          'Returns the record plus its tags, related records, recent timeline, and open tasks. Prefer this over several round trips.',
        parameters: [
          idParam,
          { name: 'activity_limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': jsonResponse('Record context'), ...COMMON_ERRORS },
      },
    };

    paths[`${base}/{id}/restore`] = {
      post: {
        tags: [tag],
        operationId: `restore${pascal(def.name)}`,
        summary: `Un-archive a ${def.name}`,
        parameters: [idParam],
        responses: { '200': jsonResponse('The restored record'), ...COMMON_ERRORS },
      },
    };

    if (def.taggable) {
      paths[`${base}/{id}/tags`] = {
        post: {
          tags: [tag],
          operationId: `addTagsTo${pascal(def.name)}`,
          parameters: [idParam],
          requestBody: jsonBody('Tagging'),
          responses: { '200': jsonResponse('The record tags'), ...COMMON_ERRORS },
        },
      };
      paths[`${base}/{id}/tags/{name}`] = {
        delete: {
          tags: [tag],
          operationId: `removeTagFrom${pascal(def.name)}`,
          parameters: [
            idParam,
            { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': jsonResponse('The remaining tags'), ...COMMON_ERRORS },
        },
      };
    }
  }

  Object.assign(paths, {
    '/api/v1/setup': {
      get: {
        tags: ['system'],
        operationId: 'getSetupStatus',
        summary: 'Has this instance been initialized?',
        security: [],
        responses: { '200': jsonResponse('Setup status') },
      },
      post: {
        tags: ['system'],
        operationId: 'runSetup',
        summary: 'Create the first owner account',
        security: [],
        requestBody: jsonBody('Setup'),
        responses: {
          '201': jsonResponse('The owner account'),
          '409': errorResponse('Already set up'),
        },
      },
    },
    '/api/v1/auth/login': {
      post: {
        tags: ['auth'],
        operationId: 'login',
        summary: 'Exchange email + password for a session cookie',
        security: [],
        requestBody: jsonBody('Login'),
        responses: { '200': jsonResponse('Session'), '401': errorResponse('Bad credentials') },
      },
    },
    '/api/v1/auth/logout': {
      post: {
        tags: ['auth'],
        operationId: 'logout',
        responses: { '200': jsonResponse('Logged out') },
      },
    },
    '/api/v1/auth/me': {
      get: {
        tags: ['auth'],
        operationId: 'whoAmI',
        summary: 'Identity and effective scopes of the current caller',
        responses: { '200': jsonResponse('Identity'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/users': {
      get: {
        tags: ['users'],
        operationId: 'listUsers',
        responses: { '200': jsonResponse('Users'), ...COMMON_ERRORS },
      },
      post: {
        tags: ['users'],
        operationId: 'createUser',
        requestBody: jsonBody('UserCreate'),
        responses: { '201': jsonResponse('The created user'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/users/{id}': {
      patch: {
        tags: ['users'],
        operationId: 'updateUser',
        parameters: [idParam],
        requestBody: jsonBody('UserUpdate'),
        responses: { '200': jsonResponse('The updated user'), ...COMMON_ERRORS },
      },
      delete: {
        tags: ['users'],
        operationId: 'deleteUser',
        parameters: [idParam],
        responses: { '200': jsonResponse('Deletion receipt'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/tokens': {
      get: {
        tags: ['tokens'],
        operationId: 'listTokens',
        responses: { '200': jsonResponse('Tokens'), ...COMMON_ERRORS },
      },
      post: {
        tags: ['tokens'],
        operationId: 'createToken',
        summary: 'Mint an API token for an agent',
        description: 'The token value is returned once and never again.',
        requestBody: jsonBody('TokenCreate'),
        responses: { '201': jsonResponse('The token, shown once'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/tokens/{id}': {
      delete: {
        tags: ['tokens'],
        operationId: 'revokeToken',
        parameters: [idParam],
        responses: { '200': jsonResponse('The revoked token'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/tokens/{id}/activity': {
      get: {
        tags: ['tokens'],
        operationId: 'getTokenActivity',
        summary: 'Everything this token changed, with a per-type summary',
        parameters: [
          idParam,
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { '200': jsonResponse('Actor activity'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/deals/{id}/move': {
      post: {
        tags: ['deals'],
        operationId: 'moveDeal',
        summary: 'Move a deal to another stage',
        description:
          'Updates status, stamps closed_at for terminal stages, and writes a timeline entry.',
        parameters: [idParam, IDEMPOTENCY_HEADER],
        requestBody: jsonBody('DealMove'),
        responses: { '200': jsonResponse('The moved deal'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/deals/{id}/close': {
      post: {
        tags: ['deals'],
        operationId: 'closeDeal',
        summary: 'Mark a deal won or lost',
        parameters: [idParam, IDEMPOTENCY_HEADER],
        requestBody: jsonBody('DealClose'),
        responses: { '200': jsonResponse('The closed deal'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/tasks/{id}/complete': {
      post: {
        tags: ['tasks'],
        operationId: 'completeTask',
        parameters: [idParam],
        responses: { '200': jsonResponse('The completed task'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/search': {
      get: {
        tags: ['search'],
        operationId: 'search',
        summary: 'Full-text search across every record type',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          {
            name: 'types',
            in: 'query',
            schema: { type: 'string' },
            description: 'Comma-separated: contact,company,deal,activity,task',
          },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
        ],
        responses: {
          '200': jsonResponse('Ranked hits with the full record inlined'),
          ...COMMON_ERRORS,
        },
      },
    },
    '/api/v1/pipelines': {
      get: {
        tags: ['pipelines'],
        operationId: 'listPipelines',
        responses: { '200': jsonResponse('Pipelines'), ...COMMON_ERRORS },
      },
      post: {
        tags: ['pipelines'],
        operationId: 'createPipeline',
        requestBody: jsonBody('PipelineCreate'),
        responses: { '201': jsonResponse('The created pipeline'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/pipelines/{id}': {
      get: {
        tags: ['pipelines'],
        operationId: 'getPipeline',
        parameters: [idParam],
        responses: { '200': jsonResponse('Pipeline'), ...COMMON_ERRORS },
      },
      patch: {
        tags: ['pipelines'],
        operationId: 'updatePipeline',
        parameters: [idParam],
        requestBody: jsonBody('PipelineUpdate'),
        responses: { '200': jsonResponse('Pipeline'), ...COMMON_ERRORS },
      },
      delete: {
        tags: ['pipelines'],
        operationId: 'deletePipeline',
        parameters: [idParam],
        responses: { '200': jsonResponse('Receipt'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/pipelines/{id}/stages': {
      post: {
        tags: ['pipelines'],
        operationId: 'createStage',
        parameters: [idParam],
        requestBody: jsonBody('StageCreate'),
        responses: { '201': jsonResponse('Stage'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/stages/{id}': {
      patch: {
        tags: ['pipelines'],
        operationId: 'updateStage',
        parameters: [idParam],
        requestBody: jsonBody('StageUpdate'),
        responses: { '200': jsonResponse('Stage'), ...COMMON_ERRORS },
      },
      delete: {
        tags: ['pipelines'],
        operationId: 'deleteStage',
        parameters: [idParam],
        responses: { '200': jsonResponse('Receipt'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/tags': {
      get: {
        tags: ['tags'],
        operationId: 'listTags',
        responses: { '200': jsonResponse('Tags'), ...COMMON_ERRORS },
      },
      post: {
        tags: ['tags'],
        operationId: 'createTag',
        requestBody: jsonBody('TagCreate'),
        responses: { '201': jsonResponse('Tag'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/tags/{id}': {
      patch: {
        tags: ['tags'],
        operationId: 'updateTag',
        parameters: [idParam],
        requestBody: jsonBody('TagUpdate'),
        responses: { '200': jsonResponse('Tag'), ...COMMON_ERRORS },
      },
      delete: {
        tags: ['tags'],
        operationId: 'deleteTag',
        parameters: [idParam],
        responses: { '200': jsonResponse('Receipt'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/audit': {
      get: {
        tags: ['audit'],
        operationId: 'listAudit',
        summary: 'Every mutation, with before/after images',
        parameters: [
          { name: 'entity_type', in: 'query', schema: { type: 'string' } },
          { name: 'entity_id', in: 'query', schema: { type: 'string' } },
          {
            name: 'actor_type',
            in: 'query',
            schema: { type: 'string', enum: ['user', 'agent', 'system'] },
          },
          { name: 'actor_id', in: 'query', schema: { type: 'string' } },
          {
            name: 'action',
            in: 'query',
            schema: { type: 'string', enum: ['create', 'update', 'archive', 'restore', 'delete'] },
          },
          {
            name: 'source',
            in: 'query',
            schema: { type: 'string', enum: ['api', 'web', 'mcp', 'cli', 'system'] },
          },
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
        ],
        responses: { '200': jsonResponse('Audit entries'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/audit/{id}': {
      get: {
        tags: ['audit'],
        operationId: 'getAuditEntry',
        parameters: [idParam],
        responses: { '200': jsonResponse('Audit entry'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/audit/{id}/revert': {
      post: {
        tags: ['audit'],
        operationId: 'revertAuditEntry',
        summary: 'Undo one recorded change',
        description:
          'Restores the before-image and records the reversal as its own audit entry. Hard deletes are not reversible.',
        parameters: [idParam, IDEMPOTENCY_HEADER],
        responses: { '200': jsonResponse('The restored record'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/views': {
      get: {
        tags: ['views'],
        operationId: 'listViews',
        responses: { '200': jsonResponse('Saved views'), ...COMMON_ERRORS },
      },
      post: {
        tags: ['views'],
        operationId: 'createView',
        requestBody: jsonBody('SavedViewCreate'),
        responses: { '201': jsonResponse('Saved view'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/views/{id}': {
      patch: {
        tags: ['views'],
        operationId: 'updateView',
        parameters: [idParam],
        requestBody: jsonBody('SavedViewUpdate'),
        responses: { '200': jsonResponse('Saved view'), ...COMMON_ERRORS },
      },
      delete: {
        tags: ['views'],
        operationId: 'deleteView',
        parameters: [idParam],
        responses: { '200': jsonResponse('Receipt'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/webhooks': {
      get: {
        tags: ['webhooks'],
        operationId: 'listWebhooks',
        responses: { '200': jsonResponse('Webhooks'), ...COMMON_ERRORS },
      },
      post: {
        tags: ['webhooks'],
        operationId: 'createWebhook',
        description:
          'Deliveries are signed with `x-open-crm-signature: sha256=HMAC(secret, "<timestamp>.<body>")`.',
        requestBody: jsonBody('WebhookCreate'),
        responses: {
          '201': jsonResponse('The webhook, including its signing secret (shown once)'),
          ...COMMON_ERRORS,
        },
      },
    },
    '/api/v1/webhooks/{id}': {
      patch: {
        tags: ['webhooks'],
        operationId: 'updateWebhook',
        parameters: [idParam],
        requestBody: jsonBody('WebhookUpdate'),
        responses: { '200': jsonResponse('Webhook'), ...COMMON_ERRORS },
      },
      delete: {
        tags: ['webhooks'],
        operationId: 'deleteWebhook',
        parameters: [idParam],
        responses: { '200': jsonResponse('Receipt'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/webhooks/{id}/deliveries': {
      get: {
        tags: ['webhooks'],
        operationId: 'listWebhookDeliveries',
        parameters: [idParam],
        responses: { '200': jsonResponse('Deliveries'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/insights/overview': {
      get: {
        tags: ['insights'],
        operationId: 'getOverview',
        summary: 'Headline counts, revenue, and activity mix',
        parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 30 } }],
        responses: { '200': jsonResponse('Overview'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/insights/work-queue': {
      get: {
        tags: ['insights'],
        operationId: 'getWorkQueue',
        summary: 'What needs attention right now',
        description:
          'Overdue tasks, deals that have gone quiet, and contacts never contacted. A good first call for an agent loop.',
        parameters: [
          { name: 'assignee_id', in: 'query', schema: { type: 'string' } },
          { name: 'stale_days', in: 'query', schema: { type: 'integer', default: 14 } },
        ],
        responses: { '200': jsonResponse('Work queue'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/insights/pipeline': {
      get: {
        tags: ['insights'],
        operationId: 'getPipelineSummary',
        parameters: [{ name: 'pipeline_id', in: 'query', schema: { type: 'string' } }],
        responses: { '200': jsonResponse('Per-stage totals and weighted value'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/system/selfcheck': {
      get: {
        tags: ['system'],
        operationId: 'selfCheck',
        summary: 'Diagnose this instance',
        description:
          'Runs schema, integrity, index, invariant, and configuration checks. `repair=true` fixes what it safely can.',
        parameters: [{ name: 'repair', in: 'query', schema: { type: 'boolean', default: false } }],
        responses: {
          '200': jsonResponse('Report'),
          '503': jsonResponse('Report with at least one failing check'),
          ...COMMON_ERRORS,
        },
      },
      post: {
        tags: ['system'],
        operationId: 'selfCheckAndRepair',
        parameters: [{ name: 'repair', in: 'query', schema: { type: 'boolean', default: true } }],
        responses: { '200': jsonResponse('Report'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/system/info': {
      get: {
        tags: ['system'],
        operationId: 'getSystemInfo',
        responses: { '200': jsonResponse('Instance info and limits'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/system/reindex': {
      post: {
        tags: ['system'],
        operationId: 'reindex',
        responses: { '200': jsonResponse('Reindex result'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/system/flush-webhooks': {
      post: {
        tags: ['system'],
        operationId: 'flushWebhooks',
        responses: { '200': jsonResponse('Flush result'), ...COMMON_ERRORS },
      },
    },
    '/api/v1/discover': {
      get: {
        tags: ['system'],
        operationId: 'discover',
        summary: 'Machine-readable capability map',
        description:
          'Start here. Lists every resource, its fields, filters, sorts, and the workflows this API is designed around.',
        security: [],
        responses: { '200': jsonResponse('Capabilities') },
      },
    },
    '/healthz': {
      get: {
        tags: ['system'],
        operationId: 'health',
        security: [],
        responses: { '200': jsonResponse('Alive') },
      },
    },
    '/readyz': {
      get: {
        tags: ['system'],
        operationId: 'ready',
        security: [],
        responses: { '200': jsonResponse('Ready'), '503': jsonResponse('Not ready') },
      },
    },
  });

  return {
    openapi: '3.1.0',
    info: {
      title: 'open-crm',
      version: '0.1.0',
      description:
        'A self-hosted CRM designed to be operated by humans through a web UI and by AI agents through this API, an MCP server, and a CLI — all three sharing one service layer, one permission model, and one audit trail.',
      license: { name: 'MIT' },
    },
    servers: [{ url: publicUrl }],
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An API token: `Authorization: Bearer ocrm_...`. This is how agents authenticate.',
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'ocrm_session',
          description: 'Set by POST /api/v1/auth/login. Used by the web UI.',
        },
      },
    },
    paths,
  };
}

function listSchema() {
  return {
    type: 'object',
    properties: {
      object: { const: 'list' },
      data: { type: 'array', items: { type: 'object' } },
      has_more: { type: 'boolean' },
      next_cursor: { type: ['string', 'null'] },
      total: { type: 'integer' },
    },
  };
}

function pascal(value: string): string {
  return value
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
