import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createRecord, type Harness } from '../testing.ts';

describe('self-check', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ seed: true });
  });
  after(async () => {
    await h.close();
  });

  test('a healthy instance reports every structural check as passing', async () => {
    const response = await h.api('GET', '/api/v1/system/selfcheck');
    assert.equal(response.status, 200);
    const byName = Object.fromEntries(response.body.checks.map((c: any) => [c.name, c]));

    for (const name of [
      'migrations',
      'sqlite_integrity',
      'foreign_keys',
      'search_index',
      'deal_stage_consistency',
      'activity_attachment',
    ]) {
      assert.equal(byName[name].status, 'pass', `${name}: ${byName[name]?.message}`);
    }
  });

  test('every failing check explains what to do about it', async () => {
    const response = await h.api('GET', '/api/v1/system/selfcheck');
    for (const check of response.body.checks) {
      if (check.status !== 'pass') {
        assert.ok(check.remedy, `${check.name} reported "${check.status}" without a remedy`);
      }
    }
  });

  test('detects a corrupted search index and repairs it on request', async () => {
    await createRecord(h, 'contacts', { first_name: 'Indexed', email: 'idx@example.com' });
    h.app.db.prepare(`DELETE FROM search_index WHERE entity_type = 'contact'`).run();

    const broken = await h.api('GET', '/api/v1/system/selfcheck');
    const check = broken.body.checks.find((c: any) => c.name === 'search_index');
    assert.equal(check.status, 'warn');
    assert.equal(check.repairable, true);

    const searchBefore = await h.api('GET', '/api/v1/search?q=Indexed');
    assert.equal(searchBefore.body.data.length, 0, 'search is genuinely broken');

    const repaired = await h.api('POST', '/api/v1/system/selfcheck?repair=true');
    assert.ok(repaired.body.repaired.includes('search_index'));
    assert.equal(repaired.body.checks.find((c: any) => c.name === 'search_index').status, 'pass');

    const searchAfter = await h.api('GET', '/api/v1/search?q=Indexed');
    assert.equal(searchAfter.body.data.length, 1, 'search works again');
  });

  test('notices when a deal status contradicts its stage', async () => {
    const deal = await createRecord(h, 'deals', { title: 'Inconsistent', amount: 1000 });
    // Simulate the drift a bad migration or a direct SQL edit would cause.
    h.app.db.prepare(`UPDATE deals SET status = 'won' WHERE id = ?`).run(deal.id);

    const response = await h.api('GET', '/api/v1/system/selfcheck');
    const check = response.body.checks.find((c: any) => c.name === 'deal_stage_consistency');
    assert.equal(check.status, 'warn');
    assert.ok(check.details.some((d: any) => d.id === deal.id));

    h.app.db.prepare(`UPDATE deals SET status = 'open' WHERE id = ?`).run(deal.id);
  });

  test('flags unrestricted tokens as a hygiene warning', async () => {
    const response = await h.api('GET', '/api/v1/system/selfcheck');
    const check = response.body.checks.find((c: any) => c.name === 'token_scopes');
    assert.equal(check.status, 'warn', 'the test harness token uses ["*"]');
    assert.ok(check.remedy.includes('narrow scopes'));
  });

  test('the reindex endpoint rebuilds every type', async () => {
    const response = await h.api('POST', '/api/v1/system/reindex');
    assert.equal(response.status, 200);
    assert.ok(response.body.indexed > 0);
    assert.ok(response.body.byType.contact >= 1);
  });

  test('system info reports migration state and limits', async () => {
    const response = await h.api('GET', '/api/v1/system/info');
    assert.equal(response.body.migrations.applied, true);
    assert.deepEqual(response.body.migrations.pending, []);
    assert.equal(response.body.limits.max_page_size, 200);
  });
});

describe('webhooks', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  test('queues a signed delivery for a matching event', async () => {
    const webhook = await h.api('POST', '/api/v1/webhooks', {
      body: { url: 'https://example.invalid/hook', events: ['contact.*'] },
    });
    assert.equal(webhook.status, 201);
    assert.ok(String(webhook.body.secret).startsWith('whsec_'), 'the secret is returned once');

    await createRecord(h, 'contacts', { first_name: 'Hooked', email: 'hook@example.com' });

    const deliveries = await h.api('GET', `/api/v1/webhooks/${webhook.body.id}/deliveries`);
    assert.equal(deliveries.body.data.length, 1);
    assert.equal(deliveries.body.data[0].event, 'contact.created');
    assert.equal(deliveries.body.data[0].status, 'pending');
  });

  test('does not queue events the subscription did not ask for', async () => {
    const webhook = await h.api('POST', '/api/v1/webhooks', {
      body: { url: 'https://example.invalid/deals-only', events: ['deal.won'] },
    });
    await createRecord(h, 'contacts', { first_name: 'Ignored', email: 'ignored@example.com' });

    const deliveries = await h.api('GET', `/api/v1/webhooks/${webhook.body.id}/deliveries`);
    assert.equal(deliveries.body.data.length, 0);
  });

  test('a failed delivery is retried and eventually marked failed', async () => {
    const { flushDeliveries } = await import('./webhooks.ts');
    const webhook = await h.api('POST', '/api/v1/webhooks', {
      body: { url: 'https://example.invalid/broken', events: ['company.created'] },
    });
    await createRecord(h, 'companies', { name: 'Flaky Co', domain: 'flaky.example' });

    const alwaysFails = async () => {
      throw new Error('connection refused');
    };

    for (let attempt = 0; attempt < 5; attempt++) {
      await flushDeliveries(h.app.db, {
        fetchImpl: alwaysFails as unknown as typeof fetch,
        // This test exercises retry mechanics, not destination policy.
        allowPrivateDestinations: true,
      });
    }

    const deliveries = await h.api('GET', `/api/v1/webhooks/${webhook.body.id}/deliveries`);
    const delivery = deliveries.body.data[0];
    assert.equal(delivery.status, 'failed');
    assert.equal(delivery.attempts, 5);
    assert.ok(delivery.last_error.includes('connection refused'));
  });

  test('a successful delivery is recorded with its signature verified by the receiver', async () => {
    const { flushDeliveries, signPayload } = await import('./webhooks.ts');
    const created = await h.api('POST', '/api/v1/webhooks', {
      body: { url: 'https://example.invalid/ok', events: ['task.*'] },
    });
    const secret = created.body.secret;

    await createRecord(h, 'tasks', { title: 'Webhook task' });

    let verified = false;
    const receiver = async (_url: string, init: any) => {
      const timestamp = init.headers['x-open-crm-timestamp'];
      const expected = `sha256=${signPayload(secret, timestamp, init.body)}`;
      verified = init.headers['x-open-crm-signature'] === expected;
      return { ok: true, status: 200 } as Response;
    };

    await flushDeliveries(h.app.db, {
      fetchImpl: receiver as unknown as typeof fetch,
      allowPrivateDestinations: true,
    });

    assert.ok(verified, 'the receiver could verify the HMAC signature');
    const deliveries = await h.api('GET', `/api/v1/webhooks/${created.body.id}/deliveries`);
    assert.equal(deliveries.body.data[0].status, 'delivered');
  });
});
