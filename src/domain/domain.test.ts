import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './auth.ts';
import { assertCan, can, SYSTEM_ACTOR, type Actor, type Ctx } from './context.ts';
import { toFtsQuery, formatMoney } from './store.ts';
import { diff } from './audit.ts';
import { eventMatches, signPayload } from './webhooks.ts';
import { normalizeTagName } from './tags.ts';
import { isId, kindOfId, newId, ulid } from '../core/ids.ts';
import { AppError } from '../core/errors.ts';

describe('identifiers', () => {
  test('ids carry a type prefix and sort by creation time', () => {
    const first = newId('contact', 1_000);
    const second = newId('contact', 2_000);
    assert.ok(first < second, 'ULIDs sort lexicographically by timestamp');
    assert.ok(isId('contact', first));
    assert.ok(!isId('deal', first));
    assert.equal(kindOfId(first), 'contact');
    assert.equal(kindOfId('bogus_123'), null);
  });

  test('ids generated in the same millisecond stay ordered and unique', () => {
    const ids = Array.from({ length: 500 }, () => ulid(5_000));
    assert.equal(new Set(ids).size, 500, 'no collisions');
    assert.deepEqual([...ids].sort(), ids, 'monotonic within a millisecond');
  });
});

describe('passwords', () => {
  test('verifies a correct password and rejects a wrong one', () => {
    const hash = hashPassword('correct-horse-battery');
    assert.ok(verifyPassword('correct-horse-battery', hash));
    assert.ok(!verifyPassword('correct-horse-batteru', hash));
  });

  test('the same password hashes differently each time', () => {
    assert.notEqual(hashPassword('same-password'), hashPassword('same-password'));
  });

  test('a malformed stored hash fails closed', () => {
    assert.ok(!verifyPassword('anything', 'not-a-hash'));
    assert.ok(!verifyPassword('anything', ''));
  });
});

describe('permissions', () => {
  const ctxWith = (actor: Actor): Ctx =>
    ({ actor, db: null as never, source: 'api', requestId: 'r', now: () => 'now' }) as Ctx;

  const agent = (scopes: string[]): Actor => ({
    type: 'agent',
    id: 'tok_1',
    label: 'agent',
    role: 'member',
    scopes,
  });

  test('write implies read, admin implies write', () => {
    const ctx = ctxWith(agent(['contacts:write']));
    assert.ok(can(ctx, 'contacts', 'read'));
    assert.ok(can(ctx, 'contacts', 'write'));
    assert.ok(!can(ctx, 'contacts', 'admin'));

    const adminCtx = ctxWith(agent(['contacts:admin']));
    assert.ok(can(adminCtx, 'contacts', 'write'));
  });

  test('scopes do not leak across resources', () => {
    const ctx = ctxWith(agent(['contacts:write']));
    assert.ok(!can(ctx, 'deals', 'read'));
  });

  test('wildcards work at both levels', () => {
    assert.ok(can(ctxWith(agent(['*'])), 'anything', 'write'));
    assert.ok(can(ctxWith(agent(['*:read'])), 'deals', 'read'));
    assert.ok(!can(ctxWith(agent(['*:read'])), 'deals', 'write'));
  });

  test('the readonly role blocks writes even with a wildcard scope', () => {
    const ctx = ctxWith({ type: 'user', id: 'u', label: 'u', role: 'readonly', scopes: ['*'] });
    assert.ok(can(ctx, 'contacts', 'read'));
    assert.ok(!can(ctx, 'contacts', 'write'));
  });

  test('a member cannot perform admin actions', () => {
    const ctx = ctxWith({ type: 'user', id: 'u', label: 'u', role: 'member', scopes: ['*'] });
    assert.ok(!can(ctx, 'users', 'admin'));
  });

  test('the system actor can do everything', () => {
    assert.ok(can(ctxWith(SYSTEM_ACTOR), 'system', 'admin'));
  });

  test('a denial explains which scope is missing', () => {
    const ctx = ctxWith(agent(['contacts:read']));
    assert.throws(
      () => assertCan(ctx, 'deals', 'write'),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'forbidden');
        assert.ok(error.message.includes('deals:write'));
        assert.ok(error.hint?.includes('contacts:read'));
        return true;
      },
    );
  });
});

describe('full-text query building', () => {
  test('quotes tokens so punctuation cannot break FTS syntax', () => {
    assert.equal(toFtsQuery('acme corp'), '"acme" AND "corp"*');
    assert.equal(toFtsQuery('ada@example.com'), '"ada" AND "example" AND "com"*');
    assert.equal(toFtsQuery('C++ (maybe)'), '"c" AND "maybe"*');
    assert.equal(toFtsQuery('a AND b'), '"a" AND "and" AND "b"*');
  });

  test('returns null when there is nothing searchable', () => {
    assert.equal(toFtsQuery('   '), null);
    assert.equal(toFtsQuery('!!!'), null);
  });
});

describe('money formatting', () => {
  test('renders minor units as currency', () => {
    assert.equal(formatMoney(150_000, 'USD'), '$1,500.00');
    assert.equal(formatMoney(0, 'USD'), '$0.00');
  });

  test('falls back gracefully on an unknown currency code', () => {
    assert.ok(formatMoney(1_000, 'XYZ').includes('10'));
  });
});

describe('audit diffing', () => {
  test('reports only fields that actually changed', () => {
    const changes = diff(
      { id: 'x', title: 'A', amount: 100, updated_at: 't1', version: 1 },
      { id: 'x', title: 'B', amount: 100, updated_at: 't2', version: 2 },
    );
    assert.deepEqual(Object.keys(changes), ['title']);
    assert.deepEqual(changes['title'], { from: 'A', to: 'B' });
  });

  test('treats a create as every field appearing', () => {
    const changes = diff(null, { id: 'x', title: 'A' });
    assert.deepEqual(changes['title'], { from: null, to: 'A' });
  });
});

describe('webhook matching and signing', () => {
  test('matches exact names, prefixes, and the catch-all', () => {
    assert.ok(eventMatches(['*'], 'contact.created'));
    assert.ok(eventMatches(['contact.*'], 'contact.created'));
    assert.ok(eventMatches(['deal.won'], 'deal.won'));
    assert.ok(!eventMatches(['deal.*'], 'contact.created'));
    assert.ok(!eventMatches(['deal.won'], 'deal.lost'));
  });

  test('signatures depend on the secret, the timestamp, and the body', () => {
    const a = signPayload('secret', '1000', '{"a":1}');
    assert.equal(a, signPayload('secret', '1000', '{"a":1}'), 'deterministic');
    assert.notEqual(a, signPayload('other', '1000', '{"a":1}'));
    assert.notEqual(a, signPayload('secret', '1001', '{"a":1}'));
    assert.notEqual(a, signPayload('secret', '1000', '{"a":2}'));
  });
});

describe('tag names', () => {
  test('normalizes to a stable slug', () => {
    assert.equal(normalizeTagName('  VIP Customer '), 'vip-customer');
    assert.equal(normalizeTagName('Follow   Up'), 'follow-up');
  });
});
