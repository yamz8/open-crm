import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Minimal .env loader. We deliberately avoid a dependency: self-hosters should be
 * able to read every line of the bootstrap path.
 */
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(resolve(ROOT_DIR, '.env'));

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n))
    throw new Error(`Environment variable ${key} must be an integer, got "${v}"`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export type AppConfig = {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  publicUrl: string;
  databaseUrl: string;
  sessionTtlHours: number;
  /** Server-side secret used to derive session and token lookup hashes. */
  secret: string;
  logLevel: string;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  /** Allow the first unauthenticated request to /api/v1/setup to create the owner account. */
  allowSetup: boolean;
  webhookTimeoutMs: number;
  trustProxy: boolean;
};

function resolveDatabasePath(raw: string): string {
  if (raw === ':memory:') return raw;
  const withoutScheme = raw.startsWith('sqlite://') ? raw.slice('sqlite://'.length) : raw;
  return resolve(ROOT_DIR, withoutScheme);
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = str('NODE_ENV', 'development') as AppConfig['env'];
  const port = int('PORT', 4000);
  const secret = str('OPEN_CRM_SECRET', '');
  if (!secret && env === 'production') {
    throw new Error(
      'OPEN_CRM_SECRET must be set in production. Generate one with: openssl rand -hex 32',
    );
  }
  const config: AppConfig = {
    env,
    host: str('HOST', '0.0.0.0'),
    port,
    publicUrl: str('PUBLIC_URL', `http://localhost:${port}`).replace(/\/+$/, ''),
    databaseUrl: resolveDatabasePath(str('DATABASE_URL', 'data/open-crm.db')),
    sessionTtlHours: int('SESSION_TTL_HOURS', 24 * 14),
    secret: secret || 'insecure-development-secret-change-me',
    logLevel: str('LOG_LEVEL', env === 'test' ? 'silent' : 'info'),
    rateLimitMax: int('RATE_LIMIT_MAX', 600),
    rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
    allowSetup: bool('ALLOW_SETUP', true),
    webhookTimeoutMs: int('WEBHOOK_TIMEOUT_MS', 10_000),
    trustProxy: bool('TRUST_PROXY', false),
    ...overrides,
  };
  return config;
}
