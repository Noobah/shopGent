import type { NextRequest } from "next/server";
import { ForbiddenError } from "@/lib/errors";

/**
 * Origin check for custom mutating Route Handlers (CSRF defense).
 *
 * Session cookies are SameSite=Lax, which already blocks most cross-site POSTs,
 * but Lax still sends the cookie on top-level GET navigations and some edge
 * cases. This adds a belt-and-suspenders check: for state-changing methods, if
 * an Origin header is present it must match the request's own origin. Requests
 * with no Origin (same-origin fetches, curl) are allowed — SameSite + the
 * requireUser() session check still protect them.
 */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function assertSameOrigin(req: NextRequest): void {
  if (!MUTATING_METHODS.has(req.method)) return;

  const origin = req.headers.get("origin");
  // No Origin header → not a browser cross-site navigation; allow.
  if (!origin) return;

  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "http";

  if (!host) {
    throw new ForbiddenError("Unable to verify request origin");
  }

  const expected = `${proto}://${host}`;
  if (origin !== expected && origin !== `https://${host}`) {
    throw new ForbiddenError("Cross-origin request rejected");
  }
}
