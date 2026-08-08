import type { FastifyInstance } from 'fastify';
import { createApp, type App } from './app.ts';
import type { AppConfig } from './core/config.ts';
import { buildServer } from './http/server.ts';
import { resetDomainEventHandlers } from './domain/events.ts';

export type Harness = {
  app: App;
  server: FastifyInstance;
  /** Bearer token for an owner-scoped API token. */
  token: string;
  ownerId: string;
  api: (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    options?: { body?: unknown; token?: string | null; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  close: () => Promise<void>;
};

export const OWNER = {
  email: 'owner@example.com',
  name: 'Test Owner',
  password: 'correct-horse-battery',
};

/**
 * A complete instance in memory: migrated, set up, with an owner and an API
 * token. Every test drives the real HTTP stack rather than calling services
 * directly, so route wiring, auth, and validation are covered too.
 */
export async function createHarness(
  options: {
    seed?: boolean;
    skipBootstrap?: boolean;
    /** Override any config value; used by tests that exercise limits. */
    config?: Partial<AppConfig>;
  } = {},
): Promise<Harness> {
  resetDomainEventHandlers();

  const app = createApp({
    config: {
      databaseUrl: ':memory:',
      logLevel: 'silent',
      env: 'test',
      secret: 'test-secret-not-used-in-production',
      rateLimitMax: 100_000,
      // Most suites log in many times; the throttle has its own dedicated test.
      loginRateLimitMax: 100_000,
      ...(options.config ?? {}),
    },
    ...(options.skipBootstrap ? { skipBootstrap: true } : {}),
  });
  const server = await buildServer(app);

  const call: Harness['api'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(opts.headers ?? {}),
    };
    const bearer = opts.token === undefined ? undefined : opts.token;
    if (bearer) headers['authorization'] = `Bearer ${bearer}`;

    const response = await server.inject({
      method,
      url: path,
      headers,
      ...(opts.body === undefined ? {} : { payload: JSON.stringify(opts.body) }),
    });
    let body: unknown = null;
    try {
      body = response.body ? JSON.parse(response.body) : null;
    } catch {
      body = response.body;
    }
    return {
      status: response.statusCode,
      body,
      headers: response.headers as Record<string, unknown>,
    };
  };

  const setup = await call('POST', '/api/v1/setup', { body: OWNER });
  if (setup.status !== 201) throw new Error(`setup failed: ${JSON.stringify(setup.body)}`);
  const ownerId = String(setup.body.user.id);

  const loginResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
  });
  const cookie = String(loginResponse.headers['set-cookie']).split(';')[0];

  const tokenResponse = await server.inject({
    method: 'POST',
    url: '/api/v1/tokens',
    headers: { 'content-type': 'application/json', cookie: cookie! },
    payload: JSON.stringify({ name: 'test-agent', scopes: ['*'] }),
  });
  const token = String(JSON.parse(tokenResponse.body).token);

  /** Default every call to the owner token unless a test overrides it. */
  const api: Harness['api'] = (method, path, opts = {}) => call(method, path, { token, ...opts });

  if (options.seed) {
    const { seedDemoData } = await import('./domain/seed.ts');
    seedDemoData(app.systemContext('cli'));
  }

  return {
    app,
    server,
    token,
    ownerId,
    api,
    close: async () => {
      await server.close();
      app.close();
      resetDomainEventHandlers();
    },
  };
}

/** Convenience for the very common "create X and return its id" step. */
export async function createRecord(
  harness: Harness,
  plural: string,
  body: Record<string, unknown>,
): Promise<any> {
  const response = await harness.api('POST', `/api/v1/${plural}`, { body });
  if (response.status !== 201) {
    throw new Error(
      `create ${plural} failed (${response.status}): ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}
