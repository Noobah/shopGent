import type { NextRequest } from "next/server";
import { getRateLimiter } from "@/lib/rateLimit";
import { RateLimitError } from "@/lib/errors";

/**
 * Auth-oriented rate-limiting helpers.
 *
 * Wraps the RateLimiter seam so callers don't repeat key/limit boilerplate.
 * Limits below are deliberately conservative for auth endpoints.
 */

// Per-IP auth limits.
export const AUTH_IP_LIMITS = {
  login: { limit: 10, windowMs: 5 * 60_000 }, // 10 / 5 min
  signup: { limit: 5, windowMs: 60 * 60_000 }, // 5 / hour
  reset: { limit: 5, windowMs: 60 * 60_000 }, // 5 / hour
} as const;

/** Extract a client IP from the request, best-effort. */
export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Record an attempt and throw `RateLimitError` (429) if over the limit.
 * Throws so it flows through `handleApiError` like any other error.
 */
export async function enforceRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const result = await getRateLimiter().hit(key, limit, windowMs);
  if (!result.allowed) {
    throw new RateLimitError("Too many attempts. Please try again later.");
  }
}

/** Standard per-IP auth rate limit keyed by action. */
export async function enforceAuthIpLimit(
  req: NextRequest,
  action: keyof typeof AUTH_IP_LIMITS,
): Promise<void> {
  const { limit, windowMs } = AUTH_IP_LIMITS[action];
  await enforceRateLimit(`auth:${action}:ip:${clientIp(req)}`, limit, windowMs);
}
