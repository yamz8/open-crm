#!/usr/bin/env node
/**
 * End-to-end smoke test against a *running* server, over real HTTP.
 *
 * The unit and integration suites use in-process injection; this catches the
 * things injection cannot: the listener, cookies, static assets, and the MCP
 * endpoint as an actual network service.
 *
 *   node scripts/smoke.mjs [--url http://localhost:4000]
 */

const args = process.argv.slice(2);
const urlFlag = args.indexOf('--url');
const BASE =
  (urlFlag !== -1 ? args[urlFlag + 1] : process.env.OPEN_CRM_URL) ?? 'http://localhost:4000';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  ✗ ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

async function json(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

const CREDENTIALS = {
  email: `smoke-${Date.now()}@example.com`,
  name: 'Smoke Test',
  password: 'smoke-test-password',
};

async function main() {
  process.stdout.write(`open-crm smoke test against ${BASE}\n\n`);

  process.stdout.write('Reachability\n');
  const health = await json('/healthz');
  check('GET /healthz', health.status === 200, `got ${health.status}`);
  const ready = await json('/readyz');
  check('GET /readyz', ready.status === 200);

  process.stdout.write('\nDiscovery\n');
  const discover = await json('/api/v1/discover');
  check('GET /api/v1/discover is public', discover.status === 200);
  check('discovery lists all five record types', discover.body?.resources?.length === 5);
  const openapi = await json('/openapi.json');
  check('GET /openapi.json', openapi.status === 200 && openapi.body.openapi === '3.1.0');
  const llms = await fetch(`${BASE}/llms.txt`);
  check('GET /llms.txt', llms.status === 200);

  process.stdout.write('\nWeb UI\n');
  const index = await fetch(`${BASE}/`);
  const indexHtml = await index.text();
  check('serves the app shell', index.status === 200 && indexHtml.includes('<div id="app">'));
  const script = await fetch(`${BASE}/assets/app.js`);
  check('serves the JS bundle', script.status === 200);
  const styles = await fetch(`${BASE}/assets/styles.css`);
  check('serves the stylesheet', styles.status === 200);
  const deepLink = await fetch(`${BASE}/contacts/whatever`);
  check('deep links fall back to the shell', deepLink.status === 200);

  process.stdout.write('\nAuthentication\n');
  const anonymous = await json('/api/v1/contacts');
  check('unauthenticated reads are refused', anonymous.status === 401);
  check(
    'the refusal explains how to authenticate',
    String(anonymous.body?.error?.hint).includes('Bearer'),
  );

  const setupStatus = await json('/api/v1/setup');
  let cookie;
  if (!setupStatus.body.complete) {
    const created = await json('/api/v1/setup', {
      method: 'POST',
      body: JSON.stringify(CREDENTIALS),
    });
    check('first-run setup creates the owner', created.status === 201);
  } else {
    process.stdout.write('  · instance already set up; using OPEN_CRM_TOKEN\n');
  }

  let token = process.env.OPEN_CRM_TOKEN;
  if (!token) {
    const login = await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: CREDENTIALS.email, password: CREDENTIALS.password }),
    });
    check(
      'login sets a session cookie',
      login.status === 200 && Boolean(login.headers.get('set-cookie')),
    );
    cookie = login.headers.get('set-cookie')?.split(';')[0];

    const minted = await json('/api/v1/tokens', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ name: 'smoke-test', scopes: ['*'] }),
    });
    check('a signed-in human can mint an API token', minted.status === 201);
    token = minted.body?.token;
  }

  const auth = { authorization: `Bearer ${token}` };
  const me = await json('/api/v1/auth/me', { headers: auth });
  check('the token authenticates', me.status === 200 && me.body.actor.type === 'agent');

  process.stdout.write('\nCore workflow\n');
  const company = await json('/api/v1/companies', {
    method: 'POST',
    headers: { ...auth, 'idempotency-key': `smoke-co-${Date.now()}` },
    body: JSON.stringify({ name: `Smoke Co ${Date.now()}`, domain: `smoke${Date.now()}.example` }),
  });
  check('create a company', company.status === 201, JSON.stringify(company.body));

  const contact = await json('/api/v1/contacts', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      first_name: 'Smoke',
      last_name: 'Tester',
      email: `smoke-${Date.now()}@example.com`,
      company_id: company.body.id,
    }),
  });
  check('create a contact linked to the company', contact.status === 201);

  const deal = await json('/api/v1/deals', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      title: 'Smoke deal',
      amount: 500000,
      company_id: company.body.id,
      contact_id: contact.body.id,
    }),
  });
  check('create a deal', deal.status === 201);
  check('amounts are minor units', deal.body?.amount_decimal === 5000);

  const pipelines = await json('/api/v1/pipelines', { headers: auth });
  const stage = pipelines.body.data[0].stages.find((s) => s.outcome === 'won');
  const moved = await json(`/api/v1/deals/${deal.body.id}/move`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ stage_id: stage.id, note: 'Smoke test close' }),
  });
  check('move the deal to a won stage', moved.status === 200 && moved.body.status === 'won');

  const context = await json(`/api/v1/deals/${deal.body.id}/context`, { headers: auth });
  check(
    'context returns the timeline entry the move wrote',
    context.body.timeline.some((a) => a.body === 'Smoke test close'),
  );
  check('context resolves related records', context.body.related.company?.id === company.body.id);

  const search = await json(`/api/v1/search?q=${encodeURIComponent('Smoke')}`, { headers: auth });
  check('search finds the new records', search.status === 200 && search.body.data.length > 0);

  process.stdout.write('\nSafety rails\n');
  const key = `smoke-idem-${Date.now()}`;
  const body = JSON.stringify({ title: 'Idempotent task' });
  const first = await json('/api/v1/tasks', {
    method: 'POST',
    headers: { ...auth, 'idempotency-key': key },
    body,
  });
  const replay = await json('/api/v1/tasks', {
    method: 'POST',
    headers: { ...auth, 'idempotency-key': key },
    body,
  });
  check('idempotency prevents duplicate writes', first.body.id === replay.body.id);
  check('the replay is labelled', replay.headers.get('idempotent-replay') === 'true');

  const bad = await json('/api/v1/contacts', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ first_name: 'Bad', nonexistent_field: 1 }),
  });
  check('unknown fields are rejected', bad.status === 422);

  const audit = await json(`/api/v1/audit?entity_id=${deal.body.id}`, { headers: auth });
  check('the audit log recorded the deal changes', audit.body.total >= 2);
  const revertable = audit.body.data.find((entry) => entry.reversible && entry.action === 'update');
  if (revertable) {
    const reverted = await json(`/api/v1/audit/${revertable.id}/revert`, {
      method: 'POST',
      headers: auth,
    });
    check('a change can be reverted', reverted.status === 200);
  }

  process.stdout.write('\nOperations\n');
  const selfcheck = await json('/api/v1/system/selfcheck', { headers: auth });
  check('selfcheck runs', [200, 503].includes(selfcheck.status));
  check(
    'selfcheck does not report a failure',
    selfcheck.body.status !== 'fail',
    JSON.stringify(selfcheck.body.checks?.filter((c) => c.status === 'fail')),
  );
  for (const item of selfcheck.body.checks ?? []) {
    if (item.status !== 'pass' && !item.remedy) {
      check(`check "${item.name}" explains itself`, false);
    }
  }

  const overview = await json('/api/v1/insights/overview', { headers: auth });
  check('overview reports metrics', overview.status === 200 && overview.body.counts.contacts >= 1);
  const workQueue = await json('/api/v1/insights/work-queue', { headers: auth });
  check(
    'work queue responds',
    workQueue.status === 200 && typeof workQueue.body.suggested_next_action === 'string',
  );

  process.stdout.write('\nMCP\n');
  const mcpUnauthorized = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check('MCP requires credentials', mcpUnauthorized.status === 401);

  const mcpInit = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      ...auth,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '1' },
      },
    }),
  });
  const mcpBody = await mcpInit.text();
  check('MCP initialize succeeds', mcpInit.status === 200 && mcpBody.includes('open-crm'));

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`\nsmoke test crashed: ${error?.stack ?? error}\n`);
  process.stderr.write(`Is the server running at ${BASE}? Start it with: npm start\n`);
  process.exit(1);
});
