import type { FastifyInstance } from 'fastify';
import { requireCtx } from '../server.ts';
import { selfCheck } from '../../domain/selfcheck.ts';
import { reindexAll } from '../../domain/search.ts';
import { assertCan } from '../../domain/context.ts';
import {
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  updateWebhook,
} from '../../domain/webhooks.ts';
import { parse } from '../validate.ts';
import * as S from '../../domain/schemas.ts';
import { pendingMigrations } from '../../db/index.ts';

export async function registerSystemRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.app;

  /**
   * The instance inspecting itself. `repair=true` fixes what it safely can and
   * reports what it did, so an operator (or an agent) can resolve drift without
   * shell access.
   */
  fastify.get<{ Querystring: { repair?: string } }>('/system/selfcheck', async (request, reply) => {
    const report = selfCheck(requireCtx(request), app.config, {
      repair: request.query.repair === 'true',
    });
    if (report.status === 'fail') reply.status(503);
    return report;
  });

  fastify.post<{ Querystring: { repair?: string } }>(
    '/system/selfcheck',
    async (request, reply) => {
      const report = selfCheck(requireCtx(request), app.config, {
        repair: request.query.repair !== 'false',
      });
      if (report.status === 'fail') reply.status(503);
      return report;
    },
  );

  fastify.post('/system/reindex', async (request) => ({
    object: 'reindex_result',
    ...reindexAll(requireCtx(request)),
  }));

  fastify.get('/system/info', async (request) => {
    const ctx = requireCtx(request);
    assertCan(ctx, 'system', 'read');
    const migrations = pendingMigrations(app.db);
    return {
      object: 'system_info',
      environment: app.config.env,
      public_url: app.config.publicUrl,
      database: app.config.databaseUrl === ':memory:' ? 'memory' : 'sqlite',
      node_version: process.version,
      uptime_s: Math.round(process.uptime()),
      migrations: {
        applied: migrations.notApplied.length === 0,
        pending: migrations.notApplied,
      },
      limits: {
        rate_limit_max: app.config.rateLimitMax,
        rate_limit_window_ms: app.config.rateLimitWindowMs,
        max_page_size: 200,
        max_bulk_records: 200,
      },
    };
  });

  /** Drains the webhook queue immediately instead of waiting for the timer. */
  fastify.post('/system/flush-webhooks', async (request) => {
    const ctx = requireCtx(request);
    assertCan(ctx, 'system', 'admin');
    await app.tick();
    return { object: 'flush_result', ok: true };
  });

  // -- Webhooks -------------------------------------------------------------

  fastify.get('/webhooks', async (request) => ({
    object: 'list',
    data: listWebhooks(requireCtx(request)),
  }));

  fastify.post('/webhooks', async (request, reply) => {
    reply.status(201);
    return createWebhook(requireCtx(request), parse(S.webhookCreate, request.body, 'webhook'));
  });

  fastify.patch<{ Params: { id: string } }>('/webhooks/:id', async (request) =>
    updateWebhook(
      requireCtx(request),
      request.params.id,
      parse(S.webhookUpdate, request.body, 'webhook'),
    ),
  );

  fastify.delete<{ Params: { id: string } }>('/webhooks/:id', async (request) =>
    deleteWebhook(requireCtx(request), request.params.id),
  );

  fastify.get<{ Params: { id: string } }>('/webhooks/:id/deliveries', async (request) => ({
    object: 'list',
    data: listDeliveries(requireCtx(request), request.params.id),
  }));
}
