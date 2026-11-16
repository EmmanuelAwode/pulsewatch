import type { PrismaClient } from "@pulsewatch/database";

export interface RetentionOptions {
  db: PrismaClient;
  now: () => Date;
  /** Check results older than this are deleted. Must cover the longest analytics range. */
  retentionDays: number;
  /** Rows deleted per statement. */
  batchSize?: number;
}

export interface RetentionResult {
  checkResults: number;
  refreshTokens: number;
}

/**
 * Keeps the two ever-growing tables bounded (ADR-005).
 *
 * Old check results are deleted in batches of a few thousand rather than in
 * one statement: a single huge DELETE would hold locks and generate WAL for a
 * long time, and every batch commits on its own so progress is never lost.
 * Incidents are kept: they are small and are the long-term record.
 */
export async function runRetention(options: RetentionOptions): Promise<RetentionResult> {
  const { db, now, retentionDays } = options;
  const batchSize = options.batchSize ?? 5_000;
  const cutoff = new Date(now().getTime() - retentionDays * 24 * 3_600_000);

  let checkResults = 0;
  for (;;) {
    // DELETE has no LIMIT in PostgreSQL, so select a batch of keys first.
    // The scheduled_for filter is served by the BRIN index.
    const deleted = await db.$executeRaw`
      DELETE FROM check_results
      WHERE id IN (
        SELECT id FROM check_results WHERE scheduled_for < ${cutoff} LIMIT ${batchSize}
      )`;
    checkResults += deleted;
    if (deleted < batchSize) break;
  }

  // Expired sessions are useless; revoked ones are kept a week for re-use
  // detection to stay meaningful, then removed.
  const revokedCutoff = new Date(now().getTime() - 7 * 24 * 3_600_000);
  const { count: refreshTokens } = await db.refreshToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: now() } }, { revokedAt: { lt: revokedCutoff } }],
    },
  });

  return { checkResults, refreshTokens };
}
