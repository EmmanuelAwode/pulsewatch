# Load testing

`api-read-path.js` is a [k6](https://k6.io) test of the dashboard's read path
through the whole stack (nginx -> API -> PostgreSQL), as an authenticated user.

## What it measures, and what it does not

- **Measures:** latency and error rate of the four requests a dashboard page
  load makes: `/dashboard`, `/monitors`, `/monitors/:id/analytics` (a random
  range of 24h/7d/30d) and `/incidents`.
- **Does not measure the worker.** Load-testing the worker would mean sending
  a high volume of requests to third-party websites, which is not acceptable.
  Its throughput is bound by the network and the monitored sites, not by this
  code.
- **Same machine.** k6, nginx, the API and PostgreSQL all ran on one machine,
  so they competed for the same CPU. A real deployment would separate them.

## How to run it

```bash
export JWT_ACCESS_SECRET="$(openssl rand -base64 48)"
# Raise the per-IP limits: every k6 request comes from one container IP.
export RATE_LIMIT_PER_MINUTE=100000 AUTH_RATE_LIMIT_PER_MINUTE=10000
docker compose --profile app up -d --build --wait

bash load/prepare.sh        # prints LOAD_EMAIL and LOAD_PASSWORD
export LOAD_EMAIL=... LOAD_PASSWORD=...

docker run --rm -i --network pulsewatch_default \
  -e BASE_URL=http://web:8080 -e LOAD_EMAIL -e LOAD_PASSWORD \
  grafana/k6 run --summary-trend-stats "avg,med,p(90),p(95),p(99),max" - < load/api-read-path.js
```

`prepare.sh` registers an account, creates 20 monitors and inserts 30 days of
one-minute check history for each (864,000 rows). That history is synthetic
test data for measuring query cost. It is never presented as real monitoring
results.

## Results (16 November 2026)

**Environment:** Intel Core i7-13700 (16 cores, 24 threads), 31.7 GB RAM,
Windows 11 with Docker Desktop 29.9.3 (WSL 2 backend, 24 CPUs and 15.5 GB
available to containers). k6 v2.4.0 running in a container on the Compose
network. PostgreSQL 16, Redis 7, one API container, default settings.

**Data:** `check_results` held 1,728,052 rows (308 MB): the preparation
script was run twice by mistake, creating two load-test accounts. The test
reads one of them; the other's rows make the table larger than intended,
which makes the result slightly more conservative, not less.

### Run 3: final

Open model, ramping to 150 dashboard loads/s (600 API requests/s) over 15 s,
then held for 60 s.

| Metric                               | Result                       |
| ------------------------------------ | ---------------------------- |
| Requests                             | 40,798 (0 failed, 0 dropped) |
| Throughput (whole run)               | 542 requests/s               |
| All requests: median / p95 / p99     | 4.3 ms / 24.8 ms / 37.0 ms   |
| `/dashboard`: p95 / p99              | 13.8 ms / 33.9 ms            |
| `/monitors/:id/analytics`: p95 / p99 | 30.1 ms / 47.2 ms            |
| Maximum                              | 213 ms                       |

nginx's log for the run: 40,798 responses with status 200, and 2 with status
401 from the setup step.

### How it got there

The first two runs failed, for different reasons. Both are kept here because
the fixes are the interesting part.

**Run 1: dashboard p95 539 ms, analytics p95 433 ms (thresholds failed).**
Closed model, 25 virtual users, 248 requests/s, no errors. `EXPLAIN ANALYZE`
showed the dashboard's 24-hour aggregation doing a parallel sequential scan
of the whole `check_results` table: **70 ms** per call, and growing with every
user's data. Rewriting the join as `monitor_id = ANY($ids)` let PostgreSQL use
the `(monitor_id, scheduled_for)` index: **6.7 ms** for the same query.

**Run 2: 81% of requests failed.** With the query fixed, the closed model
pushed about 2,700 requests/s. nginx returned 502 for 188,023 of them:
`connect() ... failed (99: Address not available)`. An earlier change to make
nginx re-resolve the API container's address had removed its connection
pool, so every request opened a new TCP connection and the local ports ran
out. The fix keeps both: an `upstream` with `keepalive` and `server ... resolve`.

**Runs are not directly comparable.** Run 1 used a closed model and run 3 an
open model at a fixed rate, so "539 ms -> 14 ms" is not a like-for-like
improvement figure. The directly comparable measurement is the query itself:
70 ms -> 6.7 ms on the same data.

### Not tested

- Write-heavy load (creating monitors, logging in): auth is deliberately slow
  (Argon2) and rate-limited, so a high rate is not a meaningful target.
- More than one API instance behind a load balancer.
- The worker's throughput and the scheduler under thousands of monitors.
