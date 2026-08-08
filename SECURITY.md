# Security policy

## Reporting a vulnerability

Please report security issues privately, not as a public issue.

Use GitHub's **[Report a vulnerability](https://github.com/yamz8/open-crm/security/advisories/new)**
form, which opens a private advisory only the maintainers can see.

Please include:

- what an attacker can do, and what they need to start with (an account? a token? a scope?)
- the smallest reproduction you have — a `curl` command is ideal
- the version or commit you tested

You will get an acknowledgement within **3 working days** and an assessment within **10**.
If a fix is warranted we will agree a disclosure date with you, credit you in the advisory
and the changelog unless you would rather stay anonymous, and publish the fix and the
advisory together.

We will not take legal action over good-faith research: testing against **your own
instance**, staying within your own data, and giving us a chance to fix things before going
public. Please do not test against someone else's deployment.

## Supported versions

open-crm is pre-1.0. Only the latest release receives security fixes.

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |

## What is in scope

The application in this repository: the HTTP API, the MCP server, the web UI, the CLI, and
the published Docker image.

Findings we would particularly like to hear about:

- authentication or authorization bypass, including scope and role enforcement
- one tenant's agent token reaching data or actions it was not granted
- SQL injection, XSS, or SSRF
- anything that lets an API token exceed the role of the user who minted it

## What is out of scope

- **Misconfiguration of your own deployment.** Running without `OPEN_CRM_SECRET`, exposing
  the port directly without TLS, or setting `TRUST_PROXY=true` without a proxy in front are
  operator errors. `npm run selfcheck` flags several of them.
- **First-run setup being open before you complete it.** Any instance is claimable by the
  first person who reaches it until an owner account exists. Complete setup immediately, or
  start with `ALLOW_SETUP=false` and create the owner using the CLI.
- **What a `*`-scoped token can do.** A wildcard token is designed to be able to do
  everything its creator can. Give agents the narrowest scopes that work; `selfcheck` warns
  when wildcard tokens exist.
- Denial of service through sheer volume, missing rate limits on non-authentication
  endpoints, and vulnerabilities in dependencies without a demonstrated path through this
  code (report those upstream).
- Findings from automated scanners with no demonstrated exploit path.

## Hardening a deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the production checklist. The short version:
set `OPEN_CRM_SECRET`, terminate TLS in front of the app, keep `WEBHOOK_ALLOW_PRIVATE=false`,
give each agent its own narrowly scoped token, and run `npm run selfcheck` after any change.
