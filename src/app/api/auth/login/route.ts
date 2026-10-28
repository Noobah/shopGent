import type { NextRequest } from "next/server";
import { withAsyncHandler } from "@/lib/asyncHandler";
import { parseBody } from "@/lib/validate";
import { loginInputSchema, UserModel } from "@/modules/auth/models";
import { login } from "@/modules/auth/service";
import { assertSameOrigin } from "@/modules/auth/origin";
import { enforceAuthIpLimit } from "@/modules/auth/rateLimit";
import { toSafeUser } from "@/modules/auth/session";
import { AuthError } from "@/lib/errors";

/**
 * POST /api/auth/login
 * Email/password login. Unknown email and wrong password return an IDENTICAL
 * error. Rate-limited per IP; origin-checked.
 */
export const POST = withAsyncHandler(async (req: NextRequest) => {
  assertSameOrigin(req);
  await enforceAuthIpLimit(req, "login");

  const input = await parseBody(loginInputSchema, req);
  const userId = await login(input);

  const user = await UserModel.findById(userId).lean();
  if (!user) throw new AuthError("Invalid email or password");

  return Response.json({ user: toSafeUser(user) });
});
