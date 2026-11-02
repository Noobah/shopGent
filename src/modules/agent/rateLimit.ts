import type { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { enforceRateLimit, clientIp } from "@/modules/auth/rateLimit";
import { reserveAgentStepForUser, utcDay } from "@/modules/sessions";

/**
 * Agent-specific abuse controls.
 *
 * - per-IP and per-user request limits on the streaming endpoint
 * - a per-user DAILY STEP cap shared across all chat sessions (UTC day)
 *
 * The daily reservation is atomic in MongoDB (see sessions/repository.ts), so
 * two concurrent streams cannot both slip past the cap at the boundary.
 */

export const AGENT_STREAM_LIMITS = {
  ip: { limit: 20, windowMs: 60_000 }, // 20 streams / minute / IP
  user: { limit: 10, windowMs: 60_000 }, // 10 streams / minute / user
} as const;

/** Throw 429 before a stream starts when the caller is over a request limit. */
export async function enforceAgentStreamRateLimits(
  req: NextRequest,
  userId: string,
): Promise<void> {
  await enforceRateLimit(
    `agent:stream:ip:${clientIp(req)}`,
    AGENT_STREAM_LIMITS.ip.limit,
    AGENT_STREAM_LIMITS.ip.windowMs,
  );
  await enforceRateLimit(
    `agent:stream:user:${userId}`,
    AGENT_STREAM_LIMITS.user.limit,
    AGENT_STREAM_LIMITS.user.windowMs,
  );
}

export interface AgentStepReservation {
  allowed: boolean;
  used: number;
  day: string;
  cap: number;
}

/** Reserve one LLM turn against the user's daily cap. */
export async function reserveAgentStep(
  userId: string,
  options: { now?: Date; cap?: number } = {},
): Promise<AgentStepReservation> {
  const cap = options.cap ?? env.AGENT_DAILY_STEPS;
  const day = utcDay(options.now ?? new Date());
  const result = await reserveAgentStepForUser(userId, day, cap);
  return { ...result, cap };
}
