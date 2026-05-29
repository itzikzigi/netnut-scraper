# Netnut Scraper — Claude Context

Backend home assignment from **Netnut** (Israeli proxy / web-scraping company — sells residential/mobile/datacenter proxies and a Website Unblocker API). The task is essentially a miniature of Netnut's actual product: a Nest.js monorepo with three services that together accept scrape jobs, queue them, fetch the target URL through a rotating proxy pool, and return the HTML.

Source brief: `backend_home_assingment (1).pdf`. Design: `architecture.drawio` (numbered flows 1–13 + read/wait variants annotated).

## Stack (locked in)

- **Nest 11** monorepo — `apps/{api, job-manager, scraper}` + `libs/shared`
- **PostgreSQL** + TypeORM — `synchronize: true` when `NODE_ENV !== 'production'`, no migrations yet
- **Redis** + **BullMQ** for the queue (`scrape-jobs`) and Pub/Sub for `?wait=true` (channel `job:<id>:done`)
- **REST** between API ↔ Job Manager (gRPC considered, rejected as overkill for take-home)
- **axios** + `https-proxy-agent` planned for the Scraper fetcher
- Path alias: `@app/shared` → `libs/shared/src`

## API contract (planned)

- `POST /scrape { url }` → `202 Accepted { jobId }` (async, default)
- `POST /scrape?wait=true { url }` → API `SUBSCRIBE`s to `job:<id>:done`; returns `200 { html }` on publish or `504` on timeout
- `GET /scrape/:id` → `{ status, html?, error? }` for polling

## Architecture decisions (the non-obvious "why"s)

- **Worker writes to Postgres directly** (status, html, attempts). Simpler than round-tripping through Job Manager; couples Scraper to the entity but acceptable for this scope. `DatabaseModule` is in `libs/shared` for this reason.
- **`JobEntity implements ScrapeJob`** — the interface is the domain contract; the entity is the persistence impl. Same shape.
- **Proxy pool is config-based, not a separate service** — `env PROXY_POOL=url1,url2,...`, Scraper rotates per request, skipped when empty. Reviewers might assume a service if it's drawn as one in the diagram, so the diagram labels it as config.
- **String literal union types over TS enums** (`JobStatus = 'pending' | 'in_progress' | 'completed' | 'failed'`). Stored as `varchar(20)` in Postgres, not PG enum, to keep migrations simple later.
- **`attempts` increment uses `QueryBuilder` with `() => '"attempts" + 1'`** — atomic, avoids read-modify-write races between concurrent workers.

## Conventions

- No `nest new` was used (no `--directory` flag); monorepo scaffolded manually.
- The user/linter pinned Nest to **v11.x**. Don't downgrade — **and don't half-upgrade**. All `@nestjs/*` deps must stay on the same major; `npm ci` (strict) rejects mixed v10/v11 peer deps. We hit this once when `@nestjs/common` was left at `^10.4.0` while everything else was on `^11.x`.
- TypeORM `synchronize` is gated by `DB_SYNCHRONIZE` (defaults to `NODE_ENV !== 'production'`). Compose / k8s demos set `DB_SYNCHRONIZE=true` so they keep `NODE_ENV=production` while still auto-creating the schema. Production should set `DB_SYNCHRONIZE=false` and run real migrations (still a TODO).
- **`nest build` outputs nested paths in this monorepo.** Because tsconfig.app.json `include`s the libs (`../../libs/**/*`), tsc treats the monorepo root as the implicit rootDir and the entry point lands at `dist/apps/<app>/apps/<app>/src/main.js`, not `dist/apps/<app>/main.js`. The Dockerfile CMD and `start:prod:*` scripts use the full path. Don't "fix" it without verifying — it's deterministic and the compiled `require()` paths inside `dist` rely on the co-located lib output.
- Hebrew-character path (`OneDrive\שולחן העבודה\netnut`) on Windows — be mindful of any tooling that mangles non-ASCII paths. Git Bash converts `/app/...` paths to Windows when shelling into containers; use PowerShell + `--entrypoint sh` for those.
- Don't add features beyond the current step. The roadmap is sequenced deliberately.

## Status (update as you go)

- [x] Scaffold (apps + lib + nest-cli + tsconfig + git init on `main`)
- [x] Step 1 — Postgres + TypeORM in Job Manager (`JobEntity`, `DatabaseModule`, `JobsService`)
- [x] Step 2 — BullMQ + Redis queue (`ScrapeQueueModule` in shared, `JobsQueueService.enqueue` in job-manager). Default retry: 3 attempts, exponential backoff @ 2s; completed jobs reaped after 1 day or 1000 entries, failed after 7 days.
- [x] Step 3 — HTTP layer. JM exposes `POST /jobs`, `GET /jobs/:id`. API exposes `POST /scrape` (202 default, 200 if `?wait=true` completed, 504 on timeout, 503 on failure) and `GET /scrape/:id`. `JobManagerClient` uses plain axios. `JobEventsService` uses ioredis `psubscribe('job:*:done')` — one connection, pattern subscription handles all jobs. **Race-safe wait pattern: register waiter BEFORE checking DB**, since worker writes DB before publishing — guarantees we don't miss a fast-completing job.
- [x] Step 4 — Scraper. `ScrapeProcessor` (WorkerHost) consumes `scrape-jobs`, `FetcherService` (plain axios, 20s timeout, transformResponse disabled so HTML stays a string), `JobEventsPublisher` (ioredis publish). Flow: `markInProgress` → fetch → `markCompleted` → publish, with `markFailed`+publish only on final retry. `safePublish` swallows publish errors so a Redis blip doesn't fail a successful job. **Refactor:** `JobsService` moved from `apps/job-manager` to `libs/shared/src/database/` so both JM and Scraper get the same data-access layer via `DatabaseModule`.
- [x] Step 5 — Proxy pool. `ProxyPoolService` reads `PROXY_POOL` env (comma-separated URLs), round-robin `next()`. `FetcherService.fetch(url, proxyUrl?)` uses both `HttpsProxyAgent` + `HttpProxyAgent` (so target scheme doesn't matter) and sets `axios.proxy = false` to bypass axios's built-in proxy handling. Processor picks a proxy **per attempt** — retries rotate. **Credentials are stripped** before logging and before storing in `jobs.proxy_used` (`describe()` keeps only `protocol//host`). Empty pool → direct fetch (logged on boot).
- [x] Step 6 — Docker Compose. One `Dockerfile` (multi-stage) with an `APP` build arg picks which app to compile and run. `docker-compose.yml` brings up postgres + redis + all three services. YAML anchors (`x-postgres-env`, `x-redis-env`) share infra env vars across services. Healthchecks on postgres (`pg_isready`) and redis (`redis-cli ping`) gate app startup via `depends_on: condition: service_healthy`. `npm ci --omit=dev` in runtime stage; runs as `node` user.
- [x] Step 7 — K8s manifests. `k8s/`: namespace, Postgres StatefulSet + Secret + 5 GiB PVC, Redis StatefulSet (AOF) + 1 GiB PVC, shared ConfigMap, Deployments for api/job-manager/scraper (rolling update, 2 replicas each, `imagePullPolicy: IfNotPresent` for local kind/minikube). **TCP probes** on app ports (no `/health` endpoint to keep the manifests code-change-free). Scraper has an HPA: CPU-based 2→10 with a comment that queue-depth via prom-adapter is the prod-correct signal. Ingress is optional (port-forward fallback documented). `k8s/README.md` lists production TODOs (managed DB, migrations, TLS, NetworkPolicies, PDBs, secret stores, observability, Bull Board).
