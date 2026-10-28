import { withAsyncHandler } from "@/lib/asyncHandler";
import { requireUser } from "@/modules/auth/requireUser";
import { listSessionsForUser } from "@/modules/auth/session";
import { shapeSession } from "@/modules/auth/shape";

/**
 * GET /api/auth/sessions
 * List the authenticated user's sessions. Ownership is baked into the query.
 */
export const GET = withAsyncHandler(async () => {
  const user = await requireUser();
  const sessions = await listSessionsForUser(user._id.toString());
  return Response.json({ sessions: sessions.map(shapeSession) });
});
