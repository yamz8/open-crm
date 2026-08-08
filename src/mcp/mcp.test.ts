import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../testing.ts';
import { injectExecutor } from './executor.ts';
import { TOOLS, TOOLS_BY_NAME } from './tools.ts';
import type { Executor } from './executor.ts';

describe('MCP tools', () => {
  let h: Harness;
  let exec: Executor;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = TOOLS_BY_NAME.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    return exec(tool.build(args));
  };

  before(async () => {
    h = await createHarness({ seed: true });
    exec = injectExecutor(h.server, `Bearer ${h.token}`);
  });
  after(async () => {
    await h.close();
  });

  test('every tool has a description, a schema, and a read-only flag', () => {
    assert.ok(TOOLS.length >= 20);
    for (const tool of TOOLS) {
      assert.match(tool.name, /^crm_[a-z_]+$/);
      assert.ok(tool.description.length > 40, `${tool.name} needs a real description`);
      assert.equal(tool.inputSchema['type'], 'object');
      assert.equal(typeof tool.readOnly, 'boolean');
    }
  });

  test('tool names are unique', () => {
    assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length);
  });

  test('read-only tools really are read-only', async () => {
    for (const tool of TOOLS.filter((t) => t.readOnly)) {
      const built = tool.build({ type: 'contact', id: 'cont_x', q: 'x', audit_id: 'aud_x' });
      assert.equal(built.method, 'GET', `${tool.name} claims read-only but uses ${built.method}`);
    }
  });

  test('discovery and identity work through MCP', async () => {
    const discover = await call('crm_discover');
    assert.equal(discover.status, 200);
    assert.equal((discover.body as any).object, 'discovery');

    const me = await call('crm_whoami');
    assert.equal((me.body as any).actor.label, 'test-agent');
  });

  test('search finds a seeded record', async () => {
    const result = await call('crm_search', { q: 'verity', limit: 5 });
    assert.equal(result.status, 200);
    assert.ok((result.body as any).data.length > 0);
  });

  test('a full create-then-read cycle works through tools alone', async () => {
    const created = await call('crm_create_contact', {
      first_name: 'Mcp',
      last_name: 'Tester',
      email: 'mcp@example.com',
      idempotency_key: 'mcp-create-1',
    });
    assert.equal(created.status, 201);
    const id = (created.body as any).id;

    const replay = await call('crm_create_contact', {
      first_name: 'Mcp',
      last_name: 'Tester',
      email: 'mcp@example.com',
      idempotency_key: 'mcp-create-1',
    });
    assert.equal((replay.body as any).id, id, 'the idempotency key prevented a duplicate');

    const context = await call('crm_get_context', { type: 'contact', id });
    assert.equal((context.body as any).record.id, id);

    const updated = await call('crm_update', {
      type: 'contact',
      id,
      fields: { title: 'Tester' },
    });
    assert.equal((updated.body as any).title, 'Tester');
  });

  test('crm_update forwards the version as an optimistic-concurrency guard', async () => {
    const created = await call('crm_create_contact', {
      first_name: 'Version',
      email: 'version@example.com',
    });
    const id = (created.body as any).id;
    await call('crm_update', { type: 'contact', id, fields: { title: 'First' } });

    const stale = await call('crm_update', {
      type: 'contact',
      id,
      fields: { title: 'Second' },
      version: 1,
    });
    assert.equal(stale.status, 409);
  });

  test('listing supports filters and pagination through the tool schema', async () => {
    const result = await call('crm_list', {
      type: 'deal',
      filter: { status: 'open' },
      limit: 2,
      sort: '-amount',
    });
    assert.equal(result.status, 200);
    const body = result.body as any;
    assert.ok(body.data.length <= 2);
    assert.ok(body.data.every((d: any) => d.status === 'open'));
  });

  test('moving a deal through MCP updates status and timeline', async () => {
    const pipelines = await call('crm_pipelines');
    const stages = (pipelines.body as any).data[0].stages;
    const won = stages.find((s: any) => s.outcome === 'won');

    const deals = await call('crm_list', { type: 'deal', filter: { status: 'open' }, limit: 1 });
    const deal = (deals.body as any).data[0];

    const moved = await call('crm_move_deal', {
      id: deal.id,
      stage_id: won.id,
      note: 'Closed via MCP',
    });
    assert.equal((moved.body as any).status, 'won');

    const context = await call('crm_get_context', { type: 'deal', id: deal.id });
    assert.ok(
      (context.body as any).timeline.some((a: any) => a.body === 'Closed via MCP'),
      'the note landed on the timeline',
    );
  });

  test('errors come back with a readable hint rather than a bare failure', async () => {
    const result = await call('crm_get', {
      type: 'contact',
      id: 'cont_01JQ8ZK4M9V2XR7T3B5N6P8QWE',
    });
    assert.equal(result.status, 404);
    assert.ok((result.body as any).error.hint.includes('list'));
  });

  test('an unknown record type fails with the list of valid types', () => {
    const tool = TOOLS_BY_NAME.get('crm_list')!;
    assert.throws(
      () => tool.build({ type: 'invoice' }),
      /Unknown record type "invoice"\. Use one of: contact, company, deal, activity, task/,
    );
  });

  test('the audit and revert tools close the accountability loop', async () => {
    const created = await call('crm_create_contact', {
      first_name: 'Undo',
      email: 'undo@example.com',
      title: 'Before',
    });
    const id = (created.body as any).id;
    await call('crm_update', { type: 'contact', id, fields: { title: 'After' } });

    const audit = await call('crm_audit', { entity_id: id, action: 'update' });
    const entry = (audit.body as any).data[0];
    assert.deepEqual(entry.changes.title, { from: 'Before', to: 'After' });

    const reverted = await call('crm_revert', { audit_id: entry.id });
    assert.equal(reverted.status, 200);
    assert.equal((reverted.body as any).record.title, 'Before');
  });

  test('selfcheck is reachable as a tool', async () => {
    const result = await call('crm_selfcheck');
    assert.ok(['pass', 'warn'].includes((result.body as any).status));
  });

  test('a scoped token is refused at the MCP layer too', async () => {
    const restricted = injectExecutor(h.server, 'Bearer ocrm_bad_token');
    const tool = TOOLS_BY_NAME.get('crm_list')!;
    const result = await restricted(tool.build({ type: 'contact' }));
    assert.equal(result.status, 401);
  });
});

describe('MCP over HTTP', () => {
  let h: Harness;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.close();
  });

  const rpc = (body: unknown, token?: string) =>
    h.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token === null ? {} : { authorization: `Bearer ${token ?? h.token}` }),
      },
      payload: JSON.stringify(body),
    });

  test('rejects an unauthenticated MCP request', async () => {
    const response = await h.server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(response.statusCode, 401);
  });

  test('completes an initialize handshake and lists tools', async () => {
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });
    assert.equal(init.statusCode, 200);
    const body = JSON.parse(init.body);
    assert.equal(body.result.serverInfo.name, 'open-crm');
    assert.ok(body.result.instructions.includes('crm_work_queue'));
  });
});
