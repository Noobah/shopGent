import type { NextRequest } from "next/server";
import { withAsyncHandler } from "@/lib/asyncHandler";
import { logout } from "@/modules/auth/service";
import { assertSameOrigin } from "@/modules/auth/origin";

/**
 * POST /api/auth/logout
 * Revokes the current session and clears the cookie. Origin-checked.
 * Always succeeds (even if no session) so logout is idempotent.
 */
export const POST = withAsyncHandler(async (req: NextRequest) => {
  assertSameOrigin(req);
  await logout();
  return Response.json({ ok: true });
});
