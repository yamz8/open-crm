# open-crm

[![CI](https://github.com/yamz8/open-crm/actions/workflows/ci.yml/badge.svg)](https://github.com/yamz8/open-crm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.18-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-24%20tools-8b5cf6.svg)](#designed-for-agents)

A self-hosted, open-source CRM built for two kinds of users at once: **people**, through a
fast web UI, and **AI agents**, through a REST API, an MCP server, and a CLI.

It is not a CRM with an API bolted on. Every interface calls the same service layer, so an
agent and a human get the same permissions, the same validation, and the same audit trail —
and any change either of them makes can be reviewed and undone.

```
┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐
│ Web UI  │  │  REST   │  │   MCP   │  │   CLI   │
└────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘
     └────────────┴────────────┴────────────┘
                        │
              service layer  ·  one permission model
                             ·  one audit trail
                             ·  one set of invariants
                        │
                    SQLite (WAL + FTS5)
```

---

## Quick start

```bash
git clone <this repo> open-crm && cd open-crm
npm install
npm run build:web
npm run seed          # default pipeline + demo records (optional)
npm start
```

Open <http://localhost:4000> and create the first account.

### Docker

```bash
cp .env.example .env
echo "OPEN_CRM_SECRET=$(openssl rand -hex 32)" >> .env
docker compose up -d
```

Data lives in a named volume at `/data`. Take a consistent, verified snapshot at any time
without stopping the server:

```bash
docker compose exec open-crm node src/cli/main.ts backup
# → /data/backups/open-crm-2026-08-08T19-56-30.db  (integrity: ok)
```

Do not back the file up with `cp` — that can miss the write-ahead log and produce a subtly
corrupt copy. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) covers TLS, reverse proxies, backup
schedules, restores, and upgrades.

---

## What it does

**Records** — contacts, companies, deals, activities, and tasks. Every record takes arbitrary
custom fields in a free-form `properties` object, so you never need a schema migration to
store something specific to your business.

**Pipelines** — deals move through configurable stages with win probabilities. Moving a deal
updates its stage, its won/lost status, its close date, and its timeline in one atomic step.

**Timeline** — calls, emails, meetings, and notes attach to any record, with the author
recorded — including which agent logged what.

**Search** — one full-text query across every record type (SQLite FTS5), plus filters,
sorting, and cursor pagination on every list.

**Insights** — a dashboard of counts, pipeline value, and win rate, and a *work queue* that
answers "what needs attention right now": overdue tasks, deals that have gone quiet, and
contacts nobody has ever contacted.

**Governance** — every mutation is written to an audit log with a complete before-image, and
any single change can be reverted through the UI or the API.

---

## Designed for agents

Most CRMs treat automation as a second-class integration surface. Here it is the primary one.

| Problem an agent hits | What this does about it |
| --- | --- |
| "What can I even do here?" | `GET /api/v1/discover` returns a capability map: every record type, its JSON Schema, its filters, its sorts, and the workflows the API is designed around. Also `/llms.txt` and `/openapi.json`. |
| Retries create duplicates | `Idempotency-Key` on every write. The same key with the same body replays the original response; the same key with a *different* body is rejected rather than silently ignored. |
| Guessing field names | Unknown fields are rejected with the list of accepted ones. Errors carry a `hint` written for the caller, not for a log file. |
| Six calls to understand one record | `GET /{type}/{id}/context` returns the record, its tags, its related records, its timeline, and its open tasks in one response. |
| Clobbering concurrent edits | Every record has a `version`. Send `If-Match: <version>` to get a 409 instead of overwriting someone. |
| "Can I trust it with write access?" | Scoped tokens (`contacts:write`, `deals:read`), a full audit trail per token, and one-click revert. |
| Half-finished imports | `POST /{type}/bulk` runs up to 200 records in one transaction, all-or-nothing or with per-row errors. |

### Connect Claude Code

```bash
# Create a token from the UI (Agents & API), or:
npm run cli -- token create --name claude-code --scopes "contacts:write,companies:write,deals:write,activities:write,tasks:write,insights:read"

claude mcp add open-crm \
  --env OPEN_CRM_URL=http://localhost:4000 \
  --env OPEN_CRM_TOKEN=ocrm_... \
  -- npx open-crm-server mcp
```

The npm package is published as `open-crm-server` (npm refuses `open-crm` as too close to an
existing package); the repository, image, and installed command are all still `open-crm`.

The MCP server exposes 24 tools (`crm_search`, `crm_get_context`, `crm_move_deal`,
`crm_work_queue`, `crm_audit`, `crm_revert`, …), four resources, and three prompts
(`daily_review`, `prep_for_meeting`, `review_agent_changes`).

There is also a streamable-HTTP MCP endpoint at `/mcp` for clients that prefer it.

### Or just use HTTP

```bash
curl -H "Authorization: Bearer $OPEN_CRM_TOKEN" \
  "http://localhost:4000/api/v1/deals?filter[status]=open&filter[amount__gte]=100000&sort=-amount"
```

Amounts are integers in minor units — `150000` is `$1,500.00`. Responses also include
`amount_decimal` and `amount_formatted` so nobody has to guess.

---

## It checks itself

`npm run check` runs formatting, types, the web build, and 132 tests. Beyond that, the running
instance can diagnose itself:

```bash
npm run cli -- selfcheck            # or GET /api/v1/system/selfcheck
```

```
✓ migrations               Schema is up to date
✓ sqlite_integrity         SQLite reports no corruption
✓ foreign_keys             No dangling foreign keys
✓ search_index             Search index matches all records
✓ deal_stage_consistency   Every deal status matches its stage outcome
✓ activity_attachment      Every activity is attached to a record
! instance_secret          OPEN_CRM_SECRET is unset, so sessions use a well-known key
  → Set OPEN_CRM_SECRET to a random 32-byte hex string and restart.
```

Every non-passing check explains what to do about it, and `?repair=true` fixes the ones that
can be fixed safely (rebuilding the search index, purging expired sessions). A test asserts
that no check is allowed to report a problem without a remedy.

`scripts/smoke.mjs` runs 35 end-to-end assertions against a *running* server — the listener,
cookies, static assets, and MCP as a real network service — covering what in-process tests
cannot.

---

## Commands

```bash
npm start                 # run the server
npm run dev               # run with auto-restart
npm run build:web         # bundle the web UI (esbuild)
npm run check             # format + types + build + tests
npm test                  # tests only
npm run smoke             # end-to-end against a running server
npm run backup            # verified snapshot of the database
npm run selfcheck         # diagnose the instance
npm run cli -- --help     # admin CLI
npm run mcp               # stdio MCP server
```

The CLI covers setup and operations: `migrate`, `seed --demo`, `user create`, `token create`,
`backup`, `selfcheck --repair`, `reindex`, `search`, `list`, `overview`, `work-queue`,
`audit`, `info`, `version`.

---

## Architecture

```
src/
  core/        config, prefixed ULIDs, structured errors
  db/          SQLite connection + SQL migrations
  domain/      the whole application: schemas, store, services, permissions
  http/        Fastify routes, OpenAPI generation, discovery
  mcp/         MCP tools, stdio server, HTTP transport
  cli/         admin CLI
  web/         browser UI (no framework)
```

A few decisions worth knowing about:

**One schema definition, three consumers.** Each record type is defined once in Zod. That one
definition drives request validation, the generated OpenAPI document, *and* the MCP tool input
schemas. They cannot drift apart, because there is nothing to keep in sync.

**MCP calls travel through the HTTP stack.** The `/mcp` endpoint executes tools by injecting
requests into the same Fastify instance that serves the REST API, in-process. Authentication,
validation, permissions, idempotency, and audit logging are identical by construction rather
than by discipline.

**Authorization lives in the domain layer, not in middleware.** `assertCan(ctx, resource,
access)` is called by services, so an MCP tool call and a CLI command get exactly the same
answer as a REST request.

**Archive, don't delete.** `DELETE` archives by default and is reversible. Hard deletion exists
but has to be asked for explicitly, and the API says so when you use it.

**SQLite on purpose.** WAL mode, FTS5 search, foreign keys enforced. One file to back up, no
database server to operate. It comfortably handles the scale a self-hosted CRM actually sees.

**Node runs the TypeScript directly.** No transpile step on the server — Node 22's built-in
type stripping runs `src/**/*.ts` as-is, in development, in tests, and in production. Only the
browser bundle is built.

---

## Configuration

Every setting has a working default except `OPEN_CRM_SECRET`, which is required in production
and derives session and token lookup keys. See [.env.example](.env.example).

## Security notes

- Passwords are hashed with scrypt (N=16384), and login runs a hash comparison even for
  unknown accounts so timing does not reveal which addresses exist.
- Session tokens and API tokens are stored only as HMACs keyed by the instance secret.
- Cookie-authenticated writes must send `Content-Type: application/json`, which blocks
  cross-site form posts. Bearer-token clients are unaffected, and no endpoint mutates on GET.
- API tokens can never exceed the role of the user who minted them, and they do not outlive
  that account: deleting or disabling a user revokes the tokens they created, and a token
  whose creator is gone is refused rather than falling back to a default role.
- Webhook payloads are signed: `x-open-crm-signature: sha256=HMAC(secret, "<timestamp>.<body>")`.
- Webhook destinations are restricted to `http(s)` and re-resolved before every delivery;
  private, loopback, and link-local addresses are refused and redirects are not followed, so a
  webhook cannot be turned into a port scanner or a route to cloud metadata. Set
  `WEBHOOK_ALLOW_PRIVATE=true` if you deliver to a sibling container you trust.

`npm run cli -- selfcheck` flags the two states that matter here: unrestricted (`["*"]`) tokens,
and tokens that outlived the account which created them.

Found a vulnerability? Please open a security advisory rather than a public issue.

## Documentation

| | |
| --- | --- |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production checklist, TLS, backups, restores, upgrades, scaling |
| [AGENTS.md](AGENTS.md) | How agents should use the CRM, and how to work on the codebase |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup and what a good change looks like |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability, and what is in scope |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release |

## Contributing

`npm run check` must pass. New behaviour needs a test; new endpoints need to appear in the
OpenAPI document and in `/api/v1/discover` (there are tests for both). Start with
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
