import type { FastifyReply, FastifyRequest } from 'fastify';
import { hashRequest, runIdempotent } from '../domain/idempotency.ts';
import { requireCtx } from './server.ts';

/**
 * Wraps a write so that repeating it with the same `Idempotency-Key` returns the
 * original response instead of performing the action twice.
 */
export function idempotent<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  run: () => T,
): T {
  const ctx = requireCtx(request);
  const outcome = runIdempotent(
    ctx,
    hashRequest(request.method, request.url, request.body),
    () => ({
      statusCode,
      body: run(),
    }),
  );
  reply.status(outcome.statusCode);
  if (outcome.replayed) reply.header('idempotent-replay', 'true');
  return outcome.body;
}
