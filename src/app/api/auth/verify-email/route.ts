import type { NextRequest } from "next/server";
import { withAsyncHandler } from "@/lib/asyncHandler";
import { parseBody } from "@/lib/validate";
import { verifyEmailInputSchema } from "@/modules/auth/models";
import { verifyEmail } from "@/modules/auth/service";
import { assertSameOrigin } from "@/modules/auth/origin";

/**
 * POST /api/auth/verify-email
 * Consumes a one-time token to mark the email verified. Origin-checked.
 */
export const POST = withAsyncHandler(async (req: NextRequest) => {
  assertSameOrigin(req);
  const input = await parseBody(verifyEmailInputSchema, req);
  await verifyEmail(input);
  return Response.json({ ok: true });
});
