# Engineering Decisions

A running log of the decisions that shaped PulseWatch. Each entry records the
problem, the options considered, the choice, and what would change at larger
scale. Entries are never deleted: if a decision is reversed, a new entry
supersedes the old one and says why.

"Primer" refers to the
[System Design Primer](https://github.com/donnemartin/system-design-primer).

| #   | Decision                                                    | Status   | Decided by         |
| --- | ----------------------------------------------------------- | -------- | ------------------ |
| 001 | Modular monolith with a separate worker process             | Accepted | Brief              |
| 002 | Postgres-driven scheduler                                   | Accepted | Owner              |
| 003 | Slot-based idempotency; check failures are not job failures | Accepted | Derived from 002   |
| 004 | Access JWT + rotating refresh token in httpOnly cookies     | Accepted | Owner              |
| 005 | Single indexed `check_results` table + retention job        | Accepted | Owner              |
| 006 | Server-Sent Events fed by Redis pub/sub                     | Accepted | Owner              |
| 007 | Row lock + partial unique index for incident transitions    | Accepted | Proposed by Claude |
| 008 | Transactional outbox for notifications                      | Accepted | Proposed by Claude |
| 009 | SSRF defence at connection time, not URL-parse time         | Accepted | Brief              |
| 010 | No application cache until measurements justify one         | Accepted | Proposed by Claude |
| 011 | Uptime counts recorded checks only                          | Accepted | Proposed by Claude |
| 012 | Toolchain versions                                          | Accepted | Proposed by Claude |
| 013 | Pin every database session to UTC                           | Accepted | Forced by a bug    |
| 014 | Hand-written SQL in migrations, guarded by a drift check    | Accepted | Proposed by Claude |
| 015 | Integration tests use a real PostgreSQL, never a mock       | Accepted | Brief              |
| 016 | One Zod schema drives validation, serialisation and OpenAPI | Accepted | Proposed by Claude |
| 017 | Central error handler; unknown errors are hidden by default | Accepted | Brief              |
| 018 | Separate liveness and readiness probes                      | Accepted | Proposed by Claude |
| 019 | Auth implementation: libraries, same-origin, known gaps     | Accepted | Proposed by Claude |
| 020 | Ownership in every query; auth before validation            | Accepted | Brief              |
| 021 | Prober: pin the checked IP, time to headers, no body        | Accepted | Proposed by Claude |
| 022 | Scheduler and processor: implementation and verification    | Accepted | Proposed by Claude |
| 023 | Incidents and alerts: implementation                        | Accepted | Proposed by Claude |
| 024 | Rate limiting, metrics and live events                      | Accepted | Proposed by Claude |

"Proposed by Claude" entries were chosen without asking because they follow
from earlier decisions or are low-risk to reverse. Any of them can be reopened.

---

## ADR-001: Modular monolith with a separate worker process

**Problem.** Serving HTTP requests and running thousands of outbound checks
are different workloads. How many deployable units should there be?

**Options.**

1. _Single process_: API and checks in one Node process. Simplest, but a burst
   of slow checks competes with API requests on the same event loop, and the
   two cannot be scaled separately.
2. _Monolith + worker_ (chosen): one codebase and one database, two processes.
3. _Microservices_ (auth, monitors, checker, notifier): independent deploys,
   but every cross-service call becomes a network hop that can fail, and "save
   result and open incident atomically" becomes a distributed transaction.

**Decision.** Option 2. The API scales with request rate; the worker scales
with the number of monitors. Those are the only two axes that differ, so they
are the only split.

**At larger scale.** Extract a service when a _measured_ need appears, for
example probe workers in several regions. The service/route layering keeps
that extraction mechanical.

**Primer.** Application layer; Microservices (and their disadvantages).

**Interview question.** _"Why didn't you use microservices?"_ Because nothing
measurable would improve, and transactional incident handling would get
harder. The split that exists follows the two workloads that scale
differently.

---

## ADR-002: Postgres-driven scheduler

**Problem.** Something must decide, every second, which monitors are due and
turn that into queue jobs, without duplicates and without losing schedules
when a process or Redis restarts.

**Options.**

1. _BullMQ Job Schedulers_: one repeating schedule per monitor, stored in
   Redis. Least code. But the schedule then exists in two places. Every
   monitor create, update and delete must write to Postgres **and** Redis,
   which cannot be made atomic (the dual-write problem), so they can drift;
   and losing Redis loses every schedule unless a reconciler rebuilds them.
2. _Postgres-driven_ (chosen): `monitors.next_check_at` is the schedule. A
   tick claims due rows and enqueues jobs.
3. _In-memory timers_ (`setInterval` per monitor): lost on restart, cannot run
   on two workers without double-checking.

**Decision.** Option 2. Each tick, in one transaction:

```sql
SELECT id, next_check_at, interval_seconds FROM monitors
WHERE paused = false AND next_check_at <= now()
ORDER BY next_check_at LIMIT 500
FOR UPDATE SKIP LOCKED;
-- enqueue each job with id check:{monitorId}:{slot}
-- UPDATE monitors SET next_check_at = <next future slot>
```

- `FOR UPDATE SKIP LOCKED` lets several scheduler instances run at once: each
  takes rows the others have not locked. No leader election is needed.
- **Enqueue before commit.** A crash after enqueue but before commit leaves
  the monitor due, so it is claimed again and the duplicate job is discarded
  by its ID (and, as a backstop, by ADR-003). Committing first would lose the
  check instead. This is at-least-once delivery with an idempotent consumer.
- **No backfill.** After downtime, `next_check_at` jumps to the next _future_
  slot. Probing "what was the status ten minutes ago" is impossible, and a
  burst of catch-up jobs would hammer both the queue and the targets.
- **Jitter.** A new monitor's first slot is offset randomly within its
  interval so that 10,000 monitors do not all fire at second `:00`.

**Trade-offs accepted.** More code than option 1; roughly one second of
scheduling granularity; one small write per monitor per interval.

**At larger scale.** Partition the claim by `hash(monitor_id)` across
scheduler instances; raise the batch size; eventually move to a dedicated
timer service.

**Primer.** Asynchronism: Task queues; Consistency patterns.

**Interview question.** _"What happens if two scheduler instances run at the
same time?"_ `SKIP LOCKED` gives each a disjoint set of rows. If one crashes
mid-tick its transaction rolls back and the rows become claimable again.

---

## ADR-003: Slot-based idempotency; a failed check is not a failed job

**Problem.** Queues deliver _at least once_. A job can run twice (worker
crashed after writing but before acknowledging; scheduler re-enqueued). How do
we stop that from recording two checks, or double-counting a failure towards
the incident threshold?

**Decision.**

1. Every check belongs to a **slot**: its scheduled time. The job ID is
   `check:{monitorId}:{slotEpochMs}`.
2. `check_results` has `UNIQUE (monitor_id, scheduled_for)` and the worker
   inserts with `ON CONFLICT DO NOTHING`. If no row was inserted, the worker
   stops: the counters and incident logic have already run for this slot.
3. Two kinds of "retry" are kept strictly apart:

|             | Check failed                                   | Job failed                                           |
| ----------- | ---------------------------------------------- | ---------------------------------------------------- |
| Example     | Target timed out, returned 503, TLS error      | Postgres unreachable, worker crashed                 |
| Meaning     | A valid measurement: the endpoint is unhealthy | We failed to take or store a measurement             |
| Job outcome | **Completes successfully**                     | Throws, BullMQ retries with backoff                  |
| Recorded    | One failed `check_result`                      | Nothing until a retry succeeds; then exactly one row |

A flapping endpoint is not retried within a slot. The threshold of 3
consecutive failures already filters single blips, and an in-slot retry would
hide real intermittent failures from the user.

**Why not rely on BullMQ job IDs alone.** Job-ID deduplication only works
while the earlier job still exists in Redis; completed jobs are trimmed. The
database constraint holds forever and holds even if Redis is wiped.

**At larger scale.** Unchanged. Idempotency keys are what make it safe to add
workers.

**Primer.** Asynchronism: Message queues; Back pressure.

**Interview question.** _"How do you get exactly-once processing?"_ You don't;
no queue truly offers it. You get at-least-once delivery and make the handler
idempotent with a deterministic key and a unique constraint, which is
indistinguishable from exactly-once in its effects.

---

## ADR-004: Access JWT + rotating refresh token in httpOnly cookies

**Problem.** The browser must prove who the user is on every request, and a
stolen credential should be useful for as short a time as possible.

**Options.**

1. _Bearer JWT in `localStorage`_: simple, no CSRF, but any XSS bug can read
   and exfiltrate it, and it cannot be revoked.
2. _Single long-lived JWT in an httpOnly cookie_: script cannot read it, but
   it still cannot be revoked before expiry.
3. _Short access JWT + rotating refresh token_ (chosen).
4. _Server-side sessions in Redis_: fully revocable and simple, but every
   request costs a Redis lookup. A legitimate alternative.

**Decision.** Option 3.

- **Access token**: JWT, 15 minutes, `httpOnly; Secure; SameSite=Lax`.
  Verified with a signature check only, so no database hit per request.
- **Refresh token**: 256 random bits (not a JWT), 7 days, cookie scoped to
  `Path=/api/v1/auth` with `SameSite=Strict`. Only its SHA-256 is stored.
- **Rotation**: each refresh revokes the presented token and issues a new one
  in the same _family_.
- **Re-use detection**: presenting an already-revoked token means two parties
  hold it. The whole family is revoked and the user must log in again.
- **CSRF**: cookies are sent automatically, so state-changing requests are
  only accepted with `Content-Type: application/json` and a matching `Origin`,
  on top of `SameSite`.

**Trade-offs accepted.** One extra table, a refresh endpoint, client logic to
retry once after a `401`. An access token stays valid for up to 15 minutes
after logout; that window is the price of stateless verification.

**Why SHA-256 for refresh tokens but Argon2 for passwords.** Argon2 is slow on
purpose because passwords are low-entropy and can be guessed. A 256-bit random
token cannot be guessed, so a fast hash is sufficient and keeps refresh cheap.

**At larger scale.** Stateless access tokens are what let any API instance
behind a load balancer serve any request with no sticky sessions.

**Primer.** Security; Load balancer: Horizontal scaling.

**Interview question.** _"JWTs can't be revoked, so how does logout work?"_
Logout revokes the refresh-token family in the database. The access token
dies within 15 minutes and cannot be renewed.

---

## ADR-005: Single indexed `check_results` table + retention job

**Problem.** `check_results` grows by one row per monitor per interval
(144,000 rows/day per 100 monitors at 60 s). How should it be stored?

**Options.**

1. _One table, one composite index, nightly retention delete_ (chosen).
2. _Monthly range partitions_: retention becomes `DROP PARTITION` (instant, no
   bloat) and queries skip old partitions. But Prisma has no partitioning
   support, so it needs hand-written DDL and a partition-creation job.
3. _Raw + hourly rollups_: fast long-range charts, but exact percentiles
   cannot be recomputed from pre-aggregated buckets, and it adds a job that
   must be correct.

**Decision.** Option 1 for the MVP: at the target scale (hundreds of monitors)
this is a few million rows, which one B-tree handles comfortably. The index
design is explained in [docs/database.md](docs/database.md).

**Known cost.** Bulk `DELETE` leaves dead tuples for autovacuum to reclaim.
Acceptable now, and the direct reason option 2 is the next step.

**At larger scale.** Around 10,000 monitors (14 million rows/day), move to
option 2, then add option 3 for 30-day charts. Analytics filter on
`(monitor_id, scheduled_for)` already, which is the natural partition key, so
queries will not need rewriting.

**Primer.** Database: SQL tuning; Sharding; Denormalization.

**Interview question.** _"Your biggest table grows forever. What's your
plan?"_ Retention bounds it today. The trigger for partitioning is row volume
where delete-bloat and index depth start to cost, and the schema was shaped so
that change is a migration, not a redesign.

---

## ADR-006: Server-Sent Events fed by Redis pub/sub

**Problem.** The dashboard should update when a check completes. The check
runs in the worker; the browser is connected to an API instance, possibly one
of several.

**Options.**

1. _Polling_: stateless and simple; delayed, and most requests return nothing.
2. _SSE_ (chosen): one-way server push over ordinary HTTP, with automatic
   reconnection built into the browser's `EventSource`.
3. _WebSockets_: bidirectional, which the dashboard does not need, at the cost
   of a protocol upgrade and more proxy configuration.

**Decision.** The worker publishes an event to a Redis channel after its
transaction commits. Every API instance subscribes and forwards the event to
its own connected clients for that user. The worker does not need to know
which instance holds which browser.

**Guarantee, stated plainly.** Redis pub/sub is fire-and-forget: an event
published while a client is reconnecting is lost. That is acceptable because
events are only a signal to refetch from Postgres, never the data of record.
This is an availability-over-consistency choice for the live view only.

**Operational care.** Heartbeat comments every 25 s; a cap on connections per
user; cleanup on disconnect; publish strictly _after_ commit so the client
never refetches before the data is visible.

**At larger scale.** Thousands of open connections per instance need tuned
file-descriptor limits; per-user channels avoid broadcasting every event to
every instance; a durable stream (Redis Streams with `Last-Event-ID`) would
allow replay if lost events ever mattered.

**Primer.** Availability vs consistency; Communication.

**Interview question.** _"Why SSE instead of WebSockets?"_ The data only flows
one way. SSE is plain HTTP, reconnects by itself, and passes through proxies
without special handling.

---

## ADR-007: Row lock + partial unique index for incident transitions

**Problem.** Two workers could process checks for the same monitor at nearly
the same moment (two adjacent slots after a queue delay). Both read
`consecutive_failures = 2`, both decide "this is the third failure", both open
an incident.

**Options.**

1. _Hope it doesn't happen_: with 60 s intervals it is rare. Rare bugs in
   alerting are the worst kind.
2. _Optimistic locking_ (version column, retry on conflict): no blocking, more
   code, needs a retry loop.
3. _Pessimistic row lock_ (chosen): `SELECT ... FOR UPDATE` on the monitor row
   at the start of the transaction.
4. _Serialise per monitor in the queue_: BullMQ group concurrency is a paid
   feature; not available.

**Decision.** Option 3, plus the partial unique index
`incidents (monitor_id) WHERE resolved_at IS NULL` as a second, independent
guard. The lock makes the transitions happen one at a time; the index makes a
duplicate open incident impossible even if the application logic has a bug.

Contention is negligible: the lock is per monitor, held for a few
milliseconds, and the slow HTTP request happens _before_ the transaction, not
inside it.

**At larger scale.** Unchanged; the lock scope is a single row.

**Primer.** Consistency patterns: Strong consistency.

**Interview question.** _"How do you prevent duplicate incidents under
concurrency?"_ Lock the monitor row for the read-decide-write sequence, and
back it with a database constraint so correctness does not depend on the
application alone.

---

## ADR-008: Transactional outbox for notifications

**Problem.** When an incident opens, an email should be sent once. "Commit the
incident, then enqueue an email job" can crash between the two steps and lose
the alert; the reverse order can send an alert for an incident that was rolled
back.

**Decision.** Insert a `notification_deliveries` row with status `PENDING` in
the _same transaction_ as the incident change. A sender job processes pending
rows and marks them `SENT`. `UNIQUE (incident_id, event, channel)` guarantees
one delivery record per event.

**Residual risk, stated plainly.** If the SMTP call succeeds and the process
dies before marking the row `SENT`, the retry sends a second email. Email has
no idempotency key, so this cannot be fully eliminated; the window is a few
milliseconds and a rare duplicate alert is far better than a missed one.

**Primer.** Asynchronism; Consistency patterns: Eventual consistency.

**Interview question.** _"How do you update a database and send a message
reliably?"_ You can't do both atomically, so write the intent to the database
in the same transaction and let a separate process deliver it: the outbox
pattern.

---

## ADR-009: SSRF defence at connection time, not URL-parse time

**Problem.** Users supply a URL and our server requests it. Without care, a
user can make the worker call `https://169.254.169.254/` (cloud metadata),
`https://localhost:5432`, or an internal admin service: Server-Side Request
Forgery.

**Why checking the URL string is not enough.**

- `https://internal.example.com` can resolve to `10.0.0.5`.
- **DNS rebinding**: the name resolves to a public IP when validated and to
  `127.0.0.1` a moment later when the request is made.
- Alternative encodings (`https://2130706433/`, IPv4-mapped IPv6) bypass naive
  pattern matching.
- A redirect can point anywhere.

**Decision.** Defence in layers:

1. Validation: `https:` only, no credentials in the URL, standard ports.
2. Resolve DNS **once**, check every returned address against a deny-list
   (private, loopback, link-local, CGNAT, multicast, reserved, IPv4-mapped
   IPv6, unique-local IPv6), then connect to **that exact IP** while still
   sending the original hostname for TLS SNI and certificate verification.
   Validation and connection use the same address, so rebinding has no gap to
   exploit.
3. Redirects disabled: a `3xx` is recorded as its status, never followed.
4. Timeout and response-size cap, so a slow or endless response cannot tie up
   a worker.
5. Network-level egress rules in deployment (Phase 6), because application
   checks should never be the only layer.

Implemented in Phase 3 and tested in Phase 4 against each bypass listed above.

**Primer.** Security.

**Interview question.** _"How would you attack your own URL validation?"_ DNS
rebinding, redirects, and IP encoding tricks, which is why the check is on the
resolved IP at connection time.

---

## ADR-010: No application cache until measurements justify one

**Problem.** Analytics queries aggregate thousands of rows. Should results be
cached in Redis?

**Analysis.** The natural design is cache-aside: on a miss, compute and store
with a TTL. The data has a useful property: a monitor's statistics cannot
change more often than its check interval, so a TTL equal to the interval
(60 s) is never staler than the data itself and needs no invalidation logic.

**Decision.** Do not build it yet. A 24-hour analytics query reads 1,440 index
entries, which Postgres does quickly; a cache would add a second source of
truth, stale-data bugs and a Redis dependency on the read path, to fix a
problem that has not been observed. In Phase 6 the k6 results decide: if the
analytics endpoint's p95 is a problem, add cache-aside with the TTL above and
record before/after numbers here.

Redis _is_ used from the start for things that are not caches: the job queue,
pub/sub and rate-limit counters.

**Primer.** Cache: Cache-aside; Disadvantages of cache.

**Interview question.** _"Where would you add caching?"_ On the bounded-range
analytics endpoint, TTL equal to the check interval. And I would say why it is
not there yet: no measurement showed a need.

---

## ADR-011: Uptime counts recorded checks only

**Problem.** If the worker is down for an hour, was the monitored site "down"?

**Decision.** `uptime = successful checks / recorded checks`. Missing slots
are excluded: our outage is not evidence of theirs. To avoid presenting a
misleading 100% from sparse data, the API also returns `expectedChecks` so the
UI can show coverage. Latency statistics use successful checks only.

**Alternative rejected.** Counting missing slots as downtime would make the
platform's own reliability problems look like the customer's.

**Interview question.** _"How do you define uptime?"_ By stating the
denominator. Most disagreements about uptime numbers are really disagreements
about what was counted.

---

## ADR-012: Toolchain versions

Checked against the npm registry and the local machine on 2026-11-15.

| Tool       | Choice   | Reason                                                                                                                                                 |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js    | 24 (LTS) | Installed locally (24.11.1); supported by every dependency.                                                                                            |
| TypeScript | 6.0.x    | `typescript-eslint` 8.72 supports `<6.1.0`. TypeScript 7.0 is the newest release but the linter does not yet support it.                               |
| Prisma     | 7.10.x   | The registry's `latest` tag currently points at an 8.0 release candidate. A release candidate is not a stable base, so the last stable line is pinned. |
| pnpm       | 10.x     | Strict `node_modules` (a package can only import what it declares) and workspace support.                                                              |
| PostgreSQL | 16       | Matches the locally installed server, so the reference schema was verified on the same major version.                                                  |

Remaining versions (Fastify, BullMQ, Vitest and others) are pinned when each
is first installed, using the same rule: newest stable release whose peer
dependencies are satisfied.

---

## ADR-013: Pin every database session to UTC

**Problem (found by a failing test, 2026-11-15).** The test that writes
`2026-03-29T01:30:00Z` and reads it back received `02:30:00Z`: one hour wrong.
Timestamps in January passed.

**Diagnosis.** The value _stored_ was correct (verified by reading the epoch
directly in SQL). The fault is on the read path. PostgreSQL renders a
`timestamptz` as text in the **session** time zone; the development server's
default zone is `Europe/London`, so it sent `02:30:00+01`. Prisma's `pg`
driver adapter drops the offset when parsing and treats the digits as UTC.
In winter London is UTC+0, which is why only a summer-time instant exposed it.

**Options.**

1. _Require the server to be configured for UTC._ Fragile: correctness would
   depend on infrastructure nobody remembers to check.
2. _Set the session time zone on every connection_ (chosen): the client
   factory passes `options: "-c timezone=UTC"`.
3. _Store `timestamp` without time zone._ Removes the symptom by removing the
   safety that `timestamptz` gives.

**Decision.** Option 2, in the one place connections are created
(`createDatabaseClient`). Two tests guard it: the daylight-saving round trip,
and a direct assertion that the session zone is `UTC`. The second exists
because CI containers default to UTC, so the first test alone would pass there
even if the pin were removed.

**Caveat for deployment.** Connection poolers in transaction mode (PgBouncer)
can reject start-up `options`. If one is introduced, set the zone on the
database role instead (`ALTER ROLE ... SET timezone = 'UTC'`).

**Interview question.** _"Tell me about a bug you found through testing."_ A
read-path time-zone bug that only appears on a non-UTC server during summer
time, invisible in CI. The lesson: test with awkward instants, and assert the
invariant itself, not only one symptom of breaking it.

---

## ADR-014: Hand-written SQL in migrations, guarded by a drift check

**Problem.** Prisma's schema language cannot express `CHECK` constraints or
partial indexes, and three guarantees in this system depend on them (one open
incident per monitor, HTTPS-only URLs, well-formed check results).

**Options.**

1. _Enforce those rules only in application code._ Any writer that bypasses
   the code path bypasses the rule.
2. _Abandon Prisma Migrate for a SQL-first tool._ Loses the generated,
   type-safe client staying in step with the schema.
3. _Let Prisma generate the migration, then append hand-written SQL_ (chosen).

**Decision.** Option 3. The appended section is clearly marked in the
migration file. The risk is that the Prisma schema and the real database drift
apart unnoticed, so `pnpm db:check-drift` compares a migrated database with
`schema.prisma` and exits non-zero on any difference.

**Verified.** On a clean migrated database the check exits 0 (Prisma ignores
the partial indexes and check constraints rather than trying to drop them).
After manually adding an untracked column it exited 2 and named the column, so
the check does detect real drift.

**Minor difference from the Phase 1 design.** `check_results.id` is
`BIGSERIAL` rather than `GENERATED ALWAYS AS IDENTITY`, because that is what
Prisma emits for `autoincrement()`. Behaviour is the same for this use.

**Interview question.** _"What do you do when your ORM can't express
something?"_ Use the database feature directly in a migration, and add an
automated check so the two descriptions of the schema cannot silently diverge.

---

## ADR-015: Integration tests use a real PostgreSQL, never a mock

**Problem.** Most of what is being tested in the data layer is database
behaviour: constraints, cascades, conflict handling, concurrency. A mocked
client would only test the mock.

**Decision.** `createTestDatabase()` creates a uniquely named database per
test run, applies the real migrations with `prisma migrate deploy`, and drops
it afterwards. The server is a Testcontainers `postgres:16-alpine` container
by default, or an existing server when `TEST_DATABASE_URL` is set.

- **Isolation without truncation.** Each test creates its own user and works
  inside that user's data, so tests can run in any order and in parallel.
- **Determinism.** Fixtures use a fixed instant (`T0`), never the wall clock.
- **Dependency injection, minimally.** `createDatabaseClient` takes its
  connection string as an argument, so tests point real code at the test
  database with no mocking framework.

**Trade-off.** Slower than unit tests (about three seconds for 26 tests here)
and needs Docker or a local Postgres.

**Interview question.** _"Why not mock the database?"_ Because the behaviour
under test lives in the database. The concurrent-writers test, for example,
proves a partial unique index admits exactly one of ten racing inserts; no
mock can tell you that.

---

## ADR-016: One Zod schema drives validation, serialisation and OpenAPI

**Problem.** An endpoint's contract is usually written three times: validation
code, the shape the handler returns, and the API documentation. Three copies
drift apart.

**Options.**

1. _Hand-written OpenAPI plus manual validation._ Full control, guaranteed drift.
2. _Fastify's native JSON Schema._ Fast, but types must be declared separately
   from schemas, and JSON Schema is verbose to write.
3. _Zod schemas on each route via `fastify-type-provider-zod`_ (chosen).

**Decision.** Each route declares Zod schemas for its body, query, params and
responses. From that single declaration: the request is validated, the
handler's `request.body` is typed, the response is serialised, and
`@fastify/swagger` generates the OpenAPI 3.1 document served at `/docs`.

**Security property worth knowing.** Response schemas are an allow-list: any
field not declared is removed before the response is sent. A test has a
handler return a whole user row including `passwordHash` and asserts the hash
never reaches the client. Leaking a field now requires adding it to a schema
on purpose, rather than forgetting to remove it.

**Trade-off.** Zod is slower than Fastify's compiled JSON Schema serialiser.
Whether that matters is a question for the Phase 6 load test, not a guess.

**Interview question.** _"How do you keep API docs accurate?"_ Generate them
from the same schema that validates requests, so documentation that is wrong
would mean validation that is wrong, and tests would fail.

---

## ADR-017: Central error handler; unknown errors are hidden by default

**Problem.** Errors come from many places (validation, business rules, the
framework, bugs, outages) and each must become a safe, consistent response.

**Decision.** Services throw `AppError(statusCode, code, message)` for
expected failures. One Fastify error handler converts everything:

| Error                          | Response                                       |
| ------------------------------ | ---------------------------------------------- |
| `AppError`                     | Its own status, code and message               |
| Zod validation failure         | `422 VALIDATION_ERROR` with a detail per field |
| Malformed JSON, oversized body | `400` / `413` with a fixed message             |
| Response fails its own schema  | `500`, logged (it is a server bug)             |
| Anything else                  | `500 INTERNAL_ERROR`, generic message, logged  |

The important design choice is the **default**: an error is hidden unless it
was explicitly marked safe by being an `AppError`. The alternative (send the
error's message unless told otherwise) leaks connection strings and SQL the
first time something unexpected happens. A test throws an error containing a
fake credential and asserts it appears in the log but not in the response.

Every response carries a server-generated request ID, also present on each
log line for that request. A client-supplied `x-request-id` is ignored so that
callers cannot forge or collide log entries.

**Interview question.** _"A user reports a 500. How do you find the cause?"_
The response includes a request ID; searching the structured logs for it
returns the full error and stack trace for exactly that request.

---

## ADR-018: Separate liveness and readiness probes

**Problem.** An orchestrator needs to know whether to restart a container and
whether to send it traffic. Those are different questions.

**Decision.** `/healthz` (liveness) checks nothing external. `/readyz`
(readiness) runs `SELECT 1` with a two-second timeout and returns `503` if the
database does not answer; Redis is added to it in Phase 3.

**Why not one endpoint that checks the database.** During a brief database
outage every instance would fail its health check, the orchestrator would
restart them all, and they would come back to the same outage: a restart loop
that adds load exactly when the database is struggling. Failing readiness only
removes the instance from the load balancer until the dependency returns.

**Primer.** Availability patterns: Fail-over; Load balancer (health checks).

**Interview question.** _"What should a health check check?"_ Liveness: only
the process itself. Readiness: the dependencies needed to serve a request.

---

## ADR-019: Auth implementation: libraries, same-origin, known gaps

This records how ADR-004 was implemented and, just as importantly, what it
does not yet cover.

**Libraries.**

| Need             | Choice            | Why                                                                                          |
| ---------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| Password hashing | `@node-rs/argon2` | Argon2id with prebuilt binaries, so there is no compiler toolchain or install script to run. |
| JWT              | `jose`            | No dependencies; the verifier is called with an explicit algorithm allow-list.               |
| Cookies          | `@fastify/cookie` | The official Fastify plugin.                                                                 |

Argon2id runs with OWASP's minimum parameters (19 MiB, 2 passes, 1 lane). They
are encoded in each hash, so they can be raised later without a migration.

**No CORS, by design.** The web app and the API are served from one origin (a
dev-server proxy locally, a reverse proxy in production). With no cross-origin
browser access there is nothing for CORS to permit, so it is not enabled at
all, which is safer than a permissive configuration. State-changing requests
carrying an `Origin` other than `APP_ORIGIN` are refused with `403`, as a
second CSRF layer behind `SameSite` cookies.

**Layering.** `auth/service.ts` holds the rules and knows nothing about HTTP;
`auth/routes.ts` only translates between HTTP and the service; `app.ts` is the
composition root that constructs both. The clock is injected, so expiry tests
move time forward instead of sleeping.

**Concurrency decisions.**

- _Registration_ relies on the unique constraint rather than "check, then
  insert", because two simultaneous requests would both pass a check. A test
  registers the same email twice in parallel and asserts one `201`, one `409`.
- _Refresh_ claims the token with a conditional update (`WHERE revoked_at IS
NULL`), so the database admits one of two simultaneous refreshes.

**Trade-off accepted: refresh races log the user out.** If two browser tabs
refresh with the same token at the same instant, the loser looks exactly like
token theft, and the whole session is revoked. Some systems add a few seconds
of grace for the previous token. That weakens theft detection, so instead the
web client will share a single in-flight refresh across tabs (Phase 5).

**Known gaps (deliberate, tracked).**

| Gap                                                | Why it exists                                       | Planned   |
| -------------------------------------------------- | --------------------------------------------------- | --------- |
| No rate limiting on login or register              | Needs Redis, which arrives with the worker          | 4.3       |
| Registration reveals whether an email is taken     | Hiding it requires an email-verification flow       | Future    |
| No email verification or password reset            | Needs outbound email                                | Future    |
| Access token stays valid up to 15 min after logout | The cost of verifying tokens without a database hit | By design |
| Expired refresh-token rows are never deleted       | Needs a scheduled job                               | 4.5       |

Until rate limiting lands, login is open to online password guessing, slowed
only by the cost of Argon2. This must be closed before any public deployment.

**Interview question.** _"What are the weaknesses of your auth system?"_ The
table above. Being able to list them, with the reason and the plan for each,
is a stronger answer than claiming there are none.

---

## ADR-020: Ownership in every query; auth before validation

**Problem.** Every monitor belongs to one user. The most common serious bug in
APIs like this is "insecure direct object reference": the server checks that
the caller is logged in, but not that the object they named is theirs.

**Options.**

1. _Load the row, then compare `row.userId` with the caller._ Works, but it is
   a separate step that each new endpoint has to remember.
2. _Put the owner in the query itself_ (chosen): `WHERE id = $1 AND user_id =
$2`. A row belonging to someone else is simply not returned.
3. _PostgreSQL row-level security._ The strongest option, since the database
   enforces it whatever the application does. It needs a per-request database
   role or session variable, which complicates connection pooling.

**Decision.** Option 2. Every `MonitorService` method takes `userId` as its
first argument and the guard is the only source of that value (the verified
token, never the URL or body). The response for "not yours" is `404`, and a
test asserts it is identical to the response for an ID that does not exist,
so the API cannot be used to discover which IDs are real.

Three related decisions made while building this:

- **Authentication runs at `onRequest`, not `preHandler`.** Found by a failing
  test: an anonymous `POST` with an invalid body received `422` rather than
  `401`. Fastify validates the body before `preHandler` hooks run, so an
  unauthenticated caller was being told what was wrong with their request.
  Moving the guard to the first lifecycle stage fixed it.
- **The per-user limit is enforced under a row lock.** "Count, then insert" is
  a race: two requests can both count 49. Creation runs in a transaction that
  first takes `SELECT ... FOR UPDATE` on the user's row, so concurrent
  creations for one user queue up. A test fires eight at once against a limit
  of three and asserts exactly three succeed.
- **Mass assignment is impossible by construction.** Request schemas list the
  fields a client may set; anything else (`userId`, `status`) is dropped
  before the handler sees it. Tests send those fields and assert they have no
  effect.

**URL validation here is only the first SSRF layer.** The API rejects
non-HTTPS URLs, embedded credentials and non-default ports. It does not, and
cannot, know what a hostname resolves to. `https://internal.example.com`
passes this check; stopping it is the worker's job in Phase 3 (ADR-009).

**At larger scale.** Row-level security becomes worth its cost once several
services or ad-hoc queries touch the same tables, because application-level
filtering only protects the code paths that remember to apply it.

**Interview question.** _"How do you make sure users can't see each other's
data?"_ The owner is part of every query, taken from the verified token, and
a test suite attacks each endpoint as a second user and asserts a 404 that is
indistinguishable from a missing record.

---

## ADR-021: Prober: pin the checked IP, time to headers, no body

This records how ADR-009 was implemented in `apps/worker/src/probe/`.

**Three small modules, each testable alone.**

| Module              | Responsibility                                                               |
| ------------------- | ---------------------------------------------------------------------------- |
| `address-policy.ts` | Given an IP address, is it ordinary public internet? Pure function.          |
| `resolve.ts`        | Resolve a hostname once; refuse if any answer fails the policy.              |
| `prober.ts`         | Make the HTTPS request to the pinned address, time it, classify the outcome. |

**How pinning works.** Node's `https.request` accepts a `lookup` function,
which it calls to turn the hostname into an address. The prober resolves and
validates first, then supplies a `lookup` that returns only the validated
address. The connection therefore goes to the IP that was checked, while TLS
still verifies the certificate against the original hostname. There is no
second DNS query for an attacker to answer differently.

**Decisions inside that.**

- _The policy takes an IP, never a URL._ Decimal (`2130706433`), hex
  (`0x7f.1`) and short (`127.1`) spellings are all normalised by the URL
  parser and the OS before the policy sees them, so there is one address
  format to reason about instead of many.
- _Block-list built from the IANA special-purpose registries_, including IPv6
  forms that embed an IPv4 address (IPv4-mapped, NAT64, 6to4). These are the
  usual way round a filter that only understands IPv4.
- _If any resolved address is blocked, all are refused._ Stricter than
  "use the first safe one", and it removes any dependence on which address
  the connection logic would pick.
- _A new connection per check_ (`agent: false`). A reused keep-alive socket
  would skip the lookup and hide connect and TLS time from the measurement.
- _Error messages are fixed strings chosen by us._ They are stored and shown
  to the user; raw socket errors can contain internal addresses, which is the
  information an SSRF attempt is fishing for.

**What "response time" means.** Time from the start of the check (before DNS)
until the response status line and headers arrive, measured with
`process.hrtime.bigint()`. That is a monotonic clock: unlike `Date.now()` it
cannot jump when the system clock is corrected, so a duration is always right.

**The body is never downloaded.** Once headers arrive the connection is
dropped. This makes the response-size limit trivially true (a test streams an
endless body and the check still returns immediately), and it keeps a slow or
huge body from occupying a worker.

Trade-off accepted: an endpoint that sends healthy headers and then fails
mid-body is reported as up. Body assertions are out of scope for the MVP.

**Redirects count as failures.** A `301` is recorded as `HTTP_STATUS`, not
followed. Observed on the real internet: `https://www.github.com/` reports
`301`. Users must monitor the final URL; the UI should say so (Phase 5).
Following redirects safely would mean re-validating every hop.

**How the tests were checked.** All 99 worker tests passed on first run, which
proves little for security code. So the guard was deliberately broken twice:

| Change made on purpose                                   | Result                    |
| -------------------------------------------------------- | ------------------------- |
| Removed the policy check from resolution                 | 17 tests failed           |
| Made the connection re-resolve the hostname (no pinning) | The rebinding test failed |

Both were then reverted. A test suite that cannot fail is not evidence.

**Limits of this layer.** It protects against requests the application makes
knowingly. It does not replace network-level egress rules (Phase 6): a bug
elsewhere, or a dependency making its own requests, bypasses it entirely.

**Interview question.** _"Explain DNS rebinding and how you prevent it."_ The
attacker's DNS answers the validation lookup with a public IP and the
connection lookup with an internal one. Prevent it by resolving once and
connecting to the address you validated, not to the name.

---

## ADR-022: Scheduler and processor: implementation and verification

This records how ADR-002, ADR-003 and part of ADR-007 were built in
`apps/worker/src/checks/`.

**The path of one check.**

1. `scheduler.ts` claims due monitors with `SELECT ... FOR UPDATE SKIP LOCKED`,
   enqueues a job per monitor, then advances `next_check_at`, all in one
   transaction.
2. `queue.ts` adds the jobs to BullMQ with the ID `check_{monitorId}_{slotMs}`.
3. `processor.ts` probes the endpoint, then in one transaction: locks the
   monitor row, inserts the result with `ON CONFLICT DO NOTHING`, and updates
   the counters only if this attempt inserted the row.

**Decisions made while building it.**

- _Slots stay on each monitor's own grid._ After downtime the scheduler jumps
  to the most recent slot rather than back-filling, computed from the
  monitor's `next_check_at` rather than from the wall clock, so the jitter
  applied at creation is preserved.
- _The HTTP request is outside the transaction._ A check can take 30 seconds;
  holding a transaction and row lock that long would exhaust the connection
  pool. Only the short "store the result" step is transactional.
- _A late result does not rewind state._ Jobs can finish out of order. A
  result for an older slot is kept in the history but does not touch the
  counters if a newer slot has already been recorded.
- _A cheap pre-check avoids re-probing on retry._ If the slot already has a
  result, the endpoint is not contacted again. This is an optimisation; the
  unique constraint is what guarantees correctness.
- _One process runs both roles._ The scheduler and the processors scale
  independently if needed, since both are safe to run as several copies.
- _BullMQ 6 needs its Redis client supplied._ `ioredis` is a peer dependency
  now, not bundled, so it is a direct dependency of the worker.

**Two meanings of "retry", kept apart.**

|             | Configured where                                 | Triggered by               | Effect on recorded checks                     |
| ----------- | ------------------------------------------------ | -------------------------- | --------------------------------------------- |
| Job retry   | BullMQ: 5 attempts, exponential backoff from 1 s | Our infrastructure failing | None: at most one row per slot                |
| Check retry | Nowhere. There isn't one.                        | n/a                        | A down endpoint is one failed result per slot |

**How the concurrency controls were verified.** The 131 tests passed on the
first run, so each control was removed in turn to see whether a test noticed.

| Control removed                               | First result     | After adding a targeted test |
| --------------------------------------------- | ---------------- | ---------------------------- |
| Scheduler row lock (`FOR UPDATE SKIP LOCKED`) | Caught           | n/a                          |
| Processor "already stored" handling           | Caught (3 tests) | n/a                          |
| `SKIP LOCKED` only (plain `FOR UPDATE`)       | **Not caught**   | Caught                       |
| Processor's lock on the monitor row           | **Not caught**   | Caught                       |

Two protections were therefore unproven until new tests were written:

- _`SKIP LOCKED`_ is a liveness property, not a correctness one. Without it
  schedulers still never double-enqueue; they queue up behind each other. The
  new test holds one scheduler mid-transaction and asserts a second one
  returns immediately with a different monitor.
- _The monitor row lock_ prevents an older result's counter update landing
  after a newer one's. The new test stores an old failure and a new success
  simultaneously, 40 times, and asserts the monitor always reflects the
  newer. It is timing-dependent: it cannot fail on correct code, but in
  principle it could miss the bug on a given run. It failed on the first run
  with the lock removed.

**Observed end to end.** The built worker process ran against the Compose
PostgreSQL and Redis with four real monitors. Each was checked exactly once:
a public site (`200`), a redirect (`301`, not followed), the cloud metadata
address (`BLOCKED_ADDRESS`) and a self-signed certificate (`TLS`). Each
monitor's counter moved by one and its next check was scheduled.

**Not built yet.** Status transitions and incidents (Phase 4): `status` stays
`PENDING` and only the counters move. `/readyz` does not check Redis, because
the API does not use Redis until rate limiting arrives.

**Interview question.** _"How do you know your concurrency code works?"_
Passing tests were not enough. I removed each lock and constraint in turn;
two removals went unnoticed, which showed two guarantees were untested, so I
wrote tests that fail without them.

---

## ADR-023: Incidents and alerts: implementation

This records how ADR-007 and ADR-008 were built.

**State machine as a pure function.** `applyCheck(state, thresholds, success)`
in `apps/worker/src/checks/state-machine.ts` holds every rule (PENDING to UP on
the first success, DOWN on the third consecutive failure, UP again on the
second consecutive success). It has no database or clock, so each rule is a
one-line unit test. The processor calls it inside the transaction that stores
the result, under the monitor row lock.

**Incident timestamps are back-dated to the streak.** An incident starts at
the first failure of the streak that crossed the threshold, and resolves at
the first success of the recovery streak, both found with an index-backed
query. Using the threshold-crossing check would make every outage look two
minutes shorter than it was.

**Alerts go only to the account's own email.** Addresses are not verified in
this version. Allowing an arbitrary recipient would let anyone point a
flapping monitor at a stranger's inbox. Email is also opt-in (off by default).

**The sender holds a row lock during the SMTP call.** That is what stops two
worker processes sending the same email (`FOR UPDATE SKIP LOCKED`). It is the
opposite of the rule used for checks, where the network call happens outside
the transaction, and the difference is deliberate: checks are frequent and
concurrent, alerts are rare and one-at-a-time, so a briefly held connection
costs nothing here. Failures retry after 1, 2, 4, 8 minutes, then the
delivery is marked `FAILED` (a second migration added `next_attempt_at`).

**Delivery is at-least-once.** If SMTP accepts a message and the process dies
before committing, the email is sent again. Email has no idempotency key.

**Monitor names are single-line.** Found while designing the email subject:
names could contain newlines, which reach email headers and log lines.
Nodemailer encodes headers safely, but the validation now rejects control
characters at the API anyway.

**Retention.** An hourly job deletes check results older than
`RETENTION_DAYS` (minimum 30, the longest analytics range) in batches of
5,000, and removes expired or long-revoked refresh tokens.

**Interview question.** _"How do you avoid alerting on a blip?"_ Hysteresis:
three consecutive failures to declare an outage, two consecutive successes to
end it, with tests for a flapping endpoint that never crosses either line.

---

## ADR-024: Rate limiting, metrics and live events: implementation

**Rate limits live in Redis.** Per-process counters would multiply the limit
by the number of API instances. The general limit is 300 requests per minute
per IP; login and registration share a separate limit of 10.

**A bug the tests found: protected routes were not limited at all.** With
the plugin in its default "global" mode, it attaches its check after each
route's own hooks. The authentication guard ran first and rejected requests
without a session before they were counted, so anyone without a session
could call protected endpoints without limit. The plugin also runs at most
one limiter per request. The fix is a single app-level `onRequest` hook,
which runs before any route hook, choosing the strict or general limiter per
route, each with its own Redis key.

**The limiter fails open.** If Redis is down, requests are allowed rather
than refused (`skipOnError`). A failing limiter should not take the whole API
down; the cost is that limits are not enforced during a Redis outage.

**`X-Forwarded-For` is ignored unless `TRUST_PROXY=true`.** Otherwise a client
sets the header to a new value per request and is never limited. A test
proves the spoofed header has no effect.

**Metrics label by route pattern.** `/api/v1/monitors/:id`, never the raw
URL: one time series per monitor ID would grow without bound. `/metrics` is
excluded from the API documentation and must not be routed publicly.

**Live events.** The worker publishes after commit; each API instance holds
one Redis subscription and an in-memory map of its own connections, capped at
5 streams per user. A test proves a user receives their events and not
another user's.

**Readiness now checks Redis as well as Postgres**, in parallel, reporting
every failed dependency rather than the first.

**Interview question.** _"How does rate limiting work with several API
servers?"_ The counters are in Redis, shared by all of them, keyed by client
IP. A test sends requests to two app instances and the limit still holds.
