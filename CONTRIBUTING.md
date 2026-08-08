# Contributing

Thanks for considering it. This project has a small number of firm conventions and is
otherwise open to change.

## Getting set up

```bash
git clone https://github.com/yamz8/open-crm.git && cd open-crm
npm install
npm run build:web
npm run seed          # default pipeline + demo records
npm run dev           # auto-restarting server on :4000
```

Node 22.18 or newer is required — the server runs TypeScript directly through Node's built-in
type stripping, so there is no server build step. Only the browser bundle is built.

Working on the UI? Run `node scripts/build-web.mjs --watch` alongside `npm run dev`.

## Before you open a pull request

```bash
npm run check     # format, typecheck, web build, and the whole test suite
```

That is the same command CI runs, and it must pass. If you touched anything that serves
traffic, also run the end-to-end pass against a live server:

```bash
npm start                      # in one terminal
npm run smoke                  # in another
```

## What a good change looks like

**New behaviour comes with a test.** Tests drive the real HTTP stack — `src/testing.ts`
builds a complete in-memory instance — rather than calling services directly, so route
wiring, authentication, and validation are covered too. A bug fix should come with a test
that fails without the fix.

**New endpoints appear in the OpenAPI document and in `/api/v1/discover`.** There are tests
that check this. A capability an agent cannot discover may as well not exist.

**New failure states explain themselves.** A test asserts that every non-passing self-check
carries a `remedy`. Hold API errors to the same standard: every `AppError` that a caller can
plausibly hit should carry a `hint` that tells them how to fix the request.

**Comments explain why, not what.** The codebase leans on short comments at the points where
the reasoning is not obvious from the code. Match that; skip the ones that restate the line
below them.

## Where things live

| Path | What belongs there |
| --- | --- |
| `src/core/` | Config, ids, error types, version. No domain knowledge. |
| `src/db/` | Connection and SQL migrations. Migrations are append-only. |
| `src/domain/` | The application. Services take `(ctx, input)` and enforce their own permissions. |
| `src/http/` | Fastify wiring, OpenAPI generation, discovery. Thin — logic belongs in `domain`. |
| `src/mcp/` | Tool definitions. Tools map to REST calls; they do not reimplement anything. |
| `src/cli/` | The admin CLI. |
| `src/web/` | Browser UI. Vanilla TypeScript, no framework. |

[AGENTS.md](AGENTS.md) Part 2 goes into the patterns worth preserving and the traps that will
bite you. It is written for AI agents but applies equally to people.

## Adding a record type

Most of it is a registry entry. `src/domain/resources.ts` defines what a type is, and routes,
list/filter/sort behaviour, discovery, and MCP tools are generated from it. Reach for a
bespoke endpoint only when there is real business logic — as with deals, whose stage
transitions live in `src/domain/deals.ts`.

## Database migrations

Add a new file in `src/db/migrations/` named `NNNN_description.sql`. **Never edit a migration
that has been applied** — `selfcheck` warns when a database contains migrations the running
build does not have, and editing one in place makes that warning lie.

## Commit messages

Explain what changed and why the change is right, in prose. If you fixed a bug, say what the
broken behaviour was — the next person reading `git log` is usually trying to understand a
decision, not re-read the diff.

## Publishing a release

Maintainers only. Releases are cut by pushing a tag; the workflow does the rest.

```bash
# 1. Bump the version and write the changelog entry, then commit
npm version 0.2.0 --no-git-tag-version
$EDITOR CHANGELOG.md          # add a "## [0.2.0]" section

# 2. Tag and push
git commit -am "Release 0.2.0"
git tag -a v0.2.0 -m "open-crm 0.2.0"
git push origin main --follow-tags
```

The workflow refuses to proceed unless the tag matches `package.json` and the changelog has a
matching section, then publishes a multi-arch image to GHCR, boots it to confirm it comes up
ready, and drafts a GitHub release.

### Publishing to npm

The npm job skips with a logged message until this is set up, so releases stay green
either way. The container image is the primary artifact; npm exists only so that
`npx open-crm-server mcp` works.

**The first publish cannot be automated.** npm's OIDC trusted publishing is configured in a
package's settings page, which requires the package to already exist — a deliberate guard
against name hijacking. So a brand-new package has to be published once by a human:

```bash
npm login
npm publish --access public     # `npm run check` runs first via prepublishOnly
```

**Then switch the automation to trusted publishing**, which is worth doing because it leaves
no long-lived credential to leak or rotate:

1. On npmjs.com, open the package → Settings → Trusted Publisher → GitHub Actions, and enter
   the organisation (`yamz8`), the repository (`open-crm`), and the workflow filename
   (`release.yml` — filename only, not a path).
2. Add a repository variable so the workflow takes the OIDC path:
   ```bash
   gh variable set NPM_TRUSTED_PUBLISHING --body true --repo yamz8/open-crm
   ```
3. Delete the `NPM_TOKEN` secret if one was ever added:
   ```bash
   gh secret delete NPM_TOKEN --repo yamz8/open-crm
   ```

From then on the workflow authenticates with a short-lived GitHub OIDC token, and npm attaches
provenance automatically — no `--provenance` flag needed for a public package from a public
repository. This needs npm 11.5.1 or newer, which is why the job upgrades npm before
publishing; Node 22 ships npm 10.

**If you would rather keep using a token**, create a granular access token on npmjs.com scoped
to this package with publish permission and the shortest expiry you can live with, then:

```bash
gh secret set NPM_TOKEN --repo yamz8/open-crm    # paste at the prompt, then Ctrl-D
```

Reading from the prompt keeps the token out of your shell history and off disk. Revoke it from
npmjs.com if it is ever exposed.

## Reporting bugs

Include the version (`npm run cli -- version`), what you expected, what happened, and the
output of `npm run selfcheck` if the instance is misbehaving. For anything security-related,
follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Code of conduct

Participation is covered by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

Contributions are accepted under the [MIT Licence](LICENSE).
