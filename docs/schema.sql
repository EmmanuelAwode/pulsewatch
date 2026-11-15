-- PulseWatch reference schema (PostgreSQL 16).
--
-- This file is the Phase 1 DESIGN artifact. In Phase 2 the Prisma schema and
-- its generated migrations become the source of truth, and this file is kept
-- only as readable documentation. Rationale for each choice: docs/database.md.
--
-- Conventions
--   * snake_case tables and columns.
--   * Every timestamp is timestamptz (stored as UTC, no local-time ambiguity).
--   * Rules that must never be violated live in the database (constraints),
--     not only in application code.

CREATE TYPE monitor_status AS ENUM ('PENDING', 'UP', 'DOWN');
CREATE TYPE http_method AS ENUM ('GET', 'HEAD');
CREATE TYPE check_error_type AS ENUM (
  'TIMEOUT',            -- no complete response within timeout_ms
  'DNS',                -- hostname did not resolve
  'CONNECTION',         -- TCP connect refused / reset
  'TLS',                -- certificate or handshake failure
  'BLOCKED_ADDRESS',    -- resolved to a private/reserved IP (SSRF guard)
  'HTTP_STATUS',        -- response received, status outside 2xx
  'RESPONSE_TOO_LARGE', -- body exceeded the size limit
  'UNKNOWN'
);
CREATE TYPE notification_event AS ENUM ('INCIDENT_OPENED', 'INCIDENT_RESOLVED');
CREATE TYPE notification_channel AS ENUM ('EMAIL');
CREATE TYPE delivery_status AS ENUM ('PENDING', 'SENT', 'FAILED');

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,                       -- Argon2id encoded hash
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_email_key UNIQUE (email),
  -- The API lower-cases emails; this stops any other writer creating
  -- "A@x.com" next to "a@x.com".
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);

-- ---------------------------------------------------------------------------
-- refresh_tokens: one row per issued refresh token (ADR-004)
-- ---------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- All tokens descended from one login share a family. Re-use of an already
  -- rotated token means theft, and the whole family is revoked.
  family_id   uuid NOT NULL,
  -- SHA-256 of the token. The raw token only ever exists in the cookie, so a
  -- database leak does not leak usable sessions.
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash)
);
CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens (family_id);

-- ---------------------------------------------------------------------------
-- monitors
-- ---------------------------------------------------------------------------
CREATE TABLE monitors (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name                  text NOT NULL,
  url                   text NOT NULL,
  method                http_method NOT NULL DEFAULT 'GET',
  interval_seconds      integer NOT NULL DEFAULT 60,
  timeout_ms            integer NOT NULL DEFAULT 10000,
  failure_threshold     integer NOT NULL DEFAULT 3,
  recovery_threshold    integer NOT NULL DEFAULT 2,
  paused                boolean NOT NULL DEFAULT false,

  -- Current state, maintained by the worker inside the same transaction that
  -- records each check (ADR-007).
  status                monitor_status NOT NULL DEFAULT 'PENDING',
  consecutive_failures  integer NOT NULL DEFAULT 0,
  consecutive_successes integer NOT NULL DEFAULT 0,
  last_checked_at       timestamptz,

  -- Scheduling (ADR-002): the next slot this monitor is due.
  next_check_at         timestamptz NOT NULL,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT monitors_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT monitors_url_https CHECK (url LIKE 'https://%' AND char_length(url) <= 2048),
  CONSTRAINT monitors_interval_range CHECK (interval_seconds BETWEEN 60 AND 86400),
  CONSTRAINT monitors_timeout_range CHECK (timeout_ms BETWEEN 1000 AND 30000),
  CONSTRAINT monitors_failure_threshold_range CHECK (failure_threshold BETWEEN 1 AND 10),
  CONSTRAINT monitors_recovery_threshold_range CHECK (recovery_threshold BETWEEN 1 AND 10),
  CONSTRAINT monitors_counters_non_negative
    CHECK (consecutive_failures >= 0 AND consecutive_successes >= 0)
);

-- "List my monitors, newest first" (dashboard, monitors page).
CREATE INDEX monitors_user_id_created_at_idx ON monitors (user_id, created_at DESC);

-- The scheduler's query: "which active monitors are due?". Partial, so paused
-- monitors cost nothing and the index stays small.
CREATE INDEX monitors_due_idx ON monitors (next_check_at) WHERE paused = false;

-- ---------------------------------------------------------------------------
-- check_results: append-only, by far the largest table
-- ---------------------------------------------------------------------------
CREATE TABLE check_results (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  monitor_id       uuid NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  -- The schedule slot this check belongs to. Deterministic, so it doubles as
  -- the idempotency key (ADR-003).
  scheduled_for    timestamptz NOT NULL,
  -- When the request actually started. checked_at - scheduled_for = queue lag.
  checked_at       timestamptz NOT NULL,
  success          boolean NOT NULL,
  status_code      integer,
  response_time_ms integer,
  error_type       check_error_type,
  error_message    text,

  -- One result per monitor per slot. This is what makes job retries and
  -- duplicate jobs harmless. It is also the index that serves history and
  -- analytics range scans, so the hot table carries one index, not two.
  CONSTRAINT check_results_monitor_slot_key UNIQUE (monitor_id, scheduled_for),

  CONSTRAINT check_results_status_code_range
    CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  CONSTRAINT check_results_response_time_non_negative
    CHECK (response_time_ms IS NULL OR response_time_ms >= 0),
  -- A success has a status code and a latency, and no error.
  CONSTRAINT check_results_success_shape CHECK (
    NOT success
    OR (status_code IS NOT NULL AND response_time_ms IS NOT NULL AND error_type IS NULL)
  ),
  -- A failure always says why.
  CONSTRAINT check_results_failure_shape CHECK (success OR error_type IS NOT NULL)
);

-- Retention deletes by time across all monitors. Rows arrive in time order, so
-- a BRIN index (a few KB) is enough; a second B-tree would double write cost.
CREATE INDEX check_results_scheduled_for_brin ON check_results USING brin (scheduled_for);

-- ---------------------------------------------------------------------------
-- incidents: one row per outage
-- ---------------------------------------------------------------------------
CREATE TABLE incidents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id        uuid NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  -- Slot of the FIRST failed check in the streak, so the duration reflects
  -- when the outage began rather than when the threshold was crossed.
  started_at        timestamptz NOT NULL,
  resolved_at       timestamptz,
  cause_error_type  check_error_type NOT NULL,
  cause_status_code integer,
  cause_message     text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT incidents_resolved_after_start
    CHECK (resolved_at IS NULL OR resolved_at >= started_at)
);

-- At most ONE open incident per monitor, enforced by the database. Even if two
-- workers race, the second INSERT fails instead of creating a duplicate.
CREATE UNIQUE INDEX incidents_one_open_per_monitor
  ON incidents (monitor_id) WHERE resolved_at IS NULL;

-- "Incident history for this monitor, newest first".
CREATE INDEX incidents_monitor_id_started_at_idx ON incidents (monitor_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- notification_settings: exactly one row per user (PK = FK)
-- ---------------------------------------------------------------------------
CREATE TABLE notification_settings (
  user_id            uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  email_enabled      boolean NOT NULL DEFAULT false,
  -- NULL means "use the account email".
  email_address      text,
  notify_on_down     boolean NOT NULL DEFAULT true,
  notify_on_recovery boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- notification_deliveries: transactional outbox + audit log (ADR-008)
-- ---------------------------------------------------------------------------
CREATE TABLE notification_deliveries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
  event       notification_event NOT NULL,
  channel     notification_channel NOT NULL,
  recipient   text NOT NULL,
  status      delivery_status NOT NULL DEFAULT 'PENDING',
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- One notification per incident, per event, per channel: a retried job can
  -- never email the user twice about the same outage.
  CONSTRAINT notification_deliveries_once_key UNIQUE (incident_id, event, channel),
  CONSTRAINT notification_deliveries_attempts_non_negative CHECK (attempts >= 0)
);

-- The sender's sweep for unsent work. Partial: almost every row is SENT.
CREATE INDEX notification_deliveries_pending_idx
  ON notification_deliveries (created_at) WHERE status = 'PENDING';
