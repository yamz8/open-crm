/**
 * `/llms.txt` — the short version, for an agent that has one screen of budget to
 * learn this API before it starts working. Everything here is also in
 * /api/v1/discover, machine-readably.
 */
export function buildLlmsTxt(publicUrl: string): string {
  return `# open-crm

> A self-hosted CRM built to be operated by both humans and AI agents. REST, MCP, and CLI
> all sit on one service layer, so every interface shares the same permissions and the same
> reversible audit trail.

Base URL: ${publicUrl}/api/v1
Capability map (machine-readable): ${publicUrl}/api/v1/discover
OpenAPI 3.1: ${publicUrl}/openapi.json

## Authenticate

    Authorization: Bearer ocrm_<prefix>_<secret>

A signed-in human mints tokens with POST /api/v1/tokens. Prefer narrow scopes
("contacts:write", "deals:read") over "*". Check yours with GET /api/v1/auth/me.

## The four calls worth learning first

    GET  /api/v1/insights/work-queue        what needs attention right now
    GET  /api/v1/search?q=acme              turn a name into an id
    GET  /api/v1/contacts/{id}/context      record + relations + timeline + open tasks, one call
    GET  /api/v1/audit?actor_id=tok_...     everything a token changed, with before/after

## Records

contacts, companies, deals, activities, tasks — each with the same shape:

    GET    /api/v1/{plural}                 list, filter, sort, paginate
    POST   /api/v1/{plural}                 create
    POST   /api/v1/{plural}/bulk            up to 200 in one transaction
    GET    /api/v1/{plural}/{id}            read
    PATCH  /api/v1/{plural}/{id}            partial update
    DELETE /api/v1/{plural}/{id}            archive (reversible; ?hard=true is not)

Deals additionally have POST /api/v1/deals/{id}/move and .../close, which update the
stage, the status, and the timeline together. Use those instead of PATCHing stage_id.

## Rules that will bite you if you skip them

- Money is an integer in minor units. 150000 is $1,500.00.
- Filters: filter[status]=open, filter[amount__gte]=500000, filter[email__contains]=@acme.com.
  Operators: eq ne gt gte lt lte contains starts_with in not_in is_null.
- Pagination is cursor-based: pass next_cursor back as cursor until has_more is false.
- Send an Idempotency-Key on every create. Retrying without one duplicates records.
- Send If-Match: <version> on PATCH if you read the record first and care about races.
- Errors are { error: { code, message, hint } }. The hint usually contains the exact fix.
- Custom data goes in the free-form \`properties\` object. Do not invent top-level fields;
  they are rejected with a list of what is accepted.

## Being a good citizen

Everything you change is attributed to your token and stored with a full before-image.
A human can review your work with GET /api/v1/audit?actor_id=<your token id> and undo any
single change with POST /api/v1/audit/{id}/revert. Archive rather than hard-delete, and
write a note on the timeline when you change something a person will wonder about later.

## MCP

    npx open-crm mcp        # stdio, reads OPEN_CRM_URL and OPEN_CRM_TOKEN
    ${publicUrl}/mcp        # streamable HTTP

The tools mirror the endpoints above and enforce the same scopes.
`;
}
