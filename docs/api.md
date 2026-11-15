# API specification (design)

> Status: **Phase 1 design.** Once the API exists (Phase 2) the OpenAPI
> document generated from the route schemas, served at `/docs`, becomes the
> authoritative reference and this file becomes an overview.

Base path: `/api/v1`. JSON in, JSON out. All timestamps are ISO 8601 UTC.

## Conventions

**Success** always wraps the payload in `data`; lists add `meta`:

```json
{ "data": { "id": "...", "name": "Checkout API" } }
{ "data": [ ... ], "meta": { "nextCursor": "MjAyNi0wMS0wMVQ...", "hasMore": true } }
```

**Errors** always have the same shape, whatever went wrong:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request body is invalid.",
    "details": [{ "path": "intervalSeconds", "message": "Must be at least 60" }],
    "requestId": "req_8f3a..."
  }
}
```

`code` is a stable machine-readable string the frontend switches on; `message`
is for humans; `requestId` ties a user's bug report to a log line.

| Status | Meaning here                                                         |
| ------ | -------------------------------------------------------------------- |
| 200    | Read or update succeeded.                                            |
| 201    | Resource created (`Location` header set).                            |
| 204    | Succeeded, nothing to return (delete, logout).                       |
| 400    | Malformed request (unparseable JSON).                                |
| 401    | Not authenticated, or the access token expired.                      |
| 404    | Not found, **or it belongs to another user**.                        |
| 409    | Conflict (email already registered).                                 |
| 422    | Well-formed but fails validation.                                    |
| 429    | Rate limit exceeded (`Retry-After` header set).                      |
| 500    | Unexpected. Body contains only a generic message and the request ID. |

Why `404` and not `403` for another user's monitor: `403` confirms the ID
exists, which leaks information. Treating "not yours" as "not found" also
means the ownership check and the lookup are one query (`WHERE id = $1 AND
user_id = $2`), so it cannot be forgotten.

**Pagination** is keyset (cursor) based, not `OFFSET`. `OFFSET 100000` makes
Postgres read and discard 100,000 rows; a cursor (`WHERE scheduled_for <
$cursor ORDER BY scheduled_for DESC LIMIT n`) jumps straight to the right
place in the index, so page 1,000 costs the same as page 1. It is also stable
when new rows arrive while the user is paging. `limit` defaults to 50, max 200.

## Endpoints

### Auth

| Method | Path             | Auth           | Purpose                                                            |
| ------ | ---------------- | -------------- | ------------------------------------------------------------------ |
| POST   | `/auth/register` | no             | Create account; sets session cookies. `201`, `409` if email taken. |
| POST   | `/auth/login`    | no             | Verify credentials; sets session cookies.                          |
| POST   | `/auth/refresh`  | refresh cookie | Rotate the refresh token, issue a new access token.                |
| POST   | `/auth/logout`   | yes            | Revoke the refresh-token family, clear cookies. `204`.             |
| GET    | `/auth/me`       | yes            | Current user (`id`, `email`, `createdAt`). Never the hash.         |

Login returns the same `401 INVALID_CREDENTIALS` for an unknown email and a
wrong password, and hashes a dummy password when the email is unknown, so
neither the response nor its timing reveals which accounts exist.

### Monitors

| Method | Path            | Purpose                                                                                                              |
| ------ | --------------- | -------------------------------------------------------------------------------------------------------------------- |
| POST   | `/monitors`     | Create. Body: `name`, `url`, `method?`, `intervalSeconds?`, `timeoutMs?`, `failureThreshold?`, `recoveryThreshold?`. |
| GET    | `/monitors`     | List the caller's monitors with current status.                                                                      |
| GET    | `/monitors/:id` | One monitor.                                                                                                         |
| PATCH  | `/monitors/:id` | Partial update, including `paused`.                                                                                  |
| DELETE | `/monitors/:id` | Delete the monitor and its history. `204`.                                                                           |

`PATCH`, not `PUT`: clients send only the fields they change. Pausing is a
field update rather than a `/pause` action endpoint, which keeps the API
resource-oriented.

### History and analytics

| Method | Path                            | Purpose                                                                                                                           |
| ------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/monitors/:id/checks`          | Paginated results. Query: `cursor`, `limit`, `from`, `to`, `success`.                                                             |
| GET    | `/monitors/:id/checks/:checkId` | One check event in full (error type and message).                                                                                 |
| GET    | `/monitors/:id/analytics`       | Query: `range=24h\|7d\|30d`. Totals, uptime %, avg / median / p95, `expectedChecks`, and a bucketed latency series for the chart. |
| GET    | `/monitors/:id/incidents`       | Paginated incidents for one monitor.                                                                                              |
| GET    | `/incidents`                    | Paginated incidents across all the caller's monitors. Query: `status=open\|resolved`.                                             |
| GET    | `/dashboard/summary`            | Counts by status, open incidents, overall 24 h uptime.                                                                            |

`range` is a fixed enum rather than arbitrary dates. That bounds the cost of
the most expensive query in the system and makes its result cacheable under a
small set of keys.

### Settings

| Method | Path                      | Purpose                                  |
| ------ | ------------------------- | ---------------------------------------- |
| GET    | `/settings/notifications` | Read notification preferences.           |
| PUT    | `/settings/notifications` | Replace them (a singleton, hence `PUT`). |

### Live events

| Method | Path      | Purpose                                     |
| ------ | --------- | ------------------------------------------- |
| GET    | `/events` | `text/event-stream` of the caller's events. |

Event types: `check.completed`, `monitor.status_changed`, `incident.opened`,
`incident.resolved`. The server sends a comment line as a heartbeat every 25 s
so proxies do not close an idle connection. Events are a _hint to refetch_,
not the source of truth: if one is missed, the next page load is still
correct.

### Operational (not under `/api/v1`, not exposed publicly)

| Method | Path       | Purpose                                                          |
| ------ | ---------- | ---------------------------------------------------------------- |
| GET    | `/healthz` | Liveness: the process is running. No dependencies checked.       |
| GET    | `/readyz`  | Readiness: Postgres and Redis reachable. Used by load balancers. |
| GET    | `/metrics` | Prometheus metrics.                                              |
| GET    | `/docs`    | Swagger UI for the generated OpenAPI document.                   |

Liveness and readiness are separate on purpose. If liveness checked the
database, a brief database outage would make the orchestrator restart every
API container, turning a partial outage into a total one.

## Rate limits (initial values, to be tuned with k6 in Phase 6)

| Scope                             | Limit        | Keyed by   |
| --------------------------------- | ------------ | ---------- |
| `/auth/login`, `/auth/register`   | 10 / minute  | IP address |
| All other authenticated endpoints | 120 / minute | User ID    |
| Monitors per account              | 50           | User ID    |

Counters live in Redis so the limit holds across several API instances.
