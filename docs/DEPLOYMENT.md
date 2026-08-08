# Deploying open-crm

open-crm is one Node process and one SQLite file. There is no database server, no queue, and
no cache to operate. This guide covers getting that process onto the internet safely, and
keeping the file safe once it has your data in it.

---

## Before you expose it

Four things, in order of how much they matter.

**1. Set `OPEN_CRM_SECRET`.** Session cookies and API tokens are keyed to it. Without it the
app falls back to a well-known development key, which means anyone who reads the source can
forge a session.

```bash
openssl rand -hex 32
```

Store it like a password. Changing it later invalidates every session and every API token —
which is also how you perform an emergency logout-everyone.

**2. Put TLS in front.** The app speaks plain HTTP by design; terminate TLS in a reverse
proxy. Set `PUBLIC_URL` to the `https://` address — the app uses it to decide whether session
cookies get the `Secure` flag, so leaving it as `http://` behind a TLS proxy silently ships
your cookies without that flag.

**3. Complete first-run setup immediately.** Until an owner account exists, whoever reaches
the URL first can claim the instance. Either finish setup the moment you deploy, or start
with `ALLOW_SETUP=false` and create the owner from the CLI:

```bash
docker compose exec open-crm node src/cli/main.ts user create \
  --email you@example.com --name "Your Name" --password '…' --role owner
```

**4. Run the self-check.** It will tell you what you missed.

```bash
docker compose exec open-crm node src/cli/main.ts selfcheck
```

---

## Docker Compose

```bash
cp .env.example .env
echo "OPEN_CRM_SECRET=$(openssl rand -hex 32)" >> .env
# edit .env: set PUBLIC_URL to your https:// address
docker compose up -d
```

The bundled `docker-compose.yml` runs the image as a non-root user, keeps data in a named
volume mounted at `/data`, restarts unless stopped, and exposes a health check on `/readyz`.

To use the published image instead of building locally:

```yaml
services:
  open-crm:
    image: ghcr.io/yamz8/open-crm:0.1.0 # pin a version, not :latest
```

The image is public and needs no authentication to pull — packages published with the
workflow's `GITHUB_TOKEN` inherit the repository's visibility. If you fork this into a private
repository, the package will be private too, and you will need `docker login ghcr.io` or a
change under the repository's Packages settings.

---

## Reverse proxy

Set `TRUST_PROXY=true` **only** when a proxy you control is in front. It makes the app trust
`X-Forwarded-For` for client IPs, which is what the login rate limiter keys on — trusting it
without a proxy lets anyone spoof their way around that limit.

### Caddy

```caddyfile
crm.example.com {
    reverse_proxy localhost:4000
}
```

Caddy obtains and renews certificates automatically and sets `X-Forwarded-*` correctly.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name crm.example.com;

    ssl_certificate     /etc/letsencrypt/live/crm.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/crm.example.com/privkey.pem;

    # Bulk imports and large notes; the app's own limit is 5 MB.
    client_max_body_size 6m;

    location / {
        proxy_pass         http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # MCP over streamable HTTP can hold a response open.
        proxy_buffering    off;
        proxy_read_timeout 300s;
    }
}
```

---

## Backups

The entire dataset is one SQLite file. **Do not** back it up with `cp` — that can miss the
write-ahead log and produce a subtly corrupt copy. Use the built-in command, which takes a
consistent snapshot while the server keeps running and then verifies it:

```bash
docker compose exec open-crm node src/cli/main.ts backup
# → /data/backups/open-crm-2026-08-08T19-56-30.db  (integrity: ok)
```

A nightly cron entry on the host:

```cron
0 3 * * * docker compose -f /srv/open-crm/docker-compose.yml exec -T open-crm \
  node src/cli/main.ts backup >> /var/log/open-crm-backup.log 2>&1
```

Copy the resulting files somewhere off the machine — a backup on the same disk protects you
from software faults and nothing else. Prune old ones on whatever schedule your retention
policy calls for.

**Restoring** is a file move, and the server must be stopped so nothing is mid-write:

```bash
docker compose stop open-crm
docker compose run --rm --entrypoint sh open-crm -c \
  'cp /data/backups/open-crm-2026-08-08T19-56-30.db /data/open-crm.db && rm -f /data/open-crm.db-wal /data/open-crm.db-shm'
docker compose start open-crm
docker compose exec open-crm node src/cli/main.ts selfcheck
```

Test a restore before you need one. An untested backup is a hope.

---

## Upgrading

Migrations run automatically on boot and are append-only, so the normal path is:

```bash
docker compose exec open-crm node src/cli/main.ts backup   # always first
docker compose pull
docker compose up -d
docker compose exec open-crm node src/cli/main.ts selfcheck
```

If you ever roll back to an older image, `selfcheck` will warn that the database contains
migrations the running build does not know about. Restore the matching backup instead of
running that way.

---

## Giving agents access

Each agent gets its own token, named for what it is, with the narrowest scopes that work:

```bash
docker compose exec open-crm node src/cli/main.ts token create \
  --name nightly-enrichment \
  --scopes "contacts:read,contacts:write,companies:read,insights:read"
```

Scopes are `<resource>:<read|write|admin>`; `write` implies `read`, `admin` implies `write`.
Resources are `contacts`, `companies`, `deals`, `activities`, `tasks`, `pipelines`, `tags`,
`views`, `audit`, `insights`, `webhooks`, `users`, `tokens`, and `system`.

A token can never exceed the role of the user who created it, and it does not outlive that
account — deleting or disabling a user revokes the tokens they made.

Review what an agent has been doing, and undo anything you disagree with:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$PUBLIC_URL/api/v1/audit?actor_id=tok_…&since=2026-08-01T00:00:00Z"
curl -X POST -H "Authorization: Bearer $TOKEN" "$PUBLIC_URL/api/v1/audit/aud_…/revert"
```

`selfcheck` warns about wildcard (`*`) tokens. Treat that warning as a to-do.

---

## Monitoring

| Endpoint | Auth | Use |
| --- | --- | --- |
| `GET /healthz` | none | Liveness — is the process up |
| `GET /readyz` | none | Readiness — can it reach the database |
| `GET /api/v1/system/selfcheck` | token | Deep check; returns `503` if any check fails |
| `GET /api/v1/system/info` | token | Version, uptime, migration state, limits |

Point your uptime monitor at `/readyz` and run `selfcheck` from cron — it is the one that
notices a corrupted index, a drifted schema, or an orphaned token.

Logs are structured JSON on stdout with `Authorization` and `Cookie` headers redacted. Set
`LOG_LEVEL=warn` in production if `info` is too chatty.

---

## Scaling notes

SQLite in WAL mode handles one writer and many concurrent readers. For a CRM — where writes
are humans typing and agents logging activities — that is a much higher ceiling than people
expect, comfortably into the tens of thousands of records and dozens of active users on
modest hardware.

What it does **not** support is running two app instances against the same file. If you
outgrow one process, that is the point to move the storage layer, not to add replicas.

Keep the database on a local disk. SQLite over NFS or similar network filesystems has
well-known locking problems and will eventually corrupt the file.

---

## Environment reference

Every setting has a working default except `OPEN_CRM_SECRET`. See [.env.example](../.env.example)
for the annotated list. The ones that matter most in production:

| Variable | Default | Notes |
| --- | --- | --- |
| `OPEN_CRM_SECRET` | — | **Required in production.** Keys sessions and tokens |
| `PUBLIC_URL` | `http://localhost:4000` | Must match the real URL; drives the `Secure` cookie flag |
| `DATABASE_URL` | `data/open-crm.db` | Local disk only |
| `TRUST_PROXY` | `false` | `true` only behind a proxy you control |
| `ALLOW_SETUP` | `true` | `false` once the owner account exists |
| `WEBHOOK_ALLOW_PRIVATE` | `false` | `true` only to reach a sibling container |
| `LOGIN_RATE_LIMIT_MAX` | `10` | Password attempts per IP per window |
| `RATE_LIMIT_MAX` | `600` | General requests per token per minute |
| `LOG_LEVEL` | `info` | `warn` is a reasonable production setting |
