import mongoose from "mongoose";
import { env } from "./env";
import { logger } from "./logger";

/**
 * Cached Mongoose connection.
 *
 * Next.js in dev reloads modules on every change, which would otherwise create
 * a new connection pool each time. We stash the in-flight promise on `globalThis`
 * so it survives Hot Module Replacement. In tests, call `disconnectDb()` to
 * teardown cleanly.
 */

const GLOBAL_KEY = Symbol.for("shoppilot.db.connection");

interface DbGlobal {
  [GLOBAL_KEY]?: Promise<typeof mongoose> | null;
}

const g = globalThis as DbGlobal;

async function createConnection(): Promise<typeof mongoose> {
  const uri = env.MONGODB_URI;

  mongoose.set("strictQuery", true);

  const conn = await mongoose.connect(uri, {
    // Fail fast instead of hanging a request on an unreachable DB.
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 10,
  });

  logger.info("mongodb.connected", { host: conn.connection.host });
  return conn;
}

/** Connect (or reuse the cached connection). */
export async function connectDb(): Promise<typeof mongoose> {
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY];

  g[GLOBAL_KEY] = createConnection().catch((err: unknown) => {
    // Clear the cached promise so the next call retries instead of reusing a
    // permanently-rejected connection.
    g[GLOBAL_KEY] = null;
    logger.error("mongodb.connection_failed", { err });
    throw err;
  });

  return g[GLOBAL_KEY];
}

/** True if Mongoose currently has an open ready connection. */
export function isDbConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

/** Disconnect and clear the cache (used in tests/teardown). */
export async function disconnectDb(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  g[GLOBAL_KEY] = null;
}
