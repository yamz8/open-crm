# AGENTS.md

Guidance for AI agents. Two audiences, two halves: agents **using** this CRM, and agents
**working on** this codebase.

---

## Part 1 — Using the CRM

### Get oriented

```
GET /api/v1/auth/me                 who you are and what your token may do
GET /api/v1/discover                every record type, field, filter, and workflow
GET /api/v1/insights/work-queue     what needs attention right now
```

Via MCP those are `crm_whoami`, `crm_discover`, and `crm_work_queue`. Read `/llms.txt` if you
have limited context budget; read `/api/v1/discover` if you want the machine-readable version.

### The rules that matter

**Search before you create.** Duplicate contacts are the most common damage an agent does to a
CRM, and they are tedious for a human to clean up. `GET /api/v1/search?q=<name or email>`
first. Emails are unique across active contacts; you will get a 409 with the conflicting
field, not a silent second record.

**Use `/context`, not five reads.** `GET /api/v1/contacts/{id}/context` returns the record, its
tags, its company, its deals, its recent timeline, and its open tasks in one response.

**Money is an integer in minor units.** `150000` means `$1,500.00`. Never send a float.

**Move deals with the dedicated endpoint.** `POST /api/v1/deals/{id}/move` updates the stage,
the status, the close timestamp, and writes the timeline entry atomically. Patching `stage_id`
directly is redirected there, but calling `move` makes your intent explicit and lets you attach
a reason. Do not also log an activity describing the move — that duplicates the timeline.

**Send an `Idempotency-Key` on every write.** Retries are normal; duplicated records are not.
Same key + same body replays the original response. Same key + different body is a 409, which
means you have a bug worth noticing.

**Send `If-Match: <version>` when you read-then-write.** You will get a 409 instead of silently
overwriting a human's concurrent edit.

**Custom data goes in `properties`.** It is a free-form JSON object on every record. Inventing
a top-level field gets you a 422 listing the accepted ones.

**Archive, never hard-delete.** `DELETE` archives and is reversible. `?hard=true` is not, and
cannot be undone from the audit log.

### Read the hint

Errors look like this, and the `hint` is written for you:

```json
{
  "error": {
    "code": "conflict",
    "message": "Another contact already uses that email",
    "hint": "Search for the existing record first: GET /api/v1/contacts?filter[email]=<value>",
    "details": { "field": "email", "value": "ada@example.com" }
  }
}
```

Correct the request from the hint rather than retrying the same call.

### You are being watched, and that is good for you

Every write you make is recorded with your token's identity and a complete before-image. A
human can review it:

```
GET /api/v1/audit?actor_id=<your token id>&since=<iso timestamp>
POST /api/v1/audit/{id}/revert
```

This is what makes it reasonable to give you write access at all. Two habits follow from it:

- **Leave a trail a person can follow.** When you change something a colleague will wonder
  about later, log an activity or put a reason in the `note` field. "Moved to Negotiation
  because the customer asked for a revised quote on the 3rd" is worth the extra field.
- **Do not invent facts.** If a deal is stale and you have no new information, say so. Logging
  a filler note to make the timeline look active is worse than leaving it quiet.

### Ask before doing damage

Archiving records, closing deals as lost, bulk-editing, and hard deletion are all things a
human should confirm first unless they told you to do them. Reading, searching, logging
activities, and completing tasks you were asked to complete do not need confirmation.

---

## Part 2 — Working on this codebase

### Ground rules

```bash
npm run check     # format + typecheck + web build + tests. Must pass.
npm run smoke     # end-to-end against a running server
```

- **New behaviour needs a test.** Tests drive the real HTTP stack (`src/testing.ts` builds a
  complete in-memory instance) rather than calling services directly, so route wiring, auth,
  and validation are covered too.
- **New endpoints must appear in `/openapi.json` and `/api/v1/discover`.** There are tests that
  check this. A capability an agent cannot discover may as well not exist.
- **New failing states must explain themselves.** A test asserts that every non-passing
  self-check carries a `remedy`; hold API errors to the same standard with a `hint`.

### Where things live

| Path | What belongs there |
| --- | --- |
| `src/core/` | Config, ids, error types. No domain knowledge. |
| `src/db/` | Connection and SQL migrations. Migrations are append-only. |
| `src/domain/` | The application. Services take `(ctx, input)` and enforce their own permissions. |
| `src/http/` | Fastify wiring, OpenAPI generation, discovery. Thin — logic belongs in `domain`. |
| `src/mcp/` | Tool definitions. Tools map to REST calls; they do not reimplement anything. |
| `src/web/` | Browser UI. Vanilla TypeScript, no framework. |

### Patterns to preserve

**One schema, three consumers.** Zod schemas in `src/domain/schemas.ts` drive request
validation, the OpenAPI document, and MCP tool input schemas. If you add a field, add it there
and it propagates. Do not hand-write a JSON Schema next to a Zod one.

**Adding a record type is a registry entry.** `src/domain/resources.ts` defines what each type
is; routes, list/filter/sort behaviour, discovery, and MCP tools are generated from it. Reach
for a bespoke endpoint only when there is real business logic — as with deals, whose stage
transitions live in `src/domain/deals.ts`.

**All mutations go through `src/domain/store.ts`.** That is what guarantees the audit entry,
the search index update, and the domain event happen together. A write that bypasses it will
silently break search and the revert feature.

**Permissions are checked in services, not middleware.** Call `assertCan(ctx, resource,
access)` inside the service so every transport gets the same answer.

**Migrations are append-only.** Never edit an applied migration; add a new file. `selfcheck`
warns when the database contains migrations that the running build does not have.

### Things that will bite you

- `z.coerce.boolean()` on a query string turns `"false"` into `true`. Use the `booleanish`
  schema.
- Fastify rejects an empty body when `Content-Type: application/json` is set. The server
  installs a parser that treats it as `{}`; don't remove it.
- FTS5 has its own query syntax and raw user input is a syntax error more often than not.
  Always go through `toFtsQuery()`.
- Keyset pagination sorts on a `COALESCE`d expression so nullable columns cannot break paging.
  New sortable fields need an entry in the resource's `sortable` map, not just a column name.
