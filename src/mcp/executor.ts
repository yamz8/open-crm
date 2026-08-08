import type { FastifyInstance } from 'fastify';
import type { RestCall } from './tools.ts';

export type ExecResult = { status: number; body: unknown };
export type Executor = (call: RestCall) => Promise<ExecResult>;

function buildPath(call: RestCall): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(call.query ?? {})) {
    if (value !== undefined) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${call.path}?${qs}` : call.path;
}

function headersFor(call: RestCall, base: Record<string, string>): Record<string, string> {
  return {
    ...base,
    'content-type': 'application/json',
    ...(call.idempotencyKey ? { 'idempotency-key': call.idempotencyKey } : {}),
    ...(call.ifMatch ? { 'if-match': call.ifMatch } : {}),
  };
}

/**
 * Runs MCP tool calls through the very same HTTP stack the REST API uses,
 * in-process. Authentication, validation, permissions, idempotency, and audit
 * logging are therefore identical by construction rather than by convention —
 * there is no second implementation to keep in sync.
 */
export function injectExecutor(
  fastify: FastifyInstance,
  authorization: string | undefined,
): Executor {
  return async (call) => {
    const response = await fastify.inject({
      method: call.method,
      url: buildPath(call),
      headers: headersFor(call, authorization ? { authorization } : {}),
      ...(call.body === undefined ? {} : { payload: JSON.stringify(call.body) }),
    });
    return { status: response.statusCode, body: safeParse(response.body) };
  };
}

/** Talks to a remote open-crm over HTTP. Used by the stdio MCP server. */
export function fetchExecutor(baseUrl: string, token: string): Executor {
  const base = baseUrl.replace(/\/+$/, '');
  return async (call) => {
    const response = await fetch(`${base}${buildPath(call)}`, {
      method: call.method,
      headers: headersFor(call, { authorization: `Bearer ${token}` }),
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: safeParse(await response.text()) };
  };
}

function safeParse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
