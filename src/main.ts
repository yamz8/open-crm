import { createApp } from './app.ts';
import { buildServer } from './http/server.ts';
import { isSetupComplete } from './domain/auth.ts';

const app = createApp();
const server = await buildServer(app);

app.startBackgroundWork();

await server.listen({ host: app.config.host, port: app.config.port });

const url = app.config.publicUrl;
const banner = [
  '',
  `  open-crm is running`,
  '',
  `  Web UI       ${url}`,
  `  API          ${url}/api/v1`,
  `  Discovery    ${url}/api/v1/discover`,
  `  OpenAPI      ${url}/openapi.json`,
  `  For agents   ${url}/llms.txt`,
  `  MCP (http)   ${url}/mcp`,
  '',
  isSetupComplete(app.db)
    ? '  Sign in with your account to continue.'
    : `  First run: open ${url} to create the owner account.`,
  '',
].join('\n');
process.stdout.write(`${banner}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      await server.close();
      app.close();
      process.exit(0);
    })();
  });
}
