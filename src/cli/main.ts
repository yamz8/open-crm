#!/usr/bin/env node
import { createApp } from '../app.ts';
import { migrate, pendingMigrations } from '../db/index.ts';
import {
  createApiToken,
  createUser,
  findUserByEmail,
  isSetupComplete,
  listApiTokens,
  listUsers,
} from '../domain/auth.ts';
import { seedDemoData } from '../domain/seed.ts';
import { selfCheck } from '../domain/selfcheck.ts';
import { reindexAll, search } from '../domain/search.ts';
import { overview, workQueue } from '../domain/insights.ts';
import { listAudit } from '../domain/audit.ts';
import { list } from '../domain/store.ts';
import { RESOURCES, RESOURCE_LIST } from '../domain/resources.ts';
import { isAppError } from '../core/errors.ts';
import type { Role } from '../domain/context.ts';

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string[]; flags: Flags } {
  const command: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      command.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) {
      flags[key!] = inline;
    } else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) {
      flags[key!] = argv[++i]!;
    } else {
      flags[key!] = true;
    }
  }
  return { command, flags };
}

const out = (value: unknown): void => {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
};

const HELP = `open-crm — self-hosted CRM for humans and agents

Usage: open-crm <command> [options]

Running
  serve                        Start the HTTP server and web UI (same as \`npm start\`)
  mcp                          Run the stdio MCP server (needs OPEN_CRM_URL, OPEN_CRM_TOKEN)

Setup
  migrate                      Apply pending database migrations
  seed [--demo]                Install the default pipeline; --demo adds example records
  user create --email <e> --name <n> --password <p> [--role owner|admin|member|readonly]
  user list
  token create --name <n> [--scopes "contacts:write,deals:read"]
  token list

Operations
  selfcheck [--repair]         Diagnose the instance; --repair fixes what it safely can
  reindex                      Rebuild the full-text search index
  info                         Show configuration and migration status

Reading data
  search <query> [--limit n]   Full-text search across every record type
  list <type> [--limit n] [--filter field=value] [--sort field]
  overview [--days 30]         Headline metrics
  work-queue [--stale-days 14] What needs attention right now
  audit [--actor-id id] [--limit n]

Types: ${RESOURCE_LIST.map((r) => r.name).join(', ')}

Every command writes to the audit log as actor "system:cli".
`;

async function run(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const [name, ...rest] = command;

  if (!name || flags['help'] || name === 'help') {
    out(HELP);
    return 0;
  }

  if (name === 'serve') {
    await import('../main.ts');
    return -1; // keep the process alive; main.ts owns the lifecycle
  }
  if (name === 'mcp') {
    await import('../mcp/stdio.ts');
    return -1;
  }

  const app = createApp({ config: { logLevel: 'silent' }, skipBootstrap: name === 'migrate' });
  const ctx = app.systemContext('cli');

  try {
    switch (name) {
      case 'migrate': {
        const result = migrate(app.db);
        out({
          applied: result.applied,
          already_applied: result.alreadyApplied.length,
          status: result.applied.length ? 'migrated' : 'up to date',
        });
        return 0;
      }

      case 'seed': {
        if (flags['demo']) {
          const result = seedDemoData(ctx);
          out({ status: 'seeded', ...result });
        } else {
          out({
            status: 'ready',
            note: 'Default pipeline installed. Pass --demo for example records.',
          });
        }
        return 0;
      }

      case 'user': {
        const action = rest[0];
        if (action === 'list') {
          out(listUsers(ctx));
          return 0;
        }
        if (action === 'create') {
          const email = String(flags['email'] ?? '');
          const password = String(flags['password'] ?? '');
          const userName = String(flags['name'] ?? email.split('@')[0] ?? '');
          if (!email || !password) {
            out('Usage: open-crm user create --email <email> --name <name> --password <password>');
            return 1;
          }
          if (findUserByEmail(app.db, email)) {
            out({ error: `A user with the email ${email} already exists` });
            return 1;
          }
          const role = (flags['role'] as Role) ?? (isSetupComplete(app.db) ? 'member' : 'owner');
          out(createUser(ctx, { email, name: userName, password, role }, { bypassAuth: true }));
          return 0;
        }
        out('Usage: open-crm user <create|list>');
        return 1;
      }

      case 'token': {
        const action = rest[0];
        if (action === 'list') {
          out(listApiTokens(ctx));
          return 0;
        }
        if (action === 'create') {
          const tokenName = String(flags['name'] ?? 'cli-token');
          const scopes = flags['scopes']
            ? String(flags['scopes'])
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : ['*'];
          const { token, record } = createApiToken(ctx, app.config.secret, {
            name: tokenName,
            scopes,
          });
          out({
            ...record,
            token,
            warning: 'Copy this now — the value is never shown again.',
            mcp_setup: `OPEN_CRM_URL=${app.config.publicUrl} OPEN_CRM_TOKEN=${token} npx open-crm mcp`,
          });
          return 0;
        }
        out('Usage: open-crm token <create|list>');
        return 1;
      }

      case 'selfcheck': {
        const report = selfCheck(ctx, app.config, { repair: Boolean(flags['repair']) });
        for (const check of report.checks) {
          const mark = check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗';
          process.stdout.write(`${mark} ${check.name.padEnd(24)} ${check.message}\n`);
          if (check.remedy) process.stdout.write(`  → ${check.remedy}\n`);
        }
        process.stdout.write(`\nstatus: ${report.status}\n`);
        if (report.repaired.length)
          process.stdout.write(`repaired: ${report.repaired.join(', ')}\n`);
        return report.status === 'fail' ? 1 : 0;
      }

      case 'reindex': {
        out(reindexAll(ctx));
        return 0;
      }

      case 'info': {
        const migrations = pendingMigrations(app.db);
        out({
          environment: app.config.env,
          database: app.config.databaseUrl,
          public_url: app.config.publicUrl,
          setup_complete: isSetupComplete(app.db),
          migrations_pending: migrations.notApplied,
          node: process.version,
        });
        return 0;
      }

      case 'search': {
        const query = rest.join(' ');
        if (!query) {
          out('Usage: open-crm search <query>');
          return 1;
        }
        const result = search(ctx, {
          q: query,
          ...(flags['limit'] ? { limit: Number(flags['limit']) } : {}),
        });
        for (const hit of result.data) {
          process.stdout.write(`${hit.entity_type.padEnd(9)} ${hit.entity_id}  ${hit.title}\n`);
        }
        if (result.data.length === 0) process.stdout.write('No matches.\n');
        return 0;
      }

      case 'list': {
        const type = rest[0];
        const def = type ? RESOURCES[type] : undefined;
        if (!def) {
          out(`Usage: open-crm list <${RESOURCE_LIST.map((r) => r.name).join('|')}>`);
          return 1;
        }
        const filter: Record<string, string> = {};
        for (const pair of ([] as string[]).concat((flags['filter'] as string) ?? [])) {
          const [key, value] = pair.split('=', 2);
          if (key && value !== undefined) filter[key] = value;
        }
        const result = list(ctx, def, {
          ...(flags['limit'] ? { limit: Number(flags['limit']) } : {}),
          ...(flags['sort'] ? { sort: String(flags['sort']) } : {}),
          ...(Object.keys(filter).length ? { filter } : {}),
        });
        for (const record of result.data) {
          process.stdout.write(`${String(record['id']).padEnd(32)} ${String(record['_label'])}\n`);
        }
        process.stdout.write(`\n${result.data.length} of ${result.total}\n`);
        return 0;
      }

      case 'overview': {
        out(overview(ctx, { ...(flags['days'] ? { days: Number(flags['days']) } : {}) }));
        return 0;
      }

      case 'work-queue': {
        out(
          workQueue(ctx, {
            ...(flags['stale-days'] ? { stale_days: Number(flags['stale-days']) } : {}),
          }),
        );
        return 0;
      }

      case 'audit': {
        out(
          listAudit(ctx, {
            ...(flags['actor-id'] ? { actor_id: String(flags['actor-id']) } : {}),
            ...(flags['entity-type'] ? { entity_type: String(flags['entity-type']) } : {}),
            ...(flags['limit'] ? { limit: Number(flags['limit']) } : {}),
          }),
        );
        return 0;
      }

      default:
        out(`Unknown command "${name}".\n\n${HELP}`);
        return 1;
    }
  } finally {
    if (!['serve', 'mcp'].includes(name)) app.close();
  }
}

try {
  const code = await run();
  if (code >= 0) process.exit(code);
} catch (error) {
  if (isAppError(error)) {
    process.stderr.write(`${error.message}\n${error.hint ? `→ ${error.hint}\n` : ''}`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  }
  process.exit(1);
}
