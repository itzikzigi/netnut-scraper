# Netnut Scraper

Nest.js monorepo for the Netnut backend home assignment. Three services build a scrape pipeline: an HTTP **API** receives jobs, the **Job Manager** validates / persists / enqueues them, and the **Scraper** workers consume the queue, fetch the target URL (optionally through a rotating proxy pool), and return the HTML.

See `architecture.drawio` for the full design.

## Layout

```
.
├── apps/
│   ├── api/             # POST /scrape, GET /scrape/:id (+ ?wait=true)
│   ├── job-manager/     # POST /jobs, GET /jobs/:id · validate · persist · enqueue
│   └── scraper/         # BullMQ Worker · fetch via proxy · publish job:<id>:done
├── libs/
│   └── shared/          # JobEntity, DatabaseModule, JobsService, ScrapeQueueModule, types
├── k8s/                 # bonus (step 7)
├── architecture.drawio  # design diagram
├── docker-compose.yml   # full local stack
├── Dockerfile           # multi-stage (APP build arg)
├── nest-cli.json
├── tsconfig.json        # @app/shared → libs/shared/src
└── package.json
```

## Stack

- **Nest 11** monorepo
- **PostgreSQL** + TypeORM (`synchronize` in non-prod, migrations TODO for prod)
- **Redis** + **BullMQ** for the queue + Pub/Sub channel `job:<id>:done` for `?wait=true`
- **axios** + `http(s)-proxy-agent` for fetching, env-configured proxy pool with round-robin rotation

## Run with Docker Compose (recommended)

```bash
docker compose up --build
```

Brings up Postgres, Redis, and all three apps. Healthchecks gate startup so apps wait for infra.

Try it:

```bash
# async — returns a jobId immediately
curl -X POST http://localhost:3000/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'

# poll
curl http://localhost:3000/scrape/<jobId>

# sync — blocks up to 30s, returns HTML directly
curl -X POST 'http://localhost:3000/scrape?wait=true' \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

## Run natively (for hot reload)

Start infra in compose, apps natively:

```bash
docker compose up postgres redis -d
cp .env.example .env

# in three terminals:
npm run start:job-manager:dev
npm run start:scraper:dev
npm run start:api:dev
```

## API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/scrape` | Body `{ url }`. Returns `202 { jobId, status: 'pending' }` |
| `POST` | `/scrape?wait=true` | Same body. Blocks up to `SCRAPE_WAIT_TIMEOUT_MS`. `200 { jobId, status: 'completed', html }`, `503` on failure, `504` on timeout. |
| `GET` | `/scrape/:id` | Returns `{ id, status, html?, error?, attempts }` |

## Config

See `.env.example`. Key vars:

- `POSTGRES_*` — DB connection
- `REDIS_HOST` / `REDIS_PORT` — queue + Pub/Sub
- `JOB_MANAGER_URL` — service-to-service (default `http://localhost:3001`)
- `SCRAPE_WAIT_TIMEOUT_MS` — `?wait=true` budget (default `30000`)
- `FETCH_TIMEOUT_MS` — per-attempt axios timeout (default `20000`)
- `PROXY_POOL` — comma-separated proxy URLs. Empty = direct fetch. Credentials are stripped before logging and before being stored in `jobs.proxy_used`.

## Notes

- BullMQ retries failed fetches **3 times** with exponential backoff (2 s → 4 s → 8 s). Each retry picks the next proxy from the pool.
- `synchronize: true` (TypeORM) is on in non-prod — auto-creates the `jobs` table. **Migrations are required for production**; not implemented in this take-home.
- The Scraper writes job status directly to Postgres (intentional — see CLAUDE.md). Workers and Job Manager share `DatabaseModule` from `libs/shared`.
