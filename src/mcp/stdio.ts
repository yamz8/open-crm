#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.ts';
import { fetchExecutor } from './executor.ts';

/**
 * stdio MCP server: what you point Claude Code (or any MCP client) at.
 *
 *   claude mcp add open-crm -- npx open-crm mcp
 *
 * It talks to a running instance over HTTP with an API token, so the same
 * binary works against localhost and against a shared deployment.
 */
async function main(): Promise<void> {
  const url = process.env['OPEN_CRM_URL'] ?? 'http://localhost:4000';
  const token = process.env['OPEN_CRM_TOKEN'];

  if (!token) {
    process.stderr.write(
      [
        'open-crm MCP: OPEN_CRM_TOKEN is not set.',
        '',
        'Create a token from the web UI (Settings → API tokens), or:',
        '  curl -X POST $OPEN_CRM_URL/api/v1/tokens \\',
        '    -H "content-type: application/json" -b cookies.txt \\',
        `    -d '{"name":"claude-code","scopes":["*"]}'`,
        '',
        'Then run:',
        `  OPEN_CRM_URL=${url} OPEN_CRM_TOKEN=ocrm_... npx open-crm mcp`,
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  // Fail fast with a readable message rather than surfacing every tool call as a
  // connection error inside the client.
  try {
    const probe = await fetch(`${url.replace(/\/+$/, '')}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (probe.status === 401 || probe.status === 403) {
      process.stderr.write(`open-crm MCP: the token was rejected by ${url}.\n`);
      process.exit(1);
    }
  } catch (error) {
    process.stderr.write(
      `open-crm MCP: cannot reach ${url} (${error instanceof Error ? error.message : String(error)}).\n` +
        'Is the server running? Start it with `npm start`.\n',
    );
    process.exit(1);
  }

  const server = createMcpServer(fetchExecutor(url, token));
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`open-crm MCP failed to start: ${String(error)}\n`);
  process.exit(1);
});
