# Netnut Scraper

Nest.js monorepo for the Netnut backend home assignment. Three services build a scrape pipeline: an HTTP **API** receives jobs, the **Job Manager** validates / persists / enqueues them, and the **Scraper** workers consume the queue, fetch the target URL (optionally through a rotating proxy pool), and return the HTML.

Scraping is slow, so the API is **async by default**: `POST /scrape` returns a `jobId` immediately (`202`). To get the HTML, either poll `GET /scrape/:id` or call `POST /scrape?wait=true` to block until the scrape completes and receive the HTML inline.

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
- **SSRF guard** on the fetch path — `http`/`https` only, private/internal/loopback/link-local targets rejected (pre-flight + connect-time DNS check), response size capped

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
| `POST` | `/scrape?wait=true` | Same body. Blocks up to `SCRAPE_WAIT_TIMEOUT_MS`. `200 { jobId, status: 'completed', html }`, `503` on failure, `504` on timeout, `410` if the result expired from cache. |
| `GET` | `/scrape/:id` | Returns `{ id, status, html?, error?, attempts }`. `html` is present only while the result is still cached (see `RESULT_TTL_SECONDS`). |

## Config

See `.env.example`. Key vars:

- `POSTGRES_*` — DB connection
- `REDIS_HOST` / `REDIS_PORT` — queue + Pub/Sub + HTML result cache
- `RESULT_TTL_SECONDS` — how long scraped HTML lives in the Redis cache (default `3600`)
- `JOB_MANAGER_URL` — service-to-service (default `http://localhost:3001`)
- `SCRAPE_WAIT_TIMEOUT_MS` — `?wait=true` budget (default `30000`)
- `FETCH_TIMEOUT_MS` — per-attempt axios timeout (default `20000`)
- `FETCH_MAX_BYTES` — max response body buffered into memory / Redis (default `5000000`, ~5 MB)
- `SCRAPER_CONCURRENCY` — jobs processed in parallel per scraper worker (default `10`; scraping is I/O-bound, so >1 is a big throughput win)
- `ALLOW_PRIVATE_TARGETS` — dev-only escape hatch; when `true` the SSRF guard is disabled so localhost/private targets are allowed. Keep `false` in any shared environment.
- `PROXY_POOL` — comma-separated proxy URLs. Empty = direct fetch. Credentials are stripped before logging and before being stored in `jobs.proxy_used`.

## Notes

- Each scraper worker processes `SCRAPER_CONCURRENCY` jobs in parallel (default 10) — the work is network-bound, so one in-flight fetch per pod would waste it.
- BullMQ retries failed fetches **3 times** with exponential backoff (2 s → 4 s → 8 s). Each retry picks the next proxy from the pool. A **blocked/invalid URL fails immediately** (BullMQ `UnrecoverableError`) — retrying a deterministic rejection can't help.
- **SSRF guard:** target URLs must be `http`/`https` and must not resolve to a private/internal/loopback/link-local address. Validated both before connecting and at connect time (so redirects and DNS rebinding are covered). On the proxy path, egress control is the proxy's responsibility. Disable only with `ALLOW_PRIVATE_TARGETS=true` for local dev. Response bodies are capped at `FETCH_MAX_BYTES`.
- `synchronize: true` (TypeORM) is on in non-prod — auto-creates the `jobs` table. **Migrations are required for production**; not implemented in this take-home.
- The Scraper writes job status directly to Postgres (intentional — see CLAUDE.md). Workers and Job Manager share `DatabaseModule` from `libs/shared`.
- Scraped **HTML is cached in Redis with a TTL** (`RESULT_TTL_SECONDS`), not persisted in Postgres — results are transient, so Postgres holds only durable metadata. The API reads the body straight from Redis, bypassing the Job Manager hop.

## Tradeoffs & scaling to production

The brief left architecture open, so I built a working, well-factored slice and made deliberate scope cuts rather than half-building production infrastructure. This section names those cuts and what I'd change to run this at Netnut-scale (100s–1000s of req/s, many scraper pods). None of these are needed for the take-home; they're here to show the decisions were intentional.

**Deliberate scoping decisions**

- **REST between API ↔ Job Manager**, not gRPC/message bus. Fastest to read in review; the schema/serialization cost of gRPC doesn't earn its keep at this scope. At scale I'd keep REST for the public edge but consider gRPC for the internal hop.
- **Config-based proxy pool** (`PROXY_POOL` env, in-memory round-robin), not a proxy-management service. This is the part closest to Netnut's actual product, so I built rotation + per-attempt retry + credential hygiene to show the shape — but kept it a single file.
- **`synchronize: true` in non-prod**, no migrations. Ergonomic for a demo; production must run real migrations (`DB_SYNCHRONIZE=false` + a migration step).
- **No auth / rate-limiting / multi-tenancy.** Out of scope for the brief, but the first thing a real proxy product needs.

**What I'd change for large scale**

- **HTML belongs in object storage, not Redis (or Postgres).** Redis-with-TTL is the right *mental model* (results are transient, PG stays metadata-only) and makes the migration small — but RAM caps how big/long you can retain. At scale: write bodies to S3/GCS (lifecycle rule = TTL for free), store the object key + size + sha256 in Postgres, and have the API return a **presigned URL** so the heavy bytes never transit the API/JM at all. Keep Redis as an optional short-TTL hot cache in front of S3 for the just-completed `?wait=true` read. Putting multi-MB HTML in Postgres would be the worst option — TOAST bloat, WAL/replication amplification, and vacuum pressure on the hottest table.
- **Split Redis by role.** Queue, Pub/Sub, and the blob cache have opposite memory/throughput profiles and currently share one instance; a flood of large pages can pressure the queue. Separate instances/DBs, with a `maxmemory-policy` that won't evict queue keys.
- **Tune BullMQ `lockDuration` above `FETCH_TIMEOUT_MS`.** The default 30 s lock is dangerously close to the 20 s fetch + DB/Redis writes under load — an expired lock means a stalled job gets re-processed (double fetch = double proxy spend). I'd set it to ~60 s and set `stalledInterval`/`maxStalledCount` explicitly.
- **Make create→enqueue atomic.** Today the JM commits the job row, then enqueues; if Redis blips between them the job is stranded `pending` forever. Production needs a transactional outbox (or a reaper for stale `pending` rows) so no job is silently lost.
- **Database: connection pooler + read path.** Add PgBouncer (transaction pooling) and explicit pool sizes — with HPA-scaled scraper pods each holding a TypeORM pool, connections exhaust before CPU does. Serve the read-heavy `GET /scrape/:id` from a replica.
- **Backpressure & quotas.** API-key auth, per-tenant rate limits (`@nestjs/throttler` on Redis), and a queue-depth circuit breaker that returns `429` when the backlog is too deep, so the queue can't grow unbounded.
- **Autoscale scrapers on queue depth, not CPU.** The HPA currently targets CPU; for a network-bound worker the correct signal is BullMQ backlog via the Prometheus adapter (noted in `k8s/README.md`).
- **Proxy pool as a service.** Health checks, ban/cooldown tracking, weighting, and pool state shared across pods (the current per-pod round-robin counter distributes unevenly, and a few dead proxies silently eat a slice of traffic as retries).
- **Observability.** Real `/health` endpoints (only TCP probes today), plus metrics for queue depth, fetch-latency percentiles, success rate per proxy, and Redis memory — you can't operate this blind at scale.
- **Idempotent terminal writes.** Guard status updates (e.g. `WHERE status != 'completed'`) so a duplicate/stale worker can't overwrite a finished job.
