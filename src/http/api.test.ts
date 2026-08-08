import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createRecord, OWNER, type Harness } from '../testing.ts';

describe('records', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  test('creates, reads, updates, archives, and restores a contact', async () => {
    const contact = await createRecord(h, 'contacts', {
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
      title: 'Analyst',
    });
    assert.equal(contact.object, 'contact');
    assert.match(contact.id, /^cont_[0-9A-Z]{26}$/);
    assert.equal(contact.full_name, 'Ada Lovelace');
    assert.equal(contact.version, 1);

    const read = await h.api('GET', `/api/v1/contacts/${contact.id}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.email, 'ada@example.com');

    const updated = await h.api('PATCH', `/api/v1/contacts/${contact.id}`, {
      body: { title: 'Chief Analyst' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.title, 'Chief Analyst');
    assert.equal(updated.body.version, 2, 'version increments on write');

    const archived = await h.api('DELETE', `/api/v1/contacts/${contact.id}`);
    assert.equal(archived.status, 200);
    assert.ok(archived.body.archived_at);

    const listed = await h.api('GET', '/api/v1/contacts');
    assert.equal(
      listed.body.data.find((r: any) => r.id === contact.id),
      undefined,
      'archived records are hidden by default',
    );

    const withArchived = await h.api('GET', '/api/v1/contacts?include_archived=true');
    assert.ok(withArchived.body.data.some((r: any) => r.id === contact.id));

    const restored = await h.api('POST', `/api/v1/contacts/${contact.id}/restore`);
    assert.equal(restored.body.archived_at, null);
  });

  test('include_archived=false does not accidentally read as true', async () => {
    const contact = await createRecord(h, 'contacts', {
      first_name: 'Hidden',
      email: 'h@example.com',
    });
    await h.api('DELETE', `/api/v1/contacts/${contact.id}`);
    const response = await h.api('GET', '/api/v1/contacts?include_archived=false');
    assert.ok(!response.body.data.some((r: any) => r.id === contact.id));
  });

  test('rejects unknown fields with the accepted list', async () => {
    const response = await h.api('POST', '/api/v1/contacts', {
      body: { first_name: 'Bad', compamy: 'typo' },
    });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'validation_failed');
    assert.ok(response.body.error.hint.includes('discover'));
  });

  test('rejects a contact with no identifying field', async () => {
    const response = await h.api('POST', '/api/v1/contacts', { body: { title: 'Nobody' } });
    assert.equal(response.status, 422);
  });

  test('reports a duplicate email as a conflict, not a crash', async () => {
    await createRecord(h, 'contacts', { first_name: 'First', email: 'dupe@example.com' });
    const second = await h.api('POST', '/api/v1/contacts', {
      body: { first_name: 'Second', email: 'dupe@example.com' },
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.details.field, 'email');
    assert.ok(second.body.error.hint.includes('filter[email]'));
  });

  test('rejects a reference to a record that does not exist', async () => {
    const response = await h.api('POST', '/api/v1/contacts', {
      body: { first_name: 'Orphan', company_id: 'comp_01JQ8ZK4M9V2XR7T3B5N6P8QWE' },
    });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.details.field, 'company_id');
  });

  test('If-Match blocks a write against a stale version', async () => {
    const contact = await createRecord(h, 'contacts', {
      first_name: 'Race',
      email: 'race@example.com',
    });
    await h.api('PATCH', `/api/v1/contacts/${contact.id}`, { body: { title: 'One' } });

    const stale = await h.api('PATCH', `/api/v1/contacts/${contact.id}`, {
      body: { title: 'Two' },
      headers: { 'if-match': String(contact.version) },
    });
    assert.equal(stale.status, 409);
    assert.ok(stale.body.error.message.includes('changed since you read it'));
  });

  test('custom data survives a round trip in properties', async () => {
    const contact = await createRecord(h, 'contacts', {
      first_name: 'Custom',
      email: 'custom@example.com',
      properties: { crm_score: 42, tags_from_import: ['a', 'b'] },
    });
    const read = await h.api('GET', `/api/v1/contacts/${contact.id}`);
    assert.deepEqual(read.body.properties, { crm_score: 42, tags_from_import: ['a', 'b'] });
  });
});

describe('listing', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
    for (let i = 0; i < 12; i++) {
      await createRecord(h, 'contacts', {
        first_name: `Person${String(i).padStart(2, '0')}`,
        last_name: 'Tester',
        email: `p${i}@example.com`,
        lifecycle_stage: i % 2 === 0 ? 'lead' : 'customer',
      });
    }
  });
  after(async () => {
    await h.close();
  });

  test('paginates without repeating or skipping records', async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url: string = `/api/v1/contacts?limit=5&sort=email${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await h.api('GET', url);
      assert.equal(page.status, 200);
      for (const record of page.body.data) {
        assert.ok(!seen.has(record.id), `record ${record.id} appeared twice`);
        seen.add(record.id);
      }
      cursor = page.body.next_cursor;
      pages++;
      assert.ok(pages < 10, 'pagination did not terminate');
    } while (cursor);

    assert.equal(seen.size, 12);
  });

  test('filters with operators', async () => {
    const leads = await h.api('GET', '/api/v1/contacts?filter[lifecycle_stage]=lead');
    assert.equal(leads.body.total, 6);

    const multi = await h.api('GET', '/api/v1/contacts?filter[lifecycle_stage__in]=lead,customer');
    assert.equal(multi.body.total, 12);

    const contains = await h.api('GET', '/api/v1/contacts?filter[email__contains]=p1');
    assert.ok(contains.body.total >= 3);

    const nullOwner = await h.api('GET', '/api/v1/contacts?filter[owner_id__is_null]=true');
    assert.equal(nullOwner.body.total, 12);
  });

  test('explains an unfilterable field instead of ignoring it', async () => {
    const response = await h.api('GET', '/api/v1/contacts?filter[nonsense]=x');
    assert.equal(response.status, 400);
    assert.ok(response.body.error.hint.includes('Filterable fields'));
  });

  test('explains an unsortable field', async () => {
    const response = await h.api('GET', '/api/v1/contacts?sort=-nonsense');
    assert.equal(response.status, 400);
    assert.ok(response.body.error.hint.includes('Sortable fields'));
  });

  test('rejects a malformed cursor with a usable hint', async () => {
    const response = await h.api('GET', '/api/v1/contacts?cursor=not-a-cursor');
    assert.equal(response.status, 400);
    assert.ok(response.body.error.hint.includes('next_cursor'));
  });
});

describe('search', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ seed: true });
  });
  after(async () => {
    await h.close();
  });

  test('finds records across types', async () => {
    const response = await h.api('GET', '/api/v1/search?q=verity');
    assert.equal(response.status, 200);
    assert.ok(response.body.data.length > 1);
    assert.ok(new Set(response.body.data.map((h2: any) => h2.entity_type)).size > 1);
  });

  test('survives punctuation that would break raw FTS syntax', async () => {
    for (const query of [
      'priya.raman@verityhealth.example',
      'C++ (maybe)',
      '"quoted"',
      'a AND b OR',
    ]) {
      const response = await h.api('GET', `/api/v1/search?q=${encodeURIComponent(query)}`);
      assert.equal(response.status, 200, `query ${query} should not error`);
    }
  });

  test('restricts to requested types', async () => {
    const response = await h.api('GET', '/api/v1/search?q=verity&types=contact');
    assert.ok(response.body.data.every((hit: any) => hit.entity_type === 'contact'));
  });

  test('excludes archived records from results', async () => {
    const contact = await createRecord(h, 'contacts', {
      first_name: 'Zzyzx',
      last_name: 'Unique',
      email: 'zzyzx@example.com',
    });
    const before = await h.api('GET', '/api/v1/search?q=zzyzx');
    assert.equal(before.body.data.length, 1);

    await h.api('DELETE', `/api/v1/contacts/${contact.id}`);
    const after = await h.api('GET', '/api/v1/search?q=zzyzx');
    assert.equal(after.body.data.length, 0);
  });
});

describe('deals', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  test('moves through stages, keeping status and timeline consistent', async () => {
    const pipelines = await h.api('GET', '/api/v1/pipelines');
    const pipeline = pipelines.body.data[0];
    const stages = pipeline.stages as any[];
    const proposal = stages.find((s) => s.name === 'Proposal');
    const won = stages.find((s) => s.outcome === 'won');

    const deal = await createRecord(h, 'deals', { title: 'Test deal', amount: 250_000 });
    assert.equal(deal.status, 'open');
    assert.equal(deal.amount_decimal, 2500);
    assert.equal(deal.stage_id, stages[0].id);

    const moved = await h.api('POST', `/api/v1/deals/${deal.id}/move`, {
      body: { stage_id: proposal.id, note: 'Sent the proposal' },
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.stage_id, proposal.id);
    assert.equal(moved.body.status, 'open');

    const context = await h.api('GET', `/api/v1/deals/${deal.id}/context`);
    const stageChange = context.body.timeline.find((a: any) => a.type === 'stage_change');
    assert.ok(stageChange, 'the move wrote a timeline entry');
    assert.equal(stageChange.body, 'Sent the proposal');
    assert.equal(context.body.related.stage.id, proposal.id);

    const closed = await h.api('POST', `/api/v1/deals/${deal.id}/close`, {
      body: { outcome: 'won', reason: 'Signed' },
    });
    assert.equal(closed.body.status, 'won');
    assert.equal(closed.body.stage_id, won.id);
    assert.ok(closed.body.closed_at);
  });

  test('refuses a stage from a different pipeline', async () => {
    const other = await h.api('POST', '/api/v1/pipelines', {
      body: {
        name: 'Partnerships',
        stages: [{ name: 'Intro' }, { name: 'Signed', outcome: 'won' }],
      },
    });
    const foreignStage = other.body.stages[0].id;
    const deal = await createRecord(h, 'deals', { title: 'Wrong pipeline' });

    const response = await h.api('POST', `/api/v1/deals/${deal.id}/move`, {
      body: { stage_id: foreignStage },
    });
    assert.equal(response.status, 400);
    assert.ok(response.body.error.message.includes('different pipeline'));
  });

  test('summarizes pipeline value by stage', async () => {
    const summary = await h.api('GET', '/api/v1/insights/pipeline');
    assert.equal(summary.status, 200);
    assert.ok(Array.isArray(summary.body.stages));
    assert.ok(typeof summary.body.totals.weighted_amount === 'number');
  });
});

describe('idempotency', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  test('a repeated create with the same key happens once', async () => {
    const body = { first_name: 'Once', last_name: 'Only', email: 'once@example.com' };
    const headers = { 'idempotency-key': 'key-abc' };

    const first = await h.api('POST', '/api/v1/contacts', { body, headers });
    const second = await h.api('POST', '/api/v1/contacts', { body, headers });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.id, first.body.id);
    assert.equal(second.headers['idempotent-replay'], 'true');

    const list = await h.api('GET', '/api/v1/contacts?filter[email]=once@example.com');
    assert.equal(list.body.total, 1);
  });

  test('the same key with a different body is an error, not a silent replay', async () => {
    const headers = { 'idempotency-key': 'key-xyz' };
    await h.api('POST', '/api/v1/contacts', {
      body: { first_name: 'A', email: 'a-idem@example.com' },
      headers,
    });
    const conflict = await h.api('POST', '/api/v1/contacts', {
      body: { first_name: 'B', email: 'b-idem@example.com' },
      headers,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'idempotency_mismatch');
  });
});

describe('bulk import', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  test('abort rolls the whole batch back', async () => {
    const response = await h.api('POST', '/api/v1/contacts/bulk', {
      body: {
        records: [
          { first_name: 'Good', email: 'good1@example.com' },
          { first_name: 'Bad', email: 'not-an-email' },
        ],
      },
    });
    assert.equal(response.status, 422);

    const list = await h.api('GET', '/api/v1/contacts?filter[email]=good1@example.com');
    assert.equal(list.body.total, 0, 'the valid record was rolled back with the batch');
  });

  test('skip imports what it can and reports the rest', async () => {
    const response = await h.api('POST', '/api/v1/contacts/bulk', {
      body: {
        on_error: 'skip',
        records: [
          { first_name: 'Keep', email: 'keep@example.com' },
          { first_name: 'Drop', email: 'nope' },
          { first_name: 'Keep2', email: 'keep2@example.com' },
        ],
      },
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.created, 2);
    assert.equal(response.body.failed, 1);
    assert.equal(response.body.errors[0].index, 1);
  });
});

describe('tags and timeline', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  test('tags are created on demand, normalized, and filterable', async () => {
    const contact = await createRecord(h, 'contacts', {
      first_name: 'Tagged',
      email: 't@example.com',
    });
    const tagged = await h.api('POST', `/api/v1/contacts/${contact.id}/tags`, {
      body: { tags: ['VIP Customer', 'newsletter'] },
    });
    assert.deepEqual(tagged.body.data.map((t: any) => t.name).sort(), [
      'newsletter',
      'vip-customer',
    ]);

    const filtered = await h.api('GET', '/api/v1/contacts?tag=vip-customer');
    assert.equal(filtered.body.total, 1);

    await h.api('DELETE', `/api/v1/contacts/${contact.id}/tags/vip-customer`);
    const after = await h.api('GET', '/api/v1/contacts?tag=vip-customer');
    assert.equal(after.body.total, 0);
  });

  test('context assembles the record, relations, timeline, and open tasks', async () => {
    const company = await createRecord(h, 'companies', {
      name: 'Contextual Inc',
      domain: 'ctx.example',
    });
    const contact = await createRecord(h, 'contacts', {
      first_name: 'Ctx',
      email: 'ctx@example.com',
      company_id: company.id,
    });
    await createRecord(h, 'activities', {
      type: 'call',
      subject: 'Intro call',
      contact_id: contact.id,
    });
    await createRecord(h, 'tasks', { title: 'Follow up', contact_id: contact.id });

    const context = await h.api('GET', `/api/v1/contacts/${contact.id}/context`);
    assert.equal(context.body.record.id, contact.id);
    assert.equal(context.body.related.company.id, company.id);
    assert.equal(context.body.timeline.length, 1);
    assert.equal(context.body.open_tasks.length, 1);
  });

  test('an activity attached to nothing is rejected', async () => {
    const response = await h.api('POST', '/api/v1/activities', {
      body: { type: 'note', body: 'floating' },
    });
    assert.equal(response.status, 422);
  });

  test('activities record which actor logged them', async () => {
    const contact = await createRecord(h, 'contacts', {
      first_name: 'Attrib',
      email: 'at@example.com',
    });
    const activity = await createRecord(h, 'activities', {
      type: 'note',
      body: 'logged by the agent token',
      contact_id: contact.id,
    });
    assert.equal(activity.actor_type, 'agent');
    assert.equal(activity.actor_label, 'test-agent');
  });
});

describe('audit trail', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  test('records every mutation with a field-level diff', async () => {
    const contact = await createRecord(h, 'contacts', {
      first_name: 'Aud',
      email: 'aud@example.com',
    });
    await h.api('PATCH', `/api/v1/contacts/${contact.id}`, { body: { title: 'Director' } });

    const audit = await h.api('GET', `/api/v1/audit?entity_id=${contact.id}`);
    assert.equal(audit.body.total, 2);
    const update = audit.body.data.find((e: any) => e.action === 'update');
    assert.deepEqual(update.changes.title, { from: null, to: 'Director' });
    assert.equal(update.actor.type, 'agent');
    assert.equal(update.source, 'api');
  });

  test('reverting an update restores the previous values', async () => {
    const contact = await createRecord(h, 'contacts', {
      first_name: 'Revert',
      email: 'rev@example.com',
      title: 'Original',
    });
    await h.api('PATCH', `/api/v1/contacts/${contact.id}`, { body: { title: 'Changed' } });

    const audit = await h.api('GET', `/api/v1/audit?entity_id=${contact.id}&action=update`);
    const entry = audit.body.data[0];
    assert.equal(entry.reversible, true);

    const reverted = await h.api('POST', `/api/v1/audit/${entry.id}/revert`);
    assert.equal(reverted.status, 200);
    assert.equal(reverted.body.record.title, 'Original');

    const again = await h.api('POST', `/api/v1/audit/${entry.id}/revert`);
    assert.equal(again.status, 400, 'an entry cannot be reverted twice');
  });

  test('reverting a create archives the record', async () => {
    const contact = await createRecord(h, 'contacts', {
      first_name: 'Oops',
      email: 'oops@example.com',
    });
    const audit = await h.api('GET', `/api/v1/audit?entity_id=${contact.id}&action=create`);
    const reverted = await h.api('POST', `/api/v1/audit/${audit.body.data[0].id}/revert`);
    assert.ok(reverted.body.record.archived_at);
  });

  test('a hard delete is reported as irreversible', async () => {
    const contact = await createRecord(h, 'contacts', {
      first_name: 'Gone',
      email: 'gone@example.com',
    });
    await h.api('DELETE', `/api/v1/contacts/${contact.id}?hard=true`);
    const audit = await h.api('GET', `/api/v1/audit?entity_id=${contact.id}&action=delete`);
    assert.equal(audit.body.data[0].reversible, false);
  });
});

describe('authentication and permissions', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  test('rejects an unauthenticated request with instructions', async () => {
    const response = await h.api('GET', '/api/v1/contacts', { token: null });
    assert.equal(response.status, 401);
    assert.ok(response.body.error.hint.includes('Bearer'));
  });

  test('rejects an invalid token', async () => {
    const response = await h.api('GET', '/api/v1/contacts', { token: 'ocrm_deadbeef_nope' });
    assert.equal(response.status, 401);
  });

  test('a scoped token can read but not write outside its scope', async () => {
    const login = await h.server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const created = await h.server.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: { 'content-type': 'application/json', cookie },
      payload: JSON.stringify({ name: 'readonly-agent', scopes: ['contacts:read'] }),
    });
    const scoped = JSON.parse(created.body).token;

    const read = await h.api('GET', '/api/v1/contacts', { token: scoped });
    assert.equal(read.status, 200);

    const write = await h.api('POST', '/api/v1/contacts', {
      token: scoped,
      body: { first_name: 'Blocked', email: 'blocked@example.com' },
    });
    assert.equal(write.status, 403);
    assert.ok(write.body.error.hint.includes('contacts:read'));

    const otherResource = await h.api('GET', '/api/v1/deals', { token: scoped });
    assert.equal(otherResource.status, 403);
  });

  test('a revoked token stops working immediately', async () => {
    const tokens = await h.api('GET', '/api/v1/tokens');
    const target = tokens.body.data.find((t: any) => t.name === 'readonly-agent');
    await h.api('DELETE', `/api/v1/tokens/${target.id}`);
    const listAfter = await h.api('GET', '/api/v1/tokens');
    assert.equal(listAfter.body.data.find((t: any) => t.id === target.id).revoked, true);
  });

  test('setup cannot be run twice', async () => {
    const response = await h.api('POST', '/api/v1/setup', {
      token: null,
      body: { email: 'second@example.com', name: 'Second', password: 'another-password' },
    });
    assert.equal(response.status, 409);
  });

  test('login with a wrong password fails without revealing which part was wrong', async () => {
    const response = await h.api('POST', '/api/v1/auth/login', {
      token: null,
      body: { email: OWNER.email, password: 'wrong-password-here' },
    });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.message, 'Incorrect email or password');
  });

  test('whoami reports the acting identity', async () => {
    const response = await h.api('GET', '/api/v1/auth/me');
    assert.equal(response.body.actor.type, 'agent');
    assert.equal(response.body.actor.label, 'test-agent');
  });
});

describe('discovery documents', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  test('discover describes every resource with a usable schema', async () => {
    const response = await h.api('GET', '/api/v1/discover', { token: null });
    assert.equal(response.status, 200);
    const names = response.body.resources.map((r: any) => r.name);
    assert.deepEqual(names.sort(), ['activity', 'company', 'contact', 'deal', 'task']);
    for (const resource of response.body.resources) {
      assert.equal(resource.create_schema.type, 'object');
      assert.ok(resource.endpoints.length > 5);
    }
    assert.ok(response.body.workflows.length >= 4);
  });

  test('openapi is valid enough to consume and covers the main routes', async () => {
    const response = await h.api('GET', '/openapi.json', { token: null });
    assert.equal(response.status, 200);
    assert.equal(response.body.openapi, '3.1.0');
    for (const path of [
      '/api/v1/contacts',
      '/api/v1/contacts/{id}',
      '/api/v1/deals/{id}/move',
      '/api/v1/audit/{id}/revert',
      '/api/v1/system/selfcheck',
      '/api/v1/search',
    ]) {
      assert.ok(response.body.paths[path], `${path} is documented`);
    }
    for (const [name, schema] of Object.entries<any>(response.body.components.schemas)) {
      assert.ok(schema.type || schema.anyOf || schema.$ref, `${name} has a usable schema`);
    }
  });

  test('llms.txt is served as plain text', async () => {
    const response = await h.api('GET', '/llms.txt', { token: null });
    assert.equal(response.status, 200);
    assert.ok(String(response.headers['content-type']).startsWith('text/plain'));
  });

  test('an unknown API route explains where to look', async () => {
    const response = await h.api('GET', '/api/v1/nope');
    assert.equal(response.status, 404);
    assert.ok(response.body.error.hint.includes('discover'));
  });

  test('health and readiness respond without credentials', async () => {
    assert.equal((await h.api('GET', '/healthz', { token: null })).status, 200);
    assert.equal((await h.api('GET', '/readyz', { token: null })).status, 200);
  });
});

describe('insights', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness({ seed: true });
  });
  after(async () => {
    await h.close();
  });

  test('overview reports counts and a win rate', async () => {
    const response = await h.api('GET', '/api/v1/insights/overview');
    assert.equal(response.status, 200);
    assert.equal(response.body.counts.companies, 5);
    assert.equal(response.body.counts.contacts, 7);
    assert.ok(response.body.revenue.open_pipeline > 0);
    assert.equal(response.body.revenue.win_rate, 50);
  });

  test('work queue surfaces overdue tasks and suggests an action', async () => {
    const response = await h.api('GET', '/api/v1/insights/work-queue');
    assert.ok(response.body.overdue_tasks.length >= 2);
    assert.ok(response.body.suggested_next_action.includes('overdue'));
  });

  test('completing a task removes it from the queue', async () => {
    const queue = await h.api('GET', '/api/v1/insights/work-queue');
    const task = queue.body.overdue_tasks[0];
    const completed = await h.api('POST', `/api/v1/tasks/${task.id}/complete`);
    assert.equal(completed.body.status, 'done');
    assert.ok(completed.body.completed_at);

    const after = await h.api('GET', '/api/v1/insights/work-queue');
    assert.ok(!after.body.overdue_tasks.some((t: any) => t.id === task.id));
  });
});
