# Kubernetes manifests

Per the brief, "files are sufficient" — these manifests are not deployed anywhere by default. They are organized to apply in order via `kubectl apply -f k8s/`.

## Layout

```
k8s/
├── 00-namespace.yaml      netnut namespace
├── 01-postgres.yaml       StatefulSet + headless Service + Secret (5 GiB PVC)
├── 02-redis.yaml          StatefulSet + headless Service (1 GiB PVC, AOF persistence)
├── 03-config.yaml         ConfigMap (shared non-sensitive env)
├── 10-job-manager.yaml    Deployment (2 replicas) + ClusterIP Service
├── 11-scraper.yaml        Deployment (2 replicas) + HPA (2–10 on CPU)
├── 12-api.yaml            Deployment (2 replicas) + ClusterIP Service
└── 13-ingress.yaml        Optional Ingress to expose the API externally
```

## Build images

```bash
docker build -t netnut-api:latest         --build-arg APP=api         .
docker build -t netnut-job-manager:latest --build-arg APP=job-manager .
docker build -t netnut-scraper:latest     --build-arg APP=scraper     .
```

For local clusters, load the images into the cluster's daemon (since they aren't in a registry):

```bash
# kind
kind load docker-image netnut-api:latest netnut-job-manager:latest netnut-scraper:latest

# minikube
minikube image load netnut-api:latest netnut-job-manager:latest netnut-scraper:latest
```

For real clusters, push to your registry and update the `image:` references in the deployments.

## Apply

```bash
kubectl apply -f k8s/
kubectl -n netnut get pods
```

Postgres and Redis come up first (StatefulSets), then apps roll out once dependencies are `Ready`.

## Reach the API

Without an Ingress controller:

```bash
kubectl -n netnut port-forward svc/api 3000:3000
curl -X POST http://localhost:3000/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

With an Ingress controller in the cluster, `13-ingress.yaml` exposes the API at `/` on the controller's external IP.

## Scaling

- **Scraper HPA** scales `2 → 10` based on **CPU @ 70%**. The honest signal is **BullMQ queue depth**, which requires `prometheus-adapter` + a custom Pods-type metric — a production TODO. CPU is a reasonable proxy because the Scraper is mostly I/O-bound and CPU rises with concurrent fetches.
- Each scraper pod processes `SCRAPER_CONCURRENCY` jobs in parallel (default 10), so total in-flight fetches ≈ replicas × concurrency. Tune both together: raise concurrency for throughput per pod, raise replicas (HPA) for fault tolerance and CPU headroom.
- API and Job Manager are fixed at 2 replicas. They're light; horizontal scaling beyond that needs evidence.

## What this skips (production TODOs)

- **Real DB** — use a managed Postgres (RDS, Cloud SQL); the in-cluster StatefulSet is for demo.
- **TypeORM migrations** — current setup uses `synchronize` in non-prod. Production needs proper migrations and a job/init container to run them.
- **TLS** — cert-manager + a real Ingress host.
- **NetworkPolicies** — restrict pod-to-pod traffic (only API → Job Manager, only apps → Postgres/Redis). The scraper's app-level SSRF guard (private-IP rejection) reduces but does not replace an **egress** NetworkPolicy — defense in depth against a guard bypass or a misconfigured `ALLOW_PRIVATE_TARGETS`.
- **PodDisruptionBudgets** — keep min replicas during voluntary disruptions.
- **Secrets management** — these manifests use a plain `Secret`. Real deployments should use external secret stores (Sealed Secrets, External Secrets Operator, Vault).
- **Observability** — no Prometheus scrape annotations / no log shipping. Add when wiring queue-depth HPA.
- **Bull Board** — would be exposed on `/admin/queues` of Job Manager behind an internal-only Service / Ingress with auth.
