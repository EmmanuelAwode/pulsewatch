// k6 load test: the dashboard's read path through the full stack
// (nginx -> API -> PostgreSQL), with an authenticated user.
//
// Run against the Compose stack: see load/README.md.
//
// What it measures: latency and error rate of the endpoints the dashboard
// calls most (/dashboard, /monitors, /monitors/:id/analytics, /incidents),
// for a user with 20 monitors, each with 30 days of one-minute check history
// (864,000 rows in total), which load/prepare.sh creates.
// What it does NOT measure: the worker. Load-testing the worker would mean
// sending a large volume of requests to third-party websites, which is not
// acceptable; its throughput is limited by the network, not this code.

import http from "k6/http";
import { check, fail } from "k6";

const BASE = `${__ENV.BASE_URL || "http://localhost:8080"}/api/v1`;
const RANGES = ["24h", "7d", "30d"];

// An open model: a fixed number of dashboard loads start every second,
// whether or not earlier ones have finished, the way independent users
// arrive. (A closed model, where each virtual user waits for its previous
// request, slows down when the server does and so hides the problem.)
// One dashboard load = 4 API requests, so 150/s is 600 requests/s: 36,000 a
// minute, under the per-IP rate limit configured for the run, so the test
// measures the application rather than the limiter.
export const options = {
  scenarios: {
    dashboard_loads: {
      executor: "ramping-arrival-rate",
      startRate: 10,
      timeUnit: "1s",
      preAllocatedVUs: 50,
      maxVUs: 300,
      stages: [
        { duration: "15s", target: 150 },
        { duration: "60s", target: 150 },
      ],
    },
  },
  // The pass/fail bar for a run. Recorded with the results either way.
  thresholds: {
    http_req_failed: ["rate<0.01"],
    dropped_iterations: ["count==0"],
    "http_req_duration{endpoint:dashboard}": ["p(95)<300"],
    "http_req_duration{endpoint:analytics}": ["p(95)<300"],
  },
};

const json = { headers: { "content-type": "application/json" } };

/**
 * Runs once. Logs in to the account that load/prepare.sh created (20 monitors
 * with 30 days of history each) and returns its session and monitor IDs.
 *
 * The session cookie is sent explicitly on each request. In production the
 * cookies are marked Secure, so k6, like a browser, will not attach them to a
 * plain-HTTP request to the internal host "web". Every virtual user therefore
 * shares this one session: many clients viewing the same account's dashboard.
 */
export function setup() {
  const email = __ENV.LOAD_EMAIL;
  const password = __ENV.LOAD_PASSWORD;
  if (!email || !password) fail("Set LOAD_EMAIL and LOAD_PASSWORD (printed by load/prepare.sh).");

  const login = http.post(`${BASE}/auth/login`, JSON.stringify({ email, password }), json);
  if (login.status !== 200) fail(`login returned ${login.status}`);
  const accessToken = login.cookies.pw_access?.[0]?.value;
  if (!accessToken) fail("login did not set the pw_access cookie");

  const cookie = `pw_access=${accessToken}`;
  const monitors = http.get(`${BASE}/monitors`, { headers: { cookie } });
  if (monitors.status !== 200) fail(`listing monitors returned ${monitors.status}`);
  const monitorIds = monitors.json("data").map((monitor) => monitor.id);
  if (monitorIds.length === 0) fail("the load-test account has no monitors; run load/prepare.sh");
  return { cookie, monitorIds };
}

export default function (data) {
  // Shared session (see setup); one iteration = one dashboard page load.
  const headers = { cookie: data.cookie };
  const monitorId = data.monitorIds[Math.floor(Math.random() * data.monitorIds.length)];
  const range = RANGES[Math.floor(Math.random() * RANGES.length)];

  const responses = http.batch([
    ["GET", `${BASE}/dashboard`, null, { headers, tags: { endpoint: "dashboard" } }],
    ["GET", `${BASE}/monitors`, null, { headers, tags: { endpoint: "monitors" } }],
    [
      "GET",
      `${BASE}/monitors/${monitorId}/analytics?range=${range}`,
      null,
      { headers, tags: { endpoint: "analytics" } },
    ],
    ["GET", `${BASE}/incidents?limit=5`, null, { headers, tags: { endpoint: "incidents" } }],
  ]);
  for (const response of responses) {
    check(response, { "status 200": (r) => r.status === 200 });
  }
}
