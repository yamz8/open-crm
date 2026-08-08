import { createHash } from 'node:crypto';
import { AppError } from '../core/errors.ts';
import type { Ctx } from './context.ts';

export type IdempotentOutcome<T> = { replayed: boolean; statusCode: number; body: T };

export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${path} ${JSON.stringify(body ?? null)}`)
    .digest('hex');
}

function actorKey(ctx: Ctx): string {
  return `${ctx.actor.type}:${ctx.actor.id ?? 'anonymous'}`;
}

/**
 * Makes a write safe to retry. Agents retry — on a timeout, on a dropped
 * connection, on their own restart — and without this a retried "create deal"
 * silently doubles the pipeline.
 *
 * The same key with a *different* payload is an error, not a replay: that means
 * the caller has a bug, and quietly returning the old response would hide it.
 */
export function runIdempotent<T>(
  ctx: Ctx,
  requestHash: string,
  run: () => { statusCode: number; body: T },
): IdempotentOutcome<T> {
  const key = ctx.idempotencyKey;
  if (!key) {
    const { statusCode, body } = run();
    return { replayed: false, statusCode, body };
  }

  const existing = ctx.db
    .prepare('SELECT * FROM idempotency_keys WHERE key = ? AND actor_key = ?')
    .get(key, actorKey(ctx)) as
    { request_hash: string; status_code: number; response: string } | undefined;

  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new AppError(
        'idempotency_mismatch',
        `Idempotency-Key "${key}" was already used with a different request body`,
        {
          hint: 'Use a fresh key for a different request, or resend the identical payload to replay the original response.',
        },
      );
    }
    return {
      replayed: true,
      statusCode: existing.status_code,
      body: JSON.parse(existing.response) as T,
    };
  }

  const { statusCode, body } = run();
  ctx.db
    .prepare(
      `INSERT OR REPLACE INTO idempotency_keys (key, actor_key, request_hash, status_code, response, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(key, actorKey(ctx), requestHash, statusCode, JSON.stringify(body), ctx.now());

  return { replayed: false, statusCode, body };
}

/** Idempotency keys are a retry window, not a permanent log. */
export function purgeIdempotencyKeys(ctx: Ctx, olderThanHours = 24): number {
  const cutoff = new Date(Date.now() - olderThanHours * 3600_000).toISOString();
  return ctx.db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff).changes;
}
