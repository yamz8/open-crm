import { newId } from '../core/ids.ts';
import { badRequest, conflict, notFound } from '../core/errors.ts';
import { assertCan, type Ctx } from './context.ts';
import { publish, writeAudit } from './store.ts';

export type PipelineRow = {
  id: string;
  name: string;
  is_default: number;
  created_at: string;
  updated_at: string;
};

export type StageRow = {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  probability: number;
  outcome: 'open' | 'won' | 'lost';
  created_at: string;
  updated_at: string;
};

export type StageSpec = {
  name: string;
  position?: number;
  probability?: number;
  outcome?: 'open' | 'won' | 'lost';
};

export const DEFAULT_STAGES: StageSpec[] = [
  { name: 'New', probability: 10, outcome: 'open' },
  { name: 'Qualified', probability: 25, outcome: 'open' },
  { name: 'Proposal', probability: 50, outcome: 'open' },
  { name: 'Negotiation', probability: 75, outcome: 'open' },
  { name: 'Won', probability: 100, outcome: 'won' },
  { name: 'Lost', probability: 0, outcome: 'lost' },
];

function serializeStage(row: StageRow): Record<string, unknown> {
  return { object: 'stage', ...row, _label: row.name };
}

export function serializePipeline(
  ctx: Ctx,
  row: PipelineRow,
  options: { withCounts?: boolean } = {},
): Record<string, unknown> {
  const stages = ctx.db
    .prepare('SELECT * FROM stages WHERE pipeline_id = ? ORDER BY position ASC')
    .all(row.id) as StageRow[];

  const counts = options.withCounts
    ? (ctx.db
        .prepare(
          `SELECT stage_id, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
           FROM deals WHERE pipeline_id = ? AND archived_at IS NULL AND status = 'open'
           GROUP BY stage_id`,
        )
        .all(row.id) as { stage_id: string; n: number; total: number }[])
    : [];
  const byStage = new Map(counts.map((c) => [c.stage_id, c]));

  return {
    object: 'pipeline',
    id: row.id,
    name: row.name,
    is_default: Boolean(row.is_default),
    created_at: row.created_at,
    updated_at: row.updated_at,
    _label: row.name,
    stages: stages.map((s) => {
      const stat = byStage.get(s.id);
      return {
        ...serializeStage(s),
        ...(options.withCounts
          ? { open_deal_count: stat?.n ?? 0, open_deal_amount: stat?.total ?? 0 }
          : {}),
      };
    }),
  };
}

export function listPipelines(
  ctx: Ctx,
  options: { withCounts?: boolean } = {},
): Record<string, unknown>[] {
  assertCan(ctx, 'pipelines', 'read');
  const rows = ctx.db
    .prepare('SELECT * FROM pipelines ORDER BY is_default DESC, created_at ASC')
    .all() as PipelineRow[];
  return rows.map((row) => serializePipeline(ctx, row, options));
}

export function getPipeline(ctx: Ctx, id: string, options: { withCounts?: boolean } = {}) {
  assertCan(ctx, 'pipelines', 'read');
  const row = ctx.db.prepare('SELECT * FROM pipelines WHERE id = ?').get(id) as
    PipelineRow | undefined;
  if (!row) throw notFound('pipeline', id);
  return serializePipeline(ctx, row, options);
}

export function getDefaultPipeline(ctx: Ctx): PipelineRow {
  const row = ctx.db
    .prepare('SELECT * FROM pipelines ORDER BY is_default DESC, created_at ASC LIMIT 1')
    .get() as PipelineRow | undefined;
  if (!row) {
    throw badRequest('No pipeline exists yet', {
      hint: 'Create one with POST /api/v1/pipelines, or run `open-crm seed` to install the default sales pipeline.',
    });
  }
  return row;
}

export function firstStageOf(ctx: Ctx, pipelineId: string): StageRow {
  const row = ctx.db
    .prepare(
      `SELECT * FROM stages WHERE pipeline_id = ? AND outcome = 'open' ORDER BY position ASC LIMIT 1`,
    )
    .get(pipelineId) as StageRow | undefined;
  if (row) return row;
  const any = ctx.db
    .prepare('SELECT * FROM stages WHERE pipeline_id = ? ORDER BY position ASC LIMIT 1')
    .get(pipelineId) as StageRow | undefined;
  if (!any) throw badRequest(`Pipeline ${pipelineId} has no stages`);
  return any;
}

export function getStage(ctx: Ctx, id: string): StageRow {
  const row = ctx.db.prepare('SELECT * FROM stages WHERE id = ?').get(id) as StageRow | undefined;
  if (!row) throw notFound('stage', id);
  return row;
}

export function createPipeline(
  ctx: Ctx,
  input: {
    name: string;
    is_default?: boolean;
    stages?: StageSpec[];
  },
): Record<string, unknown> {
  assertCan(ctx, 'pipelines', 'write');
  const id = newId('pipeline');
  const now = ctx.now();
  const stages = input.stages?.length ? input.stages : DEFAULT_STAGES;

  const run = ctx.db.transaction(() => {
    if (input.is_default) ctx.db.prepare('UPDATE pipelines SET is_default = 0').run();
    ctx.db
      .prepare(
        'INSERT INTO pipelines (id, name, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, input.name.trim(), input.is_default ? 1 : 0, now, now);
    stages.forEach((stage, index) => {
      ctx.db
        .prepare(
          `INSERT INTO stages (id, pipeline_id, name, position, probability, outcome, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId('stage'),
          id,
          stage.name.trim(),
          stage.position ?? index,
          stage.probability ?? 0,
          stage.outcome ?? 'open',
          now,
          now,
        );
    });
  });
  run();

  const row = ctx.db.prepare('SELECT * FROM pipelines WHERE id = ?').get(id) as PipelineRow;
  writeAudit(ctx, 'create', 'pipeline', id, null, row);
  const result = serializePipeline(ctx, row);
  publish(ctx, 'pipeline.created', 'pipeline', id, result);
  return result;
}

export function updatePipeline(
  ctx: Ctx,
  id: string,
  input: { name?: string; is_default?: boolean },
): Record<string, unknown> {
  assertCan(ctx, 'pipelines', 'write');
  const before = ctx.db.prepare('SELECT * FROM pipelines WHERE id = ?').get(id) as
    PipelineRow | undefined;
  if (!before) throw notFound('pipeline', id);

  const run = ctx.db.transaction(() => {
    if (input.is_default) ctx.db.prepare('UPDATE pipelines SET is_default = 0').run();
    ctx.db
      .prepare(
        'UPDATE pipelines SET name = COALESCE(?, name), is_default = COALESCE(?, is_default), updated_at = ? WHERE id = ?',
      )
      .run(
        input.name?.trim() ?? null,
        input.is_default === undefined ? null : input.is_default ? 1 : 0,
        ctx.now(),
        id,
      );
  });
  run();

  const row = ctx.db.prepare('SELECT * FROM pipelines WHERE id = ?').get(id) as PipelineRow;
  writeAudit(ctx, 'update', 'pipeline', id, before, row);
  return serializePipeline(ctx, row);
}

export function deletePipeline(ctx: Ctx, id: string): { deleted: true; id: string } {
  assertCan(ctx, 'pipelines', 'write');
  const before = ctx.db.prepare('SELECT * FROM pipelines WHERE id = ?').get(id) as
    PipelineRow | undefined;
  if (!before) throw notFound('pipeline', id);
  const deals = Number(
    (
      ctx.db.prepare('SELECT COUNT(*) AS n FROM deals WHERE pipeline_id = ?').get(id) as {
        n: number;
      }
    ).n,
  );
  if (deals > 0) {
    throw conflict(`Pipeline ${id} still has ${deals} deal(s)`, {
      hint: 'Move or archive those deals first.',
    });
  }
  ctx.db.prepare('DELETE FROM pipelines WHERE id = ?').run(id);
  writeAudit(ctx, 'delete', 'pipeline', id, before, null);
  return { deleted: true, id };
}

export function createStage(
  ctx: Ctx,
  pipelineId: string,
  input: {
    name: string;
    position?: number;
    probability?: number;
    outcome?: 'open' | 'won' | 'lost';
  },
): Record<string, unknown> {
  assertCan(ctx, 'pipelines', 'write');
  const pipeline = ctx.db.prepare('SELECT * FROM pipelines WHERE id = ?').get(pipelineId);
  if (!pipeline) throw notFound('pipeline', pipelineId);

  const maxPosition = Number(
    (
      ctx.db
        .prepare('SELECT COALESCE(MAX(position), -1) AS p FROM stages WHERE pipeline_id = ?')
        .get(pipelineId) as { p: number }
    ).p,
  );
  const id = newId('stage');
  const now = ctx.now();
  ctx.db
    .prepare(
      `INSERT INTO stages (id, pipeline_id, name, position, probability, outcome, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      pipelineId,
      input.name.trim(),
      input.position ?? maxPosition + 1,
      input.probability ?? 0,
      input.outcome ?? 'open',
      now,
      now,
    );

  const row = ctx.db.prepare('SELECT * FROM stages WHERE id = ?').get(id) as StageRow;
  writeAudit(ctx, 'create', 'stage', id, null, row);
  return serializeStage(row);
}

export function updateStage(
  ctx: Ctx,
  id: string,
  input: {
    name?: string;
    position?: number;
    probability?: number;
    outcome?: 'open' | 'won' | 'lost';
  },
): Record<string, unknown> {
  assertCan(ctx, 'pipelines', 'write');
  const before = getStage(ctx, id);
  ctx.db
    .prepare(
      `UPDATE stages SET name = COALESCE(?, name), position = COALESCE(?, position),
       probability = COALESCE(?, probability), outcome = COALESCE(?, outcome), updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.name?.trim() ?? null,
      input.position ?? null,
      input.probability ?? null,
      input.outcome ?? null,
      ctx.now(),
      id,
    );
  const row = ctx.db.prepare('SELECT * FROM stages WHERE id = ?').get(id) as StageRow;
  writeAudit(ctx, 'update', 'stage', id, before, row);
  return serializeStage(row);
}

export function deleteStage(ctx: Ctx, id: string): { deleted: true; id: string } {
  assertCan(ctx, 'pipelines', 'write');
  const before = getStage(ctx, id);
  const deals = Number(
    (ctx.db.prepare('SELECT COUNT(*) AS n FROM deals WHERE stage_id = ?').get(id) as { n: number })
      .n,
  );
  if (deals > 0) {
    throw conflict(`Stage ${id} still has ${deals} deal(s)`, {
      hint: 'Move those deals to another stage first with POST /api/v1/deals/{id}/move.',
    });
  }
  ctx.db.prepare('DELETE FROM stages WHERE id = ?').run(id);
  writeAudit(ctx, 'delete', 'stage', id, before, null);
  return { deleted: true, id };
}

/** Installs the default sales pipeline if none exists. Safe to call repeatedly. */
export function ensureDefaultPipeline(ctx: Ctx): PipelineRow {
  const existing = ctx.db.prepare('SELECT * FROM pipelines LIMIT 1').get() as
    PipelineRow | undefined;
  if (existing) return existing;
  createPipeline(ctx, { name: 'Sales Pipeline', is_default: true });
  return getDefaultPipeline(ctx);
}
