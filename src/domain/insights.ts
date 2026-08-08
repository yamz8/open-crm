import { assertCan, can, type Ctx } from './context.ts';
import { RESOURCES } from './resources.ts';
import { serialize, type Row } from './store.ts';

function count(ctx: Ctx, sql: string, ...params: unknown[]): number {
  return Number((ctx.db.prepare(sql).get(...params) as { n: number }).n);
}

/**
 * The numbers a person wants on a home screen and an agent wants before it
 * decides what to work on. Deliberately one call, not eight.
 */
export function overview(ctx: Ctx, options: { days?: number } = {}): Record<string, unknown> {
  assertCan(ctx, 'insights', 'read');
  const days = Math.min(Math.max(options.days ?? 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const now = new Date().toISOString();

  const openDeals = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
       FROM deals WHERE status = 'open' AND archived_at IS NULL`,
    )
    .get() as { n: number; total: number };

  const won = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total
       FROM deals WHERE status = 'won' AND archived_at IS NULL AND closed_at >= ?`,
    )
    .get(since) as { n: number; total: number };

  const lost = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM deals WHERE status = 'lost' AND archived_at IS NULL AND closed_at >= ?`,
    )
    .get(since) as { n: number };

  const closedTotal = won.n + lost.n;

  return {
    object: 'overview',
    window_days: days,
    generated_at: now,
    counts: {
      contacts: count(ctx, 'SELECT COUNT(*) AS n FROM contacts WHERE archived_at IS NULL'),
      companies: count(ctx, 'SELECT COUNT(*) AS n FROM companies WHERE archived_at IS NULL'),
      deals_open: openDeals.n,
      tasks_open: count(
        ctx,
        `SELECT COUNT(*) AS n FROM tasks WHERE status = 'open' AND archived_at IS NULL`,
      ),
      tasks_overdue: count(
        ctx,
        `SELECT COUNT(*) AS n FROM tasks WHERE status = 'open' AND archived_at IS NULL AND due_at IS NOT NULL AND due_at < ?`,
        now,
      ),
      activities_in_window: count(
        ctx,
        'SELECT COUNT(*) AS n FROM activities WHERE occurred_at >= ?',
        since,
      ),
      contacts_added_in_window: count(
        ctx,
        'SELECT COUNT(*) AS n FROM contacts WHERE created_at >= ? AND archived_at IS NULL',
        since,
      ),
    },
    revenue: {
      currency: defaultCurrency(ctx),
      open_pipeline: openDeals.total,
      won_in_window: won.total,
      won_count: won.n,
      lost_count: lost.n,
      win_rate: closedTotal === 0 ? null : Math.round((won.n / closedTotal) * 1000) / 10,
      average_won_deal: won.n === 0 ? 0 : Math.round(won.total / won.n),
    },
    lifecycle: ctx.db
      .prepare(
        `SELECT lifecycle_stage AS stage, COUNT(*) AS n FROM contacts
         WHERE archived_at IS NULL GROUP BY lifecycle_stage ORDER BY n DESC`,
      )
      .all(),
    activity_by_type: ctx.db
      .prepare(
        `SELECT type, COUNT(*) AS n FROM activities WHERE occurred_at >= ? GROUP BY type ORDER BY n DESC`,
      )
      .all(since),
    activity_by_actor: ctx.db
      .prepare(
        `SELECT actor_type, actor_label, COUNT(*) AS n FROM activities
         WHERE occurred_at >= ? GROUP BY actor_type, actor_label ORDER BY n DESC LIMIT 10`,
      )
      .all(since),
  };
}

function defaultCurrency(ctx: Ctx): string {
  const row = ctx.db
    .prepare(`SELECT currency, COUNT(*) AS n FROM deals GROUP BY currency ORDER BY n DESC LIMIT 1`)
    .get() as { currency: string } | undefined;
  return row?.currency ?? 'USD';
}

/**
 * "What should be worked on right now" — overdue tasks, stale open deals, and
 * contacts nobody has touched. Designed to be the first call in an agent's loop.
 */
export function workQueue(
  ctx: Ctx,
  options: { assignee_id?: string; stale_days?: number; limit?: number } = {},
): Record<string, unknown> {
  assertCan(ctx, 'insights', 'read');
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const staleDays = Math.min(Math.max(options.stale_days ?? 14, 1), 365);
  const staleBefore = new Date(Date.now() - staleDays * 86_400_000).toISOString();
  const now = new Date().toISOString();

  const assigneeClause = options.assignee_id ? 'AND assignee_id = ?' : '';
  const assigneeParams = options.assignee_id ? [options.assignee_id] : [];

  const overdueTasks = can(ctx, 'tasks', 'read')
    ? (ctx.db
        .prepare(
          `SELECT * FROM tasks WHERE status = 'open' AND archived_at IS NULL
           AND due_at IS NOT NULL AND due_at < ? ${assigneeClause}
           ORDER BY due_at ASC LIMIT ?`,
        )
        .all(now, ...assigneeParams, limit) as Row[])
    : [];

  const dueSoon = can(ctx, 'tasks', 'read')
    ? (ctx.db
        .prepare(
          `SELECT * FROM tasks WHERE status = 'open' AND archived_at IS NULL
           AND due_at IS NOT NULL AND due_at >= ? AND due_at <= ? ${assigneeClause}
           ORDER BY due_at ASC LIMIT ?`,
        )
        .all(
          now,
          new Date(Date.now() + 7 * 86_400_000).toISOString(),
          ...assigneeParams,
          limit,
        ) as Row[])
    : [];

  // A deal is stale when nothing has been logged against it recently, which is
  // a better signal than updated_at (bulk edits shouldn't reset the clock).
  const staleDeals = can(ctx, 'deals', 'read')
    ? (ctx.db
        .prepare(
          `SELECT d.* FROM deals d
           WHERE d.status = 'open' AND d.archived_at IS NULL
             AND COALESCE(
                   (SELECT MAX(a.occurred_at) FROM activities a WHERE a.deal_id = d.id),
                   d.created_at
                 ) < ?
           ORDER BY d.amount DESC LIMIT ?`,
        )
        .all(staleBefore, limit) as Row[])
    : [];

  const untouchedContacts = can(ctx, 'contacts', 'read')
    ? (ctx.db
        .prepare(
          `SELECT c.* FROM contacts c
           WHERE c.archived_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.contact_id = c.id)
           ORDER BY c.created_at ASC LIMIT ?`,
        )
        .all(limit) as Row[])
    : [];

  return {
    object: 'work_queue',
    generated_at: now,
    stale_days: staleDays,
    overdue_tasks: overdueTasks.map((r) => serialize(RESOURCES['task']!, r)),
    tasks_due_soon: dueSoon.map((r) => serialize(RESOURCES['task']!, r)),
    stale_deals: staleDeals.map((r) => serialize(RESOURCES['deal']!, r)),
    contacts_never_contacted: untouchedContacts.map((r) => serialize(RESOURCES['contact']!, r)),
    suggested_next_action: suggestion(
      overdueTasks.length,
      staleDeals.length,
      untouchedContacts.length,
    ),
  };
}

function suggestion(overdue: number, stale: number, untouched: number): string {
  if (overdue > 0) return `Clear ${overdue} overdue task(s) first.`;
  if (stale > 0)
    return `${stale} open deal(s) have gone quiet — log an activity or move the stage.`;
  if (untouched > 0) return `${untouched} contact(s) have never been contacted.`;
  return 'Nothing is overdue or stale. Good place to prospect.';
}
