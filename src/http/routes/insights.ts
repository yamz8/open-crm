import type { FastifyInstance } from 'fastify';
import { requireCtx } from '../server.ts';
import { overview, workQueue } from '../../domain/insights.ts';
import { pipelineSummary } from '../../domain/deals.ts';

export async function registerInsightRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { days?: string } }>('/insights/overview', async (request) =>
    overview(requireCtx(request), {
      ...(request.query.days ? { days: Number(request.query.days) } : {}),
    }),
  );

  fastify.get<{ Querystring: { assignee_id?: string; stale_days?: string; limit?: string } }>(
    '/insights/work-queue',
    async (request) =>
      workQueue(requireCtx(request), {
        ...(request.query.assignee_id ? { assignee_id: request.query.assignee_id } : {}),
        ...(request.query.stale_days ? { stale_days: Number(request.query.stale_days) } : {}),
        ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
      }),
  );

  fastify.get<{ Querystring: { pipeline_id?: string } }>('/insights/pipeline', async (request) =>
    pipelineSummary(requireCtx(request), request.query.pipeline_id),
  );
}
