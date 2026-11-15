-- CreateEnum
CREATE TYPE "monitor_status" AS ENUM ('PENDING', 'UP', 'DOWN');

-- CreateEnum
CREATE TYPE "http_method" AS ENUM ('GET', 'HEAD');

-- CreateEnum
CREATE TYPE "check_error_type" AS ENUM ('TIMEOUT', 'DNS', 'CONNECTION', 'TLS', 'BLOCKED_ADDRESS', 'HTTP_STATUS', 'RESPONSE_TOO_LARGE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "notification_event" AS ENUM ('INCIDENT_OPENED', 'INCIDENT_RESOLVED');

-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "method" "http_method" NOT NULL DEFAULT 'GET',
    "interval_seconds" INTEGER NOT NULL DEFAULT 60,
    "timeout_ms" INTEGER NOT NULL DEFAULT 10000,
    "failure_threshold" INTEGER NOT NULL DEFAULT 3,
    "recovery_threshold" INTEGER NOT NULL DEFAULT 2,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "status" "monitor_status" NOT NULL DEFAULT 'PENDING',
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "consecutive_successes" INTEGER NOT NULL DEFAULT 0,
    "last_checked_at" TIMESTAMPTZ(3),
    "next_check_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_results" (
    "id" BIGSERIAL NOT NULL,
    "monitor_id" UUID NOT NULL,
    "scheduled_for" TIMESTAMPTZ(3) NOT NULL,
    "checked_at" TIMESTAMPTZ(3) NOT NULL,
    "success" BOOLEAN NOT NULL,
    "status_code" INTEGER,
    "response_time_ms" INTEGER,
    "error_type" "check_error_type",
    "error_message" TEXT,

    CONSTRAINT "check_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "monitor_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "cause_error_type" "check_error_type" NOT NULL,
    "cause_status_code" INTEGER,
    "cause_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_settings" (
    "user_id" UUID NOT NULL,
    "email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "email_address" TEXT,
    "notify_on_down" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_recovery" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "incident_id" UUID NOT NULL,
    "event" "notification_event" NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" "delivery_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "monitors_user_id_created_at_idx" ON "monitors"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "check_results_scheduled_for_idx" ON "check_results" USING BRIN ("scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "check_results_monitor_id_scheduled_for_key" ON "check_results"("monitor_id", "scheduled_for");

-- CreateIndex
CREATE INDEX "incidents_monitor_id_started_at_idx" ON "incidents"("monitor_id", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_incident_id_event_channel_key" ON "notification_deliveries"("incident_id", "event", "channel");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written from here down.
--
-- Prisma's schema language cannot express CHECK constraints or partial
-- indexes, so they are added here. Prisma's diffing ignores both, which
-- `pnpm db:check-drift` verifies. Rationale: docs/database.md.
-- ===========================================================================

-- users: the API lower-cases emails; this stops any other writer creating
-- "A@x.com" next to "a@x.com".
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"));

-- monitors: bounds mirror packages/shared/src/monitoring.ts (a test asserts
-- the two agree).
ALTER TABLE "monitors"
  ADD CONSTRAINT "monitors_name_length" CHECK (char_length("name") BETWEEN 1 AND 100),
  ADD CONSTRAINT "monitors_url_https" CHECK ("url" LIKE 'https://%' AND char_length("url") <= 2048),
  ADD CONSTRAINT "monitors_interval_range" CHECK ("interval_seconds" BETWEEN 60 AND 86400),
  ADD CONSTRAINT "monitors_timeout_range" CHECK ("timeout_ms" BETWEEN 1000 AND 30000),
  ADD CONSTRAINT "monitors_failure_threshold_range" CHECK ("failure_threshold" BETWEEN 1 AND 10),
  ADD CONSTRAINT "monitors_recovery_threshold_range" CHECK ("recovery_threshold" BETWEEN 1 AND 10),
  ADD CONSTRAINT "monitors_counters_non_negative"
    CHECK ("consecutive_failures" >= 0 AND "consecutive_successes" >= 0);

-- The scheduler's query: "which active monitors are due?". Partial, so paused
-- monitors cost nothing.
CREATE INDEX "monitors_due_idx" ON "monitors" ("next_check_at") WHERE "paused" = false;

-- check_results: a success has a status code and a latency and no error; a
-- failure always says why.
ALTER TABLE "check_results"
  ADD CONSTRAINT "check_results_status_code_range"
    CHECK ("status_code" IS NULL OR "status_code" BETWEEN 100 AND 599),
  ADD CONSTRAINT "check_results_response_time_non_negative"
    CHECK ("response_time_ms" IS NULL OR "response_time_ms" >= 0),
  ADD CONSTRAINT "check_results_success_shape" CHECK (
    NOT "success"
    OR ("status_code" IS NOT NULL AND "response_time_ms" IS NOT NULL AND "error_type" IS NULL)
  ),
  ADD CONSTRAINT "check_results_failure_shape" CHECK ("success" OR "error_type" IS NOT NULL);

-- incidents: at most ONE open incident per monitor, enforced by the database.
-- If two workers race, the second INSERT fails instead of creating a duplicate.
ALTER TABLE "incidents"
  ADD CONSTRAINT "incidents_resolved_after_start"
    CHECK ("resolved_at" IS NULL OR "resolved_at" >= "started_at");

CREATE UNIQUE INDEX "incidents_one_open_per_monitor"
  ON "incidents" ("monitor_id") WHERE "resolved_at" IS NULL;

-- notification_deliveries: the sender's sweep for unsent work. Partial,
-- because almost every row is SENT.
ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_attempts_non_negative" CHECK ("attempts" >= 0);

CREATE INDEX "notification_deliveries_pending_idx"
  ON "notification_deliveries" ("created_at") WHERE "status" = 'PENDING';
