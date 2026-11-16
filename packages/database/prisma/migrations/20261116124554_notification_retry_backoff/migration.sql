-- AlterTable
ALTER TABLE "notification_deliveries" ADD COLUMN     "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ===========================================================================
-- Hand-written from here down (see ADR-014).
-- ===========================================================================

-- The sender now asks "which pending deliveries are due for an attempt?", so
-- the partial index moves from created_at to next_attempt_at.
DROP INDEX "notification_deliveries_pending_idx";

CREATE INDEX "notification_deliveries_pending_idx"
  ON "notification_deliveries" ("next_attempt_at") WHERE "status" = 'PENDING';
