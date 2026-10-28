import { connectDb, isDbConnected } from "@/lib/db";
import { withAsyncHandler } from "@/lib/asyncHandler";
import { logger } from "@/lib/logger";

/**
 * GET /api/health
 *
 * Liveness/readiness probe. Checks that MongoDB is reachable and returns 200
 * when healthy, 503 when not. Always returns JSON in the standardized shape.
 */
export const GET = withAsyncHandler(async () => {
  let dbOk = false;
  let dbError: string | undefined;

  try {
    await connectDb();
    dbOk = isDbConnected();
  } catch (err) {
    dbOk = false;
    dbError = err instanceof Error ? err.message : "unknown";
    logger.error("health.db_check_failed", { err });
  }

  const body = {
    status: dbOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks: {
      database: { status: dbOk ? "up" : "down", ...(dbError ? { error: dbError } : {}) },
    },
  };

  return Response.json(body, { status: dbOk ? 200 : 503 });
});
