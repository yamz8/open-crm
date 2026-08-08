import { createHmac, randomBytes } from 'node:crypto';
import { newId } from '../core/ids.ts';
import { notFound } from '../core/errors.ts';
import { assertCan, type Ctx } from './context.ts';
import { writeAudit } from './store.ts';
import type { DomainEvent } from './events.ts';
import type { Db } from '../db/index.ts';
import { checkDestination } from './net-guard.ts';
import { USER_AGENT } from '../core/version.ts';

export type WebhookRow = {
  id: string;
  url: string;
  secret: string;
  events: string;
  active: number;
  description: string | null;
  created_at: string;
  updated_at: string;
};

function serializeWebhook(row: WebhookRow, includeSecret = false): Record<string, unknown> {
  return {
    object: 'webhook',
    id: row.id,
    url: row.url,
    events: JSON.parse(row.events) as string[],
    active: Boolean(row.active),
    description: row.description,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(includeSecret ? { secret: row.secret } : { secret_hint: `${row.secret.slice(0, 6)}…` }),
    _label: row.url,
  };
}

export function eventMatches(patterns: string[], eventType: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.endsWith('.*')) return eventType.startsWith(`${pattern.slice(0, -1)}`);
    return pattern === eventType;
  });
}

export function listWebhooks(ctx: Ctx): Record<string, unknown>[] {
  assertCan(ctx, 'webhooks', 'read');
  const rows = ctx.db
    .prepare('SELECT * FROM webhooks ORDER BY created_at DESC')
    .all() as WebhookRow[];
  return rows.map((r) => serializeWebhook(r));
}

export function createWebhook(
  ctx: Ctx,
  input: { url: string; events?: string[]; description?: string | null; active?: boolean },
): Record<string, unknown> {
  assertCan(ctx, 'webhooks', 'admin');
  const id = newId('webhook');
  const now = ctx.now();
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  ctx.db
    .prepare(
      `INSERT INTO webhooks (id, url, secret, events, active, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.url,
      secret,
      JSON.stringify(input.events?.length ? input.events : ['*']),
      input.active === false ? 0 : 1,
      input.description ?? null,
      now,
      now,
    );
  const row = ctx.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow;
  writeAudit(ctx, 'create', 'webhook', id, null, { ...row, secret: '[redacted]' });
  // The plaintext secret is returned exactly once, at creation.
  return serializeWebhook(row, true);
}

export function updateWebhook(
  ctx: Ctx,
  id: string,
  input: { url?: string; events?: string[]; description?: string | null; active?: boolean },
): Record<string, unknown> {
  assertCan(ctx, 'webhooks', 'admin');
  const before = ctx.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as
    WebhookRow | undefined;
  if (!before) throw notFound('webhook', id);
  ctx.db
    .prepare(
      `UPDATE webhooks SET url = COALESCE(?, url), events = COALESCE(?, events),
       description = COALESCE(?, description), active = COALESCE(?, active), updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.url ?? null,
      input.events ? JSON.stringify(input.events) : null,
      input.description ?? null,
      input.active === undefined ? null : input.active ? 1 : 0,
      ctx.now(),
      id,
    );
  const row = ctx.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow;
  writeAudit(
    ctx,
    'update',
    'webhook',
    id,
    { ...before, secret: '[redacted]' },
    { ...row, secret: '[redacted]' },
  );
  return serializeWebhook(row);
}

export function deleteWebhook(ctx: Ctx, id: string): { deleted: true; id: string } {
  assertCan(ctx, 'webhooks', 'admin');
  const before = ctx.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as
    WebhookRow | undefined;
  if (!before) throw notFound('webhook', id);
  ctx.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  writeAudit(ctx, 'delete', 'webhook', id, { ...before, secret: '[redacted]' }, null);
  return { deleted: true, id };
}

export function listDeliveries(ctx: Ctx, webhookId: string, limit = 50): Record<string, unknown>[] {
  assertCan(ctx, 'webhooks', 'read');
  const rows = ctx.db
    .prepare(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(webhookId, Math.min(limit, 200)) as Record<string, unknown>[];
  return rows.map((r) => ({ object: 'webhook_delivery', ...r }));
}

export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Queues one delivery row per matching webhook. Delivery itself is asynchronous
 * so a slow subscriber never becomes a slow API response.
 */
export function enqueueEvent(db: Db, event: DomainEvent): string[] {
  const hooks = db.prepare('SELECT * FROM webhooks WHERE active = 1').all() as WebhookRow[];
  const queued: string[] = [];
  for (const hook of hooks) {
    if (!eventMatches(JSON.parse(hook.events) as string[], event.type)) continue;
    const id = newId('delivery');
    db.prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(id, hook.id, event.type, JSON.stringify(event), new Date().toISOString());
    queued.push(id);
  }
  return queued;
}

export type DeliveryRow = {
  id: string;
  webhook_id: string;
  event: string;
  payload: string;
  status: string;
  attempts: number;
};

const MAX_ATTEMPTS = 5;

export async function flushDeliveries(
  db: Db,
  options: {
    timeoutMs?: number;
    batchSize?: number;
    fetchImpl?: typeof fetch;
    /** Self-hosters delivering to a sibling container can opt back in. */
    allowPrivateDestinations?: boolean;
  } = {},
): Promise<{ attempted: number; delivered: number; failed: number; blocked: number }> {
  const doFetch = options.fetchImpl ?? fetch;
  const rows = db
    .prepare(
      `SELECT * FROM webhook_deliveries WHERE status = 'pending' AND attempts < ?
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(MAX_ATTEMPTS, options.batchSize ?? 25) as DeliveryRow[];

  let delivered = 0;
  let failed = 0;
  let blocked = 0;

  for (const row of rows) {
    const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(row.webhook_id) as
      WebhookRow | undefined;
    if (!hook) {
      db.prepare(
        `UPDATE webhook_deliveries SET status = 'failed', last_error = ? WHERE id = ?`,
      ).run('webhook was deleted', row.id);
      failed++;
      continue;
    }

    // Re-checked on every attempt, not once at subscription time: DNS can be
    // repointed at an internal address after the URL was accepted.
    const destination = await checkDestination(hook.url, {
      allowPrivate: options.allowPrivateDestinations ?? false,
    });
    if (!destination.allowed) {
      if (destination.retryable) {
        markRetry(db, row.id, row.attempts + 1, null, destination.reason);
        failed++;
      } else {
        db.prepare(
          `UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`,
        ).run(row.attempts + 1, `blocked: ${destination.reason}`, row.id);
        blocked++;
      }
      continue;
    }

    const timestamp = String(Date.now());
    const signature = signPayload(hook.secret, timestamp, row.payload);
    const attempts = row.attempts + 1;

    try {
      const response = await doFetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
          'x-open-crm-event': row.event,
          'x-open-crm-delivery': row.id,
          'x-open-crm-timestamp': timestamp,
          'x-open-crm-signature': `sha256=${signature}`,
        },
        body: row.payload,
        // A public URL must not be able to bounce the request into the private
        // range via a 302.
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (response.ok) {
        db.prepare(
          `UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, status_code = ?, delivered_at = ?, last_error = NULL WHERE id = ?`,
        ).run(attempts, response.status, new Date().toISOString(), row.id);
        delivered++;
      } else {
        markRetry(db, row.id, attempts, response.status, `HTTP ${response.status}`);
        failed++;
      }
    } catch (error) {
      markRetry(db, row.id, attempts, null, error instanceof Error ? error.message : String(error));
      failed++;
    }
  }

  return { attempted: rows.length, delivered, failed, blocked };
}

function markRetry(
  db: Db,
  id: string,
  attempts: number,
  statusCode: number | null,
  error: string,
): void {
  const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  db.prepare(
    `UPDATE webhook_deliveries SET status = ?, attempts = ?, status_code = ?, last_error = ? WHERE id = ?`,
  ).run(status, attempts, statusCode, error, id);
}
