# Milestones

> All six phases are built. The one item not done is deploying to a public
> host; docs/deployment.md lists what that requires.

Each milestone is small enough to build, test and explain in one sitting, and
each ends with something that can be demonstrated. A milestone is only marked
done when its checks have actually been run.

Every milestone finishes the same way: tests written and run, results
reported as observed, `ENGINEERING_DECISIONS.md` updated if a decision was
made or changed, and a pause for review.

## Phase 1: Architecture (done)

| #   | Milestone                                            | Evidence                                    |
| --- | ---------------------------------------------------- | ------------------------------------------- |
| 1.1 | Requirements, architecture diagram, scaling analysis | `ARCHITECTURE.md`                           |
| 1.2 | Schema design, verified on PostgreSQL 16             | `docs/schema.sql`, `docs/database.md`       |
| 1.3 | API specification                                    | `docs/api.md`                               |
| 1.4 | Decision log started                                 | `ENGINEERING_DECISIONS.md` (ADR-001 to 012) |

## Phase 2: Backend foundation (done)

Progress: **all five milestones done** (2026-11-15).

| #   | Milestone                                                                                     | Done when                                                                            |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 2.1 | Monorepo scaffold: pnpm workspace, strict TypeScript, ESLint, Prettier, Vitest                | `pnpm typecheck`, `pnpm lint`, `pnpm test` run clean on an empty project.            |
| 2.2 | `packages/database`: Prisma schema + migration matching `schema.sql`                          | Integration tests prove each constraint against a real Postgres; drift check passes. |
| 2.3 | API skeleton: config validation, structured logging, error handler, health endpoints, OpenAPI | Fastify `inject` tests for error shapes and `/readyz`.                               |
| 2.4 | Authentication: register, login, refresh rotation, logout, `me`                               | Tests include token re-use revoking the family, and no user enumeration.             |
| 2.5 | Monitor CRUD with ownership checks                                                            | Tests prove user A gets `404` on user B's monitor for every verb.                    |

## Phase 3: Monitoring engine (done)

Progress: **all four milestones done** (2026-11-15).

| #   | Milestone                                                      | Done when                                                                |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 3.1 | HTTP prober: monotonic timing, timeout, size cap, no redirects | Tests against a local HTTPS test server for 200, 500, slow, oversized.   |
| 3.2 | SSRF guard: resolved-IP validation and connection pinning      | Unit tests for every blocked range, IPv6 forms and a rebinding resolver. |
| 3.3 | Scheduler tick with `SKIP LOCKED` and deterministic job IDs    | Two concurrent schedulers claim disjoint sets; crash-before-commit test. |
| 3.4 | Check processor: idempotent result write                       | Running the same job twice yields one row and one counter increment.     |

## Phase 4: Reliability (done)

| #   | Milestone                                      | Done when                                                           |
| --- | ---------------------------------------------- | ------------------------------------------------------------------- |
| 4.1 | Incident state machine in one transaction      | Concurrent-processing test never produces two open incidents.       |
| 4.2 | Notification outbox and sender                 | Retry test sends one email per event.                               |
| 4.3 | Rate limiting, monitor caps, graceful shutdown | Tests for `429`; a worker stopped mid-job loses no result.          |
| 4.4 | Prometheus metrics, SSE event stream           | Metrics endpoint scraped in a test; SSE receives a published event. |
| 4.5 | Analytics queries and retention job            | Results match hand-computed fixtures, including percentiles.        |

## Phase 5: Frontend (done)

| #   | Milestone                                                   |
| --- | ----------------------------------------------------------- |
| 5.1 | App shell, auth pages, API client with silent refresh       |
| 5.2 | Monitors list, create / edit forms                          |
| 5.3 | Monitor detail: latency chart, check history, incidents     |
| 5.4 | Dashboard overview, incident history, settings              |
| 5.5 | Live updates, loading / empty / error states, mobile layout |

## Phase 6: Testing and deployment (done, except a public deployment)

| #   | Milestone                                                         |
| --- | ----------------------------------------------------------------- |
| 6.1 | Dockerfiles and full Compose stack                                |
| 6.2 | GitHub Actions: typecheck, lint, unit, integration, build         |
| 6.3 | k6 load tests; results recorded with the hardware and method used |
| 6.4 | Deployment guide, network-level SSRF controls, operations runbook |
| 6.5 | README with screenshots and measured results                      |
