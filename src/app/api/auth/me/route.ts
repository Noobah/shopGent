import { withAsyncHandler } from "@/lib/asyncHandler";
import { requireUser } from "@/modules/auth/requireUser";
import { toSafeUser } from "@/modules/auth/session";

/**
 * GET /api/auth/me
 * Returns the authenticated user, or 401 if not signed in. Also serves as a
 * clean ownership/session probe for the client.
 */
export const GET = withAsyncHandler(async () => {
  const user = await requireUser();
  return Response.json({ user: toSafeUser(user) });
});
