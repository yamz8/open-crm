import type { FastifyInstance } from 'fastify';
import { requireCtx } from '../server.ts';
import { parse } from '../validate.ts';
import * as S from '../../domain/schemas.ts';
import {
  createPipeline,
  createStage,
  deletePipeline,
  deleteStage,
  getPipeline,
  listPipelines,
  updatePipeline,
  updateStage,
} from '../../domain/pipelines.ts';

export async function registerPipelineRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { counts?: string } }>('/pipelines', async (request) => ({
    object: 'list',
    data: listPipelines(requireCtx(request), { withCounts: request.query.counts !== 'false' }),
  }));

  fastify.post('/pipelines', async (request, reply) => {
    reply.status(201);
    return createPipeline(requireCtx(request), parse(S.pipelineCreate, request.body, 'pipeline'));
  });

  fastify.get<{ Params: { id: string } }>('/pipelines/:id', async (request) =>
    getPipeline(requireCtx(request), request.params.id, { withCounts: true }),
  );

  fastify.patch<{ Params: { id: string } }>('/pipelines/:id', async (request) =>
    updatePipeline(
      requireCtx(request),
      request.params.id,
      parse(S.pipelineUpdate, request.body, 'pipeline'),
    ),
  );

  fastify.delete<{ Params: { id: string } }>('/pipelines/:id', async (request) =>
    deletePipeline(requireCtx(request), request.params.id),
  );

  fastify.post<{ Params: { id: string } }>('/pipelines/:id/stages', async (request, reply) => {
    reply.status(201);
    return createStage(
      requireCtx(request),
      request.params.id,
      parse(S.stageCreate, request.body, 'stage'),
    );
  });

  fastify.patch<{ Params: { id: string } }>('/stages/:id', async (request) =>
    updateStage(
      requireCtx(request),
      request.params.id,
      parse(S.stageUpdate, request.body, 'stage'),
    ),
  );

  fastify.delete<{ Params: { id: string } }>('/stages/:id', async (request) =>
    deleteStage(requireCtx(request), request.params.id),
  );
}
