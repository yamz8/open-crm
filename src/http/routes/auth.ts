import type { FastifyInstance } from 'fastify';
import { requireCtx, SESSION_COOKIE } from '../server.ts';
import { parse } from '../validate.ts';
import * as S from '../../domain/schemas.ts';
import {
  createApiToken,
  createUser,
  deleteUser,
  findUser,
  isSetupComplete,
  listApiTokens,
  listUsers,
  login,
  logout,
  publicUser,
  revokeApiToken,
  setup,
  updateUser,
} from '../../domain/auth.ts';
import { forbidden, unauthorized } from '../../core/errors.ts';
import { SYSTEM_ACTOR } from '../../domain/context.ts';
import { actorActivity } from '../../domain/audit.ts';

export async function registerAuthRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.app;

  fastify.get('/setup', async () => ({
    object: 'setup_status',
    complete: isSetupComplete(app.db),
    allowed: app.config.allowSetup,
    next_step: isSetupComplete(app.db)
      ? 'POST /api/v1/auth/login with your email and password'
      : 'POST /api/v1/setup with {email, name, password} to create the first owner account',
  }));

  fastify.post('/setup', async (request, reply) => {
    if (!app.config.allowSetup) throw forbidden('First-run setup is disabled on this instance');
    const input = parse(S.setupInput, request.body, 'setup payload');
    const ctx = app.context(SYSTEM_ACTOR, 'api', { requestId: request.id });
    const user = setup(ctx, input);
    reply.status(201);
    return { object: 'setup_result', user, next_step: 'POST /api/v1/auth/login' };
  });

  fastify.post('/auth/login', async (request, reply) => {
    const input = parse(S.loginInput, request.body, 'login payload');
    const result = login(app.db, app.config.secret, input, {
      ttlHours: app.config.sessionTtlHours,
      userAgent: String(request.headers['user-agent'] ?? ''),
      ip: request.ip,
    });
    reply.setCookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: app.config.publicUrl.startsWith('https://'),
      path: '/',
      maxAge: app.config.sessionTtlHours * 3600,
    });
    return { object: 'session', user: result.user, expires_at: result.expiresAt };
  });

  fastify.post('/auth/logout', async (request, reply) => {
    if (request.sessionToken) logout(app.db, app.config.secret, request.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { object: 'logout_result', ok: true };
  });

  fastify.get('/auth/me', async (request) => {
    const ctx = requireCtx(request);
    const user = ctx.actor.type === 'user' && ctx.actor.id ? findUser(app.db, ctx.actor.id) : null;
    return {
      object: 'identity',
      actor: {
        type: ctx.actor.type,
        id: ctx.actor.id,
        label: ctx.actor.label,
        role: ctx.actor.role,
        scopes: ctx.actor.scopes,
      },
      user: user ? publicUser(user) : null,
    };
  });

  // -- Users ----------------------------------------------------------------

  fastify.get('/users', async (request) => ({
    object: 'list',
    data: listUsers(requireCtx(request)),
  }));

  fastify.post('/users', async (request, reply) => {
    const input = parse(S.userCreate, request.body, 'user');
    reply.status(201);
    return createUser(requireCtx(request), input);
  });

  fastify.patch<{ Params: { id: string } }>('/users/:id', async (request) =>
    updateUser(requireCtx(request), request.params.id, parse(S.userUpdate, request.body, 'user')),
  );

  fastify.delete<{ Params: { id: string } }>('/users/:id', async (request) =>
    deleteUser(requireCtx(request), request.params.id),
  );

  // -- API tokens -----------------------------------------------------------

  fastify.get('/tokens', async (request) => ({
    object: 'list',
    data: listApiTokens(requireCtx(request)),
  }));

  fastify.post('/tokens', async (request, reply) => {
    const ctx = requireCtx(request);
    if (ctx.actor.type !== 'user') {
      throw unauthorized('API tokens can only be minted by a signed-in human');
    }
    const input = parse(S.tokenCreate, request.body, 'API token');
    const { token, record } = createApiToken(ctx, app.config.secret, input);
    reply.status(201);
    return {
      object: 'api_token_created',
      ...record,
      token,
      warning: 'This is the only time the token value is shown. Store it now.',
      usage: {
        http: `curl -H "Authorization: Bearer ${token}" ${app.config.publicUrl}/api/v1/contacts`,
        mcp_env: `OPEN_CRM_URL=${app.config.publicUrl} OPEN_CRM_TOKEN=${token}`,
      },
    };
  });

  fastify.delete<{ Params: { id: string } }>('/tokens/:id', async (request) =>
    revokeApiToken(requireCtx(request), request.params.id),
  );

  /** What has this token been doing? The first question to ask about any agent. */
  fastify.get<{ Params: { id: string }; Querystring: { since?: string; limit?: string } }>(
    '/tokens/:id/activity',
    async (request) =>
      actorActivity(requireCtx(request), request.params.id, {
        ...(request.query.since ? { since: request.query.since } : {}),
        ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
      }),
  );
}
