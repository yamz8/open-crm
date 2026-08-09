# Changelog

Notable changes to open-crm. Format loosely follows [Keep a Changelog](https://keepachangelog.com);
versions follow [semantic versioning](https://semver.org). While the project is pre-1.0, minor
versions may contain breaking changes — those are always listed first.

## [Unreleased]

### Added

- **CSV import with a column-mapping step.** Pick a file, review how each column maps to a
  field — matched automatically for the headings other tools emit, and overridable — then
  import. Unmapped columns can be kept as custom fields in `properties` rather than discarded.
  Rows are sent in transactional chunks with a per-chunk idempotency key, and rejected rows are
  reported individually with their line number instead of failing the batch.
- **CSV export** of whatever the current filters match, following the cursor rather than
  stopping at the loaded page.
- **Editing in the web UI.** Detail pages have an Edit button that sends only the fields that
  changed and passes `If-Match`, so a concurrent edit produces a conflict rather than a silent
  overwrite.

### Fixed

- Lists stopped at 50 rows while the header reported the full total, hiding every record past
  the first page. They now follow `next_cursor` behind a Load more button.

## [0.1.1] — 2026-08-09

### Changed

- **The npm package is `open-crm-server`, not `open-crm`.** npm's registry refuses the
  unscoped name `open-crm` as too similar to the existing `open-cli` package, so the
  `npx open-crm mcp` line that 0.1.0 documented in the README, the web UI, `/llms.txt`, and the
  MCP server's own error message could never have worked. Every reference now reads
  `npx open-crm-server mcp`. The repository, the container image, and the installed command are
  all still `open-crm`; only the npm install path changed.

## [0.1.0] — 2026-08-08

First release. A self-hosted CRM whose API is the primary surface rather than an afterthought:
REST, MCP, and a CLI all call one service layer, so agents and people share the same
permission model, the same validation, and the same reversible audit trail.

### Records and workflow

- Contacts, companies, deals, activities, and tasks, each with a free-form `properties` object
  so custom data never needs a schema migration
- Configurable pipelines with a real stage/status state machine — moving a deal updates the
  stage, the won/lost status, the close timestamp, and the timeline atomically
- Timelines that record who logged what, including which agent
- Tags, saved views, and cursor-paginated lists with filter operators and sorting
- Full-text search across every record type (SQLite FTS5)
- Dashboard metrics and a work queue: overdue tasks, deals that have gone quiet, and contacts
  nobody has ever contacted

### For agents

- `GET /api/v1/discover` — a machine-readable capability map, plus `/llms.txt` and an
  OpenAPI 3.1 document generated from the same Zod schemas the server validates with
- `Idempotency-Key` on writes; the same key with a different body is rejected rather than
  silently replayed
- `GET /{type}/{id}/context` — record, tags, relations, timeline, and open tasks in one call
- `If-Match: <version>` for optimistic concurrency
- Structured errors carrying a `hint` written for the caller; unknown fields are rejected with
  the list of accepted ones
- Bulk create, up to 200 records in one transaction, all-or-nothing or with per-row errors
- MCP server over stdio and streamable HTTP: 24 tools, 4 resources, 3 prompts. Tool calls
  execute through the same HTTP stack as REST, so authentication, validation, idempotency, and
  auditing are identical by construction
- Scoped API tokens with a per-token audit trail and one-call revert of any change

### Operations

- `GET /api/v1/system/selfcheck` — schema, integrity, search index, domain invariant, and
  configuration checks; every non-passing check carries a remedy, and `POST …?repair=true`
  fixes what it safely can
- `open-crm backup` — consistent, compacted, integrity-verified snapshot taken while the
  server is running
- Outbound webhooks with HMAC-signed payloads and delivery history
- Docker image running as a non-root user with a health check, and a `docker compose` setup
- 132 tests through the real HTTP stack, a 35-assertion end-to-end smoke test against a
  running server, and a UI/API response contract suite

### Security

Findings from the pre-release security review, fixed before publication:

- **API tokens could outlive and out-rank their creator.** A token's role was resolved from
  the user who minted it with an `admin` fallback, and `created_by` was `ON DELETE SET NULL`,
  so deleting a demoted admin restored full privileges to a token they still held. Deleting or
  disabling a user now revokes the tokens they created, and a token whose creator is gone is
  refused rather than defaulting to a role
- **Webhooks could reach the private network.** URLs are now pinned to `http(s)`, destinations
  are re-resolved before every delivery and refused if they are loopback, RFC1918, link-local,
  CGNAT, or IPv4-mapped equivalents, and redirects are no longer followed.
  `WEBHOOK_ALLOW_PRIVATE=true` opts back in for sibling containers
- No endpoint mutates state on a `GET`, so nothing is reachable cross-site with a session
  cookie alone; cookie-authenticated writes must declare a JSON content type
- Password attempts get their own tight rate-limit bucket, separate from the general budget

[Unreleased]: https://github.com/yamz8/open-crm/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/yamz8/open-crm/releases/tag/v0.1.1
[0.1.0]: https://github.com/yamz8/open-crm/releases/tag/v0.1.0
