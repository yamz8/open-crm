import type { Ctx } from '../domain/context.ts';
import type { App } from '../app.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the auth hook for every request that carries credentials. */
    ctx: Ctx | null;
    /** Session cookie value, when the caller authenticated as a human. */
    sessionToken: string | null;
  }
  interface FastifyInstance {
    app: App;
  }
}

export {};
