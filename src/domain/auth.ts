import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { newId, randomToken } from '../core/ids.ts';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
} from '../core/errors.ts';
import { assertCan, type Actor, type Ctx, type Role } from './context.ts';
import { writeAudit } from './store.ts';
import type { Db } from '../db/index.ts';

// -- Password hashing ---------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash!, 'base64');
  const derived = scryptSync(password, Buffer.from(salt!, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Deterministic lookup hash for opaque secrets, keyed by the instance secret. */
export function lookupHash(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

// -- Users --------------------------------------------------------------------

export type UserRow = {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  avatar_color: string;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
};

const AVATAR_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

export function publicUser(row: UserRow): Record<string, unknown> {
  return {
    object: 'user',
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    avatar_color: row.avatar_color,
    disabled: Boolean(row.disabled_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
    _label: row.name,
  };
}

export function countUsers(db: Db): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n);
}

export function findUserByEmail(db: Db, email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as
    UserRow | undefined;
}

export function findUser(db: Db, id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function createUser(
  ctx: Ctx,
  input: { email: string; name: string; password: string; role?: Role },
  options: { bypassAuth?: boolean } = {},
): Record<string, unknown> {
  if (!options.bypassAuth) assertCan(ctx, 'users', 'admin');
  const email = input.email.toLowerCase().trim();
  if (findUserByEmail(ctx.db, email)) {
    throw conflict(`A user with the email ${email} already exists`);
  }
  const now = ctx.now();
  const id = newId('user');
  const color = AVATAR_COLORS[countUsers(ctx.db) % AVATAR_COLORS.length]!;
  ctx.db
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, role, avatar_color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      email,
      input.name.trim(),
      hashPassword(input.password),
      input.role ?? 'member',
      color,
      now,
      now,
    );
  const row = findUser(ctx.db, id)!;
  writeAudit(ctx, 'create', 'user', id, null, { ...row, password_hash: '[redacted]' });
  return publicUser(row);
}

export function listUsers(ctx: Ctx): Record<string, unknown>[] {
  assertCan(ctx, 'users', 'read');
  const rows = ctx.db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
  return rows.map(publicUser);
}

export function updateUser(
  ctx: Ctx,
  id: string,
  input: { name?: string; email?: string; role?: Role; password?: string; disabled?: boolean },
): Record<string, unknown> {
  const isSelf = ctx.actor.type === 'user' && ctx.actor.id === id;
  if (!isSelf) assertCan(ctx, 'users', 'admin');
  if (isSelf && (input.role !== undefined || input.disabled !== undefined)) {
    assertCan(ctx, 'users', 'admin');
  }

  const before = findUser(ctx.db, id);
  if (!before) throw notFound('user', id);

  if (before.role === 'owner' && input.role && input.role !== 'owner') {
    const owners = Number(
      (
        ctx.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner'`).get() as {
          n: number;
        }
      ).n,
    );
    if (owners <= 1) {
      throw badRequest('Cannot demote the last owner', {
        hint: 'Promote another user to owner first.',
      });
    }
  }

  const updates: Record<string, unknown> = { updated_at: ctx.now() };
  if (input.name !== undefined) updates['name'] = input.name.trim();
  if (input.email !== undefined) updates['email'] = input.email.toLowerCase().trim();
  if (input.role !== undefined) updates['role'] = input.role;
  if (input.password !== undefined) updates['password_hash'] = hashPassword(input.password);
  if (input.disabled !== undefined) updates['disabled_at'] = input.disabled ? ctx.now() : null;

  const cols = Object.keys(updates);
  ctx.db
    .prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map((c) => updates[c] as never), id);

  if (input.password !== undefined || input.disabled) {
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  // Disabling an account has to cut off its agents too, or the tokens it minted
  // keep working at its old role long after the human lost access.
  if (input.disabled) revokeTokensCreatedBy(ctx, id);

  const row = findUser(ctx.db, id)!;
  writeAudit(
    ctx,
    'update',
    'user',
    id,
    { ...before, password_hash: '[redacted]' },
    { ...row, password_hash: '[redacted]' },
  );
  return publicUser(row);
}

export function deleteUser(
  ctx: Ctx,
  id: string,
): { deleted: true; id: string; revoked_tokens: number } {
  assertCan(ctx, 'users', 'admin');
  const before = findUser(ctx.db, id);
  if (!before) throw notFound('user', id);
  if (ctx.actor.id === id) throw badRequest('You cannot delete your own account');
  if (before.role === 'owner') {
    throw badRequest('Owners cannot be deleted', { hint: 'Change the role to admin first.' });
  }
  const run = ctx.db.transaction(() => {
    // Offboarding must take the account's agents with it. Without this the FK's
    // ON DELETE SET NULL orphans the tokens and they keep working.
    const revoked = revokeTokensCreatedBy(ctx, id);
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    writeAudit(ctx, 'delete', 'user', id, { ...before, password_hash: '[redacted]' }, null);
    return revoked;
  });

  const revokedTokens = run();
  return { deleted: true, id, revoked_tokens: revokedTokens };
}

export function actorFromUser(row: UserRow): Actor {
  return {
    type: 'user',
    id: row.id,
    label: row.name || row.email,
    role: row.role,
    scopes: ['*'],
  };
}

// -- Sessions -----------------------------------------------------------------

export type LoginResult = { token: string; expiresAt: string; user: Record<string, unknown> };

export function login(
  db: Db,
  secret: string,
  input: { email: string; password: string },
  meta: { ttlHours: number; userAgent?: string; ip?: string; now?: () => string },
): LoginResult {
  const now = meta.now ?? (() => new Date().toISOString());
  const user = findUserByEmail(db, input.email);
  // Always run a hash comparison so a missing account and a wrong password cost
  // the same amount of time.
  const stored = user?.password_hash ?? hashPassword('placeholder-for-timing-parity');
  const ok = verifyPassword(input.password, stored);
  if (!user || !ok) throw unauthorized('Incorrect email or password');
  if (user.disabled_at) throw forbidden('This account is disabled');

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + meta.ttlHours * 3600_000).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('session'),
    user.id,
    lookupHash(secret, token),
    expiresAt,
    now(),
    meta.userAgent ?? null,
    meta.ip ?? null,
  );
  return { token, expiresAt, user: publicUser(user) };
}

export function resolveSession(
  db: Db,
  secret: string,
  token: string,
): { user: UserRow; sessionId: string } | null {
  const row = db
    .prepare('SELECT * FROM sessions WHERE token_hash = ?')
    .get(lookupHash(secret, token)) as
    { id: string; user_id: string; expires_at: string } | undefined;
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return null;
  }
  const user = findUser(db, row.user_id);
  if (!user || user.disabled_at) return null;
  return { user, sessionId: row.id };
}

export function logout(db: Db, secret: string, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(lookupHash(secret, token));
}

export function purgeExpiredSessions(db: Db): number {
  const result = db
    .prepare('DELETE FROM sessions WHERE expires_at < ?')
    .run(new Date().toISOString());
  return result.changes;
}

// -- API tokens ---------------------------------------------------------------

export const TOKEN_PREFIX = 'ocrm';

export type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  token_hash: string;
  scopes: string;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

export function publicToken(row: TokenRow): Record<string, unknown> {
  return {
    object: 'api_token',
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: JSON.parse(row.scopes) as string[],
    created_by: row.created_by,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    revoked: Boolean(row.revoked_at),
    _label: row.name,
  };
}

export function createApiToken(
  ctx: Ctx,
  secret: string,
  input: { name: string; scopes?: string[]; expires_at?: string | null },
): { token: string; record: Record<string, unknown> } {
  assertCan(ctx, 'tokens', 'admin');
  const id = newId('token');
  const prefix = randomBytes(4).toString('hex');
  const raw = randomToken(32);
  const token = `${TOKEN_PREFIX}_${prefix}_${raw}`;
  const scopes = input.scopes?.length ? input.scopes : ['*'];

  for (const scope of scopes) {
    if (!/^(\*|[a-z_]+)(:(\*|read|write|admin))?$/.test(scope)) {
      throw badRequest(`Invalid scope "${scope}"`, {
        hint: 'Scopes look like "*", "contacts:read", "deals:write", or "tokens:admin".',
      });
    }
  }

  ctx.db
    .prepare(
      `INSERT INTO api_tokens (id, name, prefix, token_hash, scopes, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name.trim(),
      prefix,
      lookupHash(secret, token),
      JSON.stringify(scopes),
      ctx.actor.type === 'user' ? ctx.actor.id : null,
      ctx.now(),
      input.expires_at ?? null,
    );

  const row = ctx.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as TokenRow;
  writeAudit(ctx, 'create', 'api_token', id, null, { ...row, token_hash: '[redacted]' });
  return { token, record: publicToken(row) };
}

export function listApiTokens(ctx: Ctx): Record<string, unknown>[] {
  assertCan(ctx, 'tokens', 'read');
  const rows = ctx.db
    .prepare('SELECT * FROM api_tokens ORDER BY created_at DESC')
    .all() as TokenRow[];
  return rows.map(publicToken);
}

export function revokeApiToken(ctx: Ctx, id: string): Record<string, unknown> {
  assertCan(ctx, 'tokens', 'admin');
  const before = ctx.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as
    TokenRow | undefined;
  if (!before) throw notFound('api_token', id);
  ctx.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(ctx.now(), id);
  const row = ctx.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as TokenRow;
  writeAudit(
    ctx,
    'update',
    'api_token',
    id,
    { ...before, token_hash: '[redacted]' },
    {
      ...row,
      token_hash: '[redacted]',
    },
  );
  return publicToken(row);
}

export function resolveApiToken(db: Db, secret: string, token: string): Actor | null {
  if (!token.startsWith(`${TOKEN_PREFIX}_`)) return null;
  const row = db
    .prepare('SELECT * FROM api_tokens WHERE token_hash = ?')
    .get(lookupHash(secret, token)) as TokenRow | undefined;
  if (!row) return null;
  if (row.revoked_at) throw unauthorized('This API token has been revoked');
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    throw unauthorized('This API token has expired');
  }
  db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    row.id,
  );

  return {
    type: 'agent',
    id: row.id,
    label: row.name,
    role: tokenRole(db, row),
    scopes: JSON.parse(row.scopes) as string[],
  };
}

/**
 * A token can never exceed the role of whoever minted it, and it must not
 * outlive them.
 *
 * Deleting or disabling a user revokes their tokens (see `deleteUser` and
 * `updateUser`), so a live token that still names a creator must resolve to a
 * live, enabled account. If it does not, the token is an orphan from before
 * that rule existed — fail closed rather than falling back to a default role,
 * which would hand a de-provisioned account's token *more* authority than it
 * had the day before.
 *
 * A NULL `created_by` means the token was minted through the CLI, which only
 * someone with shell access to the server can run. Admin is the ceiling there.
 */
function tokenRole(db: Db, row: TokenRow): Role {
  if (!row.created_by) return 'admin';
  const creator = findUser(db, row.created_by);
  if (!creator) {
    throw unauthorized('The account that created this token no longer exists');
  }
  if (creator.disabled_at) {
    throw unauthorized('The account that created this token is disabled');
  }
  return creator.role;
}

/** Revokes every live token a user minted. Called when they are deleted or disabled. */
export function revokeTokensCreatedBy(ctx: Ctx, userId: string): number {
  return ctx.db
    .prepare('UPDATE api_tokens SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL')
    .run(ctx.now(), userId).changes;
}

// -- First-run setup ----------------------------------------------------------

export function isSetupComplete(db: Db): boolean {
  return countUsers(db) > 0;
}

export function setup(
  ctx: Ctx,
  input: { email: string; name: string; password: string },
): Record<string, unknown> {
  if (isSetupComplete(ctx.db)) {
    throw new AppError('conflict', 'This instance has already been set up', {
      hint: 'Sign in instead, or ask an owner to invite you.',
    });
  }
  return createUser(ctx, { ...input, role: 'owner' }, { bypassAuth: true });
}
