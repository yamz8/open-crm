import type { Db } from '../db/index.ts';
import { forbidden } from '../core/errors.ts';

export type Role = 'owner' | 'admin' | 'member' | 'readonly';

export type ActorType = 'user' | 'agent' | 'system';

export type Actor = {
  type: ActorType;
  /** User id or API token id. `null` only for the system actor. */
  id: string | null;
  /** Human-readable identity used in the audit log and activity timeline. */
  label: string;
  role: Role;
  scopes: string[];
};

export const SYSTEM_ACTOR: Actor = {
  type: 'system',
  id: null,
  label: 'system',
  role: 'owner',
  scopes: ['*'],
};

/** Where a mutation came from. Surfaced in the audit log so you can filter agent traffic. */
export type Source = 'api' | 'web' | 'mcp' | 'cli' | 'system' | 'webhook';

export type Ctx = {
  db: Db;
  actor: Actor;
  source: Source;
  requestId: string;
  idempotencyKey?: string | undefined;
  now: () => string;
};

export function createContext(
  db: Db,
  actor: Actor,
  source: Source,
  options: { requestId?: string; idempotencyKey?: string; now?: () => string } = {},
): Ctx {
  return {
    db,
    actor,
    source,
    requestId: options.requestId ?? '-',
    idempotencyKey: options.idempotencyKey,
    now: options.now ?? (() => new Date().toISOString()),
  };
}

export type Access = 'read' | 'write' | 'admin';

const ROLE_RANK: Record<Role, number> = { readonly: 0, member: 1, admin: 2, owner: 3 };

function scopeAllows(scopes: string[], resource: string, access: Access): boolean {
  const needed = access === 'admin' ? 'admin' : access;
  for (const scope of scopes) {
    if (scope === '*') return true;
    const [scopeResource, scopeAccess = '*'] = scope.split(':');
    const resourceOk = scopeResource === '*' || scopeResource === resource;
    if (!resourceOk) continue;
    if (scopeAccess === '*') return true;
    if (scopeAccess === needed) return true;
    // write implies read; admin implies both.
    if (needed === 'read' && (scopeAccess === 'write' || scopeAccess === 'admin')) return true;
    if (needed === 'write' && scopeAccess === 'admin') return true;
  }
  return false;
}

/**
 * Authorization is deliberately checked here in the domain layer rather than in
 * HTTP middleware, so an MCP tool call and a CLI command get exactly the same
 * answer as a REST request.
 */
export function assertCan(ctx: Ctx, resource: string, access: Access): void {
  const { actor } = ctx;

  if (access !== 'read' && actor.role === 'readonly') {
    throw forbidden(`${actor.label} has the "readonly" role and cannot modify ${resource}`, {
      hint: 'Ask an owner or admin to change the role, or use a token with write scope.',
    });
  }
  if (access === 'admin' && ROLE_RANK[actor.role] < ROLE_RANK.admin) {
    throw forbidden(`Administering ${resource} requires the admin or owner role`);
  }
  if (!scopeAllows(actor.scopes, resource, access)) {
    throw forbidden(`Token "${actor.label}" is missing the ${resource}:${access} scope`, {
      hint: `Granted scopes: ${actor.scopes.join(', ') || 'none'}. Create a new token with "${resource}:${access}" or "*".`,
    });
  }
}

export function can(ctx: Ctx, resource: string, access: Access): boolean {
  try {
    assertCan(ctx, resource, access);
    return true;
  } catch {
    return false;
  }
}
