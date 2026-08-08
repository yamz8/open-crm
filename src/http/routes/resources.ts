import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCtx } from '../server.ts';
import { idempotent } from '../respond.ts';
import { parse, unflattenQuery } from '../validate.ts';
import * as S from '../../domain/schemas.ts';
import { RESOURCE_LIST, RESOURCES, type ResourceDef } from '../../domain/resources.ts';
import { archive, create, get, list, remove, restore, update } from '../../domain/store.ts';
import { closeDeal, createDeal, moveDeal, updateDeal } from '../../domain/deals.ts';
import { recordContext, search } from '../../domain/search.ts';
import {
  addTags,
  createTag,
  deleteTag,
  listTags,
  removeTag,
  tagsFor,
  updateTag,
} from '../../domain/tags.ts';
import { getAudit, listAudit, revert } from '../../domain/audit.ts';
import { createView, deleteView, listViews, updateView } from '../../domain/views.ts';
import { badRequest } from '../../core/errors.ts';
import type { Ctx } from '../../domain/context.ts';

const MAX_BULK = 200;

function listInputFrom(def: ResourceDef, rawQuery: unknown) {
  const query = parse(
    S.listQuery,
    unflattenQuery(rawQuery as Record<string, unknown>),
    `${def.plural} query`,
  );
  const tag = (rawQuery as Record<string, unknown>)['tag'];
  return { ...query, ...(typeof tag === 'string' ? { tag } : {}) };
}

function expectedVersion(request: { headers: Record<string, unknown> }): number | undefined {
  const raw = request.headers['if-match'];
  if (typeof raw !== 'string') return undefined;
  const value = Number.parseInt(raw.replace(/"/g, ''), 10);
  if (Number.isNaN(value)) {
    throw badRequest('If-Match must be the integer `version` from the record you read', {
      hint: 'Omit the header to overwrite unconditionally.',
    });
  }
  return value;
}

/** Create dispatch: deals have a state machine, everything else is uniform. */
function createRecord(ctx: Ctx, def: ResourceDef, body: unknown): Record<string, unknown> {
  const input = parse(def.createSchema, body, def.name) as Record<string, unknown>;
  if (def.name === 'deal') return createDeal(ctx, input);
  if (def.name === 'activity') {
    return create(
      ctx,
      def,
      { occurred_at: ctx.now(), ...input },
      {
        extra: {
          actor_type: ctx.actor.type,
          actor_id: ctx.actor.id,
          actor_label: ctx.actor.label,
        },
      },
    );
  }
  return create(ctx, def, input);
}

function updateRecord(
  ctx: Ctx,
  def: ResourceDef,
  id: string,
  body: unknown,
  version?: number,
): Record<string, unknown> {
  const input = parse(def.updateSchema, body, def.name) as Record<string, unknown>;
  const options = version === undefined ? {} : { expectedVersion: version };
  if (def.name === 'deal') return updateDeal(ctx, id, input, options);
  return update(ctx, def, id, input, options);
}

export async function registerResourceRoutes(fastify: FastifyInstance): Promise<void> {
  for (const def of RESOURCE_LIST) {
    const base = `/${def.plural}`;

    fastify.get(base, async (request) =>
      list(requireCtx(request), def, listInputFrom(def, request.query)),
    );

    fastify.post(base, async (request, reply) =>
      idempotent(request, reply, 201, () => createRecord(requireCtx(request), def, request.body)),
    );

    /**
     * Bulk create in one transaction. Agents importing a list would otherwise
     * fire N requests and leave a half-imported dataset behind on failure.
     */
    fastify.post(`${base}/bulk`, async (request, reply) => {
      const ctx = requireCtx(request);
      const body = parse(
        z.object({
          records: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_BULK),
          on_error: z.enum(['abort', 'skip']).default('abort'),
        }),
        request.body,
        `${def.plural} bulk payload`,
      );

      return idempotent(request, reply, 201, () => {
        if (body.on_error === 'abort') {
          const run = ctx.db.transaction(() =>
            body.records.map((record) => createRecord(ctx, def, record)),
          );
          const created = run();
          return {
            object: 'bulk_result',
            created: created.length,
            failed: 0,
            data: created,
            errors: [],
          };
        }

        const data: Record<string, unknown>[] = [];
        const errors: { index: number; error: unknown }[] = [];
        body.records.forEach((record, index) => {
          try {
            data.push(createRecord(ctx, def, record));
          } catch (error) {
            errors.push({
              index,
              error:
                error && typeof error === 'object' && 'toJSON' in error
                  ? (error as { toJSON: () => unknown }).toJSON()
                  : { message: String(error) },
            });
          }
        });
        return { object: 'bulk_result', created: data.length, failed: errors.length, data, errors };
      });
    });

    fastify.get<{ Params: { id: string } }>(`${base}/:id`, async (request) => {
      const ctx = requireCtx(request);
      const record = get(ctx, def, request.params.id);
      return def.taggable ? { ...record, tags: tagsFor(ctx, def.name, request.params.id) } : record;
    });

    /** Record + tags + related records + timeline + open tasks, in one call. */
    fastify.get<{ Params: { id: string }; Querystring: { activity_limit?: string } }>(
      `${base}/:id/context`,
      async (request) =>
        recordContext(requireCtx(request), def.name, request.params.id, {
          ...(request.query.activity_limit
            ? { activityLimit: Number(request.query.activity_limit) }
            : {}),
        }),
    );

    fastify.patch<{ Params: { id: string } }>(`${base}/:id`, async (request) =>
      updateRecord(
        requireCtx(request),
        def,
        request.params.id,
        request.body,
        expectedVersion(request as never),
      ),
    );

    fastify.delete<{ Params: { id: string }; Querystring: { hard?: string } }>(
      `${base}/:id`,
      async (request) => {
        const ctx = requireCtx(request);
        if (request.query.hard === 'true') return remove(ctx, def, request.params.id);
        return archive(ctx, def, request.params.id);
      },
    );

    fastify.post<{ Params: { id: string } }>(`${base}/:id/restore`, async (request) =>
      restore(requireCtx(request), def, request.params.id),
    );

    if (def.taggable) {
      fastify.post<{ Params: { id: string } }>(`${base}/:id/tags`, async (request) => {
        const input = parse(S.taggingInput, request.body, 'tag payload');
        return {
          object: 'list',
          data: addTags(requireCtx(request), def.name, request.params.id, input.tags),
        };
      });

      fastify.delete<{ Params: { id: string; name: string } }>(
        `${base}/:id/tags/:name`,
        async (request) => ({
          object: 'list',
          data: removeTag(requireCtx(request), def.name, request.params.id, request.params.name),
        }),
      );
    }
  }

  // -- Deal state machine ----------------------------------------------------

  fastify.post<{ Params: { id: string } }>('/deals/:id/move', async (request, reply) => {
    const input = parse(S.dealMove, request.body, 'deal move');
    return idempotent(request, reply, 200, () =>
      moveDeal(requireCtx(request), request.params.id, input),
    );
  });

  fastify.post<{ Params: { id: string } }>('/deals/:id/close', async (request, reply) => {
    const input = parse(S.dealClose, request.body, 'deal close');
    return idempotent(request, reply, 200, () =>
      closeDeal(requireCtx(request), request.params.id, input),
    );
  });

  // -- Task shortcut ---------------------------------------------------------

  fastify.post<{ Params: { id: string } }>('/tasks/:id/complete', async (request) => {
    const ctx = requireCtx(request);
    return update(
      ctx,
      RESOURCES['task']!,
      request.params.id,
      { status: 'done' },
      {
        extra: { completed_at: ctx.now() },
        eventType: 'task.completed',
      },
    );
  });

  // -- Search ----------------------------------------------------------------

  fastify.get('/search', async (request) => {
    const raw = request.query as Record<string, unknown>;
    const types =
      typeof raw['types'] === 'string' ? raw['types'].split(',').filter(Boolean) : undefined;
    const input = parse(S.searchQuery, { ...raw, ...(types ? { types } : {}) }, 'search query');
    return search(requireCtx(request), input);
  });

  // -- Tags ------------------------------------------------------------------

  fastify.get('/tags', async (request) => ({
    object: 'list',
    data: listTags(requireCtx(request)),
  }));

  fastify.post('/tags', async (request, reply) => {
    reply.status(201);
    return createTag(requireCtx(request), parse(S.tagCreate, request.body, 'tag'));
  });

  fastify.patch<{ Params: { id: string } }>('/tags/:id', async (request) =>
    updateTag(requireCtx(request), request.params.id, parse(S.tagUpdate, request.body, 'tag')),
  );

  fastify.delete<{ Params: { id: string } }>('/tags/:id', async (request) =>
    deleteTag(requireCtx(request), request.params.id),
  );

  // -- Audit trail -----------------------------------------------------------

  fastify.get('/audit', async (request) => {
    const raw = request.query as Record<string, string | undefined>;
    return listAudit(requireCtx(request), {
      entity_type: raw['entity_type'],
      entity_id: raw['entity_id'],
      actor_type: raw['actor_type'],
      actor_id: raw['actor_id'],
      action: raw['action'],
      source: raw['source'],
      since: raw['since'],
      until: raw['until'],
      cursor: raw['cursor'],
      limit: raw['limit'] ? Number(raw['limit']) : undefined,
    });
  });

  fastify.get<{ Params: { id: string } }>('/audit/:id', async (request) =>
    getAudit(requireCtx(request), request.params.id),
  );

  fastify.post<{ Params: { id: string } }>('/audit/:id/revert', async (request, reply) =>
    idempotent(request, reply, 200, () => revert(requireCtx(request), request.params.id)),
  );

  // -- Saved views -----------------------------------------------------------

  fastify.get<{ Querystring: { entity_type?: string } }>('/views', async (request) => ({
    object: 'list',
    data: listViews(requireCtx(request), request.query.entity_type),
  }));

  fastify.post('/views', async (request, reply) => {
    reply.status(201);
    return createView(requireCtx(request), parse(S.savedViewCreate, request.body, 'saved view'));
  });

  fastify.patch<{ Params: { id: string } }>('/views/:id', async (request) =>
    updateView(
      requireCtx(request),
      request.params.id,
      parse(S.savedViewUpdate, request.body, 'saved view'),
    ),
  );

  fastify.delete<{ Params: { id: string } }>('/views/:id', async (request) =>
    deleteView(requireCtx(request), request.params.id),
  );
}
