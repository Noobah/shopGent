import type { NextRequest } from "next/server";
import { withAsyncHandler } from "@/lib/asyncHandler";
import { parseBody } from "@/lib/validate";
import { resetRequestInputSchema } from "@/modules/auth/models";
import { requestPasswordReset } from "@/modules/auth/service";
import { assertSameOrigin } from "@/modules/auth/origin";
import { enforceAuthIpLimit } from "@/modules/auth/rateLimit";

/**
 * POST /api/auth/request-reset
 * Requests a password-reset email. ALWAYS returns ok regardless of whether the
 * email exists, so this endpoint cannot be used to enumerate accounts.
 * Rate-limited per IP; origin-checked.
 */
export const POST = withAsyncHandler(async (req: NextRequest) => {
  assertSameOrigin(req);
  await enforceAuthIpLimit(req, "reset");

  const input = await parseBody(resetRequestInputSchema, req);
  await requestPasswordReset(input);

  // Deliberately identical response whether or not the account exists.
  return Response.json({ ok: true });
});
