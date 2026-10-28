import type { NextRequest } from "next/server";
import { AuthError } from "@/lib/errors";
import { withAsyncHandler } from "@/lib/asyncHandler";
import { parseBody } from "@/lib/validate";
import { signupInputSchema } from "@/modules/auth/models";
import { signup } from "@/modules/auth/service";
import { assertSameOrigin } from "@/modules/auth/origin";
import { enforceAuthIpLimit } from "@/modules/auth/rateLimit";
import { toSafeUser } from "@/modules/auth/session";
import { UserModel } from "@/modules/auth/models";

/**
 * POST /api/auth/signup
 * Create an account and start a session. Rate-limited per IP; origin-checked.
 */
export const POST = withAsyncHandler(async (req: NextRequest) => {
  assertSameOrigin(req);
  await enforceAuthIpLimit(req, "signup");

  const input = await parseBody(signupInputSchema, req);
  const userId = await signup(input);

  const user = await UserModel.findById(userId).lean();
  if (!user) {
    // Should not happen right after creation; surface as an auth error.
    throw new AuthError("Account created but could not be loaded");
  }

  return Response.json({ user: toSafeUser(user) }, { status: 201 });
});
