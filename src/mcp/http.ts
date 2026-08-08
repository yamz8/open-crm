import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.ts';
import { injectExecutor } from './executor.ts';
import { unauthorized } from '../core/errors.ts';

/**
 * MCP over streamable HTTP, stateless: one short-lived server per request, with
 * the caller's own credentials. Nothing is cached between calls, so revoking a
 * token takes effect immediately.
 */
export async function registerMcpRoute(fastify: FastifyInstance): Promise<void> {
  fastify.route({
    method: ['POST', 'GET', 'DELETE'],
    url: '/mcp',
    handler: async (request, reply) => {
      if (!request.ctx) {
        throw unauthorized('The MCP endpoint requires an API token');
      }

      const server = createMcpServer(injectExecutor(fastify, request.headers.authorization));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });

      reply.hijack();
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    },
  });
}
