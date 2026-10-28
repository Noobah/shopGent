import type { NextRequest } from "next/server";
import { withAsyncHandler } from "@/lib/asyncHandler";
import { parseBody } from "@/lib/validate";
import { resetPasswordInputSchema } from "@/modules/auth/models";
import { resetPassword } from "@/modules/auth/service";
import { assertSameOrigin } from "@/modules/auth/origin";
import { enforceAuthIpLimit } from "@/modules/auth/rateLimit";

/**
 * POST /api/auth/reset-password
 * Consumes a one-time token and sets a new password. Revokes all existing
 * sessions for the account. Rate-limited per IP; origin-checked.
 */
export const POST = withAsyncHandler(async (req: NextRequest) => {
  assertSameOrigin(req);
  await enforceAuthIpLimit(req, "reset");

  const input = await parseBody(resetPasswordInputSchema, req);
  await resetPassword(input);

  return Response.json({ ok: true });
});
