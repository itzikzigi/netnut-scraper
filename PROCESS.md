# Process & Tools

This document accompanies the solution and the `architecture.drawio` diagram. It explains how I approached the task, the choices I made, and the trade-offs I am aware of.

## Framing

Before writing code I read the brief, looked at Netnut's product surface (residential / mobile / datacenter proxies, the Website Unblocker API, the SERP scraper), and reframed the task: this is a miniature of Netnut's own product. That changed how I sized decisions — the proxy story stops being a nice-to-have and becomes the most representative part of the system. So I designed for proxies first (env-configured pool, per-attempt rotation, credential hygiene) and the rest of the pipeline second.

## Architecture (one paragraph)

Three Nest.js services in a single monorepo. `API` is the public edge (`POST /scrape`, `GET /scrape/:id`). It calls `Job Manager` over REST, which validates input, writes the job row to Postgres, and enqueues onto BullMQ (`scrape-jobs`). `Scraper` is a BullMQ worker — it consumes a job, fetches the URL through a rotating proxy pool, caches the HTML in Redis under a TTL (Postgres keeps only durable metadata), flips the job status in Postgres, and publishes `job:<id>:done` on Redis Pub/Sub. The API offers two modes: async by default (`202 { jobId }` + polling on `GET /scrape/:id`), and synchronous when called with `?wait=true` (the API `SUBSCRIBE`s to the Pub/Sub channel and returns the HTML inline, with a configurable timeout). See `architecture.drawio` for the numbered flow.

## Stack & why

**Nest.js 11 monorepo** — The brief specifically calls for Nest. I used Nest's built-in monorepo mode (`apps/` + `libs/`) instead of Nx because it gave me everything I needed (independent apps, shared lib via path alias `@app/shared`) without an extra tool to explain. The CLI doesn't offer a `--directory` flag for `nest new`, so I scaffolded by hand. The user/linter upgraded the pinned Nest version to 11.x mid-project, which I kept.

**TypeORM + PostgreSQL** — Relational fit job state perfectly: jobs move through a strict status machine (`pending → in_progress → completed/failed`), and even at this scope I want ACID transactions and indexed status lookups. `synchronize: true` is on in non-prod for ergonomics; production must use proper migrations and that is called out in the docs.

**BullMQ on Redis** — Most Nest-idiomatic queue. It gave me retries with exponential backoff, completion/failure retention, and stalled-job recovery for free. The alternative I considered was RabbitMQ via `@nestjs/microservices` — better delivery semantics on paper, but I'd have to write the retry / backoff / DLQ plumbing myself. For a take-home, that's wasted effort that the reviewer has to read.

**Redis Pub/Sub for `?wait=true`** — When the API needs to block until completion, it `psubscribe`s to `job:*:done` (one pattern subscription handles all jobs, single connection). The race-safe pattern is in `scrape.service.ts`: register the waiter BEFORE reading the job from the DB. Because the worker writes the DB row before publishing, this guarantees we never miss a job that completes between the DB check and the subscribe — the case I'd worry about in code review.

**REST between API ↔ Job Manager** — I considered gRPC and Nest's TCP microservice transport. Both add schema/serialization work that doesn't improve the demo. Plain HTTP + axios is what a reviewer will read fastest.

**`https-proxy-agent` + `http-proxy-agent`** for the fetcher. I set both agents and disable axios's built-in proxy handling (`proxy: false`), which has known quirks. This tunnels correctly regardless of target scheme.

**class-validator + class-transformer** with a global `ValidationPipe({ whitelist: true, transform: true })` so DTO validation is declarative and unknown fields are stripped.

**Docker Compose** for one-command local bring-up. **Kubernetes** manifests for the deploy bonus.

## Decisions worth surfacing

**Worker writes to Postgres directly.** I put the `JobsService` data-access layer in `libs/shared/src/database/` and import it from both Job Manager and Scraper. Each side gets clean DI, the entity is the single source of truth, and the worker doesn't need an HTTP round trip through Job Manager to update job state. The trade-off is that the Scraper now knows the `JobEntity` schema; in a stricter "events between services" architecture, the worker would emit a `JobCompleted` event and the Job Manager would own writes. For a 3-service take-home, direct writes are honest about the scope.

**Race-safe wait for `?wait=true`.** In `apps/api/src/scrape/scrape.service.ts`:
1. Register a waiter for `jobId` (synchronously inserts into a `Map`).
2. Read the job from Job Manager.
3. If it's already terminal (`completed` / `failed`), return. The waiter cleans itself up via timeout.
4. Otherwise `await` the waiter, then re-read.

The ordering matters. If I checked the DB first and then subscribed, a job that completed in those microseconds would notify nothing — the wait would only resolve on the 30 s timeout. Step 1 + 2 are sequenced deliberately.

**Proxy rotation per attempt.** `ProxyPoolService.next()` is round-robin and is called fresh on every attempt inside `ScrapeProcessor.process`. Combined with BullMQ's retry-on-throw, this means a job that fails on proxy A retries on proxy B then proxy C. Each successful (or final-failed) attempt records the **sanitized** proxy URL (host only, no credentials) in `jobs.proxy_used`.

**Credentials never touch logs or the database.** `ProxyPoolService.describe(url)` parses the proxy URL and returns `protocol://host`. That's what we log and what we store. The full URL (including any `user:pass@`) only exists in process memory.

**Failure boundary is the final retry, not every attempt.** The processor calls `markFailed` only when `attemptsMade + 1 >= opts.attempts`. Intermediate retries leave status as `in_progress`, which is what an external observer should see — BullMQ is going to try again.

**`safePublish` swallows publish errors.** A Redis blip after a successful fetch must not roll back a completed job's status. The DB write is authoritative; Pub/Sub is best-effort notification.

**HTML lives in Redis with a TTL, not Postgres.** Scraped bodies are transient and can be large, so they're cached under `job:<id>:html` (`RESULT_TTL_SECONDS`) and Postgres holds only durable metadata (`html` column removed). The worker writes the cache *before* flipping status / publishing, so any reader that observes `completed` is guaranteed the body is already present. The API reads the body straight from Redis, bypassing the Job Manager hop for the heavy payload. Once the TTL lapses: `?wait=true` on an evicted result returns `410 Gone`; `GET /scrape/:id` returns metadata with `html` omitted.

**Worker concurrency.** Scraping is network-bound (each fetch blocks on a ~20 s timeout), so the processor runs `SCRAPER_CONCURRENCY` jobs at once (default 10) instead of BullMQ's default of 1 — otherwise a single in-flight fetch per pod wastes the worker.

**SSRF guard + response size cap.** Target URLs are restricted to `http`/`https` and rejected if they resolve to a private/internal/loopback/link-local address (cloud-metadata `169.254.169.254` included, IPv4 and IPv6). Two layers: a pre-flight DNS check for a clean error, and a connect-time `lookup` guard on the direct-path agents so each redirect hop and DNS rebinding are validated against the actually-resolved IP. On the proxy path the proxy resolves the target, so egress control is the proxy's job. Responses are capped at `FETCH_MAX_BYTES` (`maxContentLength`/`maxBodyLength`) since the body is buffered fully into memory and Redis. A blocked URL is a deterministic failure, so the worker fails it immediately via BullMQ `UnrecoverableError` rather than burning all three retries.

**TCP probes in K8s, not HTTP.** Our apps don't expose a `/health` endpoint and I deliberately didn't add one to keep the manifests code-change-free for this task. A production setup would add `/health` (Nest's `@nestjs/terminus`) and switch to HTTP probes — flagged in `k8s/README.md`.

**Scraper HPA on CPU, with a comment.** Queue depth is the prod-correct signal (BullMQ exposes it). That needs `prometheus-adapter` and a custom Pods-type metric — too much yak-shaving for the bonus. CPU is a defensible proxy because the worker is I/O-bound and CPU rises with concurrent fetches. The YAML carries the comment so a reviewer knows I know.

## Build order

1. **Scaffold** — package.json, tsconfig, nest-cli.json (monorepo), three app stubs, shared lib. `git init`.
2. **Postgres + TypeORM** — `JobEntity`, `DatabaseModule`, `JobsService` in the shared lib. `synchronize: true` for dev. `attempts` increments atomically via QueryBuilder so concurrent workers can't lose a count.
3. **BullMQ + Redis** — `ScrapeQueueModule` in shared (root config + queue registration with sensible defaults: 3 attempts, exponential backoff, 1-day completed retention, 7-day failure retention). `JobsQueueService.enqueue` in Job Manager.
4. **HTTP layer** — `JobsController` (`POST /jobs`, `GET /jobs/:id`) in Job Manager. `ScrapeController` + `ScrapeService` + `JobManagerClient` (plain axios) + `JobEventsService` (ioredis psubscribe) in API. `?wait=true` Pub/Sub plumbing.
5. **Scraper processor** — `FetcherService` (axios with `transformResponse` disabled so HTML stays raw), `ScrapeProcessor` extending `WorkerHost`, `JobEventsPublisher`. The refactor that moved `JobsService` to the shared lib happened here, when the second consumer made the duplication obvious.
6. **Proxy pool** — `ProxyPoolService` reads `PROXY_POOL` env, round-robin, credential-stripping. Fetcher accepts an optional proxy URL and wires both agents.
7. **Docker** — multi-stage Dockerfile with an `APP` build arg (one image per app, identical Dockerfile). `docker-compose.yml` with YAML anchors for shared infra env and healthchecks gating app startup.
8. **K8s** — namespace, Postgres/Redis StatefulSets with PVCs, shared ConfigMap, three Deployments with rolling-update strategy, Scraper HPA, optional Ingress, prod-TODO list in `k8s/README.md`.
9. **Hardening + tests** — graceful shutdown (`enableShutdownHooks`), concurrent-waiter fix in `JobEventsService`, and the first unit suites (proxy pool, job events, scrape service).
10. **Redis HTML cache** — moved scraped bodies out of Postgres into a TTL'd Redis key; API reads them directly; `410`/omitted-`html` on expiry.
11. **Fetch-path hardening** — worker concurrency, SSRF guard (private-IP rejection + connect-time DNS check), response size cap, non-retryable blocked URLs, `http`/`https`-only DTO.

## What I deliberately did not do

- **No `/health` endpoint** — TCP probes work for the manifests; adding terminus would be code change for marginal benefit at this scope.
- **No real DB migrations** — `synchronize: true` is the dev ergonomic. A `migrations/` directory and CI job is the prod move.
- **No NetworkPolicies, PDBs, or external secret stores in K8s** — listed as production TODOs in `k8s/README.md` so a reviewer knows I considered them.
- **No Bull Board** — I'd mount it on the Job Manager at `/admin/queues` behind auth for production. Easy add, but not in the brief.
- **No retries/timeouts hardening in `JobManagerClient`** — it has a 5 s axios timeout and forwards JM's HTTP errors verbatim. Production would add explicit retries with backoff and a circuit breaker.
- **No load test or performance numbers** — out of scope.
- **No `/health` endpoint** — still the one deferred review item; TCP probes cover the manifests. `@nestjs/terminus` + HTTP probes is the prod move.

There *are* unit tests (added in the hardening pass): proxy pool, job-events waiter logic, scrape-service branches, result store, and the SSRF/URL-safety matrix. No live Postgres/Redis required. Run with `npm test`.

## Tools summary

| Layer | Choice |
|---|---|
| Framework | Nest.js 11 (monorepo mode) |
| Language | TypeScript 5.5 |
| Persistence | PostgreSQL 16 + TypeORM |
| Queue | BullMQ on Redis 7 (`@nestjs/bullmq`) |
| Pub/Sub | ioredis (separate connections for subscribe vs publish) |
| HTTP between services | plain axios |
| Validation | class-validator + class-transformer |
| Proxy tunneling | https-proxy-agent + http-proxy-agent |
| Local infra | Docker Compose (Postgres, Redis, 3 apps) |
| Deploy | Kubernetes manifests (kustomize-friendly numbered files) |
| Diagram | draw.io |

## Verification — what broke when I ran it

Three issues surfaced when I brought the compose stack up end-to-end. Worth being honest about them because they're the kind of thing that *only* shows up at integration time.

1. **Half-finished version bump.** `@nestjs/common` was still pinned to `^10.4.0` while everything else around it was on `^11.x`. Local `npm install` had been permissive about it, but the Docker build's `npm ci` (strict peer-dep mode) failed immediately. Fixed by bumping `@nestjs/common` to `^11.1.24` and regenerating the lockfile. Takeaway: `npm ci` is the canary for things `npm install` will let slide.

2. **Nest monorepo build outputs nested paths.** With `../../libs/**/*` in each `tsconfig.app.json`'s `include`, tsc treats the monorepo root as the implicit rootDir and lays files out as `dist/apps/<app>/apps/<app>/src/main.js`, not `dist/apps/<app>/main.js`. The compiled lib code lives at `dist/apps/<app>/libs/shared/src/...` and `require()` paths inside the build resolve correctly because everything is co-located. So the build is fine — my CMD and `start:prod:*` scripts were just pointing at the wrong path. Fixed by updating them to the actual entry point.

3. **`NODE_ENV=production` + no migrations = no `jobs` table.** The compose env was setting `NODE_ENV=production`, which my code used as the gate for TypeORM `synchronize`. With sync off and no migrations wired up, the first `POST /scrape` failed with Postgres error `42P01: undefined_table`. I fixed this properly by introducing a `DB_SYNCHRONIZE` env var that's decoupled from `NODE_ENV` — defaults to `NODE_ENV !== 'production'` if unset, but can be explicitly set either way. Compose and the k8s ConfigMap now set `DB_SYNCHRONIZE=true` with an inline comment noting that production should set it to `false` and run real migrations. This keeps the demo running in a production-like `NODE_ENV` while not pretending the migration story is solved.

## What I'd do next

Given another half-day:

1. **Bull Board** at `/admin/queues` of Job Manager. Big visual payoff for the demo.
2. **`/health` endpoints + HTTP K8s probes** via `@nestjs/terminus`.
3. **Migrations** — replace `synchronize` with a baseline migration + a CI gate. (Then `DB_SYNCHRONIZE=true` becomes purely a dev convenience and prod can flip it off.)
4. **Queue-depth HPA** via `prometheus-adapter`, BullMQ-prometheus exporter.
5. **A simple integration test** that exercises the async + sync paths end-to-end against the compose stack. (Even just one would be load-bearing as a regression net.)
