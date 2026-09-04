# Deployment

## What it needs

- **Node 22+**
- **PostgreSQL 16+**
- **Object storage** — optional. `STORAGE_DRIVER=local` writes to a directory and
  needs no credentials; `s3` targets any S3-compatible service.
- **An Anthropic API key** — optional. Without one the built-in local interpreter
  handles the documented modelling operations and everything else works
  identically.

## Environment

Every variable is validated at startup by `src/server/env.ts`. A missing or
malformed value fails the boot with a readable list rather than at some later
request. See `.env.example` for the annotated set.

Required in production:

```bash
DATABASE_URL="postgresql://user:pass@host:5432/atrium?schema=public"
AUTH_SECRET="$(openssl rand -base64 48)"   # at least 32 characters
APP_URL="https://atrium.example.com"       # used for cookie scoping and origin checks
```

## Docker Compose

The included compose file gives you Postgres, optional MinIO, and optionally the
application itself.

```bash
docker compose up -d db                    # database only; app runs on the host
docker compose --profile storage up -d     # add MinIO, with the bucket created
docker compose --profile app up --build    # everything in containers
```

The database container creates `atrium`, `atrium_test` and `atrium_e2e` on first
start, so the test suites have their own databases and a test run can never
destroy development data.

## A container image

The `Dockerfile` is a three-stage build producing a small runtime image from
Next's standalone output, running as a non-root user, with a health check.

```bash
docker build -t atrium-studio .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://…" \
  -e AUTH_SECRET="…" \
  -e APP_URL="https://atrium.example.com" \
  -e ANTHROPIC_API_KEY="sk-ant-…" \
  -v atrium-storage:/data/storage \
  atrium-studio
```

Migrations are not run automatically — a container that migrates on boot races
itself when you scale it. Run them once per release:

```bash
docker run --rm -e DATABASE_URL="postgresql://…" atrium-studio \
  npx prisma migrate deploy
```

## Fly.io

A worked example, because it handles the persistent volume the local storage
driver wants.

```bash
fly launch --no-deploy
fly postgres create --name atrium-db
fly postgres attach atrium-db          # sets DATABASE_URL

fly secrets set \
  AUTH_SECRET="$(openssl rand -base64 48)" \
  APP_URL="https://your-app.fly.dev" \
  ANTHROPIC_API_KEY="sk-ant-…"

fly volumes create atrium_storage --size 10
```

In `fly.toml`:

```toml
[[mounts]]
  source      = "atrium_storage"
  destination = "/data/storage"

[http_service]
  internal_port = 3000
  force_https   = true

[[http_service.checks]]
  path     = "/api/health"
  interval = "30s"
  timeout  = "5s"

[deploy]
  release_command = "npx prisma migrate deploy"
```

Then `fly deploy`.

## Vercel

Works, with one caveat: serverless functions have no persistent disk, so
`STORAGE_DRIVER=local` will not work. Use S3, R2 or B2:

```bash
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_BUCKET=atrium-studio
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
S3_FORCE_PATH_STYLE=true
```

Set `npx prisma migrate deploy && npm run build` as the build command, and use a
pooled connection string (Neon, Supabase pooler, or PgBouncer) — serverless
functions open far more connections than a long-lived server does.

The chat route declares `maxDuration = 300`, which needs a plan that allows long
function durations.

## Operations

**Health.** `GET /api/health` reports database reachability, the active AI
provider and storage driver, and returns 503 when the database is unreachable.
It also opportunistically prunes expired sessions and lapsed guest accounts, so
no separate cron is needed.

**Logs.** Structured JSON via pino. Secrets, cookies and connection strings are
redacted before serialisation. Ids, counts, durations and command types are
logged at `info`; prompt text and project content only at `debug`, which
production should not enable.

**Backups.** Everything is in Postgres except uploaded source files. `pg_dump`
plus your object store's own backup covers it. Project versions live in
`ProjectVersion`, so point-in-time recovery of a single design is a row copy.

**Scaling.** The app is stateless apart from the local storage driver. Use S3
mode and run as many instances as you like — sessions are in the database, and
rate limits are too, so they hold across instances.

**Indexes.** Defined in the schema: `Project(ownerId, updatedAt desc)`,
`ProjectVersion(projectId, createdAt desc)`, `Message(conversationId, createdAt)`,
`Operation(projectId, createdAt desc)`, `KnowledgeChunk(documentId)`,
`Session(userId)`, `Session(expiresAt)`, `RateLimitHit(bucket, createdAt)`.

## Hardening checklist

- [ ] `AUTH_SECRET` is at least 32 random characters and unique to the deployment
- [ ] `APP_URL` matches the real origin exactly (the Origin check uses it)
- [ ] TLS terminated in front of the app; `Secure` cookies require it
- [ ] `ENABLE_GUEST_MODE=false` if anonymous sessions are not wanted
- [ ] Rate limits tuned to your user base
- [ ] `LOG_LEVEL=info` or higher, never `debug`
- [ ] Database credentials scoped to the application's own database
- [ ] Object storage bucket private, with no public read
- [ ] `npm audit` clean, and dependencies updated on a schedule
