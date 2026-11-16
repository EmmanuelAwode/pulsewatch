#!/usr/bin/env bash
# Prepares the Compose stack for the k6 load test:
#   1. registers a load-test account through the API,
#   2. creates 20 monitors for it,
#   3. inserts 30 days of one-minute check history per monitor (864,000 rows)
#      directly into PostgreSQL, so analytics queries scan a realistic volume.
#
# The history is SYNTHETIC test data for measuring query performance. It is
# never presented as real monitoring results. The monitors point at
# example.invalid, a reserved name that never resolves, so no third-party
# site receives any traffic.
#
# Usage: bash load/prepare.sh            (stack running: docker compose --profile app up -d)
set -euo pipefail

BASE="${BASE_URL:-http://localhost:8080}/api/v1"
EMAIL="load-$(date +%s)@pulsewatch.test"
PASSWORD="load-test-password-not-secret"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
JSON=(-H "content-type: application/json")

status=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" "${JSON[@]}" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$BASE/auth/register")
[ "$status" = "201" ] || { echo "register failed: HTTP $status" >&2; exit 1; }

for i in $(seq 0 19); do
  status=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "${JSON[@]}" \
    -d "{\"name\":\"Load $i\",\"url\":\"https://example.invalid/load/$i\",\"intervalSeconds\":3600}" \
    "$BASE/monitors")
  [ "$status" = "201" ] || { echo "create monitor $i failed: HTTP $status" >&2; exit 1; }
done

docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-pulsewatch}" \
  -d "${POSTGRES_DB:-pulsewatch}" -q <<SQL
SELECT setseed(0.42);  -- deterministic data across runs
INSERT INTO check_results (monitor_id, scheduled_for, checked_at, success, status_code, response_time_ms, error_type, error_message)
SELECT m.id,
       slot,
       slot + interval '200 milliseconds',
       ok,
       CASE WHEN ok THEN 200 ELSE 503 END,
       (40 + random() * 160 + CASE WHEN random() < 0.05 THEN random() * 900 ELSE 0 END)::int,
       CASE WHEN ok THEN NULL ELSE 'HTTP_STATUS'::check_error_type END,
       CASE WHEN ok THEN NULL ELSE 'The endpoint responded with HTTP 503.' END
FROM monitors m
JOIN users u ON u.id = m.user_id AND u.email = '$EMAIL'
CROSS JOIN LATERAL (
  SELECT slot, random() > 0.002 AS ok
  FROM generate_series(now() - interval '30 days', now() - interval '1 minute', interval '1 minute') AS slot
) s;
UPDATE monitors SET status = 'UP' FROM users u WHERE u.id = monitors.user_id AND u.email = '$EMAIL';
ANALYZE check_results;
SQL

rows=$(docker compose exec -T postgres psql -At -U "${POSTGRES_USER:-pulsewatch}" -d "${POSTGRES_DB:-pulsewatch}" \
  -c "SELECT count(*) FROM check_results c JOIN monitors m ON m.id = c.monitor_id JOIN users u ON u.id = m.user_id WHERE u.email = '$EMAIL'")
echo "Prepared $EMAIL with 20 monitors and $rows check results."
echo "export LOAD_EMAIL='$EMAIL' LOAD_PASSWORD='$PASSWORD'"
