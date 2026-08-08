import { badRequest, notFound } from '../core/errors.ts';
import { assertCan, type Ctx } from './context.ts';
import { activityResource, dealResource } from './resources.ts';
import { create, getRow, publish, serialize, update } from './store.ts';
import { firstStageOf, getDefaultPipeline, getStage } from './pipelines.ts';

/**
 * Deals carry the only real state machine in the CRM, so their writes go through
 * this module rather than the generic store: stage, status, and the timeline
 * entry that explains the move have to change together or not at all.
 */

export function createDeal(ctx: Ctx, input: Record<string, unknown>): Record<string, unknown> {
  assertCan(ctx, 'deals', 'write');

  const pipelineId = (input['pipeline_id'] as string | undefined) ?? getDefaultPipeline(ctx).id;
  const stage = input['stage_id']
    ? getStage(ctx, input['stage_id'] as string)
    : firstStageOf(ctx, pipelineId);

  if (stage.pipeline_id !== pipelineId) {
    throw badRequest(
      `Stage ${stage.id} belongs to pipeline ${stage.pipeline_id}, not ${pipelineId}`,
      {
        hint: 'Pass a stage_id from the same pipeline, or omit pipeline_id to infer it from the stage.',
      },
    );
  }

  const status = stage.outcome === 'open' ? 'open' : stage.outcome;
  const deal = create(ctx, dealResource, input, {
    extra: {
      pipeline_id: pipelineId,
      stage_id: stage.id,
      status,
      closed_at: status === 'open' ? null : ctx.now(),
    },
  });

  logSystemActivity(ctx, {
    type: 'system',
    subject: `Deal created in ${stage.name}`,
    deal_id: String(deal['id']),
    company_id: (deal['company_id'] as string | null) ?? null,
    contact_id: (deal['contact_id'] as string | null) ?? null,
  });

  return deal;
}

export function updateDeal(
  ctx: Ctx,
  id: string,
  input: Record<string, unknown>,
  options: { expectedVersion?: number } = {},
): Record<string, unknown> {
  const before = getRow(ctx, dealResource, id);
  if (!before) throw notFound('deal', id);

  const extra: Record<string, unknown> = {};
  if (input['stage_id'] && input['stage_id'] !== before['stage_id']) {
    return moveDeal(ctx, id, { stage_id: String(input['stage_id']) }, input);
  }
  if (input['status'] && input['status'] !== before['status']) {
    extra['closed_at'] = input['status'] === 'open' ? null : ctx.now();
  }

  return update(ctx, dealResource, id, input, { extra, ...options });
}

export function moveDeal(
  ctx: Ctx,
  id: string,
  input: { stage_id: string; note?: string },
  extraFields: Record<string, unknown> = {},
): Record<string, unknown> {
  assertCan(ctx, 'deals', 'write');
  const before = getRow(ctx, dealResource, id);
  if (!before) throw notFound('deal', id);

  const target = getStage(ctx, input.stage_id);
  if (target.pipeline_id !== before['pipeline_id']) {
    throw badRequest(`Stage ${target.id} belongs to a different pipeline than deal ${id}`, {
      hint: 'Update the deal pipeline_id and stage_id together if you intend to move pipelines.',
    });
  }
  if (before['stage_id'] === target.id) return serialize(dealResource, before);

  const fromStage = getStage(ctx, String(before['stage_id']));
  const status = target.outcome === 'open' ? 'open' : target.outcome;

  const deal = update(
    ctx,
    dealResource,
    id,
    { ...extraFields, stage_id: undefined },
    {
      extra: {
        stage_id: target.id,
        status,
        closed_at: status === 'open' ? null : ctx.now(),
      },
      silent: true,
    },
  );

  logSystemActivity(ctx, {
    type: 'stage_change',
    subject: `${fromStage.name} → ${target.name}`,
    body: input.note ?? null,
    deal_id: id,
    company_id: (deal['company_id'] as string | null) ?? null,
    contact_id: (deal['contact_id'] as string | null) ?? null,
    properties: { from_stage_id: fromStage.id, to_stage_id: target.id, status },
  });

  publish(ctx, 'deal.stage_changed', 'deal', id, deal, {
    from_stage: { id: fromStage.id, name: fromStage.name },
    to_stage: { id: target.id, name: target.name },
  });
  if (status !== 'open') publish(ctx, `deal.${status}`, 'deal', id, deal);

  return deal;
}

export function closeDeal(
  ctx: Ctx,
  id: string,
  input: { outcome: 'won' | 'lost'; reason?: string; amount?: number },
): Record<string, unknown> {
  assertCan(ctx, 'deals', 'write');
  const before = getRow(ctx, dealResource, id);
  if (!before) throw notFound('deal', id);

  // Prefer moving to a terminal stage so the board reflects reality; fall back to
  // just flipping status when the pipeline has no won/lost stage.
  const terminal = ctx.db
    .prepare(
      'SELECT * FROM stages WHERE pipeline_id = ? AND outcome = ? ORDER BY position ASC LIMIT 1',
    )
    .get(before['pipeline_id'], input.outcome) as { id: string } | undefined;

  const patch: Record<string, unknown> = {};
  if (input.amount !== undefined) patch['amount'] = input.amount;
  if (input.outcome === 'lost' && input.reason) patch['lost_reason'] = input.reason;

  if (terminal) {
    return moveDeal(
      ctx,
      id,
      { stage_id: terminal.id, ...(input.reason ? { note: input.reason } : {}) },
      patch,
    );
  }

  const deal = update(ctx, dealResource, id, patch, {
    extra: { status: input.outcome, closed_at: ctx.now() },
    silent: true,
  });
  logSystemActivity(ctx, {
    type: 'system',
    subject: `Deal marked ${input.outcome}`,
    body: input.reason ?? null,
    deal_id: id,
  });
  publish(ctx, `deal.${input.outcome}`, 'deal', id, deal);
  return deal;
}

export function logSystemActivity(
  ctx: Ctx,
  input: {
    type: string;
    subject?: string | null;
    body?: string | null;
    deal_id?: string | null;
    contact_id?: string | null;
    company_id?: string | null;
    properties?: Record<string, unknown>;
  },
): void {
  create(
    ctx,
    activityResource,
    {
      type: input.type,
      subject: input.subject ?? null,
      body: input.body ?? null,
      deal_id: input.deal_id ?? null,
      contact_id: input.contact_id ?? null,
      company_id: input.company_id ?? null,
      occurred_at: ctx.now(),
      properties: input.properties ?? {},
    },
    {
      extra: {
        actor_type: ctx.actor.type,
        actor_id: ctx.actor.id,
        actor_label: ctx.actor.label,
      },
      silent: true,
    },
  );
}

/** Aggregate pipeline value grouped by stage — the number every sales dashboard opens with. */
export function pipelineSummary(ctx: Ctx, pipelineId?: string): Record<string, unknown> {
  assertCan(ctx, 'deals', 'read');
  const pipeline = pipelineId
    ? (ctx.db.prepare('SELECT * FROM pipelines WHERE id = ?').get(pipelineId) as
        { id: string; name: string } | undefined)
    : getDefaultPipeline(ctx);
  if (!pipeline) throw notFound('pipeline', pipelineId!);

  const rows = ctx.db
    .prepare(
      `SELECT s.id AS stage_id, s.name AS stage_name, s.position, s.probability, s.outcome,
              COUNT(d.id) AS deal_count,
              COALESCE(SUM(d.amount), 0) AS total_amount,
              COALESCE(SUM(d.amount * s.probability / 100), 0) AS weighted_amount
       FROM stages s
       LEFT JOIN deals d
         ON d.stage_id = s.id AND d.archived_at IS NULL AND d.status = 'open'
       WHERE s.pipeline_id = ?
       GROUP BY s.id
       ORDER BY s.position ASC`,
    )
    .all(pipeline.id) as Record<string, unknown>[];

  const totals = rows.reduce<{ deal_count: number; total_amount: number; weighted_amount: number }>(
    (acc, row) => ({
      deal_count: acc.deal_count + Number(row['deal_count']),
      total_amount: acc.total_amount + Number(row['total_amount']),
      weighted_amount: acc.weighted_amount + Number(row['weighted_amount']),
    }),
    { deal_count: 0, total_amount: 0, weighted_amount: 0 },
  );

  return {
    object: 'pipeline_summary',
    pipeline: { id: pipeline.id, name: pipeline.name },
    stages: rows,
    totals,
  };
}
