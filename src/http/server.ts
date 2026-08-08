import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../app.ts';
import { ROOT_DIR } from '../core/config.ts';
import { AppError, forbidden, isAppError, unauthorized } from '../core/errors.ts';
import { actorFromUser, resolveApiToken, resolveSession } from '../domain/auth.ts';
import type { Ctx } from '../domain/context.ts';
import './types.ts';

import { registerAuthRoutes } from './routes/auth.ts';
import { registerResourceRoutes } from './routes/resources.ts';
import { registerPipelineRoutes } from './routes/pipelines.ts';
import { registerInsightRoutes } from './routes/insights.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerDiscoveryRoutes, registerRootDocs } from './routes/discovery.ts';
import { registerMcpRoute } from '../mcp/http.ts';

export const SESSION_COOKIE = 'ocrm_session';

export function requireCtx(request: FastifyRequest): Ctx {
  if (!request.ctx) throw unauthorized();
  return request.ctx;
}

export async function buildServer(app: App): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger:
      app.config.logLevel === 'silent'
        ? false
        : {
            level: app.config.logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
    trustProxy: app.config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
    genReqId: () => `req_${Math.random().toString(36).slice(2, 12)}`,
  });

  /**
   * Fastify rejects an empty body when Content-Type is application/json. Clients
   * that set the header on every request — which is most of them, and every agent
   * SDK — would get an opaque 400 on bodyless calls like POST /tasks/{id}/complete.
   * Treat an empty body as an empty object instead.
   */
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      const text = typeof body === 'string' ? body.trim() : '';
      if (text === '') return done(null, undefined);
      try {
        done(null, JSON.parse(text));
      } catch {
        done(
          new AppError('bad_request', 'The request body is not valid JSON', {
            hint: 'Send a JSON object, or omit the body entirely.',
          }),
          undefined,
        );
      }
    },
  );

  fastify.decorate('app', app);
  fastify.decorateRequest('ctx', null);
  fastify.decorateRequest('sessionToken', null);

  await fastify.register(cookie, { secret: app.config.secret });
  await fastify.register(rateLimit, {
    global: false,
    max: app.config.rateLimitMax,
    timeWindow: app.config.rateLimitWindowMs,
    keyGenerator: (request) => {
      const ctx = (request as FastifyRequest).ctx;
      return ctx?.actor.id ?? request.ip;
    },
    errorResponseBuilder: (_request, context) => ({
      error: {
        code: 'rate_limited',
        message: `Rate limit exceeded: at most ${context.max} requests per ${context.after}.`,
        hint: 'Back off and retry after the window resets. The Retry-After header tells you how long.',
      },
    }),
  });

  // -- Authentication --------------------------------------------------------
  fastify.addHook('onRequest', async (request) => {
    const source = request.url.startsWith('/mcp') ? 'mcp' : 'api';
    const idempotencyKey = header(request, 'idempotency-key');

    const authorization = header(request, 'authorization');
    if (authorization?.toLowerCase().startsWith('bearer ')) {
      const token = authorization.slice(7).trim();
      const actor = resolveApiToken(app.db, app.config.secret, token);
      if (!actor) throw unauthorized('Invalid API token');
      request.ctx = app.context(actor, source, { requestId: request.id, idempotencyKey });
      return;
    }

    const sessionToken = request.cookies[SESSION_COOKIE];
    if (sessionToken) {
      const session = resolveSession(app.db, app.config.secret, sessionToken);
      if (session) {
        request.sessionToken = sessionToken;
        request.ctx = app.context(actorFromUser(session.user), source === 'mcp' ? 'mcp' : 'web', {
          requestId: request.id,
          idempotencyKey,
        });
      }
    }
  });

  // Cookie-authenticated writes must look like an API call, not a cross-site form
  // post. Bearer-token clients are unaffected because cookies aren't involved.
  fastify.addHook('onRequest', async (request) => {
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (!mutating || !request.sessionToken) return;
    const contentType = header(request, 'content-type') ?? '';
    if (!contentType.startsWith('application/json') && !header(request, 'x-requested-with')) {
      throw forbidden('Cookie-authenticated writes must send Content-Type: application/json', {
        hint: 'This blocks cross-site form submissions. API clients should use an Authorization: Bearer token instead.',
      });
    }
  });

  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    reply.header(
      'x-open-crm-actor',
      request.ctx ? `${request.ctx.actor.type}:${request.ctx.actor.label}` : 'anonymous',
    );
    return payload;
  });

  // -- Errors ---------------------------------------------------------------
  fastify.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      if (error.status >= 500) request.log.error({ err: error }, 'application error');
      return reply.status(error.status).send(error.toJSON());
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) return reply.status(429).send(error);
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.status(status).send(
        new AppError('bad_request', String((error as Error).message ?? 'Malformed request'), {
          hint: 'Check the request shape against GET /openapi.json.',
        }).toJSON(),
      );
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(
      new AppError('internal_error', 'Something went wrong handling this request', {
        details: { request_id: request.id },
        hint: 'Retry once; if it persists, check the server logs for this request_id.',
      }).toJSON(),
    );
  });

  // -- Routes ---------------------------------------------------------------
  await fastify.register(
    async (api) => {
      api.addHook('onRequest', api.rateLimit());
      await registerDiscoveryRoutes(api);
      await registerAuthRoutes(api);
      await registerResourceRoutes(api);
      await registerPipelineRoutes(api);
      await registerInsightRoutes(api);
      await registerSystemRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  await registerRootDocs(fastify);
  await registerMcpRoute(fastify);

  fastify.get('/healthz', async () => ({ status: 'ok', uptime_s: Math.round(process.uptime()) }));

  fastify.get('/readyz', async (_request, reply) => {
    try {
      app.db.prepare('SELECT 1').get();
      return { status: 'ready' };
    } catch (error) {
      return reply.status(503).send({
        status: 'unavailable',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // -- Web UI ---------------------------------------------------------------
  const publicDir = join(ROOT_DIR, 'public');
  const hasWebUi = existsSync(join(publicDir, 'index.html'));
  if (hasWebUi) {
    await fastify.register(fastifyStatic, { root: publicDir, prefix: '/', index: ['index.html'] });
  }

  // The single not-found handler: the UI owns client-side routes, the API owns
  // everything under a known prefix and answers with a machine-readable error.
  fastify.setNotFoundHandler((request, reply) => {
    const isApiPath =
      request.url.startsWith('/api/') ||
      request.url.startsWith('/mcp') ||
      request.url.startsWith('/openapi') ||
      request.url.startsWith('/llms.txt');
    if (hasWebUi && request.method === 'GET' && !isApiPath) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send(
      new AppError('not_found', `No route for ${request.method} ${request.url}`, {
        hint: 'GET /api/v1/discover lists every available endpoint.',
      }).toJSON(),
    );
  });

  return fastify;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
