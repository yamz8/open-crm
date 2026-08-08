import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createRecord, type Harness } from '../testing.ts';

/**
 * The browser UI reads specific fields out of specific responses. Renaming one
 * of them server-side is a silent break: types do not connect the two sides,
 * because the wire format is JSON.
 *
 * This suite pins the exact field names `src/web/app.ts` depends on. If you
 * rename a response field, this fails and points at the view to update.
 */

function assertFields(value: unknown, path: string, fields: string[]): void {
  assert.ok(value && typeof value === 'object', `${path} should be an object, got ${typeof value}`);
  for (const field of fields) {
    assert.ok(
      field in (value as Record<string, unknown>),
      `${path}.${field} is read by the web UI but is missing from the response`,
    );
  }
}

describe('web UI response contract', () => {
  let h: Harness;
  let contactId: string;
  let dealId: string;

  before(async () => {
    h = await createHarness({ seed: true });
    const contacts = await h.api('GET', '/api/v1/contacts?limit=1');
    contactId = contacts.body.data[0].id;
    const deals = await h.api('GET', '/api/v1/deals?limit=1');
    dealId = deals.body.data[0].id;
  });
  after(async () => {
    await h.close();
  });

  test('identity powers the sidebar', async () => {
    const { body } = await h.api('GET', '/api/v1/auth/me');
    assertFields(body.actor, 'actor', ['label', 'role', 'type']);
  });

  test('setup status drives the login vs first-run screen', async () => {
    const { body } = await h.api('GET', '/api/v1/setup', { token: null });
    assertFields(body, 'setup', ['complete']);
  });

  test('overview powers the dashboard stat tiles', async () => {
    const { body } = await h.api('GET', '/api/v1/insights/overview');
    assertFields(body, 'overview', ['window_days', 'counts', 'revenue']);
    assertFields(body.counts, 'counts', [
      'contacts',
      'companies',
      'deals_open',
      'tasks_open',
      'tasks_overdue',
    ]);
    assertFields(body.revenue, 'revenue', [
      'currency',
      'open_pipeline',
      'won_in_window',
      'win_rate',
      'won_count',
      'lost_count',
    ]);
  });

  test('work queue powers the attention panel', async () => {
    const { body } = await h.api('GET', '/api/v1/insights/work-queue');
    assertFields(body, 'work_queue', [
      'overdue_tasks',
      'stale_deals',
      'stale_days',
      'suggested_next_action',
    ]);
  });

  test('pipeline summary powers the dashboard table', async () => {
    const { body } = await h.api('GET', '/api/v1/insights/pipeline');
    assertFields(body.pipeline, 'pipeline', ['name']);
    assertFields(body.totals, 'totals', ['weighted_amount']);
    assertFields(body.stages[0], 'stages[0]', [
      'stage_name',
      'probability',
      'deal_count',
      'total_amount',
      'weighted_amount',
    ]);
  });

  test('lists have the envelope the table renderer expects', async () => {
    for (const plural of ['contacts', 'companies', 'deals', 'tasks', 'activities']) {
      const { body } = await h.api('GET', `/api/v1/${plural}?limit=1`);
      assertFields(body, plural, ['object', 'data', 'total', 'has_more', 'next_cursor']);
      assertFields(body.data[0], `${plural}[0]`, ['id', '_label']);
    }
  });

  test('record columns exist for every list view', async () => {
    const cases: [string, string[]][] = [
      ['contacts', ['email', 'title', 'lifecycle_stage', 'created_at']],
      ['companies', ['name', 'domain', 'industry', 'size', 'created_at']],
      [
        'deals',
        ['title', 'amount', 'amount_formatted', 'status', 'close_date', 'stage_id', 'pipeline_id'],
      ],
      ['tasks', ['title', 'due_at', 'priority', 'status']],
      ['activities', ['type', 'actor_label', 'actor_type', 'occurred_at']],
    ];
    for (const [plural, fields] of cases) {
      const { body } = await h.api('GET', `/api/v1/${plural}?limit=1`);
      assertFields(body.data[0], `${plural}[0]`, fields);
    }
  });

  test('pipelines expose the stage ids the board and move picker need', async () => {
    const { body } = await h.api('GET', '/api/v1/pipelines');
    assertFields(body.data[0], 'pipeline', ['id', 'name', 'stages']);
    assertFields(body.data[0].stages[0], 'stage', ['id', 'name', 'outcome']);
  });

  test('context powers every detail page', async () => {
    const { body } = await h.api('GET', `/api/v1/contacts/${contactId}/context`);
    assertFields(body, 'context', ['record', 'tags', 'related', 'timeline', 'open_tasks']);
    assertFields(body.timeline[0], 'timeline[0]', [
      'type',
      'subject',
      'body',
      'actor_label',
      'actor_type',
      'occurred_at',
    ]);

    const deal = await h.api('GET', `/api/v1/deals/${dealId}/context`);
    assertFields(deal.body.related, 'deal.related', ['stage', 'pipeline']);
    assertFields(deal.body.related.stage, 'deal.related.stage', ['id', 'name']);
  });

  test('tags carry the colour the detail page renders', async () => {
    const contacts = await h.api('GET', '/api/v1/contacts?tag=champion');
    const tagged = contacts.body.data[0];
    if (!tagged) return;
    const { body } = await h.api('GET', `/api/v1/contacts/${tagged.id}/context`);
    assertFields(body.tags[0], 'tags[0]', ['name', 'color']);
  });

  test('search hits render in the command palette', async () => {
    const { body } = await h.api('GET', '/api/v1/search?q=verity');
    assertFields(body.data[0], 'hit', ['entity_type', 'entity_id', 'title', 'snippet']);
  });

  test('audit entries render in the audit table', async () => {
    await h.api('PATCH', `/api/v1/contacts/${contactId}`, { body: { title: 'Contract test' } });
    const { body } = await h.api('GET', '/api/v1/audit?limit=1');
    assertFields(body.data[0], 'audit', [
      'at',
      'actor',
      'action',
      'entity_type',
      'entity_id',
      'changes',
      'reversible',
      'reverted',
    ]);
    assertFields(body.data[0].actor, 'audit.actor', ['type', 'label']);
  });

  test('tokens and webhooks render on the agents page', async () => {
    const tokens = await h.api('GET', '/api/v1/tokens');
    assertFields(tokens.body.data[0], 'token', ['id', 'name', 'scopes', 'last_used_at', 'revoked']);

    const created = await h.api('POST', '/api/v1/webhooks', {
      body: { url: 'https://example.invalid/contract' },
    });
    assertFields(created.body, 'webhook', ['id', 'url', 'events', 'active']);
  });

  test('the health page has every field it renders', async () => {
    const check = await h.api('GET', '/api/v1/system/selfcheck');
    assertFields(check.body, 'selfcheck', ['status', 'checks', 'repaired']);
    assertFields(check.body.checks[0], 'check', ['name', 'status', 'message']);

    const info = await h.api('GET', '/api/v1/system/info');
    assertFields(info.body, 'info', [
      'environment',
      'database',
      'node_version',
      'uptime_s',
      'migrations',
      'limits',
    ]);
    assertFields(info.body.migrations, 'migrations', ['applied', 'pending']);
    assertFields(info.body.limits, 'limits', ['rate_limit_max', 'rate_limit_window_ms']);
  });

  test('creating from the UI uses the same shapes the forms submit', async () => {
    // Mirrors exactly what openCreate() posts, including the minor-unit conversion.
    const deal = await createRecord(h, 'deals', {
      title: 'From the new-deal form',
      amount: Math.round(2500.5 * 100),
      close_date: '2026-12-31',
    });
    assert.equal(deal.amount, 250050);
    assert.equal(deal.amount_decimal, 2500.5);

    const task = await createRecord(h, 'tasks', {
      title: 'From the new-task form',
      due_at: new Date('2026-12-31T10:00').toISOString(),
      priority: 'high',
    });
    assert.equal(task.priority, 'high');
  });
});
