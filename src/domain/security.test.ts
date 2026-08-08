import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createRecord, OWNER, type Harness } from '../testing.ts';
import { isPrivateAddress, checkDestination } from './net-guard.ts';
import { flushDeliveries } from './webhooks.ts';

/**
 * Regression tests for the two findings in the security review. Each one fails
 * against the code as it was written, so a future refactor cannot quietly
 * reintroduce the hole.
 */

async function sessionCookie(h: Harness): Promise<string> {
  const login = await h.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
  });
  return String(login.headers['set-cookie']).split(';')[0]!;
}

/** Mints a user and an API token created by that user. */
async function userWithToken(
  h: Harness,
  email: string,
  role: 'admin' | 'member' = 'admin',
): Promise<{ userId: string; token: string }> {
  const ownerCookie = await sessionCookie(h);
  const created = await h.api('POST', '/api/v1/users', {
    body: { email, name: email.split('@')[0], password: 'a-long-enough-password', role },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const theirLogin = await h.server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: 'a-long-enough-password' }),
  });
  const theirCookie = String(theirLogin.headers['set-cookie']).split(';')[0]!;

  const tokenResponse = await h.server.inject({
    method: 'POST',
    url: '/api/v1/tokens',
    headers: { 'content-type': 'application/json', cookie: theirCookie },
    payload: JSON.stringify({ name: `${email}-agent`, scopes: ['*'] }),
  });
  assert.equal(tokenResponse.statusCode, 201, tokenResponse.body);
  void ownerCookie;
  return { userId: String(created.body.id), token: String(JSON.parse(tokenResponse.body).token) };
}

describe('token lifecycle is tied to account lifecycle', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  test('deleting a user revokes the tokens they created', async () => {
    const { userId, token } = await userWithToken(h, 'leaver@example.com');

    const beforeDelete = await h.api('GET', '/api/v1/contacts', { token });
    assert.equal(beforeDelete.status, 200, 'the token works while the account exists');

    const deleted = await h.api('DELETE', `/api/v1/users/${userId}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.revoked_tokens, 1, 'the delete reports what it revoked');

    const afterDelete = await h.api('GET', '/api/v1/contacts', { token });
    assert.equal(afterDelete.status, 401, 'the orphaned token is refused');
  });

  test('a demoted-then-deleted account cannot regain admin through its token', async () => {
    // The original escalation: role fell back to "admin" once created_by went NULL.
    const { userId, token } = await userWithToken(h, 'demoted@example.com');

    await h.api('PATCH', `/api/v1/users/${userId}`, { body: { role: 'readonly' } });
    const asReadonly = await h.api('POST', '/api/v1/contacts', {
      token,
      body: { first_name: 'Should', email: 'blocked@example.com' },
    });
    assert.equal(asReadonly.status, 403, 'demotion propagates to the token');

    await h.api('DELETE', `/api/v1/users/${userId}`);

    const afterDelete = await h.api('POST', '/api/v1/contacts', {
      token,
      body: { first_name: 'Still', email: 'still-blocked@example.com' },
    });
    assert.equal(afterDelete.status, 401, 'deletion must not restore privileges');
  });

  test('disabling a user revokes their tokens too', async () => {
    const { userId, token } = await userWithToken(h, 'suspended@example.com');
    assert.equal((await h.api('GET', '/api/v1/contacts', { token })).status, 200);

    await h.api('PATCH', `/api/v1/users/${userId}`, { body: { disabled: true } });

    const afterDisable = await h.api('GET', '/api/v1/contacts', { token });
    assert.equal(
      afterDisable.status,
      401,
      'a suspended account cannot keep acting through an agent',
    );
  });

  test('a token whose creator vanished behind our back is refused, not promoted', async () => {
    // Only admins and owners can mint tokens, so the legacy row must come from one.
    const { userId, token } = await userWithToken(h, 'ghost@example.com', 'admin');

    // Reproduce a row written by a build that deleted the user without revoking
    // the token. Foreign keys have to come off to forge it, which is itself
    // evidence that the current code cannot produce this state.
    h.app.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    h.app.db.pragma('foreign_keys = OFF');
    h.app.db
      .prepare(`UPDATE api_tokens SET revoked_at = NULL, created_by = ? WHERE name = ?`)
      .run(userId, 'ghost@example.com-agent');
    h.app.db.pragma('foreign_keys = ON');

    const response = await h.api('GET', '/api/v1/contacts', { token });
    assert.equal(response.status, 401);
    assert.match(String(response.body.error.message), /no longer exists/);
  });

  test('self-check reports legacy orphaned tokens', async () => {
    const report = await h.api('GET', '/api/v1/system/selfcheck');
    const check = report.body.checks.find((c: any) => c.name === 'token_ownership');
    assert.equal(check.status, 'warn');
    assert.ok(check.remedy, 'the warning explains what to do');
    assert.ok(check.details.some((d: any) => d.reason === 'creator was deleted'));
  });

  test('an agent token still cannot mint another token', async () => {
    const response = await h.api('POST', '/api/v1/tokens', { body: { name: 'self-minted' } });
    assert.equal(response.status, 401);
  });
});

describe('outbound destination guard', () => {
  test('classifies private and public addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:169.254.169.254', // IPv4-mapped bypass
    ]) {
      assert.equal(isPrivateAddress(address), true, `${address} should be private`);
    }
    for (const address of [
      '8.8.8.8',
      '1.1.1.1',
      '93.184.216.34',
      '2606:2800:220:1:248:1893:25c8:1946',
    ]) {
      assert.equal(isPrivateAddress(address), false, `${address} should be public`);
    }
  });

  test('rejects loopback, link-local, and non-http schemes without touching DNS', async () => {
    for (const url of [
      'http://127.0.0.1:8080/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:9200/',
      'http://192.168.0.5/internal',
    ]) {
      const result = await checkDestination(url);
      assert.equal(result.allowed, false, `${url} should be blocked`);
    }

    const badScheme = await checkDestination('file:///etc/passwd');
    assert.equal(badScheme.allowed, false);
  });

  test('the escape hatch re-enables private delivery for sibling containers', async () => {
    const blocked = await checkDestination('http://10.0.0.5/hook');
    assert.equal(blocked.allowed, false);
    const allowed = await checkDestination('http://10.0.0.5/hook', { allowPrivate: true });
    assert.equal(allowed.allowed, true);
  });
});

describe('webhooks cannot reach the private network', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  test('a non-http scheme is rejected at the API boundary', async () => {
    const response = await h.api('POST', '/api/v1/webhooks', {
      body: { url: 'file:///etc/passwd' },
    });
    assert.equal(response.status, 422);
  });

  test('delivery to a metadata endpoint is blocked before any request is made', async () => {
    const webhook = await h.api('POST', '/api/v1/webhooks', {
      body: { url: 'http://169.254.169.254/latest/meta-data/', events: ['contact.*'] },
    });
    assert.equal(webhook.status, 201, 'the URL is syntactically fine; the guard is at delivery');

    await createRecord(h, 'contacts', { first_name: 'Probe', email: 'probe@example.com' });

    let attempted = false;
    const spy = async () => {
      attempted = true;
      return { ok: true, status: 200 } as Response;
    };

    const result = await flushDeliveries(h.app.db, { fetchImpl: spy as unknown as typeof fetch });

    assert.equal(attempted, false, 'no request left the process');
    assert.equal(result.blocked, 1);

    const deliveries = await h.api('GET', `/api/v1/webhooks/${webhook.body.id}/deliveries`);
    assert.equal(deliveries.body.data[0].status, 'failed');
    assert.match(String(deliveries.body.data[0].last_error), /private address/);
  });

  test('a public destination is still delivered, and does not follow redirects', async () => {
    const webhook = await h.api('POST', '/api/v1/webhooks', {
      body: { url: 'http://93.184.216.34/hook', events: ['company.*'] },
    });
    await createRecord(h, 'companies', { name: 'Deliverable Co', domain: 'deliverable.example' });

    let sawManualRedirect = false;
    const spy = async (_url: string, init: any) => {
      sawManualRedirect = init.redirect === 'manual';
      return { ok: true, status: 200 } as Response;
    };

    const result = await flushDeliveries(h.app.db, { fetchImpl: spy as unknown as typeof fetch });
    assert.equal(result.delivered, 1);
    assert.equal(result.blocked, 0);
    assert.ok(sawManualRedirect, 'redirects are not followed into the private range');

    const deliveries = await h.api('GET', `/api/v1/webhooks/${webhook.body.id}/deliveries`);
    assert.equal(deliveries.body.data[0].status, 'delivered');
  });
});

describe('state-changing requests need more than a cookie', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  test('GET selfcheck never repairs, even with repair=true', async () => {
    await createRecord(h, 'contacts', { first_name: 'Indexed', email: 'idx@example.com' });
    h.app.db.prepare(`DELETE FROM search_index WHERE entity_type = 'contact'`).run();

    const viaGet = await h.api('GET', '/api/v1/system/selfcheck?repair=true');
    assert.deepEqual(viaGet.body.repaired, [], 'a GET must not mutate');
    assert.equal(
      viaGet.body.checks.find((c: any) => c.name === 'search_index').status,
      'warn',
      'the index is still broken after the GET',
    );

    const viaPost = await h.api('POST', '/api/v1/system/selfcheck?repair=true');
    assert.ok(viaPost.body.repaired.includes('search_index'));
  });

  test('a cookie-authenticated write must declare a JSON content type', async () => {
    const cookie = await sessionCookie(h);

    const formPost = await h.server.inject({
      method: 'POST',
      url: '/api/v1/contacts',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: 'first_name=CSRF&email=csrf@example.com',
    });
    assert.equal(formPost.statusCode, 403, 'cross-site form posts are refused');

    const jsonPost = await h.server.inject({
      method: 'POST',
      url: '/api/v1/contacts',
      headers: { 'content-type': 'application/json', cookie },
      payload: JSON.stringify({ first_name: 'Legit', email: 'legit@example.com' }),
    });
    assert.equal(jsonPost.statusCode, 201);
  });
});
