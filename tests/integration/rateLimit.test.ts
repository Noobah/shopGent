import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { enforceAuthIpLimit, clientIp } from "@/modules/auth/rateLimit";
import { setRateLimiter } from "@/lib/rateLimit";
import { RateLimitError } from "@/lib/errors";

/**
 * Integration: the auth rate limiter actually trips.
 *
 * Uses the real InMemoryRateLimiter via the RateLimiter seam. We reset the
 * singleton between tests so limits don't leak across cases.
 */

function makeReq(ip: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

beforeEach(() => {
  setRateLimiter(null); // fresh in-memory limiter
});

describe("enforceAuthIpLimit", () => {
  it("clientIp reads x-forwarded-for", () => {
    expect(clientIp(makeReq("203.0.113.9"))).toBe("203.0.113.9");
  });

  it("allows requests under the login limit, then trips", async () => {
    const ip = "198.51.100.1";
    const req = makeReq(ip);

    // Login limit is 10 / 5 min. First 10 pass…
    for (let i = 0; i < 10; i++) {
      await expect(enforceAuthIpLimit(req, "login")).resolves.toBeUndefined();
    }
    // …the 11th throws RateLimitError.
    await expect(enforceAuthIpLimit(req, "login")).rejects.toThrow(RateLimitError);
  });

  it("RateLimitError maps to 429 via handleApiError", async () => {
    const { handleApiError } = await import("@/lib/errors");
    const res = handleApiError(new RateLimitError());
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("limits are keyed per IP (one noisy IP does not block another)", async () => {
    const noisy = makeReq("203.0.113.10");
    const other = makeReq("203.0.113.11");

    // Exhaust the noisy IP.
    for (let i = 0; i < 11; i++) {
      try {
        await enforceAuthIpLimit(noisy, "login");
      } catch {
        /* expected to trip by the end */
      }
    }

    // A different IP is still allowed.
    await expect(enforceAuthIpLimit(other, "login")).resolves.toBeUndefined();
  });

  it("different actions have independent budgets", async () => {
    const ip = "203.0.113.20";
    const req = makeReq(ip);

    // Exhaust signup (5 / hour).
    for (let i = 0; i < 6; i++) {
      try {
        await enforceAuthIpLimit(req, "signup");
      } catch {
        /* expected */
      }
    }
    await expect(enforceAuthIpLimit(req, "signup")).rejects.toThrow(RateLimitError);

    // login budget is untouched by the signup exhaustion.
    await expect(enforceAuthIpLimit(req, "login")).resolves.toBeUndefined();
  });
});
