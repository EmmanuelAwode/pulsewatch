# Deploying PulseWatch

> **Status:** PulseWatch has not been deployed to a public host. Everything
> below has been run locally with Docker Compose (images built, stack started,
> load-tested). The public-deployment steps are written down but **unverified**.

## What runs

| Container  | Image target         | Role                                                        | Published?          |
| ---------- | -------------------- | ----------------------------------------------------------- | ------------------- |
| `web`      | `web`                | nginx: serves the dashboard and proxies `/api/` to the API  | Yes (only this one) |
| `api`      | `api`                | Fastify REST API and live-event stream                      | No                  |
| `worker`   | `worker`             | Scheduler, HTTPS checks, incidents, alert emails, retention | No                  |
| `migrate`  | `migrate`            | Applies database migrations, then exits                     | No                  |
| `postgres` | `postgres:16-alpine` | All durable state                                           | No                  |
| `redis`    | `redis:7-alpine`     | Job queue, live events, rate-limit counters                 | No                  |

All three application images run as a non-root user.

## Run the whole stack locally

```bash
export JWT_ACCESS_SECRET="$(openssl rand -base64 48)"
docker compose --profile app up -d --build --wait
```

Then open <http://localhost:8080>. `docker compose --profile app down` stops it;
data stays in the named volumes.

Start-up order is enforced by health checks: `migrate` waits for a healthy
Postgres and must exit successfully before `api` and `worker` start; `web`
waits for a healthy `api`.

## Required before a public deployment

These are **security requirements**, not suggestions.

### 1. TLS in front of everything

Put a TLS-terminating proxy or load balancer in front of the `web` container
and redirect HTTP to HTTPS. In production the session cookies are marked
`Secure`, so the dashboard does not work over plain HTTP on any host other
than `localhost`. Add `Strict-Transport-Security` at the TLS proxy.

### 2. Network egress controls for the worker (SSRF)

The worker makes HTTPS requests to URLs chosen by users. The application
refuses private, loopback, link-local, metadata and other reserved addresses
at connection time (ADR-009, ADR-021). That is one layer. **Add a second one at
the network level:**

- Give the worker its own network (or security group) whose **egress** allows
  only TCP 443 to the public internet, plus Postgres, Redis and SMTP.
- Explicitly deny `169.254.169.254` and the cloud provider's metadata
  endpoints, and every private range used by your infrastructure.
- On AWS, require IMDSv2 so that even a successful request to the metadata
  address cannot read credentials.

The worker needs **no inbound access** at all, other than metrics scraping
from inside the network.

### 3. Secrets

| Secret              | Used by | Notes                                                                            |
| ------------------- | ------- | -------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET` | api     | At least 32 random characters. Anyone holding it can forge a login for any user. |
| `POSTGRES_PASSWORD` | all     | The Compose default is for local development only.                               |
| `SMTP_URL`          | worker  | Contains SMTP credentials.                                                       |

- Inject them from the platform's secret store (AWS Secrets Manager, GCP
  Secret Manager, Docker or Kubernetes secrets), never from a committed file.
- Use a different `JWT_ACCESS_SECRET` per environment. Rotating it logs every
  user out (their access tokens stop verifying) but loses no data.
- The processes refuse to start if a required secret is missing or too short,
  and never print secret values in their error messages.

### 4. Only the web container is public

- Do **not** publish the API, worker, Postgres or Redis ports.
- nginx does not route `/docs`, `/metrics`, `/healthz` or `/readyz`, so those
  stay internal. Interactive API docs are also disabled when
  `NODE_ENV=production`.
- Set `TRUST_PROXY=true` on the API **only** when every request reaches it
  through a proxy that overwrites `X-Forwarded-For` (the provided nginx config
  does). Otherwise clients can forge their IP and dodge rate limits.

### 5. Configuration to set

| Variable                                              | Set to                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `APP_ORIGIN`                                          | The exact public origin, e.g. `https://pulsewatch.example.com` |
| `NODE_ENV`                                            | `production` (already set in the images)                       |
| `RATE_LIMIT_PER_MINUTE`, `AUTH_RATE_LIMIT_PER_MINUTE` | Defaults 300 and 10 per IP                                     |
| `SMTP_URL`, `MAIL_FROM`                               | To actually send alert emails                                  |
| `RETENTION_DAYS`                                      | Default 30; at least 30                                        |

### 6. Data

- Use a managed PostgreSQL with automated backups and point-in-time recovery,
  and test a restore. Postgres is the only state that matters: Redis can be
  lost and rebuilt (schedules live in Postgres; queued checks are re-created
  by the scheduler).
- Run Redis with persistence (AOF, as in Compose) and `maxmemory-policy
noeviction`. Any eviction policy can silently drop queued jobs.

## Deploying a new version

1. CI must be green on `main`: typecheck, lint, formatting, unit and
   integration tests, production build, migration drift check, image builds.
2. Build and push the four images, tagged with the commit SHA.
3. Run the `migrate` image against the production database and wait for it to
   exit successfully. Migrations must be backwards-compatible with the version
   still running (add columns and tables; remove things in a later release).
4. Roll out `api` and `worker`. Both stop gracefully on `SIGTERM`: the API
   finishes in-flight requests, and the worker finishes in-flight checks (up
   to 30 s; its Compose stop grace period is 40 s). Unstarted jobs stay in
   Redis for the new workers.
5. Roll out `web`. `index.html` is served `no-cache` and assets are
   fingerprinted, so browsers pick up the new dashboard on the next load.

Rolling back is the same with the previous SHA, as long as the migration was
backwards-compatible.

## Operations

| Question                          | Where to look                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| Is the API up?                    | `GET /healthz` (process) and `GET /readyz` (Postgres and Redis) on the API, internally             |
| Is the worker keeping up?         | `pulsewatch_check_lag_seconds` and `pulsewatch_queue_jobs` on the worker's `:9100/metrics`         |
| Are checks failing because of us? | `pulsewatch_checks_total{error_type=...}` and worker logs "check job failed permanently"           |
| Are alerts going out?             | `pulsewatch_notifications_total{outcome=...}`; `notification_deliveries` rows with status `FAILED` |
| One user's error report           | The `requestId` in the error response matches the `reqId` on the API's JSON log lines              |
| API latency                       | `pulsewatch_http_request_duration_seconds` by route pattern                                        |

Suggested alerts: readiness failing for more than a minute; check lag p95
above 30 s; failed jobs increasing; any `FAILED` notification deliveries.

## Scaling out

- **API:** stateless. Run several copies behind the load balancer; rate
  limits and live events already work across instances through Redis.
- **Worker:** run several copies. The scheduler uses `FOR UPDATE SKIP LOCKED`
  and jobs are idempotent, so extra copies share the work safely.
- **Database:** see ARCHITECTURE.md, section 7, for when to partition
  `check_results` and add a read replica.
